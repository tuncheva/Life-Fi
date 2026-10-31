# Models

What the trained models in `ml/models/` and the engine's rules are, what
they were trained or set on, how well they do, and what they must not be
used for. Updated 2026-10-30.

**Decision 2026-10-30: only the downloaded public datasets are used.** No
own recording sessions will be made (model-training-plan §0). Every
number below is a development number on other people's data, **never
Life-Fi accuracy**. Nothing here has been measured on our board in our
rooms.

## The models

| File | What | Input | Output |
|---|---|---|---|
| `gbm.txt`, `gbm.onnx`, `gbm.json` | Movement model, gradient boosting (LightGBM). **The default** | 53 window features from `engine/lifefi/features.py` (names in `gbm.json` and the ONNX metadata) | 6 class probabilities |
| `csinet.pt`, `csinet.onnx` | Movement model, 1D CNN, 58,406 weights (`ml/model.py`) | `F [B, 52, 150]`: 3 s at 50 Hz, dB, from `lifefi.dsp` (pipeline version 2) | 6 class probabilities (model view and softmax are inside the ONNX graph) |

Classes: `none`, `walking`, `sit_down`, `lie_down`, `rise`, `fall`.
`rise` is stand up and get up in one class: no public set has
`stand_up`, so E1's "get up" teaches it, and the posture state machine
tells the two apart by the posture before the move. Both ONNX files carry
their labels, input kind, window and pipeline version as metadata; the
engine refuses a model that does not match (`engine/lifefi/models.py`).
`ml/models/` is gitignored; rebuild with `ml/train_gbm.py --final`,
`ml/train_cnn.py --final`, `ml/export.py ml/models/csinet.pt` and
`ml/gbm_vectors.py`.

The engine computes the GBM's features with the same Python file as
training (`engine/lifefi/features.py`), and `engine/tests/test_features_vectors.py`
checks it against `gbm_vectors.json` (probabilities within 1e-7).

The rules (motion, presence, breathing, breathing stopped, fall →
fainted) are not trained models; their thresholds are in
`engine/config/rules.yaml`, each with where it comes from.

## Data

| ID | Dataset | Licence | Used for |
|---|---|---|---|
| E1 | Embedded_WiFi_Sensing | MIT (repository); the authors ask for a citation | movement model (E1 subject folds, 3 locked subjects); breathing gates; `no_breathing` false alerts; the fall rule's false-alarm guard |
| E8 | ESP-Fi HAR | CC BY 4.0 | movement model (leave-one-room-out); fall-rule check |
| E4 | 3DO | CC BY 4.0 | presence thresholds, calibration, motion scale, the fall rule's stillness threshold |
| E15 | SG_106B07, real recordings only | MIT | fall-rule check |
| E9 | CSI-Bench, ESP32 part of FallDetection | CC BY-NC-ND 4.0 | **evaluation only** (fall rule, held out); no converted copy leaves the machine |

Not used: E2 (licence not stated), E3 (GPL-3.0, checks only), the rest
of E9 (not ESP32).

**Attribution.** These models and thresholds are trained or set on:

- Armenta-Garcia, J. A., Gonzalez-Navarro, F. F., Caro-Gutierrez, J., &
  Garcia-Reyes, C. I. (2025). Tools and Methods for Achieving Wi-Fi
  Sensing in Embedded Devices. *Sensors*, 25(19), 6220.
  <https://doi.org/10.3390/s25196220> (E1, MIT License, Copyright (c)
  2025 AlbanyArmenta0711).
- Wen, Z., Ruan, Y., Wang, X., Zhou, J., Gao, H., & Li, T. (2026).
  ESP-Fi HAR: A low-power WiFi CSI dataset for Ad-Hoc IoT human activity
  recognition. *Ad Hoc Networks*, 186, 104192.
  <https://doi.org/10.1016/j.adhoc.2026.104192> (E8, CC BY 4.0,
  <https://creativecommons.org/licenses/by/4.0/>). Changes made: CSI
  amplitudes resampled to 50 Hz, filtered and cut into 3 s windows; clips
  with > 1 % saturated frames and activity 1 ("run") left out.
- Strohmayer, J. et al., 3DO dataset (WiFlexFormer),
  <https://zenodo.org/records/10925351>, <https://arxiv.org/abs/2411.04224>
  (E4, CC BY 4.0). Changes made: the CSV's LLTF amplitudes resampled to
  50 Hz and filtered; used only to compute thresholds.
- SG_106B07 (ESP32-S3 fall project), <https://github.com/Ken35943/SG_106B07>
  (E15, MIT). Real recordings only; used only to check the fall rule.
