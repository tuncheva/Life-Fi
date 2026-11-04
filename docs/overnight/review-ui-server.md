# Review: track B (6def786) and track C (2cb46ad)

Independent read-only review of the committed diffs. Checks run: `npx vitest run` (13 files, 145 tests
pass) and `npx tsc --noEmit` (clean). The working tree had another worker's uncommitted changes when
these ran. The file:line references below are at 2cb46ad.

No high-severity defect was found. The SSE client (`live.tsx`) cleans up its EventSource and timers.
The slow/result context split works, and no hydration mismatch was found (clock, geometry and
localStorage reads all happen after mount). The wizard sends request shapes that match the routes
(`/calibrate` `{kind, duration_s}`, `/position/fit` `{d_m, seconds}`, `/settings` `room_name`).
`replayPath` contains traversal (it uses `relative()` and rejects anything with a `..` prefix or an
absolute path). The PIN compare is constant-time. The Next 16 `error.tsx` `retry` prop is correct
according to `node_modules/next/dist/docs`.

## Medium

### M1. One global wrong-PIN bucket lets anyone lock out alert acknowledgement
`ui/src/server/http.ts:54-109`, `ui/src/app/api/v1/alerts/[id]/ack/route.ts:10-13`

- **Failure:** The limiter has one bucket shared by all clients, and dashboard acks now go through `pinGate`.
  - Anyone who can reach the server (any LAN device once `LIFEFI_HOST=0.0.0.0`, which the setup recommends for phones) can send 5 requests with a bad `X-Lifefi-Pin`. Every write and every dashboard "I'm on it" then returns 429 for 60 s.
  - The lockout doubles each time up to 1 h. `check()` returns "locked" without looking at the PIN, so the caregiver's correct PIN is refused too.
  - `lockouts` only resets on a correct PIN outside a lockout. Repeating the 5 requests at each lockout end keeps the lock on indefinitely.
  - During a fall alert the alarm keeps beeping and the dashboard cannot acknowledge it. Only the phone token path still works.
- **Fix:**
  - Do not gate alert acks on the limiter. At least let a correct PIN through during a lockout for `/ack`.
  - Or key the buckets by remote address. The Node request socket is reachable via a custom server or a middleware header set by `start.mjs`.
  - Let `lockouts` decay after a quiet period.

### M2. Room view draws a low-quality distance as a precise radius
`ui/src/components/RoomView.tsx:79-134`, `ui/src/components/RoomView.tsx:159-163`

- **Failure:** `whereText` (words.ts:280-306) promises "never a number unless the engine rates the distance medium". `positionView` still passes low-quality distances through (room.ts:137-140), and RoomView draws them:
  - a solid band circle at `d * PX`;
  - a dashed ring at exactly `d`;
  - the 1.5 m and 3.5 m ring labels and a 1 m scale bar.
- Together these let anyone read off "about 2.2 m". The only hedge is the text "rough guess".
- With the phone-hotspot transmitter, `transmitter_not_fixed` is always set, so this is the normal case. The hero view shows more certainty than the engine gives.
- **Fix:** For `quality === "low"`, draw no ring at `d`. Either fill the whole zone ring (near/middle/far, from `pos.zone`) faintly, or draw nothing and keep only the sentence. Alternatively, set `distance` to null in `positionView` when the quality is low and keep the reasons.

### M3. `npm run start` does not pass the engine port or the data dir to the engine
`scripts/start.mjs:22-23`, `scripts/start.mjs:95-96`

- **Failure, engine port:** `LIFEFI_ENGINE_PORT` is checked as free and reaches Next, but the engine is spawned without `--port`. `engine/run.py:42` defaults to 6000.
  - With `LIFEFI_ENGINE_PORT=6001` the preflight passes and the backend dials 6001 while the engine listens on 6000.
  - The dashboard then says "sensor software is not running" forever, and the watchdog raises `sensor_offline` after 30 s.
  - `docs/ops/README.md:60` documents the variable as working.
- **Failure, data dir:** `LIFEFI_DATA_DIR` is resolved for the app only. The engine keeps writing `calibration.json`, `position.json` and `spots_model.json` under the repo's `data/` (engine.py:133-136).
  - `/api/v1/position` and `position-files.ts` read the other directory and return `fit: null`.
  - The runbook mentions `--calibration` only.
- **Fix:** In `children.engine.args`, add `--port ${enginePort}`. When `LIFEFI_DATA_DIR` is set, also add `--calibration <dataDir>/calibration.json` unless the user passed one.

## Low

### L1. The headline and the room drawing contradict each other
`ui/src/lib/room.ts:127`, `ui/src/components/Cards.tsx` (RoomCard: `StateHeadline` and `WhereBlock`)

