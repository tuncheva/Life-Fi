# Review: track A (engine occupancy / quality) and track D (fixed transmitter firmware)

Scope: `git diff 433ea0c~1..HEAD -- engine/ ml/ contracts/ firmware/ docs/hardware/`
(commits 413443b, fb76886), reviewed on the committed tree only (exported with
`git archive HEAD`; uncommitted track F edits ignored).

Checked and fine: engine tests `test_occupancy`, `test_position`, `test_spots`,
`test_engine` pass on HEAD (`test_replay_position` skips without `data/`); all
`contracts/fixtures/*.json` validate against `results.schema.json`;
`ui/src/lib/contracts.gen.ts` carries `occupancy`, `quality`,
`quality_reasons`, `model_accuracy`, `reliable`; `tx off` gives exactly the old
`s_mode` decision; TX `esp_wifi_set_mac` is called after `set_mode` and before
`esp_wifi_start` (correct); the MAC prefix `1A:...` is unicast + locally
administered; the probe's channel order covers 1..13 exactly once; the `_tx`
envs do not leak flags (no base `build_flags` to override, `main.c` is fully
guarded by `!LIFEFI_ROLE_TX`).

Summary: 1 high, 3 medium, 4 low.

---

## High

### H1. Occupancy says `empty` while a person is 0.4 m from the board, and the guard cannot prevent it

- `engine/lifefi/occupancy.py:61` (`raw = ... "empty" if p <= self.p_off and presence_state != "present"`), `:68-69`.
- Failure: the only guard against a false `empty` is `presence_state == "present"`.
  Without an empty-room calibration, presence is wrong exactly where it matters:
  on S2 presence said `empty` on 100 % of the close/middle/far ticks
  (`ml/results/position_eval.json` `engine_replay.193656.nocal`). The engine
  replay then published `occupancy.state = "empty"` on 7 of 108 answered ticks
  while a person stood at 0.4 m (`close: {"unsure": 101, "empty": 7}`). This is
  with the logistic fitted on that very session (see M1), so a new room will do
  worse. A still, breathing person gives low P by design (the docstring says so),
  so "empty" for a still occupant is the expected failure, not a corner case.
  `docs/models.md` reports it only as "never wrong-and-sure on more than 8 %",
  which hides that the wrong-and-sure case is "empty with someone there".
- Fix: do not publish `empty` from the absolute level alone. Require
  `presence_state == "empty"` **and** an empty calibration loaded (or the
  position gate `P <= gate` from a calibration) for `empty`; otherwise cap at
  `unsure`. Alternatively require a much longer hold for entering `empty`
  (e.g. 30 s of continuous raw `empty`) than for `occupied`. State the residual
  false-empty rate in `docs/models.md` explicitly.

## Medium

### M1. The engine-replay numbers in docs/models.md are in-sample (evaluation leak)

- `engine/config/rules.yaml:52-53` (offset/scale "spots-192549 + 193656 pooled"),
  `ml/eval_position.py:371-373` (`replay()` builds `Engine(mode="replay")`, i.e.
  the default `rules.yaml`), `:456-486` (`eval_engine` scores both sessions with it).
- Failure: the shipped logistic was fitted on both sessions pooled
  (`fit_occupancy`), and the engine replay then scores those same two sessions
  with it. The file's protocol header says "leave-one-session-out only:
  everything fitted ... is fitted on the training session of that fold" and the
  JSON says `"protocol": "loso"`, but the per-spot replay table and the
  `docs/models.md` bullets ("never wrong-and-sure on more than 8 %", unsure
  57 % / 65 %, `criterion_7_2`) are not LOSO. Only the "Occupancy, 4 s" row of
  the first table (0.75 / 0.77) is leak-free.
- Fix: in `eval_engine`, per direction set `eng.occupancy.offset/scale` from
  `fit_logistic` on the other session before replaying; or label the replay
  table "in-sample (thresholds fitted on these sessions)" in both the JSON and
  models.md.

### M2. `loso_bal_acc` (the `reliable` gate) is optimistic: shrink is chosen on the test sessions

- `ml/train_spots.py:121-143`.
- Failure: with ≥ 2 sessions, `splits` are the LOSO folds; the loop picks the
  `shrink` (5 candidates) that maximises the pooled LOSO balanced accuracy, and
  `loso_bal_acc` is then computed with that same shrink on the same held-out
  sessions. The figure written to the model file, shown as `model_accuracy` and
  compared to `1/k + margin` for `reliable`, is therefore a max over 5 test-set
  scores, not an out-of-sample estimate. With ~12 independent windows per class
  per session the selection bias is comparable to the 0.15 margin.
- Fix: fix `shrink` beforehand (e.g. 0.2) for the LOSO number, or select it by
  an inner split inside the training sessions of each fold (nested).

