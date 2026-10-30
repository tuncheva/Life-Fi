# Models

What the trained models in `ml/models/` are, what they were trained on,
how well they do, and what they must not be used for. Started 2026-10-29
(draft: the numbers on our own recordings are still to come, model-training-plan §7).

## The models

| File | What | Input | Output |
|---|---|---|---|
| `gbm.txt`, `gbm.onnx`, `gbm.json` | Movement model, gradient boosting (LightGBM) | 53 window features from `ml/features.py` (names in `gbm.json`) | 7 class probabilities |
| `csinet.pt`, `csinet.onnx` | Movement model, 1D CNN, 58,535 weights (`ml/model.py`) | `F [B, 52, 150]`: 3 s at 50 Hz, dB, from `lifefi.dsp` (pipeline version 2) | 7 class probabilities (model view and softmax are inside the ONNX graph) |

Classes: `none`, `walking`, `sit_down`, `stand_up`, `lie_down`, `get_up`,
`fall`. **`stand_up` has no training data yet**: its output means nothing.
`ml/models/` is gitignored; rebuild with `ml/train_gbm.py --final`,
`ml/train_cnn.py --final` and `ml/export.py`.

The rules (motion, presence, breathing, fall → fainted) are not trained
models; their thresholds and checks are in model-training-plan §9.4.

## Training data

| ID | Dataset | Licence | Used for |
|---|---|---|---|
| E1 | Embedded_WiFi_Sensing | MIT (repository); the authors ask for a citation | training, E1 subject folds, the 3 locked subjects |
| E8 | ESP-Fi HAR | CC BY 4.0 | training, leave-one-room-out folds |

Not used for training: E3 (GPL-3.0), E9 (CC BY-NC-ND 4.0), E2 (licence
not stated: do not train on it until it is known).

**Attribution.** These models are trained on:

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

Cleaning, splits and every dropped file: `datasets/manifest/`,
dataset-preparation.md, model-training-plan §9.2.

## How good they are (public data only)

These are development numbers on other people's data, **never Life-Fi
accuracy**. Scores from `ml/evaluate.py`: `transition_f1` is the F1 over
sit / lie / get up only; "found" counts an event when the right class
has p > 0.5; "constant" is what always answering the most common event
class scores.

| Test | GBM | CNN |
|---|---|---|
| Unseen E1 people (5 folds), transition F1 | **0.24** | 0.17 |
| Unseen E1 people, events found (p > 0.5) / constant guess 0.31 | 0.28 | 0.32 |
| Unseen E1 people, right class top-1 (no threshold) / constant guess 0.31 | 0.42 | 0.41 |
| Unseen E1 people, walking clips with a false event | 32 % | 36 % |
| 3 locked E1 people, right movement (top-1) / constant guess 0.27 | 0.14 | 0.20 |
| Unseen E8 room | not a transition test: E8 has none (model-audit A.1) | |

The GBM stays the default (better transition F1, fewer false events). An
engine that runs it must reproduce `ml/features.py` exactly; check a
port against `ml/models/gbm_vectors.json` (`ml/gbm_vectors.py`). The CNN
needs only `F`.

**Bottom line:** on people they have not seen, neither model recognises
sit / lie / get up better than a constant guess. Posture is shown in the
demo only if our room B test (R6) clearly beats the constant guess.

## Limits

- One link, one person. Two people's states cannot be separated.
- Trained on HT20 (E1) and HT40 (E8) CSI; our recorder keeps HT20 only.
  Neither dataset is our board or our rooms.
- The `fall` class detects E8-style falls only (model-audit B.5). The fall
  alarm is the rule (`lifefi/fall.py`), not this class, and its thresholds
  are placeholders until our mat falls are in.
- Not a medical device. Fall, fainted and breathing-stopped alerts are a
  demonstration and must not be relied on for anyone's safety.

## Our own recordings

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
