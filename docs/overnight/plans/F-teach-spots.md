# Track F plan: "Teach spots" and retrain from the UI (overnight 2026-11-03)

## Critic revisions

**Final plan.** Where a revision below conflicts with the body, the revision wins
(the body is kept for detail and has been edited where noted). Verified against the
code on 2026-11-03 (engine.py, spots.py, train_spots.py, record_spots.py,
recordings routes, http.ts, config.ts, position-files.ts, source route, health.ts).

### R1. Facts the planner got wrong or missed (verified)

1. **`session.json` has no `meta` key**: `recordings/start` spreads `meta` into the
   top level (`{session, started_us, firmware, ..., kind:"spots"}`, see
   `data/sessions/spots-20261031-192549/session.json`). `listSessions` reads
   `transmitter`, `protocol`, `kind` from the top level. Teach's meta must never
   contain `session` or `started_us` (it would overwrite them).
2. **Clocks agree**: live `host_us` is `time.time_ns()//1000` (sources.py:172), the
   PC wall clock, same as Node `Date.now()*1000` and `record_spots.py`'s
   `time.time()`. So server-timed `t0_us/t1_us` line up with the `.csirec` exactly as
   the CLI's do. Compute the schedule from `startMs = Date.now()` taken **after** the
   `record_start` ack (the CLI starts 5 s early; our 20 s lead covers that).
3. **`position-files.ts` already has `loso_bal_acc`** (C did it). Do not add it again.
   Instead export a `readSpotsSummary(path)` from it (the body of the current spots
   branch, plus `loso_by_session`, `holdout_accuracy`) and reuse it in `teach.ts` for
   current/previous/candidate. Small additive edit to C's file.
