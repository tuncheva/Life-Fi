"""One line per .csirec recording: length, rate, loss, pauses, RSSI, and
what the breathing and heart estimators make of it.

    python engine/tools/inventory.py                      # firmware/recordings/
    python engine/tools/inventory.py <folder or files> --csv inventory.csv

`use` says what a recording can feed (docs/plan/model-training-plan.md §2):
  breathing  a continuous stretch >= 30 s (the estimator never bridges a
             pause > 1 s)
  model      also >= 80 Hz and < 5 % loss (csi-for-models §8 gate)
Breathing and heart numbers are the estimators' own; without a counted or
chest reference they are not accuracy.
"""

import argparse
import csv
import pathlib
import sys

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))
sys.path.insert(0, str(ROOT / "firmware" / "tools"))

from csi_recorder import load_csirec  # noqa: E402
from lifefi import breathing, heart  # noqa: E402

PAUSE_S = 1.0
MIN_RATE_HZ = 80.0
MAX_LOSS = 0.05


def _rate_text(s):
    if s["bpm"] is None:
        return f"none ({s['valid']}/{s['windows']})"
    flag = "" if s["consistent"] else " inconsistent"
    return f"{s['bpm']:.1f} ({s['valid']}/{s['windows']}){flag}"


def describe(path):
    d = load_csirec(path)
    n = len(d["ts_us"])
    row = {"file": path.name, "frames": n}
    if n < 2:
        return row | {"use": "empty"}
    t = (d["ts_us"].astype(np.int64) - int(d["ts_us"][0])) / 1e6
    dt = np.diff(t)
    seq_step = np.diff(d["seq"].astype(np.int64))
    lost = int(np.clip(seq_step[seq_step > 0] - 1, 0, None).sum())
    cuts = np.where(dt > PAUSE_S)[0]
    edges = np.r_[0, cuts + 1, n]
    longest = max(t[b - 1] - t[a] for a, b in zip(edges[:-1], edges[1:]))
    at_limit = (np.abs(d["csi"].real) >= 127) | (np.abs(d["csi"].imag) >= 127)
    row |= {
        "seconds": round(float(t[-1]), 1),
        "rate_hz": round(float(1 / np.median(dt)) if np.median(dt) > 0 else 0.0, 1),
        "loss_pct": round(100 * lost / (n + lost), 1),
        "pauses": len(cuts),
        "max_pause_s": round(float(dt.max()), 2),
        "longest_s": round(float(longest), 1),
        "rssi_median": int(np.median(d["rssi"])),
        # frames with > 2 subcarriers at the int8 limit, as the dataset readers count them;
        # the public training data drops clips above 1 % (ml/data.py MAX_SAT)
        "sat_pct": round(100 * float((at_limit.sum(axis=1) > 2).mean()), 2),
    }
    bw = breathing.estimate_breathing(d["ts_us"], d["csi"])
    hw = heart.estimate_heart(d["ts_us"], d["csi"])
    row["breathing_bpm"] = _rate_text(breathing.summarize(bw)) if bw else "no 30 s stretch"
    row["heart_bpm"] = _rate_text(heart.summarize(hw)) if hw else "no 30 s stretch"
    use = []
    if longest >= breathing.WINDOW_S:
        use.append("breathing")
        if row["rate_hz"] >= MIN_RATE_HZ and row["loss_pct"] < 100 * MAX_LOSS:
            use.append("model")
    row["use"] = "+".join(use) or "too broken"
    return row


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="*", default=[str(ROOT / "firmware" / "recordings")])
    ap.add_argument("--csv", help="also write the table to this CSV file")
    args = ap.parse_args()
    files = []
    for p in map(pathlib.Path, args.paths):
        files += sorted(p.glob("**/*.csirec")) if p.is_dir() else [p]
    if not files:
        print("no .csirec files found in", ", ".join(args.paths))
        return 1
    rows = []
    for f in files:
        try:
            rows.append(describe(f))
        except Exception as e:  # one bad file must not hide the others
            rows.append({"file": f.name, "use": f"unreadable: {e}"})
    cols = ["file", "seconds", "frames", "rate_hz", "loss_pct", "pauses", "max_pause_s",
            "longest_s", "rssi_median", "sat_pct", "breathing_bpm", "heart_bpm", "use"]
    width = {c: max(len(c), *(len(str(r.get(c, ""))) for r in rows)) for c in cols}
    print("  ".join(c.ljust(width[c]) for c in cols))
    for r in rows:
        print("  ".join(str(r.get(c, "")).ljust(width[c]) for c in cols))
    if args.csv:
        with open(args.csv, "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=cols)
            w.writeheader()
            w.writerows(rows)
    return 0


if __name__ == "__main__":
    sys.exit(main())
