"""E15 SG_106B07 (ESP32-S3 fall project): data/raw/<activity>/sample_*.csv.

Real recordings only (dataset-preparation §5): every `sample_synth_*` file
and `data/processed/` hold synthetic falls and are never read. That
leaves 5 fall_forward, 10 walking and 10 sitting_down files.

Columns: timestamp (µs), rssi, channel, amplitude_0..189, phase_0..189.
Amplitude is already linear. LLTF in the first 64: guards 0..3 and 57..63
are zero and the DC is amplitude_30, so k = -26..-1 is amplitude_4..29 and
k = +1..+26 is amplitude_31..56 (checked 2026-10-30 on the mean profile).
HT40, ~70 Hz. The 2026-09-06 files have negative timestamps (signed 32-bit
overflow), fixed by adding 2**32.

MIT licence: may set thresholds (fall rule, model-training-plan decision
2026-10-30). Not used to train the movement model.
"""

import csv
import pathlib

import numpy as np

from common import Recording

RAW = pathlib.Path(__file__).resolve().parents[1] / "raw" / "E15_SG_106B07" / "data" / "raw"
LABEL = {"fall_forward": "fall", "walking": "walk", "sitting_down": "sit_down"}
COLS = [f"amplitude_{i}" for i in list(range(4, 30)) + list(range(31, 57))]
MIN_SECONDS = 5.0


def files():
    return sorted(p for p in RAW.glob("*/sample_*.csv") if not p.name.startswith("sample_synth_")
                  and p.parent.name in LABEL)


def read(path):
    path = pathlib.Path(path)
    meta = {"dataset": "e15", "room": "e15", "subject": "e15", "clip_label": LABEL[path.parent.name],
            "session": path.stem.split("_")[1], "ltf": "lltf", "bw": "ht40",
            "source": str(path.relative_to(RAW))}
    rec_id = f"e15/{path.parent.name}/{path.stem}"
    t, rows = [], []
    with open(path, newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            t.append(int(r["timestamp"]))
            rows.append([float(r[c]) for c in COLS])
    if len(rows) < 10:
        return rec_id, meta, "no CSI rows"
    t = np.array(t, dtype=np.int64)
    t = np.where(t < 0, t + 2**32, t)
    amp = np.array(rows, dtype=np.float32)
    sat = (amp >= 127).sum(axis=1) > 2
    return Recording(rec_id, t / 1e6, amp, sat, meta)
