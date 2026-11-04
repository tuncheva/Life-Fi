# Open questions — overnight run 2 (2026-11-04)

Each item says what was built in the meantime (the default) and what we need
from you. Last night's list is still in [../OPEN-QUESTIONS.md](../OPEN-QUESTIONS.md).

<!-- items are added as the tracks finish -->

## Track P — production readiness

1. **Is the transmitter fixed?** `engine/config/rules.yaml` `position.transmitter_fixed`
   is now `auto | true | false`. **Built: `auto`** — frames from the Life-Fi transmitter
   (MAC `1a:4c:46:54:58:xx`) count as fixed, everything else (phone hotspot, old
   recordings) as not fixed. If you use a router bolted to the wall as the transmitter,
   set `true` (it has no Life-Fi MAC). Note: the `/setup` room step
   (`ui/src/components/setup/StepRoom.tsx`) still tells the user to set `true` by hand;
   with `auto` that is only needed for a router. Not edited (UI track's file).
2. **Firmware 0.1.1 watchdog fix is compile-only.** **Please re-flash the receiver**
   (`pio run -d firmware -e esp32cam -t upload`) and watch `pio device monitor` for 60 s:
   no `task_wdt` / IDLE0 warning, `queue drops 0`, the dashboard still gets data
   (`@CSI` lines still parse). If it misbehaves, the old behaviour is the previous
   `stream.c` (one `fputs` per line).
3. **Log size.** **Built: at most 50 MB per day, 14 days kept** (≤ 700 MB). Say if you
   want different numbers.
4. **Health shows transmitter and vitals.** **Built: informational only** —
   `checks.board.transmitter` and `checks.vitals` never make health red or 503 and do
   not change setup. Say if a missing breathing reading should ever count as "not ready".
5. **CI firmware job.** **Built, unverified** (never ran): builds all four envs and runs
   the host tests; triggers stay `main` / `dev` / PR / manual. Check the first run on
   GitHub; it is slow on a cold cache (PlatformIO toolchain download).
6. **Distance fit at ≥ 2 distances.** **Cut tonight.** Without it, position quality
   cannot reach `medium` unless `position.json` is edited by hand (`no_distance_fit`
   stays). Needs real recordings at two distances first.
7. **Schema wording.** `contracts/results.schema.json` still describes
   `transmitter_not_fixed` as "rules.yaml position.transmitter_fixed is false".
   **Left unchanged** (contract frozen tonight); reword with the next contract change
   (it now also means "frames not from the Life-Fi transmitter").
