# Track P — production readiness (final plan, after critic)

Planner + critic, 2026-11-04. One worker, ~60 min, runs **after track V is done**
(V edits `engine/lifefi/engine.py` first: line numbers below are from cf3cb47 and
will have shifted — **re-read `engine.py` before editing and find code by function
name**). Nothing is tested on hardware; **nothing is flashed tonight**: the
firmware change is compile- and host-test-verified only.

Worker owns: `firmware/**`, `scripts/**`, `.github/**`, `docs/ops/**`,
`docs/hardware/**`, `ui/src/server/health.ts`, `ui/test/health.test.ts`,
`contracts/api.md` (health section only; V is finished by then), and small isolated
edits in `engine/**`: new `engine/lifefi/link.py`, new `engine/tests/test_link.py`,
one line of `engine/config/rules.yaml`, and in `engine.py` only `_transmitter_fixed()`,
`feed()` (+2 lines) and `status()` (+2 keys). Do **not** edit
`contracts/results.schema.json` (or anything that regenerates `contracts.gen.ts`).
No git commands that change state. Never flash. Never leave a server running.

## Verified findings (critic re-checked against the code)

- **F1 `transmitter_not_fixed`** comes only from `rules.yaml position.transmitter_fixed:
  false` via `Engine._transmitter_fixed()` (called from `load_rules()` under
  `hasattr(self, "position")` and from `_reset_signal()`). Every v2 frame carries
  `src_mac`; `csi_recorder.parse_frame()` turns it into lowercase
  `"1a:4c:46:54:58:01"` (`bytes.hex(":")`); `feed()` stores the header as `self.hdr`
  (initialised `None`) only for frames that pass the layout check. Firmware TX prefix
  `1A:4C:46:54:58` (`lifefi_config.h` `LIFEFI_TX_MAC_PREFIX`, matched on 5 bytes by
  `tx_match.c`). The receiver's CSI callback (`csi_capture.c`) **drops every frame
  whose MAC is not the current target**, so a live stream has one source per lock; a
  "mixed" stream only happens on a re-lock (fixed TX lost → hotspot) or a concatenated
  replay. `engine/tests/scenarios.py` packs `a0b1c2d3e4f5`, so existing tests stay
  "not fixed". `Position.quality()` reads `self.transmitter_fixed` on every update.
  `get_status.device` is a loose record on the server; additive keys are safe.
- **F3 firmware IDLE0 watchdog** — confirmed in IDF 5.5.0
  (`~/.platformio/packages/framework-espidf`): `components/esp_driver_uart/src/uart_vfs.c:226-249`
  `uart_write()` calls `tx_func` **per character**; with the driver installed
  (`commands.c` `uart_vfs_dev_use_driver`) that is `uart_write_bytes(fd, &ch, 1)`
  (`:197-201`): one driver mutex take + ring item per byte. A line is `"@CSI "` +
  base64 of up to `CSI_FRAME_MAX` + `\r\n` ≈ 600 chars; at 100 Hz ≈ 60 KB/s on the
  921 600-baud console (≈ 92 KB/s): the link has room, the per-byte CPU cost is the
  problem. Lock facts verified: `CONFIG_LIBC_NEWLIB=y`, `CONFIG_LOG_VERSION_1=y`,
  `components/log/src/os/log_write.c:17` `esp_log_vprint_func = &vprintf` (takes the
  stdout FILE lock), `components/newlib/src/reent_init.c:22-28` every task shares the
  global stdout FILE. **Line ending:** `CONFIG_LIBC_STDOUT_LINE_ENDING_CRLF=y`, so the
  bytes on the wire today are `@CSI <b64>\r\n`; the fix must write `\r\n` itself to
  stay byte-identical. Parser: `firmware/tools/csi_recorder.py` `receive()` (used by
  `engine/lifefi/sources.py`) splits on `\n`, strips `\r`, accepts lines starting with
  `@CSI `; the real risk is splicing, which the stdout lock prevents.
  The command reader (`commands.c` `cmd_task`) uses `uart_read_bytes` directly and
  takes no stdio lock. Lock order of the new path: stdout FILE lock → UART driver TX
  mutex. Existing paths: stdout lock → VFS write_lock → driver mutex; stderr lock → VFS
  write_lock → driver mutex. No cycle → no deadlock.
