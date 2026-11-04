"""E8 ESP-Fi HAR: EnvironmentNo.<X>(<room>)/csv/<X>-<Y>-<Z>-<M>.csv.

X room 1-4, Y person 1-8, Z activity, M trial. The CSVs, not the .mat
(the .mat is only hypot of them). `data` = 104 ints = 52 pairs
[imag, real]; HT40 (`cwb = 1`), 100 Hz, ~10 s clips.

Activity numbering is the README's (1 run, 2 fall, ...). It is not
confirmed by the data: Z = 1 and Z = 2 are both "burst, then quiet"
(model-training-plan §2.1), so never quote an E8 fall number.

Subcarrier order [I]: index 0..25 = k -26..-1, 26..51 = k +1..+26
(dataset-preparation §6.3, unverified), so the columns are used as they
come.
"""

import csv
import json
import pathlib

import numpy as np

from common import Recording

RAW = pathlib.Path(__file__).resolve().parents[1] / "raw" / "E8_ESP-Fi-HAR"
ACTIVITY = {1: "run", 2: "fall", 3: "walk", 4: "turn", 5: "jump", 6: "squat", 7: "arm_wave"}
MIN_SECONDS = 8.0


def files():
    return sorted(RAW.glob("EnvironmentNo.*/csv/*.csv"))


def read(path):
    path = pathlib.Path(path)
    x, y, z, m = (int(v) for v in path.stem.split("-"))
    meta = {"dataset": "e8", "room": f"e8_r{x}", "subject": f"e8_r{x}_p{y}", "clip_label": ACTIVITY[z],
            "trial": m, "ltf": "lltf", "bw": "ht40", "source": str(path.relative_to(RAW))}
    rec_id = f"e8/{path.stem}"
    t, rows, sat = [], [], []
    dropped = 0
    with open(path, newline="", encoding="utf-8", errors="replace") as fh:
        for r in csv.DictReader(fh):
            d = r.get("data") or ""
            if not d.startswith("["):
                dropped += 1                         # Excel all-comma rows
                continue
            v = json.loads(d)
            if len(v) != 104:
                dropped += 1
                continue
            p = np.array(v, dtype=np.float32).reshape(52, 2)
            rows.append(np.hypot(p[:, 0], p[:, 1]))
            sat.append((np.abs(p) >= 127).any(axis=1).sum() > 2)
            t.append(int(r["local_timestamp"]))
    if len(rows) < 10:
        return rec_id, meta, "no CSI rows"
    t = np.array(t, dtype=np.int64)
    step = np.diff(t)
    t = np.r_[t[0], t[0] + np.cumsum(np.where(step < -2**31, step + 2**32, step))]   # uint32 wrap
    return Recording(rec_id, t / 1e6, np.array(rows), np.array(sat), meta, dropped_rows=dropped)
