# Track C: production readiness (plan, final after critic)

Planner, 2026-11-03; revised by the critic. **This is the worker's plan.** Worker budget: **≤ 2.5 h**.

## Critic revisions

Claims checked against the code: `config.ts`, `http.ts`, `runtime.ts`, `watchdog.ts`,
`validate.ts`, `settings.ts`, `history.ts`, `sources.py`, `run.py`, `ci.yml`,
`contracts/api.md`, Next 16.4 CLI docs (`next start -H` default is `0.0.0.0`).

1. **Budget.** The planner's items summed to ~190 min. Re-ordered and cut so
   P1 ≈ 2 h: JSON log format cut (H keeps only the log-file tee, now inside A,
   P3); runbook shortened; `version` from package.json cut; history distance
   (Track B ask 5) deferred. Every item must leave build/tsc/lint/vitest green
   before the next one starts (§5 checks after each item, not only at the end).
2. **Default bind = `127.0.0.1`, not `0.0.0.0`.** Reads are open (live presence
   of people in a care room is personal data); opening the LAN is an explicit
   choice: `LIFEFI_HOST=0.0.0.0`. To make it discoverable, `/setup` gets an
   optional `lan` step and the runbook's First-run section says to set it for
   phones / ntfy ack links. `npm run dev` is untouched (still `next dev`, its own default).
3. **Config must never throw at import.** `export const config = loadConfig()`
   throwing would break every module that imports `config`/`repoRoot`
   (validate.ts, all routes) with Next's HTML 500, and could break `next build`
   and `npm run dev`. Now: `loadConfig()` returns `{...config, problems: string[]}`
   with safe fallbacks; `runtime.start()` throws `ConfigError` when `problems`
   is non-empty; `instrumentation.ts` catches and logs it (server stays up,
   API answers `500 {"error":"config"}` via D) instead of crashing boot into a
   supervisor restart loop.
4. **Supervisor exit rules (Windows).** Exit `0` (run.py's KeyboardInterrupt
   path) and `3221225786` / `-1073741510` (`STATUS_CONTROL_C_EXIT`) mean "stopped
   on purpose" → no restart, shut down. Ctrl+C reaches the children before the
   parent's handler may run; without this rule the supervisor races and
   restarts the engine during shutdown. Hard stop on Windows uses
   `taskkill /pid <pid> /T /F` (kills the tree; `child.kill()` does not).
   Backoff does not spin with the board unplugged: `SerialSource.run()` already
   retries every 2 s *inside* the engine, which stays up and connected; the
   engine only exits on a crash or port 6000 busy (then backoff caps at 30 s
   and the preflight catches the usual case: an orphan engine).
5. **Health/setup shapes tightened** (C below): dropped `data_dir` (absolute
   path to the LAN, no use for the UI), dropped duplicate `engine.connected`,
   `board.last_result_ms` (already in `/status`); kept `result_age_s` (server
   clock, immune to phone clock skew). Fixed the `calibration.state` null case.
   Added setup step `lan`. Both shapes are frozen once landed.
