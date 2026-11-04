# Track V — vital signs in the engine (final plan, after critic)

Planner + critic, 2026-11-04. Owner files: `engine/**`, `ml/**`,
`contracts/fixtures/**`, `contracts/*.md`, `docs/models.md`,
`ui/src/server/validate.ts` (no change needed), plus — by orchestrator decision —
the **description text only** of the top-level `heart` property in
`contracts/results.schema.json` and the regenerated `ui/src/lib/contracts.gen.ts`.
Contract shape (commit 38fb377) is fixed: top-level `heart` = null | {bpm|null,
valid, confidence, snr?, valid_share?, reason}; `breathing.reason`. Enum for
both reasons: `warming_up | no_person | motion | noise | unstable | null`.
No git commands that change state. Existing fields of every result must stay
byte-identical; only `breathing.reason` and `heart` are added.

## Facts the worker can rely on (verified)

- `engine/lifefi/heart.py`: `estimate_heart(ts_us, csi) -> [HeartWindow]`
  (30 s at 20 Hz, step 5 s; fields `t_start, bpm, snr, confidence, acf_bpm,
  breath_bpm, valid, reason`). Reason = `"; "`-join of `near breathing harmonic (..)`,
  `at noise floor (snr ..)`, `peak at band/notch edge`, `no clear peak (..)`,
  `several peaks (..)`, `FFT/ACF disagree`, `motion (..)`. Constants
  `WINDOW_S=30`, `MIN_VALID_SHARE=0.3`, `CONSISTENT_BPM=8.0`. **Do not change heart.py.**
- `engine/lifefi/breathing.py`: `BreathWindow` has `band_ratio`, `valid`,
  `reason` (`no clear peak (..)`, `motion/noise (..)`, `FFT/ACF disagree`,
  `drift at band edge`). `STEP_S=5`, `WINDOW_S=30`.
- `engine/lifefi/engine.py`:
  - `_reset_signal()` (called from `__init__` and from `handle()` on
    `set_source`) rebuilds `LiveF`, sets `breath=None`, `breath_at=None`,
    `next_breath=-inf`, `breath_valid=False`, `warm_until=-inf`.
  - `tick(now)`: on `lv.segment != self.segment` (a gap > MAX_GAP_S, or a new
    `boot_id` in `feed()`) it resets fall/position and `next_breath`, **but not
    `self.breath`**. `LiveF.new_segment()` clears the raw buffers, so no
    post-gap window can contain pre-gap packets.
  - `_breathing_step(now)` runs every 5 s on `self.live.raw(30.5)` (one window),
    sets `self.breath, self.breath_at = w[-1], now`, then `self.apnea.on_breathing(...)`.
    It runs **before** presence is updated in the same tick.
  - `breath_valid = breath.valid and present and not warm and now-breath_at <= 10
    and quiet_for >= rules.breathing.low_motion_s (20 s)`. Presence states:
    `present | empty | uncertain`.
  - `_result(now, t_ms, state, level, B, S, post, warm, occ_out=None)` is only
    called from `tick()` (grep confirms).
  - `outputs()` = `{posture, count, activity}`; `ui/src/server/context.ts` (not
    ours) types it exactly. **Keep `outputs.heart` cut.**
- `engine/lifefi/synth.py` has no pulse; `engine/tests/scenarios.py`
  `scenario(name, seed=1)`: 130 s empty (2-min calibration), walk-in moving
  `ENTER=(130,135)`, then 15 /min breathing; `sitting` ends at 260 s, `leave`
  walks out at 200–205 s and ends at 330 s. Every scenario's **first 130 s are
  an empty room** — use that instead of a separate `empty` run.
- Harmonic trap: 15 /min breathing → harmonics 60, 75, 90, 105, 120 /min,
  guard ±3.6 /min (and the per-window fb estimate can be ±0.5 /min off, so the
  harmonics move ±1–2 /min). Use **82** (≥ 6 from 75/90) and **66** (≥ 5 from
  60/75). Never 72, 60, 75, 90, 105. 45–49 and >116 are band-edge risks too.
