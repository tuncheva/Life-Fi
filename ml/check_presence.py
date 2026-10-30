"""Can a still person be told from an empty room? Checked on E4 (3DO).

    .venv/Scripts/python ml/check_presence.py

E4: 3 days (d1-d3), sessions b (empty), s (sitting), l (lying), w
(walking), a class per packet; LLTF in the first 128 bytes of `data`, 64
centred pairs, our k = j - 32 (pairs 6..31 and 33..58). Directional
antenna, through a wall: a different domain from ours.

As live (plan-v2 §6.1, §6.6): calibrate on the first 120 s of the day's
b1 (the 2-min empty calibration), then score 10 s windows of the other
recordings:
  D = mean |p - p_empty| over subcarriers, both profiles offset-removed (dB)
  S = 1 - corr(p, p_empty)
where p is the window's mean dB profile. Threshold T_on = 2 x P99 of the
calibration windows (plan-v2 starting value). Reports the share of still
(sitting / lying) windows above T_on = detected, and of other empty
windows above it = false; same day and with a calibration two days old
(d1 -> d3, drift). Windows within 2 s of a label change are dropped.

Then the breathing-band energy B (plan-v2 §6.1's second feature), per 30 s
window, with the threshold taken from one day's empty recordings and
applied to every day. Found 2026-10-29: the static profile drifts as much
in 10 empty minutes as a still person changes it, while B separates a
still person from an empty room on every day (AUC 0.98-1.00).
Writes ml/results/presence_e4.json.
"""

import csv
import json
import pathlib
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "engine"))

from lifefi import dsp  # noqa: E402

RAW = HERE.parent / "datasets" / "raw" / "E4_3DO" / "3DO"
PAIRS = list(range(6, 32)) + list(range(33, 59))
WIN_S = 10
CAL_S = 120
EDGE_S = 2.0


def read(path):
    t, amp, cls = [], [], []
    csv.field_size_limit(1 << 24)
    with open(path, newline="") as fh:
        for r in csv.DictReader(fh):
            v = r["data"].strip("[]").split(",")
            if len(v) < 128:
                continue
            p = np.array(v[:128], dtype=np.float32).reshape(64, 2)[PAIRS]
            amp.append(np.hypot(p[:, 0], p[:, 1]))
            t.append(int(r["local_timestamp"]))
            cls.append(int(r["class"]))
    t = np.array(t, dtype=np.int64)
    step = np.diff(t)
    t = np.r_[t[0], t[0] + np.cumsum(np.where(step < -2**31, step + 2**32, step))] / 1e6
    t = t - t[0]
    segs = dsp.to_features(t, np.array(amp))
    out = []
    cls = np.array(cls)
    change = t[np.r_[False, np.diff(cls) != 0]]
    for s in segs:
        c = cls[np.clip(np.searchsorted(t, s.t), 0, len(t) - 1)]
        near = np.zeros(len(s.t), bool)
        for tc in change:
            near |= np.abs(s.t - tc) < EDGE_S
        out.append((s.t, s.F, s.valid, c, near))
    return str(path.relative_to(RAW)), out


def windows(segs, start_s=0.0):
    """10 s windows with one class: (mean profile, class)."""
    res = []
    n = int(WIN_S * dsp.FS)
    for t, F, valid, c, near in segs:
        for a in range(0, len(t) - n + 1, n):
            sl = slice(a, a + n)
            if t[a] < start_s or near[sl].any() or valid[sl].mean() < 0.9 or len(set(c[sl])) != 1:
                continue
            p = F[sl].mean(axis=0)
            res.append((p - p.mean(), int(c[a])))
    return res


def scores(P, p_empty):
    D = np.abs(P - p_empty).mean(axis=1)
    S = 1 - np.array([np.corrcoef(p, p_empty)[0, 1] for p in P])
    return D, S


