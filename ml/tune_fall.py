"""Starting thresholds for the fall rule from E8 (lifefi.fall).

    .venv/Scripts/python ml/tune_fall.py

E8 only: its falls are impacts at 100 Hz. E1's FA clips are softer than
its own sit-downs (fast-motion peak 7x the quiet level vs 18x), so they
look like controlled lie-downs and would teach the rule nothing.
E8 activity 1 ("run") is left out: it looks exactly like activity 2
("fall") and one of the two labels may be wrong (model-training-plan §2.1).

Leave-one-room-out: thresholds are picked on three rooms (highest recall
with at most MAX_FALSE of the other clips raising a fall) and scored on
the fourth. Development numbers only: no empty-room calibration exists in
E8, so the baseline is each clip's quiet level (lifefi.fall.baseline_quiet).
"""

import itertools
import json
import pathlib
import sys

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "engine"))

import data  # noqa: E402
from lifefi import fall, motion  # noqa: E402

GRID = {"t_fall": [40, 60, 80, 100, 130, 160], "ratio": [2, 4, 8], "t_still": [5, 10, 20, 40]}
MAX_FALSE = 0.05
NEG = {"walk", "squat", "jump", "turn", "arm_wave"}


def main():
    Fs, Vs, meta = data.common.load("e8")
    clips = []
    for F, m in zip(Fs, meta):
        lab = m["clip_label"]
        if lab == "fall" or lab in NEG:
            base = fall.baseline_quiet(motion.motion(F))
            clips.append((F, base, lab == "fall", m["room"], lab))
    combos = [dict(zip(GRID, v)) for v in itertools.product(*GRID.values())]
    hits = np.zeros((len(combos), len(clips)), bool)
    for j, (F, base, _, _, _) in enumerate(clips):
        for i, c in enumerate(combos):
            hits[i, j] = any(k.fall for k in fall.detect(F, base, **c))
    is_fall = np.array([c[2] for c in clips])
    room = np.array([c[3] for c in clips])
    label = np.array([c[4] for c in clips])

    def rates(i, mask):
        return hits[i, mask & is_fall].mean(), hits[i, mask & ~is_fall].mean()

    folds = {}
    for r in sorted(set(room)):
        tr, te = room != r, room == r
        best = max(range(len(combos)), key=lambda i: (rates(i, tr)[1] <= MAX_FALSE, rates(i, tr)[0], -rates(i, tr)[1]))
        rec, fa = rates(best, te)
        folds[r] = {"thresholds": combos[best], "recall": round(float(rec), 3), "false_share": round(float(fa), 3),
                    "falls": int((te & is_fall).sum()), "others": int((te & ~is_fall).sum())}
        print(f"held-out {r}: {combos[best]}  recall {rec:.2f}  false on other clips {fa:.2f}")
    best_all = max(range(len(combos)), key=lambda i: (rates(i, room == room)[1] <= MAX_FALSE, rates(i, room == room)[0]))
    rec, fa = rates(best_all, room == room)
    per = {lab: round(float(hits[best_all, label == lab].mean()), 3) for lab in sorted(set(label))}
    print(f"all rooms: {combos[best_all]}  recall {rec:.2f}  false {fa:.2f}  detection share per activity {per}")
    (HERE / "results").mkdir(exist_ok=True)
    (HERE / "results" / "fall_rule.json").write_text(json.dumps(
        {"folds": folds, "chosen": combos[best_all], "recall": round(float(rec), 3), "false_share": round(float(fa), 3),
         "per_activity": per}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