- CPU (planner, measured): `estimate_heart` on one 30.5 s window ≈ 15 ms at
  90 Hz, every 5 s. No optimisation.
- `ui/src/server/validate.ts` compiles the schema directly; vitest
  (`ui/test/validate.test.ts`) runs every fixture through it ⇒ no code change.
- CI runs `npm run gen:types -w ui` then `git diff --exit-code -- ui/src/lib/contracts.gen.ts`.
- `ml/eval_position.py`: `find_sessions`, `load_session`, `empty_spot`,
  `replay(s, cal=None, cal_at=None, occ_fit=None) -> (rows, ms, cal, occ_ms)`
  (rows = `[(now, result)]`, it does **not** return the engine), `CAL_S`,
  `calibration_mod` MIN_S override pattern in `eval_engine()`. Two sessions in
  `data/sessions/spots-20261031-*` (4 spots × 60 s: close/middle/far/empty).

## Decisions (orchestrator-confirmed)

1. `heart` is an **object** in every result while `rules.yaml heart.publish`
   is true — from the first tick, `{bpm: null, valid: false, confidence: 0.0,
   snr: null, valid_share: 0.0, reason: "warming_up"}`. `heart: null` only when
   `publish: false`. Update the schema's top-level `heart` **description text
   only** to say so, then `npm run gen:types -w ui`.
2. Heart is published only while breathing is valid (`require_breathing: true`).
3. No `heart.py` threshold is changed to get more readings; the real valid
   share is reported.
4. `outputs.heart` stays cut (context.ts belongs to another track).

## Steps (in this order)

### 1. rules (2 min) — `engine/config/rules.yaml`
After the `breathing:` block:

```yaml
heart:                      # lifefi.heart, EXPERIMENTAL (not validated against a pulse sensor)
  publish: true             # false: `heart` is null in every result
  history_s: 60.0           # contract: bpm = median of the valid windows of the last 60 s
  min_still_s: 30.0         # the whole 30 s heart window must be after the last motion
  require_breathing: true   # heart only while breathing is valid (harmonic removal needs its rate)
```
`config_hash` changes — expected (no test pins its value). In the engine read it
as `self.rules.get("heart") or {}` with these defaults, so a rules file without
the block (old configs, test copies) still works.

### 2. engine wiring (20 min) — `engine/lifefi/engine.py`

- `from . import heart` next to the other lifefi imports (match the existing
  import style in the file).
- `__init__` (not `_reset_signal`): `self.heart_ms = deque(maxlen=200)` — call
  timings survive a source switch so the eval can read them.
- `_reset_signal()`: add `self.heart_hist = deque()` (entries `(now, HeartWindow)`),
  `self.heart_last = None`, `self.heart_new = None`, `self.vitals_since = -np.inf`.
- `tick()` segment branch (`if lv.segment != self.segment:`): add
  `self.vitals_since = now`, `self.heart_hist.clear()`, `self.heart_last = None`,
  `self.heart_new = None`. Do **not** touch `self.breath` (would change existing
  breathing output).
- `_breathing_step(now)`: **after** `self.apnea.on_breathing(...)` (so a heart
  failure can never skip apnea), if heart publish is on:
  ```python
  t0 = time.perf_counter()
  try:
      hw = heart.estimate_heart((t_raw * 1e6).astype(np.int64), csi)
  except (ValueError, IndexError, np.linalg.LinAlgError):
      hw = []                     # a numeric edge case must never cost the tick
  self.heart_ms.append((time.perf_counter() - t0) * 1e3)
  if hw:
      self.heart_last = self.heart_new = hw[-1]
  ```
  Same `t_raw, csi` as breathing (reuse the local variables; the conversion
  expression is already computed for breathing — reuse it).
