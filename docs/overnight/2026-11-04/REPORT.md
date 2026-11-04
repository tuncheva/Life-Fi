# Overnight report 2 — 2026-11-04 (01:45 → 07:00)

Branch **`feat/overnight`** (pushed; no PRs, nothing merged anywhere else).
Every feature went planner → critic (revised the plan) → worker, all subagents at
medium effort; plans, critiques and worker reports are in [plans/](plans/).
**Your questions: [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md)** (each already built
with a default).

> **Two interruptions, both outside our control.**
> 1. **API usage limit at ~02:50, reset at 06:40** — about 3 h 50 min lost. Everything
>    you asked for was already built, reviewed, fixed, browser-checked and **pushed**
>    by 02:47. What was in flight (overnight vitals history, a second UI round, an
>    engine/firmware review) was resumed at 06:41; status at the bottom.
> 2. **Commit signing stopped at 03:48** (gpg-agent's 2-hour passphrase cache; I kept
>    it warm until then, never bypassed it). Work after that is **in the working tree,
>    uncommitted**. Run
>    `powershell -ExecutionPolicy Bypass -File docs\overnight\2026-11-04\commit-pending.ps1`
>    from the repo root: it makes the prepared commits (gpg asks for the passphrase
>    once) and pushes `feat/overnight`.

## TL;DR