def evaluate(cal_segs, test):
    cal = [p for p, c in windows(cal_segs) if c == 0][: CAL_S // WIN_S]
    if len(cal) < 6:
        return None
    cal = np.array(cal)
    p_empty = cal.mean(axis=0)
    Dc, Sc = scores(cal, p_empty)
    out = {}
    for name, sc, ref in (("D", 0, Dc), ("S", 1, Sc)):
        t_on = 2 * np.percentile(ref, 99)
        groups = {}
        for kind, P in test.items():
            if len(P):
                groups[kind] = round(float((scores(np.array(P), p_empty)[sc] > t_on).mean()), 3)
        out[name] = {"t_on": round(float(t_on), 4), "share_above": groups}
    return out


def breath_power(segs, n=30 * 50):
    """B per 30 s window (hop 15 s): mean 0.1-0.5 Hz variance of the 8 strongest subcarriers, with its class."""
    from scipy import signal
    sos = signal.butter(2, [0.1, 0.5], btype="band", fs=dsp.FS, output="sos")
    out = []
    for t, F, valid, c, near in segs:
        for a in range(0, len(t) - n + 1, n // 2):
            sl = slice(a, a + n)
            if near[sl].any() or valid[sl].mean() < 0.9 or len(set(c[sl])) != 1:
                continue
            bp = signal.sosfiltfilt(sos, F[sl] - F[sl].mean(axis=0), axis=0)
            out.append((float(np.sort(bp.var(axis=0))[-8:].mean()), int(c[a])))
    return out


def breathing_check(by_day):
    """Threshold from one day's empty recordings (P99), applied to every day."""
    B = {day: [w for segs in sessions.values() for w in breath_power(segs)] for day, sessions in by_day.items()}
    out = {}
    for cal_day in sorted(B):
        t_on = float(np.percentile([p for p, c in B[cal_day] if c == 0], 99))
        for day in sorted(B):
            empty = [p for p, c in B[day] if c == 0]
            still = [p for p, c in B[day] if c in (2, 3)]
            out[f"threshold from {cal_day} -> {day}"] = {
                "t_on": round(t_on, 5),
                "still_detected": round(float(np.mean(np.array(still) > t_on)), 3),
                "empty_flagged": round(float(np.mean(np.array(empty) > t_on)), 3)}
    return out


def main():
    files = sorted(RAW.glob("d*/*/csiposreg.csv"))
    with ProcessPoolExecutor(8) as pool:
        data = dict(pool.map(read, files))
    by_day = {}
    for key, segs in data.items():
        day, sess = key.split("\\")[0].split("/")[0], key.replace("\\", "/").split("/")[1]
        by_day.setdefault(day, {})[sess] = segs

    def test_set(day, skip_cal):
        groups = {"empty (other recordings)": [], "sitting still": [], "lying still": [], "walking": []}
        for sess, segs in by_day[day].items():
            if skip_cal and sess == "b1":
                continue
            for p, c in windows(segs):
                groups[["empty (other recordings)", "walking", "sitting still", "lying still"][c]].append(p)
        return groups

    results = {}
    for day in sorted(by_day):
        if "b1" not in by_day[day]:
            continue
        results[f"{day} same day"] = evaluate(by_day[day]["b1"], test_set(day, True))
    days = sorted(by_day)
    if len(days) >= 3 and "b1" in by_day[days[0]]:
        results[f"{days[0]} calibration -> {days[-1]} (drift)"] = evaluate(by_day[days[0]]["b1"], test_set(days[-1], False))
    for k, v in results.items():
        print(k)
        for name, r in (v or {}).items():
            print(f"   {name} (T_on {r['t_on']}):  " + "  ".join(f"{g}: {s:.2f}" for g, s in r["share_above"].items()))
    breath = breathing_check(by_day)
    print("breathing-band energy B, threshold = P99 of one day's empty windows:")
    for k, r in breath.items():
        print(f"   {k}: still person detected {r['still_detected']:.2f}, empty room flagged {r['empty_flagged']:.2f}")
    (HERE / "results").mkdir(exist_ok=True)
    (HERE / "results" / "presence_e4.json").write_text(json.dumps({"static_profile": results, "breathing_energy": breath},
                                                                  indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