- `tick()`, right after `self.breath_valid = ...` is computed, call
  `self._heart_step(now, present, warm, quiet_for)`:
  - `still = present and not warm and quiet_for >= hr["min_still_s"]`
    (presence + stillness: the physical gate).
  - `not still` ⇒ `heart_hist.clear()` (person left/moved/warm-up: old windows
    belong to another situation).
  - `still` and `heart_new` pending and (`breath_valid` or not
    `require_breathing`) ⇒ append `(now, heart_new)`. If breathing is merely
    invalid, the pending window is **dropped but the history is kept** (one bad
    breathing window must not wipe 60 s of heart history).
  - `heart_new = None` either way; pop entries older than `history_s`.
  - Store `self.heart_gate = still and (self.breath_valid or not require_breathing)`.
- One helper, with a comment saying it is the only place that reads the
  estimators' reason texts:
  ```python
  def _window_reason(w):
      """lifefi.breathing / lifefi.heart window reason text -> contract enum (noise | unstable).
      Motion is NOT taken from the window text: the engine's own motion gate decides it, so the
      reason never says "motion" while the dashboard's motion level shows the person still."""
  ```
  `"unstable"` when every `"; "`-part of `w.reason` starts with `FFT/ACF disagree`;
  `"noise"` otherwise (no clear peak, at noise floor, several peaks, band/notch
  edge, near breathing harmonic, drift at band edge, motion/noise, motion (..)).
  Valid window ⇒ `None`.
- `_vitals_reason(now, state, warm, quiet_for, still_s)` — the shared prefix,
  first match wins:
  1. `warming_up` — `warm`, or `self.breath is None`, or
     `self.breath_at < self.vitals_since`, or `now - self.breath_at > 2 * breathing.STEP_S`.
  2. `no_person` — `state != "present"` (includes `uncertain`; matches the
     schema text "presence is not present").
  3. `motion` — `quiet_for < still_s` (`low_motion_s` for breathing,
     `min_still_s` for heart).
  4. otherwise `None` (caller continues).
- Breathing reason (in `_result`): `None if self.breath_valid else
  (_vitals_reason(..., low_motion_s) or _window_reason(self.breath) or "unstable")`.
  (The final `"unstable"` is unreachable in practice; it keeps the invariant
  `bpm is None ⇔ reason is not None` total.)
- `_heart_out(now, state, warm, quiet_for)`; returns `None` when publish is off:
  - `valid_w = [w.bpm for _, w in heart_hist if w.valid]`,
    `share = len(valid_w) / len(heart_hist)` if `heart_hist` else `0.0`.
  - `valid = heart_gate and len(valid_w) > 0 and share >= heart.MIN_VALID_SHARE
    and max(valid_w) - min(valid_w) <= heart.CONSISTENT_BPM`.
  - `bpm = round(float(np.median(valid_w)), 1) if valid else None`.
  - reason when not valid, first match:
    `_vitals_reason(..., min_still_s)`; then, if `require_breathing` and not
    `breath_valid`: the breathing reason computed above (it is `noise` or
    `unstable` at this point); then, if history empty:
    `_window_reason(heart_last)` or `"unstable"`; then if the last history window
    is invalid: `_window_reason(last)`; else `"unstable"` (too few valid / they
    disagree).
  - `confidence = round(float(np.clip(heart_last.confidence, 0, 1)), 3)` else `0.0`;
    `snr = round(float(max(heart_last.snr, 0.0)), 2)` else `None`;
    `valid_share = round(share, 3)`. Cast everything to Python float/bool
    (`json.dumps` of numpy bools fails).
- `_result(...)`: add keyword params `present_state`/`quiet_for` (only `tick()`
  calls it), add `"reason"` as the **last** key of `breathing`, and
  `"heart": self._heart_out(...)` right after `"breathing"`. Nothing else in the
  dict changes.
- Module docstring step 3: "breathing (lifefi.breathing) and the experimental
  heart rate (lifefi.heart) every 5 s on the same 30 s of raw CSI".