- **Failure:** The case is presence `empty` with occupancy `occupied`. `roomStatus` gives the headline "Nobody in the room", while `positionView` gives `unsure`. The drawing directly under it fills amber and says "Not sure if anyone is there". This also breaks the plan's "one message per problem" rule.
- **Fix:** Feed occupancy into `roomStatus` so the headline is the hedged one. Alternatively, have the where-block show nothing extra when it disagrees.

### L2. The "Fix" link for `transmitter_not_fixed` goes to a step that cannot fix it
`ui/src/lib/room.ts:146-151`, `ui/src/lib/words.ts:267-269`, `ui/src/components/setup/StepRoom.tsx:26-43`

- **Failure:** The reason comes from `rules.yaml` `position.transmitter_fixed`. The "transmitter" step only saves the room geometry to localStorage. After "Save and continue" the reason and the "Fix" link stay forever, and nothing tells the user what actually clears it.
- **Fix:** Say in the step that the setting is `position.transmitter_fixed` in `rules.yaml` and needs a fixed router. Or add a server or engine setting that the step writes.

### L3. "Finish setup" never goes away in replay mode or with the default PIN
`ui/src/server/health.ts:107-115`, `ui/src/lib/setup.ts:217-221`, `ui/src/components/setup/StepDone.tsx:28`

- **Failure:**
  - The server `board` step requires `source === "live"`, and `pin` is non-optional. So `complete` is false for the whole of a replay demo, and whenever the PIN is still 1234.
  - The wizard has no PIN step. `board` is not in `SERVER_EXTRA`, so StepDone shows every step ticked and gives no reason.
  - The pill also refetches only when the calibration state or the local flag changes. If the first fetch ran while the engine was down, `complete: false` stays until one of those changes.
- **Fix:** Treat replay as "board ok (recording)" for setup completeness, or list `board` in `SERVER_EXTRA`. Also refetch when `engine.connected` changes.

### L4. Installer 3D view shows unreliable spots and low-quality distances as numbers
`ui/src/components/Room3D.tsx:165-172`, `ui/src/components/Room3D.tsx:234-261`

- **Failure:** In `model` mode (on `/model`), Room3D shows "Spot: desk · 1.2 m · 83 % sure" and places the marker regardless of `spot.reliable`. That is exactly what plan B1.1 forbids. Distance mode prints `2.3 m ± 0.5 m · quality low`.
- The panel is labelled experimental and for installers, so the severity is low. The `/model` page is still linked from the Setup menu.
- **Fix:** Gate the spot label and marker on `spotReliable(pos)`, and print "not reliable for this room (LOSO acc x)" otherwise.

### L5. "2 people here" from the board's capped head count
`ui/src/lib/words.ts:293-295`, `ui/src/lib/room.ts:133`

- **Failure:** `position.people` is the board's own count from its USB log, where 2 means "2 or more". `LiveViews.tsx:28` renders it as "2+". The consumer sentence states "2 people here" as a fact and ignores `usePublished().count`.
- **Fix:** Say "More than one person may be here" and show it only when the count output is published.

### L6. Room geometry exists twice and is never synced
`ui/src/lib/room.ts:20-54`, `ui/src/server/settings.ts:8-38`, `ui/src/app/api/v1/settings/route.ts:33-37`

- **Failure:** Track C added `Settings.room` (`width_m`, `depth_m`, `sensor`, `transmitter`), but the UI never reads or writes it. The wizard keeps `{length_m, width_m, tx_m}` in each browser's localStorage. As a result:
  - the phone and the PC draw different rooms;
  - the "transmitter" step shows as done only in the browser that saved it.
- **Fix:** Have StepRoom PUT `room` (convert `length_m` to `depth_m`, and put the sensor on the bottom wall) and have `useRoomGeometry` read `/settings`, with localStorage as a fallback.

### L7. Supervisor treats exit 0 as "stopped on purpose"
`scripts/start.mjs:89`, `scripts/start.mjs:122-125`, `scripts/start.mjs:140-151`

- **Failure:**
  - Any clean exit 0 shuts the whole stack down instead of restarting the child. That covers `run.py` returning after `server.serve()` ends, and `next start` exiting 0.
  - On Windows that path calls `shutdown(..., consoleCtrl=true)`. That sends nothing to the surviving sibling, which keeps running unsupervised for 10 s until `forceKill`.
- **Fix:** Treat exit 0 as intentional only when the supervisor itself received SIGINT or SIGBREAK. On a lone child exit, call `shutdown(why, false)` so the sibling is stopped right away.