### M3. Transmitter rates the TX accepts are invisible to the receiver's probe

- `firmware/src/tx_main.c:43` (`RATE_MIN 10`), `firmware/src/lifefi_config.h`
  (`LIFEFI_TX_PROBE_FIRST_MS 400`, `LIFEFI_TX_PROBE_MS 120`, `LIFEFI_TX_PROBE_MIN 5`),
  `firmware/src/wifi_link.c` `probe_fixed_tx` (`seen[j].frames >= LIFEFI_TX_PROBE_MIN`).
- Failure: 5 frames in 120 ms needs ≥ 42 Hz on any non-default channel, and 5 in
  400 ms needs ≥ 12.5 Hz on the default channel (minus channel-switch settle
  time). After `rate 10`..`40` combined with `channel N` (both offered in the TX
  console and in docs/hardware/fixed-transmitter.md §7 "channel 1, 6 or 13"),
  the receiver logs "no Life-Fi fixed transmitter found" and silently falls back
  to the hotspot/sniffer, which is exactly the moving-transmitter setup the track
  exists to remove.
- Fix: raise `RATE_MIN` to 50 on the TX, or make the probe threshold
  rate-independent (e.g. ≥ 2 frames in the window and then confirm with a second
  longer listen on that channel), or lengthen `LIFEFI_TX_PROBE_MS` to ≥ 250 ms.

## Low

### L1. A class missing from one session makes `loso_bal_acc` meaningless (NaN → argmax)

- `ml/train_spots.py:78-93` (`fit`, `predict`), `:101-109`.
- Failure: if one session lacks a spot the other has (likely once spots are
  taught from the UI, track F), the fold trained without it gets `means[c] = NaN`
  and `b[c] = NaN` (`log(0)` plus NaN). `np.argmax` returns the first NaN, so
  every window of that fold is predicted as the missing class (verified:
  `np.argmax([[1, nan, .5]], axis=1) -> [1]`). The fold scores ~0 and the saved
  `model_accuracy` is garbage (safe direction: `reliable` false, but the number
  is shown).
- Fix: in `loso_bal_acc`, skip folds whose training data lacks a class, or
  return None (and print why) when sessions do not share the same label set.

### L2. Occupancy keeps its hysteresis state across a signal gap

- `engine/lifefi/engine.py:297-302` resets `position` on a new segment but not
  `self.occupancy`.
- Failure: after a gap (board reboot, USB stall > 1 s) the first answers after
  warm-up report the pre-gap state (e.g. `occupied` from minutes ago) for up to
  `hold_ticks` (1.5 s) before the new raw state takes over.
- Fix: in the gap block, `self.occupancy = occupancy.Occupancy(r["occupancy"])`
  (or add a `reset()` that sets `state="unsure"`, `cand=None`, `run=0`).

### L3. `quality` is tied to config, not to what the board is actually doing; `medium` is reachable only via a hand-edited file

- `engine/lifefi/engine.py:182-190`, `:641-643`; `engine/lifefi/position.py:214-220`.
- Failure: `transmitter_not_fixed` comes from the static rules flag
  `position.transmitter_fixed`, not from the receiver's link mode
  (`LINK_FIXED_TX`). If someone sets it `true` and the probe later falls back to
  the hotspot (M3, TX unplugged), the reason disappears. `no_distance_fit`
  clears when `position.json` has a list `d_m` with ≥ 2 values, but no code
  writes one (`position_fit` stores a scalar and `n` is never fitted), so a
  hand-edited file earns `medium` with `n` still the 2.0 guess.
  docs/hardware/fixed-transmitter.md also never tells the user to flip the flag,
  so a real fixed transmitter keeps reporting `transmitter_not_fixed`.
- Fix: derive "fixed" from the source MAC in the frame header / link status
  (prefix `1A:4C:46:54:58`), and count fit distances only from fits the engine
  itself made (store a list of `(d_m, R_db)` and fit `n` when ≥ 2).

### L4. The receiver no longer "carries on exactly as before" with `tx` on (the default)

- `firmware/src/wifi_link.c` `wifi_link_start` (probe before station/sniffer),
  `wifi_link_tx_probe_enabled` (defaults to 1); docs/hardware/fixed-transmitter.md:113-115.
- Failure: every existing receiver, with no transmitter anywhere, now spends
  ~1.9 s hopping channels in promiscuous mode before connecting, and station mode
  is started by an explicit `esp_wifi_connect()` instead of the STA_START
  handler. Functionally equivalent as far as I can see, but the doc's "exactly
  as before" holds only for `tx off`.
- Fix: say "after a ~2 s probe" in the doc, or default the probe off until the
  transmitter has been tested on hardware.