### 3. contract description + types (3 min)
- `contracts/results.schema.json`: change **only** the top-level `heart`
  `"description"` sentence "null when the engine has no heart estimator or has
  not run one yet." to "null when the engine has no heart estimator or
  rules.yaml heart.publish is false; before the first window it is an object
  with bpm null and reason warming_up." Nothing else in the file.
- `npm run gen:types -w ui`; `git diff --stat ui/src/lib/contracts.gen.ts`
  must show only that comment changing.

### 4. synthetic pulse, test-only (5 min) — `engine/lifefi/synth.py`, `engine/tests/scenarios.py`
- `synth(..., heart_bpm=None, heart_db=0.3)`. Only when `heart_bpm` is set:
  `hr = np.random.default_rng(seed + 2000)`; `affected = hr.random(52) < 0.4`,
  `sign = hr.choice([-1.0, 1.0], 52)`; `pulse = sin(2π·heart_bpm/60·t + hr.uniform(0, 6.3))`
  zeroed inside the same `breath_off` intervals and inside `moving`;
  `db += heart_db * np.outer(pulse, sign * affected)`. Insert it **after** all
  draws from `rng` that exist today and do not draw from `rng` at all, so every
  existing call is bit-identical (verify: `test_engine.py sitting` unchanged,
  and a one-off `np.array_equal` of `synth(60, bpm=15)` before/after in a
  scratch script, not committed). Docstring: test-only, a pure sine, real
  pulses are not.
- `scenarios.scenario(name, seed=1, **synth_kw)`: pass `synth_kw` through to
  `synth(...)`. `SCENARIOS` unchanged (test_engine iterates all of them).

**Feasibility probe first (3 min, before step 5):** run the engine on
`sitting` + `heart_bpm=82` (seed 1) and print, for 170–260 s, the share of ticks
with `heart.valid` and the bpm range. If fewer than 20 valid ticks in 200–260 s,
raise the **test signal** (`heart_db=0.5` in the test) — this is the synthetic
input, not a threshold. If still failing, stop and report (do not touch heart.py).