### L8. Body-size limit skips requests without Content-Length
`ui/src/server/http.ts:151`, `ui/src/server/http.ts:30-31`

- **Failure:** A chunked request has no `content-length`, so it passes the 413 check, and `readBody` buffers the whole body. This only matters after a correct PIN, so the impact is small.
- **Fix:** Read the stream with a byte cap in `readBody`.

## Test runner and CI

`scripts/test-all.mjs` and `.github/workflows/ci.yml` should run on Linux:
- `npm` is spawned without a shell off Windows.
- The python job installs `engine/requirements.txt`, which covers the imports of `ml/tests/test_own.py` and `ml/` (numpy, scipy, yaml).
- Only `test_features_vectors.py` (no vectors or onnxruntime) and `test_replay_position.py` (no sessions, because `data/` is gitignored) print `SKIPPED`. Both are reported as SKIP in the summary rather than hidden.
- One gap: the CI never runs `node scripts/test-all.mjs` as a whole. It calls `check:contracts`, `npm test -w ui` and `--only engine` separately, so the runner's own ui path is untested in CI.

## Fixes applied

Fix worker, same night. Each finding was checked against the code first; all were confirmed. Checks: `npx tsc --noEmit`, `npx vitest run` (15 files, 174 tests), `npm run lint -w ui`, all clean.

- **M1, fixed.** A right PIN that anyone could push through a lockout would turn the lockout into an oracle (429 = wrong, 200 = right). A shared, serialised check budget can be filled by the attacker before the caregiver's request gets in. Instead, every accepted PIN now sets an HttpOnly `lifefi_trust` cookie. Its value is HMAC-SHA256(per-install key in `data/trust.key`, PIN), so a PIN change revokes it. A request that carries this cookie and the right PIN is never locked out. Everyone else still gets 429 whatever they send, so brute force stays at 5 guesses per lockout. `lockouts` now decays after 1 h without wrong PINs. The constant-time compares are kept for both the PIN and the cookie. The design is explained in the comment on `PinLimiter` (`ui/src/server/http.ts`). The ack route hands out the cookie too. Tests: trusted vs untrusted vs forged cookie during a lockout, decay, token persistence and revocation.
  - Left open: a browser that has never given the right PIN cannot get past a lockout. The phone's one-time ack token still works.
- **M2, fixed.** `roomDrawing()` in `ui/src/lib/room.ts` is now the single rule. It allows a ring, the zone rings, their labels and the scale bar only for a "medium" distance. For a low-quality distance, `RoomView` draws nothing distance-related. Tests are in `ui/test/room.test.ts`.
- **M3, fixed.** `scripts/start.mjs` now passes `--port $LIFEFI_ENGINE_PORT` and `--calibration <dataDir>/calibration.json` to the engine. `position.json` and `spots_model.json` are siblings of that file in engine.py, so they move with it. User-supplied flags still win. `LIFEFI_ENGINE_PORT` is validated. `run.py` needed no change. `docs/ops/README.md` is updated.
- **L1, fixed.** `roomStatus` now hedges ("Not sure if anyone is there") when presence says empty but occupancy says occupied. A test is added.
- **L2, fixed (text).** StepRoom now says that saving does not clear the warning, and that `position.transmitter_fixed: true` in `engine/config/rules.yaml` does, once a fixed transmitter is in place. No new setting was added.
- **L3, partly fixed.** `board` was added to `SERVER_EXTRA`, so StepDone says why setup is not complete. The pill now refetches when `engine.connected` or the source changes. Replay still counts as "not set up". That is deliberate: a demo is not a set-up room.
- **L4, fixed.** Room3D no longer places a marker for an unreliable spot. It prints "not reliable for this room (tested accuracy x %)". `SignalSample.spot` gained `reliable`. Distance mode prints a number only for medium quality.
  - Left open: the 3D distance ring itself is still drawn in this installer view.
- **L5, partly fixed.** The text now reads "More than one person may be here" instead of "2 people here". Gating it on the published count output was skipped because it needs plumbing through `positionView`.
- **L6, skipped.** Syncing the room geometry between `/settings` and localStorage changes the wizard and the data model. It is too large for this pass.
- **L7, fixed.** Exit 0 is no longer "stopped on purpose": a clean child exit is restarted. A real Ctrl+C sets `stopping` through our own handler and clears any pending restart. A stop that was not caused by Ctrl+C now hard-stops the sibling right away (`consoleCtrl` is true only for the Ctrl+C exit codes).
- **L8, fixed.** `readBody` reads the stream with a 64 KB cap and answers 413 (test with a chunked body that has no Content-Length).