- **F4 logs**: `scripts/start.mjs` prunes `lifefi-*.log` older than 14 days once at
  start; `out()` uses `appendFileSync` (open/append/close per line: no long-lived
  handle, so deleting files can never lose one). `logDir = <dataDir>/logs`; never
  touches `data/sessions/`.
- **F5 health**: `ui/src/server/health.ts` checks engine/board/calibration/storage;
  `state.engineStatus` is refreshed every 1 s by `runtime.ts` `pollStatus()` and set to
  `null` on disconnect; `state.latest` is a `Result` whose generated type already has
  optional `heart` and `breathing.reason`. `ui/test/health.test.ts` has a `toEqual` on
  the whole `checks.board` object ("every field present").
- **F6 CI** has no firmware job; triggers are `main`/`dev`/PR/manual.
- Checked, no gap: engine crash loop (start.mjs backoff 1→30 s), board unplugged
  (sources.py retries every 2 s), host-test binaries untracked, SQLite WAL bounded.

## Steps (in order; ✂ = cut first when short on time)

### 1. Firmware: one UART write per CSI line (IDLE0 watchdog) — 15 min
File: `firmware/src/stream.c` (+ version bump in step 5).

In `stream_send()`, replace `fputs(line, stdout);` with a static helper:

```c
#if CONFIG_ESP_CONSOLE_UART
#include "driver/uart.h"
#endif
...
/* The UART VFS writes stdout one character at a time (one driver call and ring item
 * per byte): ~600-char lines at up to 100 Hz kept the CSI task busy enough to starve
 * IDLE0 (task watchdog). One driver write per line instead, under the stdout lock so a
 * log line (ESP_LOG prints through vprintf on the same FILE) never splices into it. */
static void usb_write_line(const char *line, size_t n)
{
#if CONFIG_ESP_CONSOLE_UART
    if (n > 0 && line[n - 1] == '\n' && uart_is_driver_installed(CONFIG_ESP_CONSOLE_UART_NUM)) {
        flockfile(stdout);
        fflush(stdout);                                           /* a log's buffered bytes go first */
        uart_write_bytes(CONFIG_ESP_CONSOLE_UART_NUM, line, n - 1);
        uart_write_bytes(CONFIG_ESP_CONSOLE_UART_NUM, "\r\n", 2);  /* what the VFS sent: byte-identical */
        funlockfile(stdout);
        return;
    }
#endif
    fputs(line, stdout);
}
```
Call it with the length `csi_frame_line()` returns:
`size_t n; if (usb && (n = csi_frame_line(line, sizeof(line), frame, len)) > 0) { usb_write_line(line, n); s_usb_sent++; }`
(or equivalent in the file's style). Do **not** change `csi_frame_line()` (host-tested),
the watchdog config, task priorities or affinity.

Alternatives compared (critic):
- `vTaskDelay(1)` per packet: with the FreeRTOS tick this caps CSI near the tick rate
  and adds latency; hides the cost. Rejected.
- One `fwrite`/`fputs` of the whole line: still goes through `uart_write()`'s
  per-character loop. No gain. Rejected.
- Disabling `CHECK_IDLE_TASK_CPU0` or pinning to core 1: hides or moves the
  starvation. Rejected.
- Chosen: two `uart_write_bytes` calls (line + `\r\n`), both under the stdout lock so
  nothing comes between them; 2 ring items per line instead of ~1200.
  `uart_write_bytes` blocks when the 8 KB TX ring is full — same as today's `fputs`.

Acceptance: all four envs build (`esp32dev`, `esp32cam`, `esp32dev_tx`,
`esp32cam_tx`) with no new warnings in `stream.c`; host tests pass (`run.ps1`).
Report: **not flashed, not run on a board**; expected: no `task_wdt` warning,
`queue drops` 0, same or higher CSI rate; the owner checks with
`pio run -e esp32cam -t upload` + `pio device monitor` for 60 s.

### 2. Transmitter auto-detect (engine) — 15 min
Files: new `engine/lifefi/link.py`, `engine/lifefi/engine.py`,
`engine/config/rules.yaml`, new `engine/tests/test_link.py`.

1. `link.py` (pure Python, no numpy):
   ```python
   TX_PREFIX = "1a:4c:46:54:58"   # firmware/src/lifefi_config.h LIFEFI_TX_MAC_PREFIX
   def is_fixed_tx(src_mac) -> bool      # str or None; .lower().startswith(TX_PREFIX + ":")
   def transmitter_fixed(setting, src_mac) -> bool
       # setting is True -> True; setting is False -> False (YAML true/false/yes/no load as bools);
       # anything else ("auto", None/missing, junk, quoted "true", 1) -> is_fixed_tx(src_mac)
   ```
   Use `is True` / `is False` so ints and strings fall to auto; say so in the docstring.
2. `rules.yaml` (`position:` block): `transmitter_fixed: auto  # auto: from the frames' source MAC (Life-Fi TX 1A:4C:46:54:58:xx); true/false force it (e.g. a router bolted to the wall)`.
3. `engine.py`, only these three places:
   - `_transmitter_fixed()` →
     `link.transmitter_fixed((self.rules.get("position") or {}).get("transmitter_fixed", "auto"), (getattr(self, "hdr", None) or {}).get("src_mac"))`
     (`getattr` because `load_rules()` may run before `self.hdr` exists).
   - `feed()`, right after `self.hdr = hdr`:
     `fixed = self._transmitter_fixed()`; `if fixed != self.position.transmitter_fixed: self.position.transmitter_fixed = fixed`.
     Last frame wins: the firmware passes one source MAC at a time, so this cannot
     flap within a lock; a re-lock to the hotspot flips it back.
   - `status()` `device`: add `"src_mac": h["src_mac"]` and
     `"transmitter": "fixed" if link.is_fixed_tx(h["src_mac"]) else "other"`
     (`device` stays `None` before the first frame; health reads that as unknown).
4. `test_link.py` (script style like the others: `check()` + exit code, < 30 s):
   `is_fixed_tx` on upper/lower/None/hotspot MAC/a truncated prefix;
   `transmitter_fixed` with `True`/`False`/`"auto"`/`None`/`"true"` (string → auto)/`1`;
   YAML round-trip `yaml.safe_load("a: auto\nb: true\nc: false")` → `"auto"`/`True`/`False`
   resolve correctly; an `Engine` fed a few hundred `scenarios` packets with the 6 MAC
   bytes patched (unpack/repack with the `csi_recorder` header struct; if using a byte
   offset, assert it against the struct): hotspot → `position.transmitter_fixed` false
   and `"transmitter_not_fixed"` in `position.quality(...)["quality_reasons"]`; LFTX →
   true and that reason gone; back to hotspot (mixed stream) → false again;
   `status(now)["device"]["transmitter"]` matches each phase; with rules forced
   `False`, LFTX frames stay not fixed.

Acceptance: `test_link.py`, `test_position.py`, `test_engine.py`, `test_control.py`,
`test_replay_position.py`, `test_occupancy.py` pass. Replays of old (hotspot)
recordings still report `transmitter_not_fixed` — required.

### 3. Health: transmitter + vitals, informational only — 10 min
Files: `ui/src/server/health.ts`, `ui/test/health.test.ts`, `contracts/api.md`
(health section), `docs/ops/README.md`.
- `checks.board.transmitter: "fixed" | "other" | null` from
  `ctx.state.engineStatus?.device?.transmitter` (only those two strings, else `null`).
- `checks.vitals: { breathing: { valid: boolean; reason: string | null }; heart: { valid: boolean; reason: string | null } | null } | null`
  from `state.latest`, only when the result is < 10 s old (reuse the computed
  `ageMs`), else `null`; `heart` is `null` when the result has none; a missing
  `breathing.reason` → `null`. Copy values; invent no reason strings.
- **Neither field is read by `ok`, `ready` or `setup()`**: no new 503 path. Add a test
  asserting `ok`/`ready` are unchanged with `heart.valid=false` and
  `breathing.valid=false`.
- Update the existing "every field present" test's `toEqual` on `checks.board` (it now
  includes `transmitter: null`) and assert `checks.vitals` is `null` there; add tests:
  fixed / other / unknown transmitter; vitals present, heart absent, stale (> 10 s) →
  `null`.