### 5. tests (15 min) — new `engine/tests/test_vitals.py`
Plain script like `test_engine.py` (module docstring, `check()`, prints
`PASSED`/`FAILED`, exit code). Copy its `run()` driver (importing test_engine
would execute it) with two changes: `scenarios.scenario(name, **kw)` and it
returns `(results, eng, now)`. Validate every result with jsonschema
(Draft202012Validator, as test_engine does). **All runs use seed 1** (only the
pulse differs from test_engine's known-good `sitting`), so presence/motion
timings are the ones test_engine already checks — no new flakiness from seeds.

Runs (≈ 4 scenario replays; see Runtime):
- **A** `sitting`, `heart_bpm=82`
- **B** `sitting`, `heart_bpm=66`
- **C** `sitting`, no pulse
- **D** `leave`, `heart_bpm=82`

Checks:
1. (A, B) for `200 <= t <= 260`: ≥ 20 results with `heart.valid`; every
   published heart bpm in the whole run is within ±3 of the pulse;
   `valid_share >= 0.5` whenever valid; `reason is None` whenever valid.
2. (C) never `heart.valid`; whenever `breathing.valid`, `heart.reason in {"noise","unstable"}`.
3. Warm-up (A): for `t < 30`: `heart.reason == breathing.reason == "warming_up"`,
   `heart.bpm is None`. First result: `heart == {"bpm": None, "valid": False,
   "confidence": 0.0, "snr": None, "valid_share": 0.0, "reason": "warming_up"}`.
4. Empty start (A, C): `35 <= t <= 128`: `heart.reason == breathing.reason ==
   "no_person"` whenever `presence.state != "present"` (and assert that is
   true for ≥ 90 % of those ticks — it is the empty room).
5. Motion (A): for `ENTER[0]+2 <= t <= ENTER[1]+15` with `presence.state ==
   "present"`: both reasons `"motion"`. No heart value before `ENTER[1] + 30`
   (the walk-in ends at `ENTER[1]`; heart needs 30 s still after it).
6. Leave (D): no heart and no breathing value for `t >= 210`; for `t >= 240`
   both reasons in `{"no_person", "motion"}`.
7. Consistency, every result of every run: `bpm is None ⇔ reason is not None`
   and `valid ⇔ bpm is not None` (heart and breathing); `0 <= confidence <= 1`;
   `0 <= valid_share <= 1`; if `presence.state != "present"` then both reasons
   in `{"warming_up", "no_person"}`; heart valid ⇒ breathing valid.
8. Source switch (end of A, no extra replay): `eng.handle({"type":"set_source",
   "id":9,"mode":"replay"}, acks.append, now)`, then `r = eng.tick(now+0.5)`:
   `heart.reason == "warming_up"`, `heart.valid_share == 0`,
   `heart.confidence == 0.0`, `breathing.reason == "warming_up"`.
9. Gap (end of B, no extra replay): `eng.live.new_segment()` then `eng.tick(now+0.5)`:
   `heart.bpm is None`, `valid_share == 0`, `len(eng.heart_hist) == 0`.
10. `_window_reason` unit check with hand-built `HeartWindow`/`BreathWindow`
    (`dataclasses.replace` on a real window, or construct directly): every
    reason fragment listed above → expected enum; `"FFT/ACF disagree"` →
    `unstable`; `"FFT/ACF disagree; no clear peak (0.20)"` → `noise`; valid →
    `None`. Guards against wording drift in heart.py/breathing.py.
11. `publish: false`: a fresh `Engine()`, set `eng.rules["heart"]["publish"] = False`,
    feed the first 40 s of C's frames, tick: every result has `heart is None`
    and still validates. (Cheap: 40 s, no calibration needed.)

Also print, not assert: mean/max `eng.heart_ms` per run.

Then run unchanged: `test_engine.py` (all), `test_heart.py`, `test_breathing.py`,
`test_apnea.py`, `test_control.py` — must pass.

### 6. recorded-data plausibility (10 min) — new `ml/eval_vitals.py` → `ml/results/vitals_eval.json`
- `import eval_position as ep` (same `sys.path` setup as eval_position) and
  reuse `find_sessions`, `load_session`, `empty_spot`, `replay`, `CAL_S`, and
  the `calibration_mod.MIN_S` override exactly as `ep.eval_engine()` does
  (fresh 30 s calibration pass, then `nocal` and `fresh` replays). Do not edit
  `eval_position.py`.
- Timing: `replay()` does not return the engine, so wrap the module function
  (`lifefi.heart.estimate_heart = timed(original)`, restored in `finally`) —
  the engine calls `heart.estimate_heart`, so the patch is seen.
- Per session × variant × spot (results with `spot.t0 + 2 <= now <= spot.t1 - 2`):
  ticks, present ticks, share of present ticks with valid breathing / valid
  heart, reason histograms (breathing, heart), published bpm p10/p50/p90 and
  min/max, jumps (consecutive published values differing by > 3 /min breathing,
  > 8 /min heart), heart `valid_share` median when present.
- Raw estimator, ungated: `heart.estimate_heart` / `breathing.estimate_breathing`
  on each spot's packets (load with `ep`'s csirec loader on the same path; use
  the raw complex CSI and the packet timestamps the engine would see) → windows,
  valid share, bpm list. Shows whether gating or the estimator is the bottleneck.
- JSON top-level `"note"`: "No pulse-oximeter or breathing-belt reference was
  recorded: plausibility only (resting adult ranges 6-30 breaths/min, 45-120
  /min), not accuracy. Spots are 60 s each; heart needs 30 s still after the last
  motion plus a valid breathing window, so at most ~25 s per spot can show a
  value. The transmitter was a phone hotspot." Plus `"thresholds": "heart.py
  unchanged"`.
- CLI: `.venv/Scripts/python.exe ml/eval_vitals.py` prints a short table;
  prints `SKIPPED` and exits 0 if no sessions. Not a `test_*` file, so
  `npm test` does not run it. Expect a few minutes (3 replays × 2 sessions);
  run it in the background while doing step 7–8.

