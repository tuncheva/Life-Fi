"""Fall-rule thresholds from our own recordings (R5 mat falls, R4 / R7 negatives).

    .venv/Scripts/python ml/tune_fall_own.py --empty room_a/empty.csirec \
        room_a/falls.csirec:room_a/falls_labels.jsonl \
        room_a/transitions.csirec:room_a/transitions_labels.jsonl ...

--empty: the 2-min empty-room calibration (R1). Its P99 of M is the
baseline, as live (lifefi.motion). Every other argument is
recording:labels (ml/own.py formats).

What it reports:
1. t_fall the plan-v2 §6.5 way: P99.9 of M / baseline over everything
   that is not a fall (walking segments, sit / lie marks, hard negatives,
   unlabelled time), so normal movement almost never crosses it.
2. A grid over t_fall, ratio, t_still (lifefi.fall.detect): recall = fall
   marks with a `fall` detection within +-MATCH_S; false = `fall`
   detections away from every fall mark, per hour of recording and as a
   share of the hard-negative / transition marks they land on. The pick:
   highest recall with false <= --max-false-per-h; ties go to the
   strictest setting (fewer false alarms in a room we have not seen).
3. Per fall mark: peak, burst, stillness after it, so a missed fall can
   be looked at.
With few falls (10-20) every number is in-sample: treat the pick as a
starting value and check it on the venue check run (model-training-plan §6
step 5). Writes ml/results/fall_own.json.
"""

import argparse
import itertools
import json
import pathlib
import sys

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "engine"))

import own  # noqa: E402
from lifefi import fall, motion  # noqa: E402

GRID = {"t_fall": [20, 30, 40, 60, 80, 100, 130, 160, 200], "ratio": [1, 2, 4, 8], "t_still": [2, 3, 5, 10, 20]}
MATCH_S = 3.0
NEGATIVE = {"sit_down", "lie_down", "stand_up", "get_up", "hard_negative_sit", "hard_negative_liedown",
            "hard_negative_drop"}


def baseline_from(paths):
    Ms = [motion.motion(s.F)[int(motion.FS):] for p in paths for s in own.load_segments(p)]
    if not Ms:
        raise SystemExit("no usable segment in the empty recording(s)")
    return float(np.percentile(np.concatenate(Ms), 99))


def load(pair):
    rec, _, lab = pair.partition(":")
    labels = own.read_labels(lab) if lab else []
    marks = [(L["t_press_us"] / 1e6, L["event"]) for L in labels if L["kind"] == "mark"]
    return rec, own.load_segments(rec), marks


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--empty", action="append", required=True, help="empty-room recording (repeatable)")
    ap.add_argument("recordings", nargs="+", help="recording.csirec:labels.jsonl")
    ap.add_argument("--max-false-per-h", type=float, default=1.0)
    args = ap.parse_args()

    base = baseline_from(args.empty)
    recs = [load(p) for p in args.recordings]
    falls = [(r, t) for r, _, marks in recs for t, e in marks if e == "fall"]
    negs = [(r, t, e) for r, _, marks in recs for t, e in marks if e in NEGATIVE]
    hours = sum(s.t[-1] - s.t[0] for _, segs, _ in recs for s in segs) / 3600
    print(f"baseline (P99 of M, empty room) {base:.4g}; {len(falls)} fall marks, {len(negs)} negative marks, "
          f"{hours * 60:.1f} min of recording")
    if not falls:
        raise SystemExit("no `fall` marks: this script needs the R5 mat falls")

    # 1. plan-v2 t_fall: P99.9 of M / baseline away from falls
    quiet = []
    for rec, segs, _ in recs:
        for s in segs:
            M = motion.motion(s.F) / base
            near = np.zeros(len(s.t), bool)
            for r, t in falls:
                if r == rec:
                    near |= np.abs(s.t - t) <= MATCH_S + 5
            quiet.append(M[int(motion.FS):][~near[int(motion.FS):]])
    t_fall_plan = float(np.percentile(np.concatenate(quiet), 99.9))
    print(f"plan-v2 t_fall = P99.9 of M / baseline outside falls: {t_fall_plan:.1f}")

    # 2. grid
    # the scale of M / baseline on our board is unknown until now: also try multiples of the plan value
    grid = {**GRID, "t_fall": sorted({*GRID["t_fall"], *(round(t_fall_plan * f, 1) for f in (0.5, 1, 1.5, 2, 3))})}
    combos = [dict(zip(grid, v)) for v in itertools.product(*grid.values())]
    rows = []
    for c in combos:
        hits, false_t = set(), []
        for rec, segs, _ in recs:
            for s in segs:
                for k in fall.detect(s.F, base, **c):
                    if not k.fall:
                        continue
                    t = s.t[0] + k.t_peak
                    match = [i for i, (r, tf) in enumerate(falls) if r == rec and abs(t - tf) <= MATCH_S]
                    hits.update(match)
                    if not match:
                        false_t.append((rec, t))
        on_neg = sum(any(r == rec and abs(t - tn) <= MATCH_S for rec, t in false_t) for r, tn, _ in negs)
        rows.append({**c, "recall": round(len(hits) / len(falls), 3),
                     "false_per_h": round(float(len(false_t) / max(hours, 1e-9)), 2),
                     "negatives_flagged": round(on_neg / len(negs), 3) if negs else None})
    ok = [r for r in rows if r["false_per_h"] <= args.max_false_per_h]
    # ties go to the strictest setting: higher t_fall and ratio, lower t_still
    pick = max(ok or rows, key=lambda r: (r["recall"], -r["false_per_h"], r["t_fall"], r["ratio"], -r["t_still"]))
    if not ok:
        print(f"no setting reaches <= {args.max_false_per_h} false / h; the pick below breaks that limit")
    print("pick:", pick)
    print("best 10 by recall:")
    for r in sorted(rows, key=lambda r: (-r["recall"], r["false_per_h"]))[:10]:
        print("  ", r)

    # 3. per fall, with the pick
    per_fall = []
    for rec, t in falls:
        segs = next(segs for r, segs, _ in recs if r == rec)
        best = None
        for s in segs:
            if not s.t[0] <= t <= s.t[-1]:
                continue
            # threshold at half of this fall's own peak: with a low one, an earlier, smaller burst
            # (above half of *its* peak) runs on over the impact and hides it
            near = np.abs(s.t - t) <= MATCH_S
            peak = float((motion.motion(s.F) / base)[near].max())
            for k in fall.detect(s.F, base, t_fall=0.5 * peak, ratio=0, t_still=pick["t_still"]):
                dt = s.t[0] + k.t_peak - t
                if abs(dt) <= MATCH_S and (best is None or k.peak > best["peak"]):
                    best = {"dt_s": round(float(dt), 2), "peak": round(k.peak, 1), "ratio": round(k.ratio, 2),
                            "burst_s": round(k.burst_s, 2), "still_s": round(k.still_s, 1)}
        per_fall.append({"recording": pathlib.Path(rec).name, "t": t, **(best or {"burst": "none found"})})
        print("  fall", per_fall[-1])

    out = HERE / "results"
    out.mkdir(exist_ok=True)
    (out / "fall_own.json").write_text(json.dumps({"baseline": base, "t_fall_plan": t_fall_plan, "pick": pick,
                                                   "grid": rows, "falls": per_fall}, indent=2))
    print(f"wrote {out / 'fall_own.json'}; put the pick into engine/lifefi/fall.py only after the venue check run")
    return 0


if __name__ == "__main__":
    sys.exit(main())
