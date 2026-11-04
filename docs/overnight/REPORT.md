# Overnight report — 2026-11-03 (02:55 → 08:00)

Branch **`feat/overnight`** (pushed; no PRs, nothing merged anywhere else).
Base: `origin/dev` + a merge of your latest `feat/usb-live-next-backend-spot-model`
(see open question 4). Every feature went planner → critic (revised the plan) →
worker; plans, critiques and worker reports are in [plans/](plans/).
**Your questions: [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md)** (16 items, each
already built with a default).

> **Interruption:** the API usage limit was hit at ~03:55 and only reset at
> 07:40, so about 4 hours were lost. Tracks A, B, C and D were already done and
> committed by then; track F (teach spots from the UI) and the two independent
> code reviews were cut mid-way and resumed at 07:41 — their status is at the
> bottom and will be updated in this file when they finish.

> **Commits blocked since 07:44 — needs you.** Your commits are GPG-signed
> (`commit.gpgsign=true`). The gpg-agent passphrase cache expired during the
> pause, and signing now times out waiting for the passphrase. I did not bypass
> signing. Everything up to commit 2cb46ad (tracks A–D plans and code, track C)
> **is pushed**. Everything after it — this report, the cleaned-up open
> questions, the review reports and fixes, and track F — is **in the working
> tree, uncommitted**. Run
> `powershell -ExecutionPolicy Bypass -File docs\overnight\commit-pending.ps1`
> from the repo root: it makes the three prepared commits (review fixes →
> track F → docs; gpg asks for your passphrase) and pushes `feat/overnight`.

## TL;DR

- **Where people are, honestly.** The dashboard hero is now a 2D top-down room
  view driven by a new **occupancy** estimate (empty / occupied / unsure, every
  tick, no calibration needed). Distance is shown only as a quality-labelled
  band, with a "why it's rough" link to the setup step that fixes it. No fake
  x/y dot — one link has no direction.
- **Accuracy.** Measured leak-free across the two real sessions: occupancy
  **0.75 / 0.77** balanced accuracy (chance 0.50). Distance and spot models are
  **not** better than chance with the phone-hotspot transmitter and are now
  labelled that way instead of shown as fact. The real fix is a fixed
  transmitter — **firmware for it is ready** (compile-only).
- **UX.** First-run **/setup wizard**, consumer nav reduced to Room + Alerts,
  mobile overflow fixed (375 px), /present no longer says LIVE when it is not,
  three.js lazy-loaded, error / 404 / loading / empty states, 44 px targets.
- **Production.** `npm run start` = supervised engine + `next start` (backoff,
  clean shutdown, 127.0.0.1 by default), `/api/v1/health`, `/api/v1/setup`,
  error JSON + bounded inputs on every route, PIN rate limit, one `npm test`
  for everything, CI uses it, runbook in `docs/ops/README.md`.

## What shipped, by track

### A — position / model accuracy ([plan + report](plans/A-position-accuracy.md)) · commit 413443b
- `engine/lifefi/occupancy.py`: empty / occupied / unsure from the link's
  disturbance power on 4 s windows; never says "empty" while presence says
  someone is there. New top-level result field `occupancy: {state, p}`.
- `position.quality` (none / low / medium) + `quality_reasons`
  (`transmitter_not_fixed`, `no_distance_fit`, `no_empty_calibration`,
  `low_packet_rate`); `spot.model_accuracy` / `spot.reliable` from the spot
  model's leave-one-session-out score. All additive and optional in
  `contracts/results.schema.json`.
- `ml/eval_position.py` → `ml/results/position_eval.json`: cross-session
  evaluation with 95 % intervals. `docs/models.md` updated with the honest numbers.