### 7. fixtures (3 min) — `contracts/fixtures/`
Add `"reason"` to `breathing` and a `heart` object, consistent with each
fixture's presence/breathing:
- `present_still.json` (present, breathing valid): `breathing.reason: null`;
  `heart: {"bpm": 68.4, "valid": true, "confidence": 0.52, "snr": 9.1, "valid_share": 0.58, "reason": null}`.
- `warmup.json` (uncertain, breathing invalid): `breathing.reason: "warming_up"`,
  heart `{"bpm": null, "valid": false, "confidence": 0.0, "snr": null, "valid_share": 0.0, "reason": "warming_up"}`.
- `empty.json` (empty): `breathing.reason: "no_person"`, heart reason `no_person`
  (bpm null, valid false, confidence 0.08, snr 2.1, valid_share 0.0).
- `present_live_link.json` (present, breathing **valid**): `breathing.reason: null`;
  heart `{"bpm": null, "valid": false, "confidence": 0.21, "snr": 3.4, "valid_share": 0.0, "reason": "noise"}` — the common real case.
- `fall.json`, `position_quality.json`: unchanged (prove both fields stay optional).
Run `node scripts/check-contracts.mjs` and `npm run test -w ui -- validate`.

### 8. docs (5 min)
- `contracts/README.md`: a short "Vital signs" paragraph: `breathing.reason`
  and `heart`, the enum meanings, EXPERIMENTAL / not a medical measurement,
  object-always-while-published, `heart.publish`, heart only while breathing is
  valid, 30 s stillness for heart, 20 s for breathing.
- `docs/models.md`: "Heart rate (experimental)" subsection after the rules
  section: method (short, from heart.py), gating, 60 s median, measured CPU,
  the synthetic result (82 / 66 /min, "a pure sine, easier than a real
  pulse"), the `vitals_eval.json` numbers as measured (whatever they are,
  including 0 % valid), and a Limits row "heart: no reference recording;
  plausibility only". Add `breathing.reason` to the breathing row. Keep "Not a
  medical device". No accuracy claim anywhere.
- `ui/src/server/validate.ts`: untouched.

## Runtime of `npm test` (critic estimate)
`test_vitals.py` = 4 scenario replays of 260–330 s each + a 40 s one. Each
replay costs about what one `test_engine.py` scenario costs (heart adds
~15 ms per 5 s simulated ≈ 1 s per run). Measured on this machine:
`test_engine.py sitting` = **56 s** wall (critic, 2026-11-04), so 4 runs ≈
4 min (+ ~10 s for check 11). Budget: ≤ 5 min added to `npm test`,
well under the 10-min per-file cap. If the measured file time is > 6 min, drop
run B (and check 9 moves to the end of A, after check 8 — re-feed is not
needed since `new_segment()` works on any engine) and shorten D to 260 s via
`until`.

## Acceptance criteria
- Every engine result has `breathing.reason` and (publish on) a `heart` object;
  all validate (jsonschema in Python, Ajv via fixtures in vitest).
- `bpm` null ⇔ `reason` non-null and `valid` ⇔ bpm non-null, heart and
  breathing, every tick. Reason is `no_person`/`warming_up` whenever presence is
  not `present`; `motion` only while the engine's own motion gate is open.
- Synthetic 82 and 66 /min pulses reported within ±3 /min once still ≥ 30 s;
  no pulse ⇒ never a heart value; warm-up / empty / motion / leave / source
  switch / gap ⇒ the matching reason and an empty history.
- Existing tests pass unchanged; existing result fields unchanged (synth
  bit-identical for old arguments).
- Schema: only the top-level `heart` description text changed;
  `contracts.gen.ts` regenerated and committed-ready.
- `ml/results/vitals_eval.json` exists, states there is no ground truth, and
  reports the real valid shares; heart.py untouched.
- `npm run typecheck`, `npm run lint`, `npm test` green.