4. **Replay during a recording corrupts the session**: the engine writes every fed
   frame into the open `.csirec` (engine.py:263) and `set_source` does not close it;
   `PUT /api/v1/source` does not check `ctx.state.recording`. Fix (C's file, 2 lines):
   `PUT /source` answers `409 conflict "a recording is running; stop it first"` while
   `ctx.state.recording` is set. TeachRun still aborts on `source.mode !== "live"`.
5. **Mixed label sets break training silently**: `train_spots.fit` takes the mean of a
   class with no rows (NaN) when one session lacks a label. `train_spots.py` must exit 2
   with `labels differ between sessions: ...` when the label sets differ, and
   `POST /spots/train` checks the same thing first (400).
6. **Engine reload**: confirmed missing (`spot_model` only in `__init__`, line 136;
   `reload_models` only re-runs `load_models()`). Do **not** move it into
   `load_models()` (that also rebuilds posture). Add `Engine.load_spots()` (path
   `calibration_path.with_name("spots_model.json")`, margin from
   `self.rules["spots"]`; a load error prints and keeps the old model; a missing file
   sets `None`), call it in `__init__` after `load_rules()` instead of line 136, and in
   the `reload_models` handler. Ack becomes `{"models": [...], "spots": {"labels",
   "loso_bal_acc"} | null}` (additive; document in `contracts/control.md`, C's file).
   The install route compares `ack.data.spots.labels` with the candidate to say
   "engine reloaded" honestly.
7. **Where files live**: sessions in `sessionsDir()` (config.dataDir), models in
   `config.dataDir` (same as `readPositionFiles`). The engine reads
   `<--calibration dir>/spots_model.json`, default `ROOT/data`: matches unless
   `LIFEFI_DATA_DIR` is changed. Note it in api.md, do not fix.
8. `/setup?step=transmitter` exists (`ui/src/lib/setup.ts`), use it as is.

### R2. Scope cuts (2 h, medium effort)

- **Spot names are fixed**: `close`, `middle`, `far` (+ `empty`); only the distances
  are editable (0.2-10 m). Reason: `ml/eval_position.py` hard-codes these four labels,
  and sessions must share label sets. Drop the editable name list, the name regex,
  the "names differ" warning on the page (the server still checks, R1.5).
- **Timing**: only `rounds` (1 or 2) is a choice; hold 45 s, empty 60 s, walk 10 s
  (15 s on entering/leaving) are constants in `teach.ts`. Drop "Advanced".
- **Drop server-side speech** (`speak_server`) entirely. Drop "Install anyway"
  (R3). Drop the confusion matrix from the UI (keep it in METRICS).
- No `ui/src/lib/teach.ts` client lib beyond the pure `secondsLeft`/`currentStep`
  helpers; put fetch calls inline in the components like B's pages do.

### R3. Safety (replaces the matching body parts)

- **Never auto-install a worse model.** `shouldPromote(cand, cur)`: candidate
  `loso_bal_acc` null → no; current missing or its `loso_bal_acc` null → yes; else
  yes iff `cand − 1/k_cand >= cur − 1/k_cur` (margin over chance, **no** 0.02
  tolerance: ties install, the newer data wins). No "Install anyway". The only manual
  swap is **Restore previous** (`POST /api/v1/spots/restore`, replaces `/promote`).
  The candidate file stays on disk for the CLI.
- **Install**: copy current → `spots_model.prev.json.tmp` → rename to `.prev.json`;
  copy candidate → `spots_model.json.tmp` → rename over `spots_model.json`
  (`fs.renameSync` replaces on Windows; on `EPERM`/`EBUSY` retry once after 200 ms,
  then 500 with nothing half-written). Restore swaps the two the same way. Never
  delete anything in `data/`.
- **Training is async**: `POST /spots/train` → `202 {training}`; state lives in the
  `teach.ts` singleton (`globalThis`, `Symbol.for("lifefi.teach")`) as
  `{state:"running"|"done"|"failed", started_ms, ended_ms, result|error}` and is
  returned by `GET /api/v1/spots` (polled every 1 s while running). A phone that
  sleeps does not lose the result.
- **`runPython(args, {timeoutMs, spawnFn})`**: `.venv\Scripts\python.exe` /
  `.venv/bin/python` under `repoRoot`, else `python`; `spawn` with no shell,
  `windowsHide: true`, `cwd: repoRoot`, env `PYTHONIOENCODING=utf-8`,
  `PYTHONUNBUFFERED=1`; keep only the last 64 KB of stdout/stderr; timeout 180 s →
  Windows `spawnSync("taskkill", ["/pid", pid, "/T", "/F"])`, else `kill("SIGKILL")`;
  resolves `{code, stdout, stderr, timedOut}`. `spawnFn` is injectable for tests.
- **Paths**: the client sends only session ids; each must match
  `^spots-\d{8}-\d{6}$` **and** be an `ok` entry of `listSessions()`; dirs are built
  with `sessionDir(id)`. `--out` is always `<dataDir>/spots_model.candidate.json`.
  A new teach session whose dir already exists → 409.
- **Locks** (all 409 `conflict`): start teach while `ctx.state.recording`, a teach
  run, training, or an engine calibration job is active, source not live, or engine
  not connected; train while a teach run or training is active; restore while
  training. `recordings/start` already 409s during a run (recording is set).
- **Abort conditions** (each: `record_stop`, `teach.json {state:"aborted", reason}`,
  no `spots.json`): user stop; engine disconnected > 5 s; `source.mode` not live;
  `ctx.state.recording` null or another session (engine restart, runtime.ts:125, or
  stopped from /label); **board gone**: no result for 10 s or
  `latest.health.rate_hz < 10` for 10 s. `record_stop` failing because the engine
  is gone is logged, not thrown.
- **Server restart mid-run** (not a hot reload): the run is lost; the engine may still
  be recording. Out of scope; the listing shows the dir as "stopped early (no
  spots.json)". Document in api.md.

### R4. Honesty (replaces the result card headline rules)

- Headline is `loso_bal_acc` floored to whole percent, with chance `1/k` and the bar
  `1/k + margin` on the same line, plus every per-left-out-session score.
  `holdout_accuracy` only under "Details", labelled "chosen on the same split,
  optimistic".
- When `loso_bal_acc <= 1/k + 0.05` the card says, in plain words: **"Not better
  than chance: the model cannot tell these spots apart from another visit. Spots
  need a fixed transmitter"** with a link to `/setup?step=transmitter`. Between
  that and the bar: "Better than chance but not reliable yet: the dashboard will not
  show spot names. Record another session." The current-model card follows the same
  rules. Never show a spot accuracy without the chance level next to it.
- Training with sessions of `transmitter !== "fixed"` (incl. old ones) shows the
  line "Includes phone-hotspot sessions: their signal moves between visits."

### R5. Client timing

The page gets the whole schedule once and computes the current step locally every
250 ms from `Date.now() + skew` (skew from each poll's `server_now_ms`), so the
spoken prompt fires at `t0`, not up to 1 s late on the next poll. Polling (1 s)
only refreshes state/abort. Speak once per step id; "Test voice" unlocks speech on
iOS.

### R6. Order (each step ends with its tests green, so a partial finish ships)

| # | Step | Time |
|---|---|---|
| 1 | `train_spots.py`: `main(argv=None)` + argparse (positional dirs, `--out`, `--json`), skip dirs without `spots.json`/`.csirec` with a printed reason, exit 2 on < 1 usable session or differing label sets; `METRICS {json}` line (`allow_nan=False`, plain floats). `ml/tests/test_train_spots.py` | 20 min |
| 2 | `Engine.load_spots()` + reload ack + `engine/tests/test_spots.py` reload case; control.md line | 10 min |
| 3 | `python.ts`, `teach.ts` pure parts (`listSessions`, `shouldPromote`, `install`/`restore`, `parseMetrics`, train job), routes `GET /spots`, `POST /spots/train`, `POST /spots/restore`, `readSpotsSummary` in position-files; vitest. **Milestone: retrain works over the API.** | 30 min |
| 4 | `/teach` page with the **training panel only** (sessions table, Train, result card, restore) + StepSpots link | 20 min |
| 5 | `buildSchedule`, `TeachRun`, `GET/POST /spots/teach`, `/teach/stop`, `PUT /source` guard; vitest with fake ctx + fake timers | 25 min |
| 6 | Record panels (before/recording) on `/teach`; api.md, models.md; full vitest/tsc/lint/python pass | 15 min |

### R7. Tests (replaces §6 where different)

- vitest never runs Python: `runPython` tests use a fake `spawnFn` returning an
  EventEmitter child (exit 0 with a `METRICS` line; never exits → timeout →
  taskkill args asserted via an injected `killFn`). Train route test stubs
  `runPython` and uses a tmp `dataDir` with fake session dirs and model files.
- `listSessions`: reads top-level `transmitter`; `_invalid/` ignored; `teach.json`
  → "stopped early"; ids not matching the pattern ignored.
- `TeachRun`: full run → `spots.json` has exactly the empty/hold steps, `t0_us/t1_us`
  equal schedule ms × 1000, shape loadable by `train_spots.load` (asserted in the
  Python test with a file written in that shape); stop → no `spots.json`; board gone
  (no result 10 s) → aborted; recording cleared from outside → aborted; second start
  → 409; `PUT /source` → 409 while recording.
- Python (`ml/tests/test_train_spots.py`, plain script, `check()` style like
  `ml/tests/test_own.py`): fake `train_spots.load_csirec` returning
  `{host_us, csi, rssi}` arrays built per spot (amplitude/RSSI level per spot plus
  noise; `engine/lifefi/synth.synth()` can supply the base CSI if its shapes fit);
  2-3 sessions in a tmp dir, each with empty at start **and** end: separable →
  `loso_bal_acc > 0.9`; noise → `< 0.5`; `--out` writes only there; `--json` gives
  one parseable `METRICS` line with `len(loso_by_session) == sessions`; one session →
  `loso_bal_acc` null; dir without `spots.json` skipped; differing label sets → exit 2.
- Engine: write model A, `Engine(calibration_path=tmp/calibration.json)`, overwrite
  with model B, `handle reload_models` → `spot_model.labels == B`, margin from rules;
  bad JSON → old model kept.

---

Planner draft, for the critic. The worker starts **after tracks A and C have
finished** (both still edit `engine/`, `ml/`, `ui/src/server/`, `ui/src/app/api/`).
Budget: **≤ 2 h**. Ground rules: `docs/overnight/README.md` (no git writes, no mock
data in the app, never flash, board not connected: nothing here can be run end to
end tonight; tests use fakes and synthetic data).

## 0. Why and what

The spot model (`engine/lifefi/spots.py`) is below chance across the two existing
sessions (LOSO 0.19, chance 0.25), recorded with a moving phone hotspot. In the
morning the owner installs a fixed transmitter (track D) and must record **3+ new
labelled sessions**, each starting and ending with ~60 s of empty room
(OPEN-QUESTIONS #4), then retrain. Today that needs `ml/record_spots.py --say` in a
terminal and `ml/train_spots.py` by hand. Track F adds a `/teach` page that:

1. records one labelled session with big visual and spoken prompts, timed by the
   **server** (so a sleeping phone or a skewed phone clock cannot corrupt labels);
2. lists the sessions, trains on the chosen ones (leave-one-session-out), shows the
   honest cross-session accuracy next to chance and the `reliable` bar;
3. installs the new model only when it is not worse than the current one, keeps the
   old one as a backup, and makes the engine reload it.

## 1. What exists (read before coding)

| Piece | Fact that matters |
|---|---|
| `ml/record_spots.py` | Calls `POST /recordings/start {session, meta:{kind:"spots"}}`, follows a schedule, `POST /recordings/stop`, then writes `data/sessions/<id>/spots.json` = `{session, spots:[{name, d_m, t0_us, t1_us}]}` in **host-clock µs** of the PC. Session id `spots-YYYYMMDD-HHMMSS`. Spoken names: `close`, `middle`, `far`, `empty`. |
| `ml/train_spots.py` (A's final) | Positional session dirs (default: every `data/sessions/spots-*`), 2 s windows, LDA, shrink picked on the split score, writes `data/spots_model.json` with `loso_bal_acc` + `loso_by_session` when ≥ 2 sessions (scored on windows 2 s from each spot's ends). Repeated spot names in one `spots.json` already work (labels are deduplicated). **No `--out`, no machine-readable output, crashes on a dir without `spots.json`/`.csirec`.** |
| `ml/eval_position.py` (A) | Hard-codes `LABELS = ["close","middle","far","empty"]` and "empty is recorded last" (its `fresh` reference). Takes ~2 min with the engine replay. **Not used for the training gate**: `train_spots.py`'s own `loso_bal_acc` is the number the engine trusts, so it is the number we show. The page links to the CLI harness for the deep dive only. |
| `engine/lifefi/spots.py` | `SpotModel.load(path, margin)`; `reliable()` = `loso_bal_acc ≥ 1/k + margin` (`rules.yaml spots.reliable_margin`, 0.15). |
| `engine/lifefi/engine.py` | Loads `spots_model.json` **only in `__init__`** (line ~136). `reload_models` (control command) calls `load_models()`, which does **not** touch the spot model. `load_rules()` sets the margin only if a model is loaded. → needs a small change (§4). |
| Recordings API (C) | `POST /api/v1/recordings/start` (live only, 409 if one is running, writes `session.json` = header + `meta`), `/stop` (ack `{frames, t_start_us, t_end_us}`), segments/marks into `labels.jsonl`. `ctx.state.recording` is the single-recording lock. |
| `ui/src/server/position-files.ts` (C) | `readPositionFiles()` → `spots` summary for `GET /api/v1/position` (labels, distances, `holdout_accuracy`, session, trained_at). No `loso_bal_acc` yet. |
| `scripts/python.mjs` (C) | `.venv` python lookup, ESM outside `ui/` (Next cannot import it cleanly): re-implement the 5 lines in TS. |
| Setup wizard (B) | `ui/src/components/setup/StepDone.tsx` `StepSpots` tells people to use /label + the CLI. It becomes a link to `/teach`. |
| `data/sessions/` | Two valid sessions (phone hotspot), `_invalid/` holds bad ones. Never delete anything there. |

## 2. User flow (`/teach`, three panels on one page, mobile first)

Page header: "Teach spots" + one line: "Record where people usually are, then train.
Needs the board live and a fixed transmitter." Link from Setup → Spots step and from
the Setup menu. The page polls `GET /api/v1/spots/teach` every 1 s while a run is
active, `GET /api/v1/spots` otherwise (on load and after actions).

### 2.1 Panel A, "Before you record"

- **Readiness checks** (green/red rows, from `/api/v1/health` / status already used
  by the wizard): engine connected; source is `live`; readings arriving (rate ≥ 20 Hz);
  no recording in progress; no training running. The Start button is disabled with the
  failing reason shown until all pass.
- **Transmitter**: radio "Fixed (router or 2nd ESP32)" / "Phone hotspot". Default
  "Fixed" when `rules.yaml position.transmitter_fixed` is true, else unselected (must
  pick). Stored in the session meta; training pre-selects only `fixed` sessions.
- **Spots**: an editable list, default `close 0.5 m`, `middle 1.5 m`, `far 3.0 m`
  (names `^[a-z][a-z0-9_]{0,15}$`, not `empty`, 2–6 spots, distance 0.2–10 m, "measure
  it with a tape, from the sensor"). The list is remembered in `localStorage` (try/catch)
  so sessions 2 and 3 reuse exactly the same names: training needs the same labels in
  every session. A warning shows if the names differ from the last recorded session's.
- **Timing** (collapsed "Advanced"): hold per spot 45 s (30–120), empty 60 s (60–180,
  floor 60 = the engine's empty-calibration minimum), walk gap 10 s (5–30), rounds 2
  (1–3). Shows the total, e.g. "about 8 min".
- **Voice**: "Test voice" button (speaks "Voice is working"; this click also unlocks
  `speechSynthesis` on iOS/Safari, which needs a user gesture). Checkbox "Also speak
  from the dashboard computer" (Windows only, off by default; server runs the same
  PowerShell `System.Speech` call as `record_spots.py`, for when the phone locks).
- Big **Start** button → PIN prompt (existing `usePin`) → `POST /api/v1/spots/teach`.

### 2.2 Schedule of one session (built server-side, pure function)

```
lead 20 s   "Leave the room and close the door. Empty room recording starts in 20 seconds."
empty 60 s  "Recording the empty room. Stay outside for 60 seconds."           (labelled empty)
walk 15 s   "Come in and stand at close, 0.5 metres from the sensor."           (unlabelled)
hold 45 s   "Recording close. Stay there, move normally, 45 seconds."           (labelled close)
walk 10 s   "Stop. Go to middle, 1.5 metres."  ... middle, far
-- round 2: reversed order (far, middle, close), so position is not confounded with time --
walk 15 s   "Leave the room and close the door."
empty 60 s  "Recording the empty room again. Stay outside for 60 seconds."    (labelled empty)
end         "All done. You can come back."
```

There is always a walk between two holds, also far → far at the round boundary ("Step
away, then come back to far"): a re-entered spot is a new visit. Last 3 s of every
walk: "3, 2, 1" spoken and shown. Default total (3 spots, 2 rounds): 20 + 60 + 15 +
6·45 + 5·10 + 15 + 60 = 490 s ≈ 8 min; rounds 1 ≈ 5 min. Recording starts at the beginning
of `lead` (like `record_spots.py`, which starts 5 s early) and stops at the end of the
last empty; only `empty`/`hold` steps go into `spots.json`.

### 2.3 Panel B, "Recording" (replaces A while a run is active, also after a reload)

- Full-width phase band, colour by phase: **empty** = neutral/blue "Room must be
  empty", **walk** = amber "Move now", **hold** = green "Stay here".
- The instruction in very large type (≥ 40 px on a phone): "Stand at FAR · 3 m".
- A giant countdown (seconds left in this step, ≥ 96 px, tabular numerals), computed
  from the server's `step.t1_ms` with the skew `server_now_ms − Date.now()` taken from
  each poll.
- "Next: middle · 1.5 m" underneath; a thin progress bar "step 7 of 14 · 4:10 left".
- Live sanity line (small): readings/s from status; if it drops under 10 Hz the band
  shows "Signal lost: this session may be unusable" (the server aborts after 10 s, §3.3).
- **Stop** button (secondary, confirm "Stop and discard this session?") →
  `POST /api/v1/spots/teach/stop`.
- Speech: the client speaks each step's `say` text once when the step id changes
  (`speechSynthesis.cancel()` first, rate 0.95), plus the 3-2-1. `navigator.wakeLock`
  `screen` is requested on start and re-requested on `visibilitychange` (try/catch,
  not supported everywhere). `aria-live="assertive"` on the instruction so screen
  readers announce it too. Respect `prefers-reduced-motion` (no pulsing).

### 2.4 Panel C, "Sessions and training" (always visible under A)

- Table of sessions from `GET /api/v1/spots`: date/time, transmitter (`fixed`,
  `phone`, `unknown (old)`), spots, duration, mean rate, status (`ok`, or the problem:
  "no spots.json (stopped early)", "no .csirec", "rate 8 Hz, too low", "spot names
  differ"). A checkbox per valid session; default checked = valid **and** transmitter
  `fixed`. Old phone-hotspot sessions stay unchecked (their RSSI flips between
  sessions) but can be ticked.
- Progress hint: "2 of 3 recommended sessions with the fixed transmitter. Record
  another one later (different time of day) for a fairer score."
- **Train** button (PIN), disabled under 2 ticked sessions ("Training needs at least 2
  sessions: the score is measured on a session the model never saw"). Shows a spinner
  with elapsed seconds while `POST /api/v1/spots/train` runs (sync, ≤ 180 s).
- **Result card** (from the response, also persisted as the candidate's metrics):
  - headline: "Across sessions: 58 % (chance 25 %, needs 40 % to be used)", i.e.
    `loso_bal_acc`, `1/k`, `1/k + margin`; verdict word: **Reliable** / **Not reliable
    yet** (honesty rule: never round up, never show `holdout_accuracy` as the headline;
    it may appear in "Details" labelled "within one session, optimistic");
  - per left-out session accuracy (each one, not only the mean);
  - confusion matrix (small table) from the script's split;
  - decision line: "Installed. The previous model is kept as a backup." or "Not
    installed: worse than the current model (31 % vs 44 % across sessions)." with a
    secondary "Install anyway" button (confirm) → `POST /api/v1/spots/promote
    {from:"candidate"}`.
- Current model card: labels, trained_at, sessions used, cross-session accuracy or
  "not measured (one session or older file): never shown as reliable", and a
  "Restore previous model" button when a backup exists (`{from:"previous"}`).

## 3. Server and API

All new server code in **`ui/src/server/teach.ts`** (pure functions + one small run
object) and **`ui/src/server/python.ts`**. Routes use `read()`/`write()` from
`http.ts` (PIN on writes). Shapes documented in `contracts/api.md` (C) under
"Spots".

### 3.1 Routes

| Route | Method | Body / answer |
|---|---|---|
| `/api/v1/spots` | GET | `{model: Summary\|null, previous: Summary\|null, candidate: Summary\|null, margin, sessions: SessionInfo[], teach: RunState\|null, training: {started_ms}\|null}` |
| `/api/v1/spots/teach` | GET | `RunState\|null` (cheap, polled every 1 s): `{session, state: "running"\|"done"\|"aborted", reason, server_now_ms, steps: Step[], index, started_ms, ends_ms}` where `Step = {id, kind: "lead"\|"empty"\|"walk"\|"hold"\|"end", name, d_m, t0_ms, t1_ms, say}` |
| `/api/v1/spots/teach` | POST | (R2) `{distances: {close, middle, far}, rounds: 1\|2, transmitter: "fixed"\|"phone"}` → `RunState`. 400 on bad input; 409 when a recording, run or training is active, source not live, or engine not connected; engine errors via `engineFail`. |
| `/api/v1/spots/teach/stop` | POST | aborts: stops the recording, writes **no** `spots.json`, writes `teach.json {state:"aborted", reason:"stopped by user"}` in the session dir → `RunState` |
| `/api/v1/spots/train` | POST | `{sessions: string[]}` (≥ 2, each must be a valid session id from the listing) → (R3, async) `202 {training}`; the job's result `{metrics, promoted, reason, engine_reloaded, model: Summary}` (or `error` = timeout / last 20 stderr lines) appears in `GET /spots` `training`; 409 if training or a run is active; 400 on unknown ids or differing label sets |
| `/api/v1/spots/restore` | POST | (R3) no body → swaps `spots_model.json` and `.prev.json`, then `reload_models` → `{model: Summary, previous: Summary\|null}`; 409 when there is no backup or training runs |

`Summary = {labels, distances, loso_bal_acc|null, loso_by_session|null, chance,
reliable, sessions: string[], trained_at_ms, holdout_accuracy}` (`reliable` computed
with the margin read from `rules.yaml`, same formula as `spots.py`). `margin` comes
from the existing rules loader if it exposes `spots`, else parse `engine/config/rules.yaml`
`spots.reliable_margin`, default 0.15.

### 3.2 Files on disk (same format as the CLI, so both agree)

- `data/sessions/spots-YYYYMMDD-HHMMSS/` (server local time, same id format as
  `record_spots.py`):
  - `<id>.csirec` (engine), `session.json` (start route; `meta` = `{kind:"spots",
    transmitter, protocol:"teach-v1", spots:[{name,d_m}], hold_s, empty_s, gap_s, rounds}`);
  - `spots.json` written **only on a complete run**: exactly `record_spots.py`'s shape
    `{session, spots:[{name, d_m, t0_us, t1_us}]}` with `empty` entries `d_m: 0.0`, plus
    extra keys the scripts ignore: `"frames"` (from the stop ack), `"protocol":
    "teach-v1"`, `"transmitter"`. Times are the server's `Date.now()*1000` schedule
    times (host clock, same as the engine's `host_us`).
  - `teach.json` on abort (reason), so the listing can say why there is no `spots.json`.
- `data/spots_model.json` (current, read by the engine), `data/spots_model.prev.json`
  (backup), `data/spots_model.candidate.json` (last training output, with an extra
  `"metrics"` key holding the full metrics block).

`ml/record_spots.py` keeps working unchanged; its sessions show as transmitter
`unknown (old)`.

### 3.3 The run (server-side timing)

`buildSchedule(opts, startMs)` is pure (tested). `TeachRun` (module singleton on
`globalThis`, like the runtime context, so Next dev reloads do not lose it):

- `start`: validate; take the locks; `startRecording(ctx, session, meta)` (helper
  extracted from the `recordings/start` route, §4); one `setInterval(500 ms)` ticks:
  advances `index` by time, speaks on the server when `speak_server` (fire-and-forget
  `powershell` spawn, `windowsHide`, text from the schedule only, single quotes
  escaped), and checks health.
- **Abort conditions** (each sets `state:"aborted"`, stops the recording, writes
  `teach.json`): user stop; engine disconnected > 5 s; source no longer `live`;
  `ctx.state.recording` gone or a different session (someone stopped it from /label);
  no result for 10 s. Never writes `spots.json` then.
- At `ends_ms`: `stopRecording(ctx)` (helper), write `spots.json`, `state:"done"`,
  clear the interval. Finished/aborted state stays readable until the next start.
- Locks: `ctx.state.recording` (existing) + `run` + `training` flags in `teach.ts`.
  Starting a run while training, or training while a run is active → 409.

### 3.4 Training

`runPython(args, {timeoutMs})` in `python.ts`: `.venv\Scripts\python.exe` /
`.venv/bin/python` under `repoRoot`, else `python`/`python3`; `spawn` with
`cwd: repoRoot`, `windowsHide: true`, no shell; on timeout kill the tree (Windows:
`taskkill /pid <pid> /T /F`, else `SIGKILL`); returns `{code, stdout, stderr}`.

`POST /spots/train`:

1. Validate ids against `listSessions()` (only `ok` sessions; no paths from the client:
   dirs are built server-side from `sessionDir(id)`; this is the path-injection guard).
2. `runPython(["ml/train_spots.py", "--out", candidatePath, "--json", ...dirs], 180 s)`.
3. Parse the line starting `METRICS ` (last one) → metrics; non-zero exit → 500.
4. **Promotion gate** (pure function `shouldPromote(candidate, current, margin)`,
   tested): compare **margin over chance** (`loso_bal_acc − 1/k`) so models with
   different spot sets compare fairly.
   - candidate `loso_bal_acc` null → never auto-install ("needs ≥ 2 sessions");
   - current missing or its `loso_bal_acc` null → install;
   - else install iff `cand_margin ≥ cur_margin − 0.02` (a tie within noise favours the
     newer data, which has the fixed transmitter).
5. Install = copy current → `.prev.json` (overwrite the older backup), rename candidate
   → `spots_model.json` (write to temp + rename, so the engine never reads half a file),
   then `ctx.engine.send("reload_models")`. If the engine is not connected, the file
   is still installed and the answer says "the engine will load it on its next start".

Installing a model that is still below the `reliable` bar is fine: the engine keeps
the spot hidden (A's honesty rule). The card says so.

## 4. Changes to other tracks' files (after A and C finish; keep them small)

| File (owner) | Change |
|---|---|
| `ml/train_spots.py` (A) | `argparse`: positional dirs (unchanged default), `--out PATH` (default `data/spots_model.json`), `--json` (print one final line `METRICS {...}`: `sessions`, `labels`, `windows` per session per label, `chance`, `shrink`, `split_bal_acc` (the current printed number), `how`, `confusion`, `loso_bal_acc`, `loso_by_session`). Skip (with a printed reason) dirs without `spots.json` or `.csirec`; exit 2 when < 1 usable session or a label has no windows. Same numbers as today for the same input. |
| `engine/lifefi/engine.py` (A) | Move the spot-model load into `load_models()` (path = `calibration_path.with_name("spots_model.json")`, margin from `self.rules["spots"]`), so `reload_models` picks up a new file; keep `self.spot_model = None` when absent. A load error (bad JSON) logs and keeps the old model. |
| `engine/tests/test_spots.py` (A) | One test: write model A, build the engine (or call the loader the way existing tests do), overwrite with model B, `reload_models` → labels of B, margin applied. |
| `ui/src/server/recordings.ts` (C) | Extract `startRecording(ctx, session, meta)` and `stopRecording(ctx)` from the two routes (same behaviour, same errors), used by the routes and `teach.ts`. |
| `ui/src/app/api/v1/recordings/start/route.ts`, `stop/route.ts` (C) | Call the helpers. |
| `ui/src/server/position-files.ts` (C) | Additive: `loso_bal_acc` in `SpotsSummary` (reuse its reader in `teach.ts` instead of a second parser). |
| `contracts/api.md` (C) | Document the five routes. |
| `ui/src/components/setup/StepDone.tsx` `StepSpots` (B) | Primary button "Teach spots" → `/teach`; keep "Open Labelling" secondary. Add `/teach` to the Setup menu where B lists `/model` and `/label`. |
| `docs/models.md` (A) | Short "Retrain from the dashboard" paragraph. |

## 5. New files (worker)

- `ui/src/server/teach.ts`: `buildSchedule`, `validateTeach`, `listSessions(dir)`,
  `readModelSummary`, `shouldPromote`, `installCandidate`/`restorePrevious`,
  `TeachRun` (start/stop/state), `parseMetrics`.
- `ui/src/server/python.ts`: `findPython`, `runPython`.
- `ui/src/app/api/v1/spots/route.ts`, `spots/teach/route.ts`,
  `spots/teach/stop/route.ts`, `spots/train/route.ts`, `spots/restore/route.ts` (R3)
  (all `export const dynamic = "force-dynamic"`; check
  `ui/node_modules/next/dist/docs/` for route handler specifics as the other routes do).
- `ui/src/app/teach/page.tsx` + `ui/src/components/teach/TeachSetup.tsx`,
  `TeachRunView.tsx`, `TeachTrain.tsx`; `ui/src/lib/teach.ts` (client: API calls,
  `speak()`, wake lock, countdown math `secondsLeft(step, skew)`, pure and tested).
- Tests: `ui/test/teach.test.ts`, `ui/test/spots-train.test.ts`,
  `ml/tests/test_train_spots.py`.

## 6. Tests

**vitest** (`cd ui; npx vitest run`), no engine, no python except where stubbed:

- `buildSchedule`: order (lead, empty, round 1 forward, round 2 reversed, empty, end),
  contiguous `t0/t1`, total duration, every `hold`/`empty` gets a `say`, walk ≥ 5 s.
- `validateTeach`: bad names (`empty`, duplicates, uppercase, > 6), distances, timing
  bounds, transmitter required.
- `listSessions` on a tmp dir: ok session; no `spots.json` + `teach.json` → "stopped
  early"; no `.csirec`; `_invalid/` ignored; transmitter from `session.json` meta,
  `unknown` when absent; rate from `frames` / duration.
- `shouldPromote`: null candidate; no current; current null loso; better; worse;
  tie within 0.02; different k compared by margin over chance.
- `installCandidate` / `restorePrevious` on a tmp dir: backup written, candidate
  renamed, previous restore swaps; never leaves no `spots_model.json` behind.
- `TeachRun` with a fake ctx (fake `engine.send` recording calls, fake timers
  `vi.useFakeTimers()`): full run writes `spots.json` in the `record_spots.py` shape
  with exactly the hold/empty steps; stop mid-run → no `spots.json`, `teach.json`
  aborted, `record_stop` sent; engine disconnect → aborted; second start → 409.
- `parseMetrics`: picks the last `METRICS` line, rejects garbage.
- `runPython` with a tiny inline script (`-c "print('METRICS {}')"`) and a sleeping one
  for the timeout kill, skipped when no python is found.
- `secondsLeft` with clock skew.

**Python** (`.venv\Scripts\python ml\tests\test_train_spots.py`, picked up by
`scripts/test-all.mjs`): fake two/three sessions by monkeypatching
`train_spots.load_csirec` (as `ml/tests/test_own.py` fakes its loader) and writing
`spots.json` files in a tmp dir: separable spots → `loso_bal_acc` > 0.9; noise → near
chance; `--out` writes there and not to `data/`; `--json` prints a parseable
`METRICS` line with `loso_by_session` of length = sessions; one session → no
`loso_bal_acc`; a dir without `spots.json` is skipped; repeated `empty` entries in one
session (start + end) work.

**Engine**: the `test_spots.py` reload case (§4).

Manual (morning, with the board): one 5-minute session with rounds 1 end to end,
check `spots.json` against `session.json` times and that the CLI
`ml/train_spots.py --out` on it gives the same numbers as the page.

## 7. Acceptance criteria

1. `/teach` renders on a 375 px phone with no horizontal scroll; Start is disabled
   with a reason when the engine is not live (tonight: replay/no board → disabled,
   no mock run).
2. A completed run writes `spots.json` that `ml/train_spots.py` and
   `ml/eval_position.py` load without change (test with fake timers + fixture).
3. A stopped/aborted run never writes `spots.json`; nothing in `data/` is deleted.
4. Training with < 2 sessions is refused; with ≥ 2 it shows `loso_bal_acc`, chance,
   the reliable bar, per-session scores; `holdout_accuracy` is never the headline.
5. A worse candidate is not installed; installing keeps `spots_model.prev.json`;
   "Restore previous" works; the engine gets `reload_models` and actually reloads the
   spot model (engine test).
6. Only one run or training at a time (409s tested); training is killed after 180 s.
7. `npx vitest run`, `npx tsc --noEmit`, `npm run lint -w ui`, every engine and ml
   test script pass; CLI `record_spots.py` / `train_spots.py` with no new flags behave
   as before.

## 8. Order and budget (≤ 2 h)

| # | Step | Time |
|---|---|---|
| 1 | `train_spots.py` flags + `test_train_spots.py` | 20 min |
| 2 | engine spot reload + test | 10 min |
| 3 | `recordings.ts` helpers, `python.ts`, `teach.ts` (pure parts) + vitest | 30 min |
| 4 | `TeachRun` + five routes + vitest (fake ctx/timers) | 25 min |
| 5 | `/teach` page (three panels, speech, wake lock, countdown) + StepSpots link | 30 min |
| 6 | api.md, models.md, full test/lint/typecheck pass | 5 min |

Cut first if late: server-side speech, "Restore previous" button (keep the backup
file), confusion matrix display.

## 9. Risks

- **Not runnable end to end tonight** (no board): the run is covered by fake-engine
  tests only; the morning manual check in §6 is required before trusting it.
- Spot names must match across sessions; the page reuses the last list and warns, and
  `listSessions` flags a session whose names differ from the selected majority.
- A tab-sleeping phone misses spoken prompts; timing and labels stay correct
  (server-side), and the server-voice option covers the gap on the PC.
- `ml/eval_position.py` stays 4-label and "empty last"; new sessions (empty first and
  last) load fine there (`empty_spot` takes the first empty, which is now
  a calibration-before), custom spot names would break it: documented, not fixed here.

## Worker report

**Shipped (all six R6 steps):**
1. `ml/train_spots.py`: `main(argv)` + argparse (`--out`, `--json` → one `METRICS {...}` line, `allow_nan=False`); skips dirs without `spots.json`/`.csirec` with a reason; exit 2 on no usable session or differing label sets. Same numbers as before on the two real sessions (holdout 0.189, shrink 0.3; LOSO 0.169, run to a temp `--out`). `ml/tests/test_train_spots.py` (7 cases, fake `load_csirec`).
2. `Engine.load_spots()` (called after `load_rules()` and on `reload_models`; bad JSON keeps the old model, missing file → None); ack adds `spots: {labels, loso_bal_acc} | null`; `contracts/control.md` row; reload cases in `engine/tests/test_spots.py`.
3. `ui/src/server/python.ts` (`runPython`, injectable spawn/kill, taskkill tree on Windows), `ui/src/server/teach.ts` (sessions listing, `shouldPromote` per R3, tmp+rename install/restore, async training job in a `globalThis` singleton, readiness checks, `buildSchedule`, `TeachRun` with all R3 abort conditions), `readSpotsFile` in `position-files.ts`, `startRecording`/`stopRecording` helpers in `recordings.ts` (routes use them), `PUT /source` 409 while recording. Routes: `GET /spots`, `GET|POST /spots/teach`, `POST /spots/teach/stop`, `POST /spots/train` (202), `POST /spots/restore`.
4–6. `/teach` page (`app/teach/page.tsx`, `components/teach/TeachRecord.tsx`, `TeachTrain.tsx`, `lib/teach.ts`): readiness list, transmitter, fixed spot names with editable distances (localStorage), rounds 1/2, test voice, run view (phase band, big instruction + countdown from the server clock at 250 ms, next step, progress, speech once per step + 3-2-1, wake lock, Stop with confirm), sessions table, Train, honest result/current-model cards (R4 wording, chance + bar on the same line, per-session scores, holdout only under Details), Restore previous. StepSpots → "Teach spots" primary; Setup menu entry. `contracts/api.md` Spots section, `docs/models.md` paragraph.

**Checks:** `npm test` 17 passed, 1 skipped (features_vectors), 0 failed; vitest 174 passed (18 in `teach.test.ts`, 3 in `teach-client.test.ts`); `npx tsc --noEmit` clean; `npm run lint -w ui` clean. `GET /api/v1/spots` checked on `next dev` against the real data dir (2 old sessions listed as transmitter unknown, current model "not measured", Start blocked: engine not connected); `/teach` SSRs 200.

**Not verified:** the page in a browser: the Browser pane never hydrated any page (HMR websocket refused, every page stuck on "Compiling…"), so the client UI is type/lint-checked only. No end-to-end run (no board): the morning manual check in §6 still applies.

**Dropped (per R2):** server-side speech, editable spot names, Advanced timing, Install anyway, confusion matrix display.

**For the orchestrator:** other agents edited files at the same time as me; `docs/models.md` and `ui/src/components/TopBar.tsx` contain their changes as well as mine (mine: the "From the dashboard" paragraph; the one `/teach/` menu row). `ui/next-env.d.ts` was already modified before I started (not mine).