| Cross-session (train S2→test S1 / S1→S2) | Before | After |
|---|---|---|
| Occupancy, balanced accuracy (chance 0.50) | — (did not exist; old spot model's "empty" was 0.47–0.53) | **0.75 [0.55–0.87] / 0.77 [0.55–0.89]** |
| Spot model, balanced accuracy (chance 0.25) | 0.19 | 0.09 / 0.23 → now flagged **unreliable**, not shown to consumers |
| Distance vs true distance | wrong-sign correlation (−0.70 in S2) | unchanged physics → labelled **quality "low"** with reason |
| Engine cost of the new work | — | ~1.5 ms per update |

Caveats: only ~12 independent empty windows per session (hence the wide
intervals); "unsure" covers 57–65 % of ticks, above the plan's 50 % target —
not tuned to pass, because tuning on two sessions would only overfit.

### B — UI / UX ([plan + reports](plans/B-ui-ux.md)) · commit 6def786
- **Room view** (`ui/src/lib/room.ts`, `RoomView.tsx`): one derived, tested
  room state; occupancy fills the room, the distance band carries its quality
  label, spot only when reliable. `live.tsx` split (`useLiveSlow`, `useResult`,
  `useMounted`) so SSE ticks stop re-rendering whole pages.
- **/setup wizard**: sensor → transmitter → room → empty-room calibration →
  distance fit → done, on `/api/v1/health` + `/api/v1/setup`, with deep links
  (`/setup?step=…`) and a "Finish setup" pill in the header until done.
- Shell: Room + Alerts nav, Setup menu, one message per problem, error /
  not-found / loading / empty states, 44 px targets, inline sound prompt.
- Checked in a browser at 375 px and 1280 px, light and dark, offline and on
  a replay. tsc / lint / vitest green.

### C — production readiness ([plan + report](plans/C-prod-readiness.md)) · commit 2cb46ad
- `scripts/start.mjs` supervisor (checks setup, restarts a crashed engine or
  app with 1–30 s backoff, no restart on Ctrl+C or bad arguments, Windows
  process-tree kill, logs in `data/logs/`).
- Config errors never crash the server (API answers `500 config` with the list).
- New routes `GET /api/v1/health` (503 when not ok, `?soft=1` for UI polling),
  `GET /api/v1/setup`, `GET /api/v1/position`; `Settings.room`. Documented in
  `contracts/api.md`.
- Every handler returns error JSON; inputs bounded; replay paths confined to
  the recordings folders; wrong PINs rate-limited and compared in constant
  time; `validate.ts` now follows `results.schema.json`; no false
  `sensor_offline` in the first 30 s.
- `npm test` runs contracts + engine script tests + vitest; CI uses it.
- Verified: tsc, lint (0 warnings), vitest, check-contracts, `npm test`,
  `npm run build`, and a live `start` run on port 3100 (health, setup, SSE,
  bad input, engine restart).

### D — fixed transmitter firmware ([plan + report](plans/D-fixed-transmitter.md)) · commit fb76886
- New envs `esp32dev_tx` / `esp32cam_tx`: ESP-NOW broadcast at 100 Hz on
  channel 11 at HT20 MCS0 (the default 11b rate carries no CSI) from MAC
  `1A:4C:46:54:58:01`.
- Receiver: ~1.9 s boot probe for that MAC; locks onto it when found;
  `tx off` gives exactly the old boot path.
- All four envs compile (esp32dev, esp32cam, esp32dev_tx, esp32cam_tx); host
  tests pass. **Nothing was flashed or run on hardware.**
- Guide: [docs/hardware/fixed-transmitter.md](../hardware/fixed-transmitter.md).

## Your morning, in order

1. Plug the receiver in, then `npm run dev` → http://localhost:3000 → follow
   **/setup**.
2. Flash a spare ESP32 as the transmitter and re-flash the receiver
   (exact commands in `docs/hardware/fixed-transmitter.md`); fix the
   transmitter in place 2–2.5 m from the receiver; the receiver log should say
   `link: fixed transmitter … ~100 Hz`.
3. Set `position.transmitter_fixed: true` in `engine/config/rules.yaml`, run
   the empty-room calibration from /setup, then record 3 labelled spot
   sessions at different times from **/teach** and press Train.
4. Answer [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md).

## Status at 08:00 (superseded by "Updates after 08:00" below)

- **Track F — teach spots + retrain from the UI** ([plan](plans/F-teach-spots.md)):
  planned and critic-revised; the worker was cut by the usage limit midway
  (server-side training/recording helpers in progress, uncommitted) and
  resumed at 07:41 with a 60-minute budget. Not committed until it is green.
- **Independent code reviews** (engine/ML/firmware and UI/server): cut by the
  usage limit, resumed at 07:41; findings will be fixed and listed below.
- Auto-detecting the fixed transmitter in the engine (so `transmitter_not_fixed`
  drops off by itself) — small, planned after F because it touches the same
  engine file.
- Movement / fall model: unchanged. Its public training data (~10 GB) is not
  on this PC and it cannot be judged on our board without own recordings.

## Updates after 08:00

- **Reviews done (07:50).** Engine/ML/firmware review
  ([review-engine-firmware.md](review-engine-firmware.md)): 1 high, 3 medium,
  4 low. The high one: **occupancy can say "empty" while a still person sits
  0.4 m away** when no calibration exists (presence is the only guard), so do
  not trust "empty" on the committed code yet. The occupancy replay numbers in
  `docs/models.md` are in-sample. The spot "reliable" gate is optimistic. The
  transmitter accepts rates the receiver probe can't see.
  UI/server review ([review-ui-server.md](review-ui-server.md)): 0 high,
  3 medium, 8 low. A LAN flood of wrong PINs could lock out alert acks; the
  room drawing showed a precise ring for low-quality distances; `npm run start`
  did not pass the engine port or data dir to the engine.
- **Review fixes (08:00–08:10, uncommitted, see the top note).**
  - *Occupancy "empty" is now a high-evidence state:* low disturbance **and**
    presence "empty" **and** an empty-room calibration loaded, all held for
    30 s; anything less is "unsure". A synthetic still-person test reproduces
    the reviewer's failure and passes now. Replays: false "empty" with a person
    there 7 → 0; "unsure" share 52 % (S1) / 88 % (S2). More "unsure" is the
    honest price. The occupancy replay numbers are now fitted on the *other*
    session (no longer in-sample), and `docs/models.md` says so.
  - Spot `loso_bal_acc` now uses a fixed shrinkage (`SHRINK_LOSO = 0.2`), not
    one picked on the held-out sessions.
  - Transmitter minimum rate 50 Hz; receiver probe 200 ms per channel (worst
    case 2.8 s at boot). Both builds and host tests pass.
  - PIN lockout: a browser that has entered the right PIN once gets an
    HttpOnly trust cookie (HMAC of the PIN under a random per-install key), so
    the right PIN still acknowledges a fall alert during a LAN-flood lockout;
    attackers still get 429.
  - Room drawing: no ring, labels or scale bar unless distance quality is
    "medium". `npm run start` passes the engine port and data dir.
  - Mine, from the browser check: with no board the dashboard said "Starting
    up, checking the room" next to a green "Live" pill. It now says "We cannot
    see the room right now — the sensor board can't be read (…)" with a red
    "Sensor offline" pill (test added).
- **Track F — teach spots + retrain from the UI (done, uncommitted).**
  `/teach` (Setup menu and the last /setup step): a checklist that blocks
  recording until the board is live at ≥ 20 readings/s, spot distances, 1 or
  2 rounds (~8 min), spoken prompts from the browser, server-timed labels in
  the same format as `ml/record_spots.py`; then **Train**: runs
  `ml/train_spots.py --json` and shows the cross-session score next to chance.
  It never auto-installs a model that is strictly worse, keeps the old one
  as `data/spots_model.prev.json` ("Restore previous"), and the engine reloads
  it without a restart. `PUT /source` answers 409 while a recording runs. Old
  phone-hotspot sessions are left out of training by default. Not run end to
  end (no board).
- **Final checks (08:14, whole working tree):** `npm test` 17 passed, 1 skipped
  (needs the public datasets), 0 failed; `tsc` clean; lint clean;
  `npm run build` OK (37 routes incl. /teach, /setup); browser: /, /setup,
  /teach hydrate with no errors, no horizontal scroll at 375 px.
- **Note on a stale dev server:** a `next dev` left running by a worker went
  into a hot-reload loop after `next build` ran next to it (100k requests). A
  fresh `npm run dev` is stable (one navigation in 11 s). If you ever see
  the page flicker forever, restart `npm run dev`.
- **Still not done:** the engine does not yet detect the fixed transmitter by
  itself (it still reads `position.transmitter_fixed` from
  `engine/config/rules.yaml`, so set it to `true` after you install the
  transmitter); review lows L3 (engine) and L6 (UI, large) are written up in
  the review files.
- **13:50, first run with the board (COM3, hotspot on):** live at ~41
  readings/s; dashboard reads "Someone is home · Distance: rough guess only".
  `/api/v1/health` called the board ok while it was still unplugged (fixed,
  test added, in the commit script). The empty-room calibration (cal-0002) is
  2.8 days old and shows as stale: redo it from `/setup` with the room empty.
  The firmware already on the board logs a task-watchdog warning every 5 s
  (its `csi` task keeps CPU 0 busy, so IDLE0 never runs); watchdog panic is
  off, so the board keeps streaming, but it is not fixed.