## Commands
```
.venv/Scripts/python.exe engine/tests/test_vitals.py
.venv/Scripts/python.exe engine/tests/test_engine.py
.venv/Scripts/python.exe engine/tests/test_heart.py
.venv/Scripts/python.exe engine/tests/test_control.py
.venv/Scripts/python.exe ml/eval_vitals.py          # background, a few minutes
npm run gen:types -w ui
node scripts/check-contracts.mjs
npm run test -w ui -- validate
npm run typecheck && npm run lint && npm test       # repo root, last
```

## Risks
- Reason text drift → one helper + unit check 10.
- Synth change perturbs old tests → separate RNG, no draws from `rng`, verify.
- Heart almost never valid on real data (likely: 60 s spots, 30 s stillness,
  phone TX, harmonics). Honest outcome; report it, no tuning.
- `json.dumps` on numpy types → cast to float/bool in `_heart_out`.
- Track M must render `heart` null/absent too (older engines, `publish: false`).

## Time estimate (one worker, ~60 min)
rules 2 · engine 20 · schema text + gen 3 · synth/scenarios 5 · probe 3 ·
test_vitals 15 · eval script 7 · fixtures 3 · docs 5 = 63 min, plus the
`npm test` run (~10–15 min, overlap with docs).

## Cut (not tonight)
- `engine.outputs.heart` in get_status (needs `ui/src/server/context.ts`, other track).
- Heart in `/history` rows (track M).
- Any `heart.py`/`breathing.py` threshold change (no reference; fitting noise).
- Incremental heart estimator / CPU optimisation.
- Separate `--synthetic` mode in `eval_vitals.py`; a gap scenario replay (check 9
  covers the reset path directly).

## Critic revisions
1. **Motion reason from the engine gate only.** The plan mapped window texts
   `motion (..)` / `motion/noise` to `motion`; those fire on a low band ratio
   while the engine's motion level can show the person still, so the UI would
   say "moving" under a "still" motion bar. Now `motion` ⇔ `quiet_for` below the
   gate; window texts map only to `noise`/`unstable` (simpler matching too).
2. **Heart stillness 30 s, not 20 s** (`heart.min_still_s`). With 20 s the 30 s
   window still contained the last 10 s of the walk-in; breathing keeps its 20 s
   (existing output unchanged).
3. **History not wiped by one invalid breathing window.** The plan cleared the
   heart history whenever `breath_valid` dropped; now only presence / motion /
   warm-up / segment / source change clear it, a bad breathing window just
   drops that heart window and blocks publishing.
4. **Segment change also clears `heart_last`/`heart_new`**; `heart_ms` moved to
   `__init__` so it survives `set_source`; heart call placed after
   `apnea.on_breathing` so an exception can never skip apnea.
5. **`no_person` for `uncertain` presence** made explicit (schema says "not
   present"); invariant test that reasons are `warming_up`/`no_person` whenever
   presence is not `present`, and heart valid ⇒ breathing valid.
6. **Orchestrator decisions folded in**: schema top-level `heart` description
   text + `gen:types` (CI diffs contracts.gen.ts); `outputs.heart` cut; no
   threshold tuning.
7. **Tests made cheaper and less flaky**: all runs seed 1 (seed 2 changed
   presence/motion timings that nobody has checked); separate `empty` run
   dropped (every scenario starts with 130 s of empty room); source-switch and
   gap checks added at the end of existing runs (no extra replay); `publish:
   false` is a 40 s run on a mutated `eng.rules`, not a temp rules file;
   feasibility probe before writing all cases, fallback is a stronger
   synthetic pulse, never a looser threshold.
8. **Fixtures fixed**: `present_live_link.json` has *valid* breathing, so its
   `breathing.reason` must be null (plan implied otherwise); `fall.json` and
   `position_quality.json` left without the new fields.
9. **Eval script**: `replay()` doesn't return the engine, so timing is taken by
   wrapping `heart.estimate_heart`; note text updated for the 30 s heart gate.
10. Contract invariants extended to `valid ⇔ bpm not None`; numpy→Python casts.