- `contracts/api.md`: add both fields to the Health example/description, marked
  "informational, never affects ok/ready".

Acceptance: `npm run test -w ui`, `npm run typecheck`, `npm run lint` clean.

### 4. Log pruning while running + daily size cap — 8 min
Files: `scripts/start.mjs`, `docs/ops/README.md`.
- Move the prune loop into `prune()` (same regex `^lifefi-.*\.log$`, same 14 days,
  only `logDir`; try/catch around each `statSync`/`unlinkSync`). Call it at start and
  inside `out()` when `day()` differs from the remembered day.
- Keep `appendFileSync` (no stream, so no handle to lose; today's file is never 14
  days old, so it is never pruned).
- Cap `LOG_MAX_BYTES = 50 * 1024 * 1024` per day: counter initialised from `statSync`
  of today's file (0 if missing), reset on day change; at the cap append one line
  `[start] log cap (50 MB) reached: the rest of today goes to the console only` and
  stop appending until the day changes. Console output unchanged. No env var.

Acceptance: `node --check scripts/start.mjs`; review by reading. Do **not** start the
app (M/U may be running dev servers).

### 5. Docs + version — 5 min (do not cut)
- `firmware/src/lifefi_config.h` `LIFEFI_FW_VERSION "0.1.0"` → `"0.1.1"` (the boot log
  tells the re-flashed build apart; the TX shares it — fine).
