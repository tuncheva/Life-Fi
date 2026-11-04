# Review: engine + firmware commits (cd11db8, 51d848a, 1315f22)

Independent reviewer, overnight run 2026-11-04. Read-only: no code edits, no git state changes, nothing flashed, app not started.

## What was run

- `npm test` (repo root): **19 passed, 1 skipped (test_features_vectors, dataset-only), 0 failed**, including `test_vitals.py` (94.5 s), `test_link.py`, `test_heart.py` and ui vitest. The ui/src/server/{store,history}.ts edits by the other worker did not fail vitest.
- `pio run -e esp32dev -e esp32cam -e esp32dev_tx -e esp32cam_tx`: all four **SUCCESS**.
- `firmware/test/host/run.ps1`: **ALL HOST TESTS PASSED**. stream.c is ESP-only, so no host test covers the new `usb_write_line`.
- Estimator probe: I ran `breathing.estimate_breathing` and `heart.estimate_heart` on constant and all-zero CSI. Neither raised an exception or returned a non-finite bpm, snr or confidence. The breathing ratio was NaN on all-zero input, and the new `_still()` correctly rejects that window.

No high-severity defect was found. Findings, most severe first:

## Findings

### 1. medium: breathing bpm from before a gap is published for up to ~7 s after it
`engine/lifefi/engine.py:379-381` (`breath_valid`). Verified by reading the code, not reproduced in a run.

- **Mechanism.** On a gap or a new `boot_id`, `tick()` sets `vitals_since = now` but keeps `self.breath` and `self.breath_at`, as the V plan notes. `breath_valid` only checks `now - breath_at <= 10` and `not warm`, and warm-up is just 3 s (`warmup_s`). `quiet_for` also counts the gap time as still.
- **Scenario.** A sitting person is shown at 14 /min. The board link drops for 2 s and comes back. From about 3 s after the gap until `breath_at + 10 s`, `breathing.valid` is true and `bpm` repeats the pre-gap window. At the same time, `_vitals_reason` already treats that window as stale (`breath_at < vitals_since` gives `warming_up`). The two code paths disagree.
- **Affected values.** Heart is not affected: `heart_hist` is cleared on the gap and needs a new window. The bpm values here are unchanged from before cd11db8, so this is pre-existing, but it falls in the "number after a gap" class this review was asked to hunt.
- **Fix.** Add `and self.breath_at >= self.vitals_since` to `breath_valid`. Alternatively, set `self.breath = None` on a segment change. Check `test_engine.py` timings afterwards.

### 2. medium: an automatic transmitter flip keeps calibration and fits taken with the old link
`engine/lifefi/engine.py:312-314` (`feed`).

- **Mechanism.** With `transmitter_fixed: auto`, swapping the phone hotspot for the Life-Fi TX clears `transmitter_not_fixed` on its own. Several things are not reset or marked:
  - the distance fit (`A`, `n`), measured with the phone's transmit power and position;
  - the empty calibration (`p_empty`, `pos_p50`/`pos_p95`), used by presence `S` and by the position gate;
  - the spot model's RSSI window (`self.rssi`, 10 s).
- **Scenario.** Once a two-distance fit exists, quality rises to `medium` while distances come from a fit made for another transmitter. Presence `S` also compares against an empty-room profile of another link. Today this is masked, because `fit_distances` is 1 and `no_distance_fit` keeps quality `low`.
- **Fix.**
  - Store `src_mac` (or `transmitter`) in calibration.json and position_fit.
  - On a flip or a mismatch, add a quality reason such as `calibration_other_transmitter` and ask for a re-calibration.
  - Clear `self.rssi` and call `position.reset()` when `fixed` changes.

### 3. low: `get_status.device.transmitter` ignores a forced `transmitter_fixed: true`
`engine/lifefi/engine.py:703`.

- **Mechanism.** `status()` reports `"fixed"` only from `link.is_fixed_tx(src_mac)`.
- **Scenario.** A user who forces `true` for a router bolted to the wall gets health `checks.board.transmitter = "other"`. Position quality meanwhile no longer reports `transmitter_not_fixed`, so the UI shows contradicting facts.
- **Fix.** Report `self.position.transmitter_fixed`, or add a separate `transmitter_setting` field.

### 4. low: the heart motion gate does not cover the first ~1 s of a new segment
`engine/lifefi/engine.py:378` and `_heart_step`.

