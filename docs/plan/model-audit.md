# Model and dataset audit (2026-10-29)

Scope: everything on `feat/model-training` that trains, evaluates, exports
or adapts a model: `datasets/readers/`, `datasets/manifest/`, `ml/`,
`engine/lifefi/{dsp,motion,fall,breathing}.py`, `ml/models/`, `ml/results/`
and the claims in [model-training-plan.md](model-training-plan.md) §6 and §9.
No code was changed. One extra experiment was run (§A.5); its script is
not in the repo.

Severity: **Critical** = a number we would quote or a demo decision is
wrong; **High** = will break or mislead before 11-05; **Medium** =
biased numbers or fragile code; **Low** = hygiene.

---

## Summary

| # | Sev. | Finding |
|---|---|---|
| 1 | Critical | The "unseen room" scores (0.54 / 0.38) never test a transition: E8 has no sit / lie / get-up, so they score `none`, `walking` and E8 `fall` only |
| 2 | Critical | On the 3 locked E1 people, the movement model finds the right movement in **14 %** (GBM, the default) / **20 %** (CNN) of events. Always answering `get_up` scores **27 %** |
| 3 | Critical | The venue simulation does not test what step 4 is for: E8 has no transitions, and most of its gain is on **falls**, which the real guided reps do not contain |
| 4 | Critical | The fall rule (the headline) has no tested thresholds: best in-sample 36 % recall with 19 % false alarms, and jumps fire 32 % |
| 5 | High | The datasets are trivially separable (AUC ≥ 0.994; E1 has 2× E8's sample-to-sample noise), and the `fall` output works on E8 falls only. E8 is HT40, which our recorder throws away |
| 6 | High | If tomorrow's labels come from a key-press script in the plan §5 format, `ml/own.py` drops every one of them silently |
| 7 | High | `gbm.onnx` expects 53 hand-made features that only exist in Python; the engine has no port and no test vectors |
| 8 | Medium | The saturation filter drops 32 % of E8 falls and 31 % of squats, against 14–20 % of the rest (r4: 59 % of falls), so `fall` loses the most violent clips |
| 9 | Medium | Breathing gates were tuned and scored on the same 66 files; 36 of 66 recordings never produce a reading; the plan's per-rate claim does not match the results file |
| 10 | Medium | Design choices were made on the test folds (no validation split); the plan quotes an E8 fall number it says never to quote |
| 11 | Medium | E8 participants 1–8 probably appear in every room, so leave-one-room-out may test on people seen in training |
| 12 | Medium | Venue keep / reject compares F1 on ~9 events against a 0.05 margin, which is all noise |
| 13 | Medium | The GBM feature cache only checks the row count, so stale features are reused after a code change |
| 14 | Low | The E1 repair adds a little jitter on k = −2, −1 (+5–12 % vs neighbours, measured) |
| 15 | Low | `ml/models/` (14 MB incl. a pickle) is not gitignored; `torch.load(weights_only=False)` |
| 16 | Low | No pinned Python requirements; no Python tests in CI |
| 17 | Low | Licences: E8 CC BY 4.0 and E1 MIT need attribution next to the models; E2 has no licence and is the next planned source |
| 18 | Low | Own recordings are health data, possibly from minors; demo wording must not sound medical |

What is sound: splits by subject and room fixed before training, so no
window-level leakage; locked subjects; QC manifests with a reason per drop;
the E1 CR-LF repair argument; ONNX ≤ 1e-4 parity checks; CNN ONNX with the
model view inside; docs that already say "development numbers only".

---

## A. Critical

### A.1 "Unseen room" does not measure transitions

`evaluate.score` computes macro-F1 over the classes present in the test
fold. In every E8 room fold that is `none`, `walking`, `fall`
(`ml/results/gbm.json`, `cnn.json`). So:

- "Unseen E8 room macro-F1 0.54 (GBM) vs 0.38 (CNN)" (plan §9.3) says
  nothing about `sit_down`, `lie_down`, `get_up`. A third of it is the
  E8 `fall` F1, which plan §2.1 / §8 #4 says never to quote.
- `event_found` = "the most confident event-class window has the right
  class", with no probability threshold. In E8 the only event class is
  `fall`, and in the extra run (§A.5) `fall` wins the event-class argmax
  on **72–80 % of all windows** in a held-out room, quiet clips included.
  So `event_found = 1.0` in the E8 rooms is close to automatic.
- The GBM-over-CNN choice ("the simple model ships as the default") rests
  on these room folds.

**Do:** pick the model on transitions only: E1 subject folds now, then
room B (R6). Report per-class F1, `event_found` with a threshold (for
example p > 0.5), and a chance / "always fall" baseline next to each
number.

### A.2 Below chance on unseen people

`gbm_locked.json` / `cnn_locked.json` (the 3 locked E1 subjects, the only
untouched test):

| | GBM (default) | CNN |
|---|---|---|
| right movement found | **13.9 %** | **19.7 %** |
| sit_down F1 | 0.10 | 0.23 |
| lie_down F1 | 0.15 | 0.13 |
| get_up F1 | 0.14 | 0.08 |
| fall F1 | 0.04 | 0.005 |

The locked set has 137 located event clips: fall 32, get_up 37, lie_down
36, sit_down 32. A model that always answers `get_up` would score 27 %;
uniform guessing over the 4 trained classes gives 25 %. (`stand_up` has
no training data at all, class weight 0.) The E1 subject folds look
the same (`event_found` 0.31–0.53). Transitions make up 4 % of the
labelled windows (sit 1,067, lie 1,011, get-up 892 of 75,024; 18 k are
ignored). On the evidence so far, T1 cannot recognise transitions in a
person it has not seen. The plan's fallback (hide posture, demo the rules)
is the realistic default, not the exception.

### A.3 The venue simulation answers a different question

`ml/venue_sim.py` makes each E8 room "the venue". Per-class F1
(`venue_sim.json`, CNN before → AdaBN + head):

| room | none | walking | fall |
|---|---|---|---|
| r1 | 0.70 → 0.91 | 0.18 → **0.00** | 0.40 → 0.85 |
| r2 | 0.62 → 0.86 | 0.17 → 0.10 | 0.29 → 0.68 |
| r3 | 0.79 → 0.86 | 0.08 → 0.22 | 0.34 → 0.72 |
| r4 | 0.64 → 0.86 | 0.11 → **0.005** | 0.25 → 0.68 |

- The guided set is random whole E8 clips from the setup half: falls,
  walks, and turn / jump / squat / arm wave. The real step 4 has
  transitions and walking, and no falls. The 0.38 → 0.56 gain is mostly
  `fall` and `none`.
- E8 has no sit / lie / get-up, so the classes step 4 is for are not
  tested at all.
- Setup (trials 1–5) and demo (6–10) are the same people in the same
  session, which flatters the adaptation.
- Walking gets worse in 3 of 4 rooms (r1 and r4 drop to about 0).

What the run does show: a head fine-tune improves the classes that are
in the guided set. That *suggests* step 4 helps transitions at the venue,
but it does not show it, and it may cost walking. Plan §6 / §9.3 should
say "suggested", until rooms A and B (R4 / R6) are tested.

### A.4 The fall rule is unvalidated, and its defaults are arbitrary

- `fall_rule.json`: best setting over all rooms (in-sample) is 36 % recall
  with 19 % of other clips flagged; per activity, jump 32 %, walk 23 %,
  fall 36 %. Held-out rooms are 6–34 % recall at 13–27 % false.
  `MAX_FALSE = 0.05` is never met.
- The chosen `t_still = 40` is the top of the grid, so stage 2 is
  effectively off.
- `engine/lifefi/fall.py` defaults (`T_FALL = 80`, `RATIO = 4`,
  `T_STILL = 10`) are commented "tuned on E8" but match none of the tuned
  outputs (100 / 2 / 40, or the per-fold sets). Copying the tuned values
  in would not help, because they are bad. Fix the comment to
  "placeholder", and set the values from R5.

The docs already call these placeholders. The liability is demoing
"fall → fainted" as working before R5 (mat falls) has set the thresholds.
Until then, any jump or dropped bag can fire it.

### A.5 Extra check run for this audit

LightGBM on the cached features, same data and folds:

- E1 vs E8 on `none` / `walking` windows only, grouped 4-fold:
  **AUC 0.998, 0.999, 1.000, 0.994**. The features tell the dataset apart
  almost perfectly.
- Held-out rooms r1 / r2: event-class argmax is `fall` on 3,984 / 5,439
  and 4,499 / 6,551 windows. Mean p(fall) is 0.21 on fall clips and 0.01
  on quiet clips, so there is some real fall signal, but the 1.0 is
  mostly bias.
- Held-out E1 subjects (fold 1): `fall` also wins the event argmax on 48 %
  of windows. But mean p(fall) is **0.018 on E1 fall clips vs 0.026 on
  the rest**, so the `fall` output does not detect E1 falls at all.

---

## B. High

### B.5 Datasets are trivially separable; `fall` only knows E8

Measured:

- The features tell E1 from E8 with AUC 0.994–1.000 (A.5).
- E1's mean sample-to-sample change is 0.65 dB against E8's 0.33 dB, so
  the noise level alone gives the dataset away. The top GBM features
  (`diff_corr`, `turb_*`) are exactly the noise-sensitive ones.
- The `fall` output detects E8 falls (p 0.21 vs 0.01) but not E1 falls
  (0.018 vs 0.026).
- E8 is HT40 (`cwb = 1` in its CSVs), while
  `csi_recorder.load_csirec` drops every packet with `cwb != 0`. Our
  data will always be HT20, like E1. E8's subcarrier order is also
  unverified (reader docstring), and the CNN's first layer mixes
  subcarriers by index.

Not proven: that the model *uses* dataset identity. E1 falls are gentle
(plan §9.2), which would explain the same pattern. Either way, the `fall`
class has learned "an E8-style fall", which is neither our board, our
bandwidth nor a mat fall.

**Do:** today, only measure it (report AUC with the folds). The fix is
data: our own transitions and falls from rooms A and B.

### B.6 Label format mismatch, silent

There are two label formats:

- The dashboard labelling page (`server/src/api.ts`) writes the plan-v2
  format, `{"kind": "mark", "t_press_us": …, "event": …}` (and
  `kind: "segment"`). That is the only one `ml/own.py` reads. But the page
  records through the real engine, which does not exist yet.
- Plan §5 tells the team to use a key-press script that writes
  `{"t": host_ms, "label": "sit_down"}` instead. No such script is in the
  repo, so whoever records tomorrow writes their own.

If tomorrow's labels use the §5 format:

- every line is skipped;
- `adapt.py` skips the head fine-tune (fewer than 20 labelled windows);
- `--check` labels every window `none`, so keep / reject compares two
  models on `none` only.

None of this raises an error. **Do today:** make `own.windows` stop with
an error on lines it cannot read, and on a labelled run with 0 marks. Add
a reader for the §5 point marks (`t` ms → `t_press_us`). Point marks
cannot express walking or empty *segments*, so check the real file
tomorrow before trusting the conversion.

### B.7 The GBM cannot be deployed as it stands

`gbm.onnx` takes `features [N, 53]`. The 53 features (SVD,
FFT band shares, kurtosis, change envelope, `diff_corr`, turbulence) exist
only in `ml/features.py`. `engine/ts/src` has no `dsp`, no `features`,
and no test vectors exist. Any port that differs slightly gives a
different model at inference. The CNN ONNX has the model view inside and
needs only `F`. If the GBM stays the default, ship
`(F window, features, probabilities)` test vectors with it, or run the
Python feature code in the engine.

Related train / serve differences to keep in mind:

- training F is stored as float16;
- offline Hampel is centred, while the live one runs 3 samples late.

### B.8 Saturation filter thins out falls (Medium)

`ml/data.py` drops every clip with more than 1 % saturated frames
(`MAX_SAT`), for all classes. The share of E8 clips dropped, per label:

| fall | squat | jump | turn | walk | run | arm wave |
|---|---|---|---|---|---|---|
| 32 % | 31 % | 20 % | 17 % | 16 % | 15 % | 14 % |

Per room, falls go from 80 to 42 (r3) and 33 (r4). The movements close
to the floor saturate most, so the T1 `fall` class loses its most violent
clips. E1 falls are gentle too (plan §9.2). `tune_fall.py` does not use
this filter, so the fall rule is not affected.

**Do today:** add the saturation share to `engine/tools/inventory.py`,
so tomorrow's falls are checked. Optionally re-run the folds with
`MAX_SAT` relaxed for `fall` and compare. Do not change the filter
without that comparison.

---

## C. Medium

- **C.9 Breathing.** The gates (`MIN_CONFIDENCE = 0.40`) were picked from
  a 30-cell sweep on the same 66 files the 95 % is reported on. Coverage:
  15 % of 30 s windows, and only 30 of 66 recordings ever give a valid
  reading. Plan §9.4 says "weakest at 20 /min (67 %)", but
  `breathing_e1.json` (current gates) says 15 /min 78 %, 20 /min 88 %. The
  labels are metronome targets. Quote nothing until R2 (phyphox).
- **C.10 Selection on test folds.** There is no validation split.
  `PEAK_RATIO`, `SPAN`, keeping `fall` as a class, dropping `run`, and the
  saturation filter were all chosen from fold scores. Plan §9.2's "unseen
  room fall detection 95 % → 77 %" is that kind of choice, and it is an E8
  fall number. Fold numbers are optimistic. Only the locked set (A.2) is
  clean.
- **C.11 E8 people across rooms.** The README gives participant 1–8 for
  each scenario. The reader scopes subject IDs by room (`e8_r1_p3`), which
  hides any overlap. If they are the same 8 people, leave-one-room-out is
  not leave-one-person-out. Check the paper.
- **C.12 Keep / reject at the venue.** The check run has 2 × 4
  transitions + 1 fall, about 9 events. The F1 noise on that is about
  ±0.1, against a 0.05 margin that already favours the adapted model, and
  without `--check` the adapted model is kept unchecked. Treat the venue
  F1 as a sanity check, not a decision.
- **C.13 Stale feature cache.** `train_gbm.features` reuses
  `datasets/processed/gbm_features.npz` whenever the row count matches.
  After an edit to `features.py` or `dsp.py`, the old features *and*
  feature names are reused and written into `gbm.json`. Key the cache on a
  hash of `features.py`, `PIPELINE_VERSION` and the row count.
- **C.14 E1 repair artefact (measured, small).** Rows that lost pairs
  get k = −1…−4 copied from a neighbour. Mean `|dF|` on k = −2, −1 is
  0.68 / 0.72 dB, against 0.63–0.66 dB on the neighbours, so about
  +5–12 %. That is small next to the 2× noise gap between E1 and E8
  (B.5). Not worth a fix this week.
- **Label noise (E1).** Event time is found in only 62–86 % of event clips.
  Windows more than 1.25 s from the peak are labelled `none` even when
  the clip has other movement in them. That probably explains part of the
  32–38 % false events on E1 walking clips.

## D. Low

- **D.15** `ml/models/` is not gitignored, so `git add .` commits 14 MB
  of binaries (`gbm.txt` 8.5 MB, `gbm.onnx` 5.6 MB, `csinet.pt`).
  `export.load` uses `torch.load(..., weights_only=False)`, which runs
  any pickle it is given (also `adapt.py --model`). `weights_only=True`
  loads the current `csinet.pt` fine (tested).
- **D.16** No `requirements.txt` for `ml/` (the versions are only in plan
  §9.1 prose); `.github/workflows/ci.yml` runs no Python, so
  `engine/tests/test_dsp.py` is not in CI.
- **D.17 Licences.** E8 is CC BY 4.0 and asks for a citation; E1 is
  MIT, and its README asks for a citation. Whether trained weights count
  as derived works is not settled, so attributing both is the safe
  default. Add a model card (the planned `docs/models.md`) that cites both. E2 WiFall
  has "not stated" for its licence and is the next planned source: do not
  train on it until that is known. E9 is CC BY-NC-ND: keep it out of
  training. E3 (GPL-3.0) is only for checks; keep it that way.
- **D.18 People and claims.** Breathing, breath-holds and falls are
  health data (GDPR Art. 9). The volunteers may be under 18. Get written
  consent, use pseudonymous `subject` IDs, set a retention period, and
  keep `.csirec` gitignored (it is). For the pitch: no public-data number
  as Life-Fi accuracy, and wording like "demo / not a medical device" for
  fall, fainted and breathing-stopped.

---

## Status (2026-10-29, evening)

| Finding | Done | Left |
|---|---|---|
| B.6 labels | `own.py` reads both formats and stops on bad lines, a wrong clock or a missing file; `ml/tests/test_own.py` | look at tomorrow's real file |
| A.1 scores | `evaluate.py`: `transition_f1`, `event_found` at p > 0.5, `event_top1`, `event_constant`, found per class; folds re-run. Unseen E1 people: transition F1 GBM 0.24 / CNN 0.17; found at p > 0.5 0.28 / 0.32 against a constant guess of 0.31. GBM stays the default | choose the model on room B |
| A.4 fall rule | `fall.py` comments say placeholder; `ml/tune_fall_own.py` (smoke-tested on synthetic data) | run it on R5 |
| C.9 breathing | held-out check in `tune_breathing.py`: 98–99 % right on the other half of the subjects, so the gates hold | R2 accuracy |
| B.8 saturation | `sat_pct` column in `engine/tools/inventory.py` | check our falls |
| C.12 venue check | `adapt.py` prints a 90 % block-bootstrap interval, and stops when no mark snapped | — |
| C.13 cache | feature cache keyed on a hash of the code and windows | — |
| D.15 / D.16 | `ml/models/` gitignored, `weights_only=True`, `ml/requirements.txt`, Python tests in CI | — |
| D.17 / D.18 | `docs/models.md`: attribution, limits, consent and data rules | consent form text |
| A.2, A.3, B.5 | plan §6, §9 wording corrected | **not done: decision 2026-10-30** (no rooms A / B). Posture is hidden; venue = calibration only |
| B.7 GBM port | `ml/gbm_vectors.py` → `ml/models/gbm_vectors.json`; the engine is Python and imports the same `engine/lifefi/features.py` (`test_features_vectors.py`, 1e-7) | **closed** (2026-10-30) |
| A.4 fall rule (update) | public-data thresholds in `rules.yaml` (`ml/tune_fall.py`): a false-alarm guard; no public fall passes the full rule | **not validated**; the team chose no board test for now |
| C.11, C.14 | — | C.11 needs the paper; C.14 not worth it |

Update 2026-10-30: the team decided to use only the downloaded data
(model-training-plan §0). Everything in this audit that waits on rooms A
/ B or own recordings (A.2, A.3, A.4's recall, B.5's fix, B.6's real
label file, C.9's chest reference) stays open by that decision.

## Fix order for the 7 days left

1. Today: make `own.py` fail loudly and read the §5 format too (B.6).
2. Choose the model on transitions only (A.1). Decide now that posture is
   shown only if room B clearly beats the best constant guess (A.2).
3. Fall rule: write the R5 tuning script today, set thresholds only from
   R5, and mark the `fall.py` defaults as placeholders (A.4). Add
   saturation to `inventory.py` (B.8).
4. If the GBM stays: test vectors for the features, or switch to the CNN
   (B.7).
5. Hygiene, 30 minutes: gitignore or LFS `ml/models/`, `weights_only=True`,
   `ml/requirements.txt`, cache key (C.13, D.15, D.16).
6. Wed: `docs/models.md` with attribution, the clean numbers, and the
   limits (D.17).