- **Heart rate and breaths per minute on `/` and on `/model`.** The engine now
  publishes an experimental heart rate next to breathing, and a plain-words reason
  whenever either has no trusted number ("Nobody to measure", "Moved recently:
  waiting for about 30 s of stillness", "Signal too weak…"). A new **Vital signs**
  card shows both on the dashboard and on Insights; heart rate is always labelled
  *Experimental · not a medical measurement*.
- **`/model` is now "Insights — what the sensor sees"**, in the main nav (Room /
  Insights / Alerts), with a 2 / 5 / 15 min window and **collapsible sections**:
  Presence, Breathing, Heart (experimental), Movement ("why vitals go missing"),
  Where (distance vs taught spots, 3D on demand), Sensor health, Raw signal. Each
  answers one question, has a one-line explanation, a chart, a stat line and an
  empty state; open/closed is remembered. Charts are filled on page load from a
  15-minute **in-memory** server buffer (`GET /api/v1/recent`; nothing on disk).
- **UX across the app:** skip link, per-page titles, icon + manifest, one page-header
  style, safer Settings (an emptied escalation field used to save `0` and silently
  stop re-sending alerts — fixed; PIN change no longer wipes unsaved edits; Save
  sends only changed fields; unsaved-changes warning), Alerts paging and empty state,
  no 503 noise in the console from /setup.
- **Production:** firmware fix for the task-watchdog warning (compile-only), the engine
  now **detects the fixed Life-Fi transmitter by itself** (no more hand-editing
  `rules.yaml`), log pruning at midnight + 50 MB/day cap, informational health fields
  for transmitter and vitals, a CI firmware job.
- **Honest numbers:** on your two real recordings (phone hotspot, gappy) breathing and
  heart rate are valid **0 %** of the time — through the engine and even with the
  estimators run ungated. On synthetic data with a known pulse the engine reports
  **exactly 82 and 66 /min**, and never a number with no pulse, an empty room, motion,
  after leaving, a gap or a source switch. A number on the real board needs the
  fixed transmitter and a still person.

## What shipped, by track (all pushed)

| Commit | Track | What |
|---|---|---|
| 38fb377 | contract | optional `heart` object and `breathing.reason` (fixed up front so engine and UI could be built in parallel) |
| e683666 | U — shell & pages | nav Room / Insights / Alerts (`lib/nav.ts`), skip link, page titles, icon + manifest, `PageHeader`/`Field`/`EmptyState` in `ui.tsx` (additive), Settings safety fixes, Alerts, Source, AlertBanner 44 px targets |
| 1315f22 | P — production 1 | firmware: one `uart_write_bytes` per CSI line (bytes on the wire unchanged, all 4 envs build, host tests pass, **not flashed**), firmware 0.1.1; log pruning + cap; health `checks.board.transmitter`, `checks.vitals` (never make health red); CI firmware job (never run yet) |
| 8843490 | M — dashboard + Insights | Vital signs card on `/` (home, clinic) and Insights; Insights page and sections; `Section.tsx`; `TrendChart` (uPlot), sparklines; `/api/v1/recent` |
| cd11db8 | V — engine vitals | heart rate in the live engine (every 5 s on the breathing window, only while present + 30 s still + breathing valid; median of valid windows of the last 60 s; cleared on leaving, motion, gaps, source switch); reasons for every null; `synth.py` pulse (test only); `test_vitals.py`; `ml/eval_vitals.py` |
| 51d848a | P — production 2 | `transmitter_fixed: auto` from the frame's source MAC (`engine/lifefi/link.py`), NaN-safe motion check in `heart.py`, docs |
| 15dcb35 | review fixes | 13 findings of an independent UI review + 8 of my browser check, all fixed (one motion threshold everywhere, honest distance on Insights, reconnect gap filled, even chart ticks, stale charts dimmed, settings partial save, 20-char minimum for *new* ntfy topics, a11y) |
| c65799a | docs | browser check round 2, owner questions |

Plus planner/critic plan commits for every track (cf3cb47 … 5764731).

## Verified

- `npm test` (contracts + engine + ml + vitest): **19 passed, 1 skipped** (needs the
  public datasets, skipped before tonight too), **0 failed**; vitest 235 tests.
  `npm run typecheck` and `npm run lint` clean at 15dcb35.
- Firmware: `esp32dev`, `esp32cam`, `esp32dev_tx`, `esp32cam_tx` build; host tests pass.
- `npm run build` passes at 06:51 on the final working tree (incl. track H and the
  engine fix): every route, `/model`, `/api/v1/history/vitals`, icon, manifest.
- Browser ([browser-check.md](browser-check.md)), on a replay of
  `spots-20261031-192549` and on a synthetic test recording (scratchpad only, never in
  `data/`): `/` and Insights at 800 px and 375 px, dark theme, no console errors, no
  horizontal scroll. With the synthetic pulse the card reads **15 breaths/min** and
  **82 beats/min** ~30 s after the walk-in; with the real recording it shows "—" and
  the engine's reason. Request rate on `/`: 1 alerts + 1 history request per 10 s.
- My test replays wrote rows into `data/lifefi.sqlite`; I restored it from a copy
  taken before the synthetic run (integrity ok). Nothing was flashed; the ESP32 was
  not used.

## Your morning, in order

1. Run the commit script above (signs and pushes what is still uncommitted).
2. `npm run dev` → http://localhost:3000 → look at **/** (Vital signs card) and
   **Insights**.
3. Re-flash the receiver with firmware 0.1.1 and watch the monitor for 60 s: no
   `task_wdt` warning, `@CSI` lines still parse (`docs/ops/README.md`).
4. With the fixed transmitter in place, the engine marks it fixed by itself
   (`transmitter_fixed: auto`); then sit still ~1 min to see breathing/heart numbers.
5. Answer [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md).

## In flight at 06:41 (resumed after the usage limit)

- **Track H — "Last hours" on Insights (done; uncommitted → commit script).**
  Planner + critic + worker. History rows gain `heart_bpm`/`heart_valid` (home and
  clinic only, same 30-day retention; school stores nothing new); existing databases
  migrate in place on first start (tested on old-format files and on a copy of your
  DB: 8 155 rows kept, 6.6 ms). New `GET /api/v1/history/vitals?hours=1|6|24`;
  Insights gets a collapsible **"Last hours — How was the night?"** with breathing,
  heart (experimental) and movement; a bucket with fewer than 3 valid readings is a
  gap, never a number. typecheck, lint, vitest **263 passed**. Browser-checked at
  06:45 with the app only (no engine, so no new rows): it shows yesterday's real
  session ("read 2 % of the time someone was there · median 7.0 breaths/min"), heart
  "not measured in these hours", no console errors. Your `data/lifefi.sqlite` is now
  migrated (integrity ok); copies from before are in the session scratchpad.
- **UI round 2 — planned and critic-revised, not built**
  ([plans/R2-ui-round2.md](plans/R2-ui-round2.md)): /setup wording now that the
  transmitter is auto-detected, one breathing rule for the room card and the vitals
  card (today the room card can show a number the vitals card refuses), vitals on
  `/present`, `/` sensor details and 3D views on the new collapsible (keeps your
  open/closed choice), a tighter empty vitals card. About 45 min for one worker; it
  did not fit after the usage limit. Say "build R2" and it runs as planned.
- **Independent engine/firmware review — done**
  ([review-engine-firmware.md](review-engine-firmware.md)): 0 high, 2 medium, 4 low;
  the rest checked out (heart gating and reasons, NaN never reaches JSON, an exception
  loses one tick, not the loop; MAC prefix and byte order; old recordings stay
  not-fixed; firmware lock order; log pruning never touches today's log).
  - Medium 1 (a pre-gap breathing rate shown as valid for up to ~7 s after a gap):
    **fixed** with one line in `engine.py`; engine tests after it: **17 passed, 1 skipped, 0 failed** (06:50).
  - Medium 2 (an empty-room calibration taken with the phone hotspot survives the
    switch to the fixed transmitter): not fixed, proposal in OPEN-QUESTIONS.
  - Lows: listed in OPEN-QUESTIONS; none affects today's setup.