6. **D bounds must not change existing behaviour:** `position/fit` keeps its
   current `d_m` range 0.3–8 (the planner's 0.2–20 widened it); only `seconds`
   gets 5–120.
7. **PIN limiter:** route handlers get a plain `Request` (no client IP in Next
   16), so one global bucket. Planner's flat 5/60 s still allows a 4-digit
   PIN to fall in about a day; now lockout doubles each time (60 s → 1 h cap),
   reset on a correct PIN. Restarting the server clears it (runbook).
8. **Track B asks** (orchestrator, folded in as new items J–L):
   - Ask 4 (`sensor_offline` at start): **real but minor.** The watchdog's 10 s
     grace runs from construction; with `start.mjs` starting engine and app
     together, a cold Python import (numpy/scipy/onnxruntime) on Windows can
     take > 10 s, so a false `sensor_offline` (and ntfy push) can fire at every
     boot. Fix: 30 s start-up grace (J, P1, 10 min). After that, raising it when
     the engine never came up, or the board is unplugged, is correct and stays.
   - Asks 2+3: one read route `GET /api/v1/position` with the saved fit and the
     spot model summary (K, P2).
   - Ask 1: room size + sensor/transmitter position in settings (L, P2).
   - Ask 5 (distance in history): **deferred** — needs a SQLite column
     migration in `store.ts`; not worth the risk tonight. In OPEN-QUESTIONS.
   - Validator vs Track A's new optional `position` fields: `validate.ts`
     compiles `contracts/results.schema.json` with `strict: true`, and
     `position` has `"additionalProperties": false`. Unknown fields **are
     rejected** and the server drops the whole result. That is the contract
     working as designed: Track A must add each new field to the schema
     (optional, not in `required`) in the same change, and regenerate
     `contracts.gen.ts`. Track C does not loosen the validator. Orchestrator:
     tell Track A.
9. **CI:** python job needs `actions/setup-node` for `test-all.mjs`; any engine
   test reading `data/` (gitignored, absent on CI) must print `SKIPPED` and exit 0
   — the worker greps `engine/tests ml/tests` for `data/` before switching CI.
10. Touched-files list made explicit (§6), incl. `contracts/api.md` and
   `ui/src/server/watchdog.ts`.
Scope: a local appliance (one Windows PC, the ESP32 on USB, phones on the LAN),
not a cloud service. No Docker, no new runtime dependencies unless stated.

## 0. Where we are (measured, not assumed)

| Check | Result |
|---|---|
| `npm run build -w ui` | **passes** (Next 16.4.3, Turbopack). 1 warning: `validate.ts:17` dynamic `readFileSync(join(repoRoot, …))` makes NFT trace the whole project. `ExperimentalWarning: SQLite` printed once per build worker (import of `node:sqlite` only; the runtime does **not** start during build, no `[lifefi` log lines). |
| `npx tsc --noEmit` (ui) | **passes** |
| `npm run lint -w ui` | 0 errors, **1 warning** (`settings.ts:52` unused `_profile`) |
| vitest | 65 passing (per orchestrator) |
| CI | **exists**: `.github/workflows/ci.yml` (contracts, gen-types drift, vitest, lint/build/typecheck on Node 24; engine script tests on Python 3.12). The README brief said it was missing; it is not. Gaps listed in §6. |

What is already good and must be kept: engine client reconnects every 1 s; the
watchdog raises `sensor_offline` after a 10 s grace; results are schema-checked
and dropped if bad; SQLite runs WAL + `synchronous=NORMAL`; history/alerts are
purged hourly by `retention_days`; writes need `X-Lifefi-Pin` (custom header ⇒
browsers must preflight ⇒ cross-site POSTs are blocked, since no route answers
CORS); ntfy ack uses one-time tokens, never the PIN; the engine binds 127.0.0.1.

What is missing for "production":

1. `npm run start` = `concurrently` of `dev:engine` + `next start`: no build
   check, no preflight, no engine restart, binds Next on 0.0.0.0 implicitly, no
   log file.
2. No health/readiness or first-run "setup status" route.
3. Config (`config.ts`) is never validated: `LIFEFI_ENGINE_PORT=abc` → `NaN`,
   silent; default PIN `1234` is used forever with no warning.
4. Route handlers: an unexpected throw returns Next's HTML 500, not the
   contract's error JSON; malformed JSON bodies are treated as `{}`; some
   numbers are unbounded (`calibrate.duration_s`, `source.speed`); `PUT /source`
   passes any path on disk to the engine as a replay file.
5. PIN: stored in plain text in `data/settings.json`, compared with `===`, no
   brute-force limit (4 digits = 10 000 tries).
6. Logs are human text only; nothing on disk after a crash.
7. No single "run every test" command; engine tests listed by hand in CI
   (a new `test_*.py` is silently skipped).
8. No ops runbook.

## 1. Priorities

P1 = must land tonight; P2 = should; P3 = only if time is left. Order of work = order below.

| # | Item | Pri | Est |
|---|---|---|---|
| A | Production start: `scripts/start.mjs` supervisor | P1 | 40 min |
| B | Config validation (never throws at import) | P1 | 10 min |
| C | `GET /api/v1/health` + `GET /api/v1/setup` (+ contracts/api.md) | P1 | 30 min |
| J | Watchdog 30 s start-up grace | P1 | 10 min |
| D | Consistent error JSON + input bounds | P1 | 20 min |
| E | One test command `scripts/test-all.mjs` + CI update | P1 | 20 min |
| F | Ops runbook `docs/ops/README.md` (short) | P1 | 15 min |
| G | PIN hardening (limiter, constant-time, default warning) | P2 | 15 min |
| K | `GET /api/v1/position` (saved fit + spot model summary) | P2 | 15 min |
| L | Room geometry in settings | P2 | 15 min |
| H | Log file tee in `start.mjs` (no JSON format) | P3 | 10 min |
| I | Small fixes: lint warning, NFT trace warning | P3 | 10 min |

Deferred (OPEN-QUESTIONS): distance in history rows; PIN hashing; Windows CI matrix; JSON logs.

## 2. Items

### A. Production start path (P1)

**Files:** new `scripts/start.mjs`; root `package.json`; `scripts/engine.mjs`
(extract the python lookup into a tiny shared `scripts/python.mjs` so both use it).

`npm run start` → `node scripts/start.mjs [engine/run.py args…]`. Keep
`npm run dev` exactly as it is (the UI track uses it). Remove
`concurrently` from `start` only.

`start.mjs` does, in order:

1. **Preflight**, each failure prints one line `start: <what is wrong> — <how to fix>` and exits 1 *before* spawning anything:
   - Node ≥ 22.13 (`node:sqlite` unflagged).
   - `ui/.next/BUILD_ID` exists → else "run `npm run build` first".
   - Python found (`.venv` first, same rule as `engine.mjs`) and
     `python -c "import numpy, scipy, yaml, serial"` succeeds → else
     "pip install -r engine/requirements.txt".
   - `LIFEFI_PORT` (default 3000) is free on `LIFEFI_HOST` (try `net.createServer().listen`), and engine port 6000 is free on 127.0.0.1 (a leftover engine is the classic failure).
   - Data dir (`LIFEFI_DATA_DIR`, default `data/`) exists or can be created, and is writable (write+delete a temp file).
2. **Engine child** (`python -u engine/run.py …args`, cwd repo root), **supervised**:
   - exit code 2 (argparse/config error, run.py returns 2) → do **not** restart; print and stop everything with exit 2.
   - exit code 0 or `STATUS_CONTROL_C_EXIT` (3221225786, or -1073741510 signed) or
     any exit while `stopping` → treat as a deliberate stop: do not restart; begin shutdown of the other child.
   - any other exit while we are not shutting down → restart with backoff 1, 2, 4, 8, 16, 30 s (cap 30 s); reset the backoff after the child has run 60 s. Log each restart with exit code and the next delay.
   - No restart storm guard beyond the cap: the app shows `sensor_offline` meanwhile, which is the right user-facing signal.
3. **App child**: `node ui/node_modules/next/dist/bin/next start -p $LIFEFI_PORT -H $LIFEFI_HOST` with cwd `ui/` (resolve the bin via `createRequire(ui/package.json).resolve("next/dist/bin/next")`, not `npx`, so Windows has no `.cmd` shim / shell). If the app exits unexpectedly, restart it with the same backoff (it is the alert path; it must come back).
4. **Prefix child output** with `[engine]` / `[app]` line by line (readline on piped stdout/stderr). (Log file: item H, P3.)
5. **Graceful shutdown** on SIGINT/SIGTERM (and `SIGBREAK` on Windows): set `stopping`
   (set it first, synchronously, before anything else), on POSIX send
   `child.kill("SIGINT")`; on Windows rely on the console Ctrl+C that the
   children already got, wait ≤ 10 s for both `exit`, then force: POSIX
   `kill("SIGKILL")`, Windows `spawnSync("taskkill", ["/pid", pid, "/T", "/F"])`
   (kills the whole tree; `child.kill()` is TerminateProcess on the one PID only).
   Spawn children with `windowsHide: true`, no `shell`. Data is safe on a hard
   kill: SQLite WAL + NORMAL loses at most the last transaction.
   Do not use `detached`; the children must stay in the console group so Ctrl+C reaches them.

Env read by `start.mjs`: `LIFEFI_HOST` (default **`127.0.0.1`**; set
`0.0.0.0` so phones on the LAN reach the dashboard and ntfy ack links),
`LIFEFI_PORT` (3000), plus the `LIFEFI_*` the backend reads. `start.mjs` passes
`LIFEFI_HOST` (resolved, with the default) into the app child's env so the
backend can report it in `/setup` (`lan` step).

Root `package.json` scripts afterwards:
```
"start": "node scripts/start.mjs",
"start:engine": "node scripts/engine.mjs",      // = dev:engine, kept for clarity
"test": "node scripts/test-all.mjs",
"test:ui": "npm run test -w ui",
"test:engine": "node scripts/test-all.mjs --only engine",
"typecheck": "npm run typecheck -w ui",
"check": "npm run lint && npm run typecheck && npm test"
```

**Acceptance**
- With no `ui/.next`: `npm run start` exits 1 with the "run npm run build first" line, nothing spawned.
- After `npm run build`: `LIFEFI_PORT=3100 npm run start -- --replay firmware/recordings/<one>.csirec --loop` serves `http://127.0.0.1:3100/api/v1/health` with `engine.connected=true` within 10 s.
- Kill the python process by PID (`Stop-Process`): log shows `engine exited (code …), restarting in 1 s`; health shows engine connected again within ~3 s.
- `npm run start -- --bogus-flag` exits 2 without a restart loop.
- Ctrl+C: both children gone (`Get-Process python, node` shows none from this tree), ports 3100/6000 free.
- Stop the server afterwards (rule 7: port 3100, stop when done).

### B. Config validation (P1)

**File:** `ui/src/server/config.ts` (+ `ui/test/config.test.ts`).

Turn `config` into `loadConfig(env = process.env): Config` returning the same
fields **plus `problems: string[]`**, and a module-level `export const config =
loadConfig()` so callers do not change. `loadConfig` **never throws**: a bad
value gets its default (e.g. port 6000) and a line in `problems`. `runtime.ts`
`start()` throws one `ConfigError` when `problems.length > 0`, message:

```
life-fi: invalid configuration
  - LIFEFI_ENGINE_PORT must be an integer 1-65535 (got "abc")
  - LIFEFI_PROFILES: file not found: E:\…\profiles.yml
```

Rules: `LIFEFI_ENGINE_PORT` integer 1–65535; `LIFEFI_PIN` empty or 4–8 digits
(same rule as `PUT /settings`); `LIFEFI_LOG` ∈ debug|info|warn|error;
`LIFEFI_PROFILES` exists; `LIFEFI_HOST` (new field `bindHost`, default
`"0.0.0.0"` when unset because that is `next dev`'s default; `start.mjs` always sets it).
Also fix the `dbPath` default to use the resolved `dataDir` (today it
re-reads the env unresolved). Keep `version: "0.1.0"` as is.

`instrumentation.ts`: wrap `getRuntime()` in try/catch and `console.error`
the message (so `next start`/`next dev` boot is never killed by config).
`getRuntime()` must not cache a failed start (the `??=` already only assigns
on success). Every API call then answers `500 {"error":"config"}` via item D.
`start.mjs` preflight does not duplicate these rules; it only checks paths/ports.

**Acceptance:** unit tests on `loadConfig({...})` (valid defaults → `problems`
empty; two bad vars → two problems, both named). `LIFEFI_ENGINE_PORT=abc` on
the port-3100 run shows the list in `[app]` output and `/api/v1/health` answers
500 JSON, not HTML.

### C. Health and setup routes (P1)

**Files:** new `ui/src/server/health.ts` (pure functions over `AppContext` +
an injectable `now`), `ui/src/app/api/v1/health/route.ts`,
`ui/src/app/api/v1/setup/route.ts`, `ui/test/health.test.ts`,
`contracts/api.md` (two rows + shapes; this file is unowned, Track C is the API
owner by extension — report it).

Both are reads (no PIN), `dynamic = "force-dynamic"`, `Cache-Control: no-store`.

#### `GET /api/v1/health` (frozen shape)

HTTP **200 when `ok`**, **503 otherwise**; the body is the same either way
(UI: read the body, do not treat 503 as a network error).

```json
{
  "ok": true,
  "ready": false,
  "version": "0.1.0",
  "uptime_s": 812,
  "checks": {
    "engine":      { "ok": true },
    "board":       { "ok": false, "source": "live", "result_age_s": null, "rate_hz": null,
                     "error": "no USB serial port found" },
    "calibration": { "ok": false, "state": "none", "id": null, "age_s": null },
    "storage":     { "ok": true, "db_bytes": 1048576, "free_bytes": 52428800000 }
  }
}
```

Types (every field always present; unknown = `null`):
`ok`, `ready`: boolean · `version`: string · `uptime_s`: integer ·
`board.source`: `"live" | "replay"` · `board.result_age_s`: number (1 decimal) | null ·
`board.rate_hz`: number | null · `board.error`: string | null ·
`calibration.state`: `"none" | "running" | "ok" | "stale" | null` ·
`calibration.id`: string | null · `calibration.age_s`: integer | null ·
`storage.db_bytes`: integer · `storage.free_bytes`: integer | null.

Definitions:
- `uptime_s` = whole seconds since `state.startedAt`.
- `engine.ok` = `ctx.engine.connected` (EngineClient).
- `board.source` = `state.source.mode`; `result_age_s` = seconds since
  `state.lastResultAt` or `null`; `rate_hz` = `state.latest.health.rate_hz`
  when the result is < 10 s old, else `null`; `error` = `state.source.error`.
  `board.ok` = `engine.ok` **and** result age < 5 s **and** `!watchdog.isOffline`.
- `calibration` from `state.latest.calibration` (schema enum none|running|ok|stale),
  else `state.engineStatus?.engine?.calibration` if it has the same shape, else all `null`.
  `age_s` from the calibration's own timestamp if present, else `null`. `ok` = `state === "ok"`.
- `storage`: `db_bytes` = size of the sqlite file + `-wal` (0 for `:memory:` or
  missing); `free_bytes` = `fs.statfsSync(dataDir)` `bavail * bsize` (null if it throws);
  `ok` = data dir writable (write+unlink a probe file, result cached 60 s)
  **and** (`free_bytes` null or > 500 MB).
- top-level `ok` = `engine.ok && storage.ok` (the server can do its job);
  `ready` = `ok && board.ok` (people are actually being sensed).
  Calibration never fails `ok`/`ready`: it is a setup step, not an outage.

#### `GET /api/v1/setup` (for Track B's first-run flow, frozen shape)

HTTP 200 always.

```json
{
  "complete": false,
  "steps": [
    { "id": "engine",      "done": true,  "optional": false, "detail": null },
    { "id": "board",       "done": false, "optional": false, "detail": "no USB serial port found" },
    { "id": "pin",         "done": false, "optional": false, "detail": "the PIN is still the default" },
    { "id": "calibration", "done": false, "optional": false, "detail": "no empty-room calibration yet" },
    { "id": "notify",      "done": false, "optional": true,  "detail": "no ntfy topic set" },
    { "id": "lan",         "done": false, "optional": true,  "detail": "only this PC can open the dashboard (set LIFEFI_HOST=0.0.0.0)" }
  ]
}
```

- `steps` is always these six ids **in this order**; `detail` is a short
  English reason when not done, else `null`. The UI owns wording/translation;
  it must key on `id`, never on `detail`.
- `engine.done` = engine connected (detail `"the engine is not running"`).
- `board.done` = health `board.ok` and source `live`; in replay mode `false`
  with detail `"replaying a recording, not the board"`; otherwise detail =
  `state.source.error` or `"no data from the board"`.
- `pin.done` = PIN ≠ `DEFAULT_PIN` (`"1234"`, exported from `config.ts`).
- `calibration.done` = state `ok`; `stale` → detail
  `"calibration is stale: redo it with the room empty"`; `running` → `"calibration running"`.
- `notify.done` = `settings.notify.topic` non-empty.
- `lan.done` = `config.bindHost` is not a loopback address (`127.0.0.1`, `::1`, `localhost`).
- `complete` = every non-optional step done.

Document both in `contracts/api.md`: two rows in the Endpoints table plus
`### Health` and `### Setup` sections in the same style as `Status`.

**Acceptance:** `health.test.ts` covers: engine down → 503, `ok=false`;
engine up + no result → 200, `ready=false`; fresh result + watchdog online →
`ready=true`; stale result (> 5 s) → `ready=false`; setup with default PIN →
`pin.done=false`, `complete=false`; all non-optional done → `complete=true`;
step ids/order exactly as above. Live check against the replay run from A:
`curl -s localhost:3100/api/v1/health` shows `board.ok=true` while replaying
(source `replay`), and `setup` shows `board.done=false` with the replay detail.

### D. Consistent errors and input bounds (P1)

**Files:** `ui/src/server/http.ts`, routes under `ui/src/app/api/v1/**`,
`ui/test/http.test.ts`, `contracts/api.md` (Errors section).

- `read()`/`write()` wrap the handler in try/catch: unexpected errors →
  `log.error({ err: stack, path })` and `fail(500, "internal", "unexpected server error")`
  (never the stack in the response). `EngineError` thrown out of a handler →
  `engineFail`. Also wrap `getRuntime()` so a `ConfigError` gives
  `500 {"error":"config","message":<the list>}` (a LAN appliance: showing the config problem is more useful than hiding it).
- `readBody`: a body that is present but not valid JSON → `400 bad_request
  "body is not valid JSON"` (make it return `Body | Response`, or add
  `readJson()` and switch the write routes to it; keep `{}` for empty bodies).
  Reject `content-length` > 64 KB with `413 {"error":"bad_request"}` (writes only).
- The SSE route `/live` must keep streaming: the try/catch covers creating the
  `Response`, never the stream itself. Check `/live` with `curl -N` on the 3100 run after D.
  Keep `engineFail` working for the existing `catch (err) { return engineFail(err) }` call sites.
- Bounds: `calibrate.duration_s` finite, 10–1800; `source.speed` finite,
  0.1–20; `position/fit` keeps its current `d_m` check (0.3–8, unchanged),
  `seconds` finite 5–120 (default 25 stays); `settings.retention_days` ≤ 3650;
  `alerts?state=` unknown values → 400.
- `PUT /source` replay `file`: resolve it and require it to be inside
  `firmware/recordings/` or `<dataDir>/sessions/` and to end in `.csirec`;
  else `400 bad_request`. (The engine reads whatever path it is given.)
- Add codes `internal`, `config`, `rate_limited` to `contracts/api.md` Errors.

**Acceptance:** tests: handler throwing → 500 JSON with `error:"internal"`;
malformed JSON → 400; `PUT /source` with `../../Windows/win.ini` → 400;
existing 65 tests still pass.

### E. One test command + CI (P1)

**Files:** new `scripts/test-all.mjs`; `.github/workflows/ci.yml`; root `package.json`.

`node scripts/test-all.mjs [--only contracts|engine|ui] [--full]`:
1. contracts: `node scripts/check-contracts.mjs`.
2. engine: every `engine/tests/test_*.py` and `ml/tests/test_*.py`
   (glob, sorted), each run as its own process with the shared python lookup,
   cwd = repo root, 120 s timeout each; print `PASS/FAIL/SKIP name (s)`; a
   script whose output contains `SKIPPED` counts as SKIP.
3. ui: `npm run test -w ui` (vitest).
4. `--full` adds `npm run lint -w ui`, `npm run build -w ui`, `npm run typecheck -w ui` (build first, as CI does).

Runs every step even after a failure, prints a summary table, exits 1 if
anything failed. No pytest (the scripts `sys.exit` at module level).

CI changes (keep the two jobs):
- python job: replace the hand-written list with `node scripts/test-all.mjs --only engine`
  (add `actions/setup-node`), `cache: pip` with `cache-dependency-path: engine/requirements.txt`,
  install from `engine/requirements.txt` (it now also has `onnxruntime`, so
  `test_features_vectors` runs when vectors exist; if onnxruntime install fails
  on the runner, fall back to the current explicit pins and say so).
- portal job: add `npm run check:contracts` stays; add `workflow_dispatch`;
  add a `concurrency` group that cancels superseded runs.
- Before switching CI, grep `engine/tests ml/tests` for reads of `data/` or
  `firmware/recordings/`: any test that needs a gitignored file must print
  `… SKIPPED: <why>` and exit 0 when it is missing (CI has no `data/`). If such a
  test is Track A's file, report it instead of editing it.
- Do **not** add a Windows matrix tonight (P3 idea in OPEN-QUESTIONS).
- Validate the YAML locally (`node -e "require('yaml').parse(...)"` via ui's `yaml` dep). CI cannot be run from here; say so in the report.

**Acceptance:** `npm test` from the repo root runs all three parts locally on
Windows and exits 0 (engine scripts that need datasets report SKIP, not FAIL).

### F. Ops runbook (P1)

**Files:** new `docs/ops/README.md` (one file, ≤ ~250 lines); link it from
root `README.md` (one line under setup).

Sections: **Install** (Node ≥ 22.13, Python 3.12, `python -m venv .venv`,
`pip install -r engine/requirements.txt`, `npm ci`, `npm run build`, CH340/CP210x
driver) · **Run** (`npm run start`, flags pass through to `engine/run.py`,
`LIFEFI_*` env table: name, default, meaning — this replaces a root
`.env.example`, which no track owns) · **Autostart on Windows** (Task Scheduler
"At log on", action `npm.cmd run start` in the repo dir, "restart on failure";
no NSSM dependency) · **First run** (the default binds `127.0.0.1`: set
`LIFEFI_HOST=0.0.0.0` so phones and ntfy ack links reach it, and set
`dashboard_url` in settings; open `http://<pc-ip>:3000`, change the PIN,
calibrate the empty room, set ntfy topic; `/api/v1/setup` lists what is left)
· **Health** (`/api/v1/health`, meaning of 200/503 and each check) ·
**Update** (stop, `git pull`, `npm ci`, `pip install -r …`, `npm run build`, start;
the data dir survives) · **Back up / restore** (stop first or use
`sqlite3 .backup`; copy `data/` — `lifefi.sqlite*`, `settings.json` (contains the PIN),
`calibration.json`, `position.json`, `spots_model.json`, `sessions/`) ·
**Data growth** (history/alerts purged by `retention_days`; recordings under
`data/sessions/` are **never** deleted automatically, they are training data;
check `storage.free_bytes`) · **Troubleshooting** (board not found: Device
Manager → Ports, cable, close Arduino/PlatformIO serial monitor, `--serial COM3`;
port 6000/3000 busy: find PID with `Get-NetTCPConnection -LocalPort 6000`;
`sensor_offline` alert meaning; engine restart loop; config error list;
logs location from H) · **Security notes** (dashboard is LAN-only, no HTTPS,
do not port-forward it; engine control port is loopback-only and has no auth;
the PIN guards writes only — reads are open on the LAN by design).

**Acceptance:** every command in the runbook was run once tonight (except
driver install, Task Scheduler, and anything needing the board — mark those
"not verified tonight").

### G. PIN hardening (P2)

**Files:** `ui/src/server/settings.ts`, `ui/src/server/http.ts`, `ui/test/settings.test.ts`.

- `checkPin`: constant-time compare (`crypto.timingSafeEqual` on equal-length
  buffers; length mismatch → false).
- Failed-PIN limiter in `http.ts` (a small class with injectable `now`, so it
  is testable): **one global bucket** (route handlers get a plain `Request`, no
  client IP in Next 16; `x-forwarded-for` is not trusted). After 5 failures
  within 60 s, every write answers `429 {"error":"rate_limited","message":"too many wrong PINs, try again in N s"}`
  with `Retry-After: N`; the lockout is 60 s and doubles on each further lockout
  (cap 3600 s). A correct PIN outside a lockout resets the count and the doubling.
  The ntfy ack token path does not go through the limiter.
- Log a `warn` at startup if the PIN is the default `"1234"`.
- Do **not** hash the PIN in `settings.json` tonight (migration + recovery
  story is owner-level; see OPEN-QUESTIONS). The runbook says the file holds it,
  and that restarting the app clears a lockout.

**Acceptance:** tests: 5 wrong PINs → 6th call 429 even with the right PIN;
after 60 s the right PIN works; a second lockout lasts 120 s.

### J. Watchdog start-up grace (P1, Track B ask 4)

**Files:** `ui/src/server/watchdog.ts`, `ui/test/watchdog.test.ts`.

Add option `startGraceMs` (default 30 000): until `now - createdAt >= startGraceMs`,
`tick()` raises nothing (same as the disconnect grace: `healthySince = null; return`).
After it, behaviour is unchanged (engine never connected → "engine
disconnected"; no board → "no result for 10 s" — both correct alerts).
Existing tests that rely on the 10 s timing pass `startGraceMs: 0`.
**Acceptance:** new test: engine never connects → no raise at 25 s, raise at 31 s.

### K. `GET /api/v1/position` (P2, Track B asks 2+3)

**Files:** new `ui/src/app/api/v1/position/route.ts` (sibling of `position/fit/`),
`ui/src/server/position-files.ts` (pure reader, injectable dir), test, `contracts/api.md`.
Read-only, no PIN. Reads `<dataDir>/position.json` and `<dataDir>/spots_model.json`
on each request (small files; the engine rewrites them); missing or unparsable → `null`.
Never returns the model weights (`mu`, `sd`, `W`, `b`, `shrink`).

```json
{
  "fit":   { "A": 16.13, "n": 2.0, "d_m": 2.0, "at": 1793463150102 },
  "spots": { "labels": ["close", "middle", "far", "empty"],
             "distances": { "close": 0.4, "middle": 1.2, "far": 2.2, "empty": null },
             "holdout_accuracy": 0.19, "session": "spots-…", "trained_at": 1793463150000 }
}
```

`at` / `trained_at` are converted to ms since epoch (the files hold seconds;
check the type of `trained_at` in the file and convert accordingly). Both
top-level fields are nullable. Note in api.md: the engine writes these files
next to its `--calibration` path (default `data/`), so a non-default
`LIFEFI_DATA_DIR` needs a matching `--calibration`.

### L. Room geometry in settings (P2, Track B ask 1)

**Files:** `ui/src/server/settings.ts`, `ui/src/app/api/v1/settings/route.ts`,
test, `contracts/api.md` (`Settings`).

New `Settings.room`, default `null`, returned by `GET /settings`, set by `PUT /settings`:

```json
"room": { "width_m": 4.0, "depth_m": 3.5,
          "sensor": { "x_m": 0.2, "y_m": 0.0 },
          "transmitter": { "x_m": 3.8, "y_m": 3.5 } | null }
```

Validation: width/depth finite 1–30; positions finite, inside the room
(0 ≤ x ≤ width, 0 ≤ y ≤ depth); `room: null` clears it; else 400 `bad_request`.
Origin = a corner of the room, x along the width, y along the depth. This is
for drawing to scale only; the engine does not use it (one link still gives
only a radius from the sensor — the UI must not invent a direction).

### H. Log file (P3)

**Files:** `scripts/start.mjs`.

- No JSON log format tonight (cut).
- `start.mjs` tees both children's prefixed output to
  `<dataDir>/logs/lifefi-YYYY-MM-DD.log` (append; new file at local midnight),
  and deletes `lifefi-*.log` older than 14 days at start. `*.log` and `data/`
  are already gitignored.

**Acceptance:** after a start/stop, today's log file exists and contains both `[engine]` and `[app]` lines.

### I. Small fixes (P3)

- `settings.ts:52` lint warning: `const { pin, profile, ...rest } = this.value; void profile;` or an eslint-disable line comment — whichever matches house style.
- `validate.ts` NFT warning: pass the schema path from `runtime.ts` and/or add
  `/* turbopackIgnore: true */` to the `join` call **only if** the Next 16.4 docs
  in `ui/node_modules/next/dist/docs/` document it; otherwise leave it and note it.
- Optional: suppress the `node:sqlite` ExperimentalWarning noise? **No** — leave it; hiding warnings is worse.

## 3. Out of scope (said on purpose)

Docker; HTTPS/TLS; user accounts; a reverse proxy; metrics/Prometheus;
automatic deletion of recordings; Windows service wrappers; touching
`engine/lifefi/control.py`'s protocol (contract owned jointly with Track A).

## 4. Cross-track notes for the orchestrator

- `contracts/api.md` gains `/health`, `/setup`, new error codes. Not in any
  track's table; Track C edits it (it documents C's routes).
- Track B can build the first-run flow on `GET /api/v1/setup` (shape above,
  frozen once the worker lands it) and a header health dot on
  `GET /api/v1/health` `ok`/`ready`. Neither exists in `/live`; poll ≤ every 5 s or
  derive from the `status` SSE message which already carries engine/source.
- No change to `npm run dev` (UI track runs it on port 3000).
- Track A: new optional fields in the result (e.g. `position.occupancy`,
  `position.quality`) **must be added to `contracts/results.schema.json` in the
  same change** — `position` has `additionalProperties: false` and the server
  validator drops any result with an unknown field. Track C will not loosen it.
- Track B: `GET /api/v1/position` (K) and `Settings.room` (L) land only if the
  worker reaches P2; B must handle their absence (404 / missing `room`).
- Deferred to OPEN-QUESTIONS: distance in `/history` rows (needs a SQLite
  migration), PIN hashing, Windows CI matrix.

## 5. Verification the worker reports

After **each** item: `cd ui; npx tsc --noEmit` and `npx vitest run`; before
moving past A, C, D and at the end also `npm run lint -w ui` and
`npm run build -w ui`. At the end: `npm test` (root), the replay start/kill/
restart/Ctrl+C session from A on port 3100, `curl -N` on `/live` for a few
seconds, curl output of `/health`, `/setup` (and `/position` if K landed).
Leave no process on 3100/6000.

## 6. Files the worker may touch

`scripts/start.mjs`, `scripts/python.mjs`, `scripts/engine.mjs`, `scripts/test-all.mjs`,
root `package.json`, `.github/workflows/ci.yml`, `ui/src/instrumentation.ts`,
`ui/src/server/{config,http,runtime,settings,watchdog,health,position-files,validate}.ts`,
`ui/src/app/api/v1/**` (incl. new `health/`, `setup/`, `position/route.ts`),
`ui/test/**`, `contracts/api.md` (outside the ownership table; Track C documents
its own routes there — report it), `docs/ops/README.md`, root `README.md` (one link),
`docs/overnight/OPEN-QUESTIONS.md` (append only).

## Worker report

**Shipped (every item, P1-P3):**
- A: `npm run start` = `scripts/start.mjs` (checks the setup first, supervises engine and app with 1 to 30 s backoff, exit 2 stops it, graceful/forced stop, binds `127.0.0.1` by default). The python lookup moved to `scripts/python.mjs`. `npm run dev` is unchanged.
- B: `loadConfig()` never throws; it returns `problems`. `runtime.start()` throws `ConfigError`, `instrumentation.ts` logs it and the API answers `500 {"error":"config"}`.
- C: `GET /api/v1/health` (plus `?soft=1` for B2's polling) and `GET /api/v1/setup`, both with the frozen shapes.
- J: the watchdog waits 30 s after start before it raises anything.
- D: every handler returns error JSON (`internal` / `config` / engine); malformed JSON gets 400, bodies over 64 KB get 413; added the bounds; replay paths are allowlisted (`replayPath` in recordings.ts); `/live` goes through `read()`.
- E: `scripts/test-all.mjs` (10 min timeout per script: test_engine alone takes about 5 min under load); CI uses it, with pip cache, `workflow_dispatch` and `concurrency`.
- F: `docs/ops/README.md`, linked from the root README.
- G: the PIN compare is constant time; one global limiter (5 wrong PINs locks writes for 60 s, doubling up to 1 h); a warning is logged while the PIN is the default.
- K: `GET /api/v1/position`. It returns `loso_bal_acc`, not `holdout_accuracy`, as track A asked.
- L: `Settings.room`.
- H: the log tee writes to `data/logs/` and keeps 14 days.
- I: the lint warning is fixed. The NFT trace warning is left as it is: `turbopackIgnore` is documented only for imports.

**Validator:** `validate.ts` compiles `results.schema.json` at start, so A's schema change is all it takes; it does need an app restart to load. The new `test/validate.test.ts` checks every fixture, including `position_quality.json`.

**Checks:** tsc clean, lint clean (0 warnings), vitest 12+ files pass, check-contracts ok, `npm test` 16 pass / 1 skip / 0 fail, `npm run build` passes (port 3000 was free).

**Live run on port 3100 with a replay:**
- health: ready=true; setup: board done=false with the replay reason; position works; SSE streams.
- Malformed JSON and `../../Windows/win.ini` both get 400.
- Killing the engine gave "restarting in 1 s" and it reconnected.
- `--bogus-flag` exits 2 with no restart.
- `LIFEFI_ENGINE_PORT=abc` makes the API answer 500 config JSON.
- After `taskkill /T` nothing is left running.

**Not verified:**
- A console Ctrl+C: it could not be sent from the agent shell.
- CI on GitHub.
- The board, the driver and Task Scheduler.

**Other tracks:** B can use `/setup`, `/health?soft=1`, `/position` and `Settings.room`. `contracts/api.md` was edited (outside the ownership table).
