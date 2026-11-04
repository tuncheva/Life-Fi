"""Check and tune lifefi.breathing on E1's paced-breathing files.

    .venv/Scripts/python ml/tune_breathing.py

66 files: 22 subjects x paced 10 / 15 / 20 breaths per minute x 3 min,
ESP32 LLTF at ~50 Hz. The labels are the metronome *targets*, with no
chest reference, so this is a sanity check and a threshold sweep, never
accuracy (dataset-preparation §5, E1 step 6). A window counts as right
when it is within +-2 /min of the target.

Sweep: MIN_CONFIDENCE x MIN_BAND_RATIO, re-applied to the windows the
estimator computed (FFT/ACF agreement and the drift check kept as they
are). Reports, per setting, how many windows are called valid and how
many of those are right. Writes ml/results/breathing_e1.json.

Held out: the sweep picks the gates by looking at the answers, so its
best row is optimistic. `held_out` splits the subjects in two, picks the
gates on one half (most right among valid, with >= MIN_COVER of windows
valid) and scores them on the other half, both ways round.
"""

import json
import pathlib
import sys

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "engine"))
sys.path.insert(0, str(HERE.parent / "datasets" / "readers"))

import e1  # noqa: E402
from lifefi import breathing  # noqa: E402

CONF = [0.2, 0.25, 0.3, 0.35, 0.4, 0.5]
RATIO = [1.0, 1.5, 2.0, 3.0, 4.0]
TOL = 2.0
MIN_COVER = 0.15             # the coverage of the gates picked on 2026-10-29


def _rates(v, right):
    return float(v.mean()), (float(right[v].mean()) if v.any() else 0.0)


def held_out(subj, conf, ratio, other, right):
    names = sorted(set(subj), key=lambda s: int(s.split("_s")[-1]))
    halves = [np.isin(subj, names[0::2]), np.isin(subj, names[1::2])]
    out = []
    for pick_on, score_on in (halves, halves[::-1]):
        best = None
        for c in CONF:
            for r in RATIO:
                v = (conf >= c) & (ratio >= r) & ~other
                cover, ok = _rates(v[pick_on], right[pick_on])
                if cover >= MIN_COVER and (best is None or ok > best[2]):
                    best = (c, r, ok)
        c, r, ok = best
        v = (conf >= c) & (ratio >= r) & ~other
        cover, ok_test = _rates(v[score_on], right[score_on])
        out.append({"min_confidence": c, "min_band_ratio": r, "right_among_valid_picked": round(ok, 3),
                    "right_among_valid_held_out": round(ok_test, 3), "valid_share_held_out": round(cover, 3)})
    return out


def main():
    rows = []
    files = e1.breathing_files()
    for path in files:
        rec = e1.read(path, root=e1.BREATHING)
        if not isinstance(rec, e1.Recording):
            continue
        target = float(rec.meta["clip_label"].replace("BPM", ""))
        ws = breathing.estimate_breathing((rec.t_s * 1e6).astype(np.int64), rec.amp)
        for w in ws:
            other = "FFT/ACF disagree" in w.reason or "drift" in w.reason
            rows.append((rec.meta["subject"], target, w.bpm, w.confidence, w.band_ratio, other, w.valid))
    subj = np.array([r[0] for r in rows])
    tgt, bpm, conf, ratio = (np.array([r[i] for r in rows], float) for i in (1, 2, 3, 4))
    other, valid_now = np.array([r[5] for r in rows]), np.array([r[6] for r in rows])
    right = np.abs(bpm - tgt) <= TOL
    print(f"{len(files)} files, {len(rows)} windows of 30 s; any window right (no gates): {right.mean():.2f}")
    print(f"current gates (conf {breathing.MIN_CONFIDENCE}, ratio {breathing.MIN_BAND_RATIO}): "
          f"valid {valid_now.mean():.2f} of windows, right among valid {right[valid_now].mean():.2f}")
    sweep = []
    for c in CONF:
        for r in RATIO:
            v = (conf >= c) & (ratio >= r) & ~other
            sweep.append({"min_confidence": c, "min_band_ratio": r, "valid_share": round(float(v.mean()), 3),
                          "right_among_valid": round(float(right[v].mean()), 3) if v.any() else None,
                          "files_with_valid": int(len({(s, t) for s, t, ok in zip(subj, tgt, v) if ok}))})
    print("conf  ratio  valid  right|valid  files-with-a-valid-window")
    for s in sweep:
        print(f"{s['min_confidence']:4.2f}  {s['min_band_ratio']:4.1f}  {s['valid_share']:5.2f}  "
              f"{s['right_among_valid'] if s['right_among_valid'] is not None else '-':>6}  {s['files_with_valid']:3d}")
    per_rate = {int(t): {"windows": int((tgt == t).sum()), "right_no_gates": round(float(right[tgt == t].mean()), 3),
                         "right_among_valid_now": round(float(right[(tgt == t) & valid_now].mean()), 3)
                         if ((tgt == t) & valid_now).any() else None} for t in sorted(set(tgt))}
    print("per target rate:", per_rate)
    ho = held_out(subj, conf, ratio, other, right)
    for h in ho:
        print(f"held out: gates ({h['min_confidence']}, {h['min_band_ratio']}) picked at "
              f"{h['right_among_valid_picked']:.2f} right -> {h['right_among_valid_held_out']:.2f} right on the "
              f"other subjects, {h['valid_share_held_out']:.2f} of their windows valid")
    out = HERE / "results"
    out.mkdir(exist_ok=True)
    (out / "breathing_e1.json").write_text(json.dumps({"windows": len(rows), "right_no_gates": round(float(right.mean()), 3),
                                                       "current": {"valid_share": round(float(valid_now.mean()), 3),
                                                                   "right_among_valid": round(float(right[valid_now].mean()), 3)},
                                                       "per_rate": per_rate, "held_out": ho, "sweep": sweep}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