- Zhu, G. et al. (2025). CSI-Bench: A Large-Scale In-the-Wild Dataset
  for Multi-task WiFi Sensing. <https://arxiv.org/abs/2505.21866>
  (E9, CC BY-NC-ND 4.0, <https://creativecommons.org/licenses/by-nc-nd/4.0/>).
  Evaluation only; nothing derived from it is distributed.

Cleaning, splits and every dropped file: `datasets/manifest/`,
dataset-preparation.md, model-training-plan §9.2.

## How good the movement model is

Scores from `ml/evaluate.py` (`ml/results/gbm*.json`, `cnn*.json`,
2026-10-30, 6 classes). `transition_f1` is the F1 over sit down / lie
down / rise; "found" counts an event when the right class has p > 0.5;
"constant" is what always answering the most common event class scores.

| Test | GBM | CNN |
|---|---|---|
| Unseen E1 people (5 folds), transition F1 | **0.24** | 0.17 |
| Unseen E1 people, events found (p > 0.5) / constant guess 0.31 | 0.28 | 0.31 |
| Unseen E1 people, right class top-1 (no threshold) / constant guess 0.31 | 0.41 | 0.40 |
| Unseen E1 people, walking / quiet clips with a false event | 34 % | 39 % |
| 3 locked E1 people, transition F1 | 0.13 | 0.15 |
| 3 locked E1 people, events found (p > 0.5) / constant guess 0.27 | 0.10 | 0.18 |
| Unseen E8 room, macro-F1 over none / walking / fall | 0.54 | 0.37 |

The locked people were scored once before (7 classes, 2026-10-29) and
again after the `rise` merge; no choice was made from either score.

**Bottom line:** on people it has not seen, neither model recognises sit
/ lie / rise better than a constant guess. The GBM stays the default.
**Posture is hidden in the demo** (decision 2026-10-30): the engine runs
the model and the posture state machine, but sends `posture: null`
unless `rules.yaml` sets `posture.publish: true`. With no own recordings
there is no room-B test that could justify showing it.

## How good the rules are

| Rule | Set on | Result | Limit |
|---|---|---|---|
| Presence (moving) | E4 | Every E4 recording with a person: PRESENT ~2 s after they walk in, held to the end; empty recordings never PRESENT (`presence_e4.json`, replay) | E4 never shows anyone leaving: the exit rule is checked on synthetic data only |
| Presence (still person) | E4, 2-min calibration | Breathing energy from a 2-min empty calibration finds a still person in 67-76 % of 30 s windows with 0-2.6 % of empty windows flagged, on days not used to pick the threshold | Directional antenna through a wall, not our board; the static profile S drifts too much to use |
| Motion 0-1 | E4 | Empty room and a still person read 0; walking peaks at 0.65-0.72; 0.1 means the same as presence's motion threshold | — |
| Breathing rate | E1 (66 paced files) | 95 % of valid 30 s windows within ±2 /min of the metronome; 15 % of windows valid (`breathing_e1.json`) | Targets, not a chest reference; one person, still, near the link |
| Breathing stopped | E1 (false alerts), synthetic (latency) | 0 false alerts on E1 in the 0.47 h (28 min, 22 of 66 files) it was armed, i.e. able to fire (`apnea_e1.json`); every synthetic 25 s hold caught ~15 s after the last breath | No public breath-hold data: never seen a real one. Settings picked and scored on the same E1 files |
| Fall → fainted | E1, E4 (thresholds); E8, E15, E9 (check) | **Not validated.** The full rule fires on 0.4 % of E1's ordinary movements but on 30 % of E8's (more often than on E8's own falls), and catches 2.5 % of E8 falls, 0 % of E15 and 0 % of E9 (`fall_rule.json`) | See below |

**Why the fall rule cannot be set from public data.** The impact size in
units of the quiet level depends on the dataset: the median fall peak is
187× in E8, 31× in E15, 7× in E1 and 3× in E9 (each set's noise floor
differs ~15×), and within E9 (ESP32-S3) it barely separates falls from
other movement. In no public set do people lie still after falling, which
is what stage 2 needs. So `t_fall` = 40× is a false-alarm guard (P95 of
E1's sit-downs, lie-downs, get-ups and walks: E1 is closest to our chain),
and `t_still` comes from E4's still people. Whether a fall on our board
triggers it is untested; a hard sit-down followed by sitting still can.
The team chose not to test it on the board for now (2026-10-30).

## Limits

- One link, one person. Two people's states cannot be separated.
- Trained on HT20 (E1) and HT40 (E8) CSI; our recorder keeps HT20 only.
  None of the datasets is our board or our rooms.
- The movement model's `fall` class detects E8-style falls only
  (model-audit B.5). The fall alarm is the rule, not this class.
- Not a medical device. Fall, fainted and breathing-stopped alerts are a
  demonstration and must not be relied on for anyone's safety. Say "demo"
  when showing them.

## Own recordings

None are planned (decision 2026-10-30). The code to use them stays
(`ml/own.py`, `ml/adapt.py`, `ml/tune_fall_own.py`) in case that changes.
Breathing, breath-holds and falls are health data (GDPR Art. 9), and
volunteers may be under 18. Before recording anyone:

- written consent (a parent's too for anyone under 18) that says what is
  recorded, why, who sees it, and how long it is kept;
- a pseudonymous `subject` (P01, P02, …) in `labels.jsonl`; the name ↔
  code list is kept on paper or offline, never in the repo;
- `.csirec` and `labels.jsonl` stay out of git (`.gitignore`: `data/`,
  `*.csirec`), and are deleted after the project unless the consent says
  otherwise;
- breath-holds follow the safety rules in plan-v2 §10.4.