- `docs/hardware/fixed-transmitter.md`: the engine detects the transmitter from the
  frame MAC (`transmitter_fixed: auto`); `true`/`false` only force it; re-flash the
  receiver for the 0.1.1 watchdog fix.
- `docs/ops/README.md`: health fields (step 3); log policy ("logs older than 14 days
  are deleted at start and at midnight; at most 50 MB per day"); Troubleshooting:
  "`task_wdt` / IDLE0 warnings on the board: fixed in firmware 0.1.1, re-flash".

### 6. ✂ CI firmware job (unverified tonight) — 5 min
`.github/workflows/ci.yml`, new job `firmware` (ubuntu-latest): checkout;
`actions/setup-python@v5` 3.12; `actions/cache@v4` on `~/.platformio` and
`firmware/.pio`, key `pio-${{ hashFiles('firmware/platformio.ini') }}`;
`pip install platformio`;
`pio run -d firmware -e esp32dev -e esp32cam -e esp32dev_tx -e esp32cam_tx`;
`sh firmware/test/host/run.sh`. Triggers unchanged. Mark it **unverified** in the
report and in a YAML comment (CI cannot run tonight). Parse-check the YAML with a
node YAML parser if one is in `node_modules`, else by eye.

### CUT tonight
- **Distance fit from ≥ 2 distances** (planner's step 5): changes position semantics
  with no real data to validate it. Not built; listed in OPEN-QUESTIONS.
- `/teach` default transmitter: a note in the report only (U's files): the page can
  default from `/api/v1/health` `checks.board.transmitter`.
- `npm run build` + `npm run start` smoke: only if every step above is done **and**
  `Get-NetTCPConnection -LocalPort 3000 -State Listen` shows nothing; use
  `LIFEFI_PORT=3100 LIFEFI_ENGINE_PORT=6100 LIFEFI_DATA_DIR=<scratch dir>` and a
  replay; stop the process tree afterwards.

## Checks before finishing
```bash
.venv/Scripts/python.exe engine/tests/test_link.py
.venv/Scripts/python.exe engine/tests/test_position.py
.venv/Scripts/python.exe engine/tests/test_engine.py
npm test                    # contracts + every engine/ml test + vitest
npm run typecheck && npm run lint
node --check scripts/start.mjs
```
```powershell
$pio = "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe"
& $pio run -d firmware -e esp32dev; & $pio run -d firmware -e esp32cam
& $pio run -d firmware -e esp32dev_tx; & $pio run -d firmware -e esp32cam_tx
powershell -ExecutionPolicy Bypass -File firmware\test\host\run.ps1
```
Never `-t upload`.

## At the end: OPEN-QUESTIONS.md
Append a "Track P" section to `docs/overnight/2026-11-04/OPEN-QUESTIONS.md`, each item
with the default that was built:
1. `transmitter_fixed` is `auto|true|false` — **built: `auto`**; force `true` for a
   router used as the fixed transmitter (it has no LFTX MAC).
2. Firmware 0.1.1 watchdog fix is compile-only — **re-flash the receiver and watch the
   monitor 60 s** (no `task_wdt`, `queue drops 0`, `@CSI` lines still parse).
3. Log cap — **built: 50 MB/day, 14 days kept** (≤ 700 MB).
4. Health vitals/transmitter — **built: informational, never red/503**.
5. CI firmware job — **built (if not cut), unverified; triggers stay `main`/`dev`/PR**.
6. Distance fit at ≥ 2 distances — **cut tonight**; `medium` position quality stays
   unreachable without hand-editing `position.json`.
7. `results.schema.json` text for `transmitter_not_fixed` still says "rules.yaml …
   is false" — **left unchanged** (contract frozen tonight); reword with the next
   contract change.

## Risks
- `engine.py` merge with V: only the three P edits; re-run `test_engine.py` after.
- Firmware is compile-verified only. stderr writers and `esp_rom_printf`
  (panic/assert paths) bypass the stdout lock and could still splice into a line —
  same as today; acceptable.
- `uart_is_driver_installed` false (driver install failed) → falls back to `fputs`
  (old behaviour and cost).

## Time
1: 15 · 2: 15 · 3: 10 · 4: 8 · 5: 5 → 53 min; 6 (5) if time is left.

## Critic revisions
1. **Firmware line ending**: the planner's version wrote `line` (ending `\n`) raw and
   would have dropped the `\r` the VFS adds (`CONFIG_LIBC_STDOUT_LINE_ENDING_CRLF=y`).
   The parser tolerates it, but the orchestrator required byte-identical output: the
   helper now writes `n-1` bytes + `"\r\n"`, both under the stdout lock. Verified in
   IDF 5.5.0: the per-character VFS loop, log v1 printing through `vprintf` on the
   shared stdout FILE, and the lock order (no deadlock with ESP_LOG or the command
   reader, which uses `uart_read_bytes`). Baud 921 600 checked: ~65 % link use at
   100 Hz. Compared `vTaskDelay` and a single `fwrite` and recorded why they are worse.
2. **Firmware moved to step 1** (largest owner pain, independent of V's engine work).
   Version bump to 0.1.1 made mandatory.
3. **Transmitter parse made explicit**: `is True`/`is False`, everything else auto
   (quoted `"true"`, `1`, junk); YAML round-trip test added; `getattr(self, "hdr",
   None)` guard because `load_rules()` may run before the header exists; recorded the
   firmware's per-MAC CSI filter (why "last frame wins" cannot flap); added
   mixed-stream and forced-`false` tests; `test_occupancy.py` added to acceptance.
4. **Health**: explicit "never read by ok/ready/setup" with a test for it; flagged that
   the existing `toEqual` on `checks.board` must be updated.
5. **Logs**: keep `appendFileSync` (no handle to lose), try/catch per unlink, no env
   var; scope limited to `<dataDir>/logs`.
6. **Orchestrator decisions folded in**: the worker may edit `contracts/api.md`
   (health only); distance fit **cut**; CI firmware job kept as ✂, cached, marked
   unverified; OPEN-QUESTIONS appended at the end with the built defaults; schema
   description left frozen (new question 7). Ownership list narrowed to the exact
   files touched.