---

## Fixes applied

All findings verified before fixing; none was wrong.

- **H1 (fixed, `engine/lifefi/occupancy.py`, `engine/config/rules.yaml`).** `empty` is now a
  high-evidence state: p <= p_off **and** presence `empty` **and** an empty-room calibration
  loaded (`update(..., calibrated=)`), all three without a break for `empty_hold_s` = 30 s
  (presence's breathing window, `presence.B_WIN_S`; not tuned on the sessions). Anything less is
  `unsure`; losing any of the three leaves `empty` at once. **engine.py is not mine (track F):**
  until it passes `calibrated`, the engine never says `empty` (safe direction). Exact change for
  the orchestrator, `engine/lifefi/engine.py` in `tick`:
  `occ.update(now, *lv.raw_amp(occ.window_s + 1.0), state)` ->
  `occ.update(now, *lv.raw_amp(occ.window_s + 1.0), state, calibrated=self.calibration is not None)`.
  New tests (`engine/tests/test_occupancy.py`): a synthetic still person breathing 0.1 dB has P in
  the empty band on > 90 % of ticks (reproduces H1); with presence `empty` and no calibration it
  reads `empty` on 0 ticks; calibrated empty room reads `empty` only after window + 30 s; evidence
  broken every 20 s never gives `empty`. `ml/eval_position.py` synthetic check (iii) now uses a
  shallow breather (0.15 dB) and the presence-`empty`-without-calibration case.
  Replay, before (old rule, in-sample) -> after (new rule, LOSO): false `empty` with a person there
  7 -> 0 (S2 close); `occupied` in the empty minute 8 -> 8 (S1), 6 -> 2 (S2); `unsure` share of
  answered ticks 57 % -> 52 % (S1), 65 % -> 88 % (S2). No `empty` at all on the replays (both
  calibrations are refused by the engine). Residual risk stated in docs/models.md.
- **M1 (fixed, `ml/eval_position.py`, `docs/models.md`, `ml/results/position_eval.json`).**
  `eval_engine` now fits the occupancy logistic on the other session (`fit_occupancy(others)`)
  and sets it on the replayed engine (`replay(..., occ_fit=)`); the JSON records it per session as
  `occupancy_fit` and in `notes`. models.md's replay table and occupancy bullet rewritten with the
  LOSO numbers and the in-sample history.
- **M2 (not mine: `ml/train_spots.py`, track F).** Suggested fix: in `ml/train_spots.py` (lines
  ~121-143) do not pick `shrink` by the pooled LOSO score. Fix it beforehand,
  `SHRINK_LOSO = 0.2`, and compute `loso_bal_acc` with that value only; keep the shrink sweep
  (if wanted) for the final model, selected by an inner split inside the training sessions of
  each fold (nested), never on the held-out session.
- **M3 (fixed, `firmware/src/lifefi_config.h`, `firmware/src/tx_main.c`,
  `docs/hardware/fixed-transmitter.md`).** New shared `LIFEFI_TX_RATE_MIN 50`; the TX's
  `RATE_MIN` is it (old NVS rates below it fall back to the default). `LIFEFI_TX_PROBE_MS`
  120 -> 200, so the slowest rate gives 10 expected frames per channel, twice
  `LIFEFI_TX_PROBE_MIN`; `_Static_assert`s keep the two in step and the default rate above the
  minimum. Worst-case probe 1.9 s -> 2.8 s. `esp32dev_tx` and `esp32cam` build; host tests pass.
- **L1 (not mine: `ml/train_spots.py`).** Suggested fix: in `loso_bal_acc`, skip a fold whose
  training sessions lack a class present in its test session (or return None and print
  "sessions do not share the same spots") instead of letting `means[c] = NaN` reach `np.argmax`.
- **L2 (fixed in `occupancy.py`, no engine.py change).** An update more than `STALE_S` = 2 s after
  the previous one (a gap plus the engine's warm-up) resets to `unsure`, and a tick with no
  answer breaks the empty evidence. Test added.
- **L3 (not fixed).** Needs `engine.py` (link mode / source MAC into `quality`) and a new fit
  store; out of my files and not cheap. Suggested: in engine.py set `transmitter_fixed` from the
  frame source MAC prefix `1A:4C:46:54:58` instead of `rules.position.transmitter_fixed`.
- **L4 (fixed, docs).** docs/hardware/fixed-transmitter.md now says the receiver searches up to
  ~3 s at boot and that only `tx off` skips it.

Checks: every `engine/tests/test_*.py` exits 0, `node scripts/check-contracts.mjs` passes,
`firmware/test/host/run.ps1` passes, `pio run -e esp32dev_tx` and `-e esp32cam` succeed.