- **Mechanism.** After a gap, `last_motion` is kept from before the gap. After a source switch it is `None`, so `quiet_for = now - self.started`, which is time since the engine started. Both pass the 30 s gate at once. `M` is `None` until about 1 s of F exists, so motion in that first second is never seen by the engine.
- **Scenario.** The first heart window (and breathing window) after a switch or gap starts at the segment start, so it can include that unchecked second. The estimator's own `breath_ratio` check is then the only guard.
- **Fix.** On a segment change or `_reset_signal`, set `last_motion = now`. Alternatively, take `quiet_for` as `min(now - last_motion, now - segment_start)`. This also strengthens finding 1.

Verified by reading the code only. The impact is small because `heart.py` still rejects windows with a low breathing ratio.

### 5. low: firmware CSI line is two UART writes, with a hard-coded CRLF
`firmware/src/stream.c:111-114`.

- **Two writes.** Holding the stdout lock serialises the line against ESP_LOG and printf. It does not cover stderr (a separate FILE lock), `esp_rom_printf` or `ets_printf`. Any of those can land between the payload write and the `"\r\n"` write, or inside the payload. The commit message's "one uart_write_bytes per line" is actually two calls.
- **CRLF.** Byte identity depends on `CONFIG_LIBC_STDOUT_LINE_ENDING_CRLF`. All four sdkconfigs have it (checked), so the output is identical today, but a config change would silently diverge.
- **Fix.** Write `line[n-1] = '\r'; line[n] = '\n'` (CSI_LINE_MAX has room once `n < CSI_LINE_MAX`) and send it with one `uart_write_bytes`, guarded by `#if CONFIG_LIBC_STDOUT_LINE_ENDING_CRLF` with an LF fallback.

### What was checked and is fine

Lock order is consistent: `stdout` FILE lock, then the driver tx mutex, the same order as the VFS path, so there is no deadlock with ESP_LOG or the command reader. Without the UART driver, it falls back to `fputs`. With a TX ring buffer, `uart_write_bytes` blocks and does not write partially. No new stack buffers were added. Not run on a board, so this is unverified on hardware.

### 6. low: CI firmware job has never run
`.github/workflows/ci.yml` (firmware job). Unverified.

- **Why it may fail.** `run.sh` builds with `-Werror` and the system `cc` (gcc on ubuntu-latest). Locally the tests build with a different compiler (Zig/MSVC-era toolchain), so gcc-only warnings could fail the job.
- **Cache.** The cache key covers only `platformio.ini`, so a changed sdkconfig reuses a stale `firmware/.pio`.
- **Fix.** Run the job once. Add `sdkconfig.*` to `hashFiles`.

## Checked, no defect found

- **Heart gating.** Published only when present, not warming up, 30 s still, and breathing valid. History is cleared on leaving, motion, warm-up, a gap or a boot_id change (a replay loop gets a new boot_id), and `_reset_signal` (source switch). Every invalid path yields a non-null reason, and `bpm is None` holds exactly when `reason is not None`.
- **NaN/inf.** Non-finite heart windows are replaced with an invalid window. Confidence is clipped and snr is at least 0. On the flat/zero probes the estimators produced no NaN bpm, snr or confidence.
- **Exceptions.** `estimate_heart` errors (ValueError, IndexError, LinAlgError) are caught. Any other exception is caught by `control._ticker`, so the loop survives and only that tick's result is lost.
- **CPU.** The heart estimator takes about 17-21 ms every 5 s (ml/results/vitals_eval.json, worst case 67 ms).
- **Existing result fields.** Unchanged. Only `breathing.reason` and `heart` are added, both schema-valid.
- **Transmitter detection.**
  - Prefix `1a:4c:46:54:58` matches `LIFEFI_TX_MAC_PREFIX`, and `parse_frame` gives lowercase `hex(":")` in wire order.
  - In YAML, `auto` is a string; `true`/`yes`/`false`/`no` load as bools and are compared with `is`.
  - Old recordings (phone/router MAC) stay not-fixed.
  - The firmware passes one source per lock, so a mixed stream cannot flap.
- **start.mjs.** Pruning only touches `lifefi-*.log` older than 14 days by mtime, so today's file is never deleted. Errors are swallowed. Midnight rollover resets the size and runs the prune on the next line. There is a trivial overshoot: one cap notice line is appended on each restart once the file is past 50 MB.
- **health.ts.** `transmitter` and `vitals` are read-only, and `ok`/`ready`/`setup` never read them. Missing `device` or `heart` gives `null`, and results older than 10 s give `vitals: null`.
