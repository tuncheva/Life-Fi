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

Added 2026-10-30 for the live rules, all with the engine's own code
(lifefi.calibration on the first 120 s of the day's b1, as live):
- `b_multiplier`: B relative to a **2-min** calibration's P99 / P95 (the
  live case, not a whole empty day). The multiplier is picked on two days
  (most still windows found with <= 2 % of empty ones flagged) and scored
  on the third, each day in turn;
- `motion`: M relative to the calibration per class, the 0-1 motion level
  (lifefi.presence.motion_level), and the fall rule's units: P10 of M in
  a recording with a still person vs the empty calibration's P10 (the
  fall baseline), and `t_still` = P95 of M / baseline while someone sits
  or lies still;
- `replay`: the lifefi.presence state machine run over every recording
  (0.5 s ticks, starting EMPTY), scored against E4's per-packet class.
Writes ml/results/presence_e4.json. The parsed E4 is cached in
datasets/processed/e4_presence.npz (delete it after a reader change).
"""

import csv
import json
import pathlib
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "engine"))

from lifefi import calibration, dsp, presence  # noqa: E402
from lifefi import motion as motion_mod  # noqa: E402

RAW = HERE.parent / "datasets" / "raw" / "E4_3DO" / "3DO"
CACHE = HERE.parent / "datasets" / "processed" / "e4_presence.npz"
CLASS_NAMES = ["empty", "walking", "sitting", "lying"]
K_GRID = [1.0, 1.25, 1.5, 2.0, 3.0, 4.0, 6.0, 8.0]
MAX_EMPTY_FLAGGED = 0.02
TICK_S = 0.5
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
    """B per 30 s window (hop 15 s), with its class (lifefi.presence.breath_energy, as the engine)."""
    out = []
    for t, F, valid, c, near in segs:
        for a in range(0, len(t) - n + 1, n // 2):
            sl = slice(a, a + n)
            if near[sl].any() or valid[sl].mean() < 0.9 or len(set(c[sl])) != 1:
                continue
            out.append((presence.breath_energy(F[sl]), int(c[a])))
    return out


def load_all():
    """{"d1/b1": segments, ...}, parsed once and cached (E4 is 2.4 GB of CSV)."""
    if CACHE.exists():
        z = np.load(CACHE, allow_pickle=False)
        index = json.loads(str(z["index"]))
        return {key: [(z[f"{i}_{j}_t"], z[f"{i}_{j}_F"].astype(np.float32), z[f"{i}_{j}_valid"],
                       z[f"{i}_{j}_c"], z[f"{i}_{j}_near"]) for j in range(n)]
                for i, (key, n) in enumerate(index)}
    files = sorted(RAW.glob("d*/*/csiposreg.csv"))
    with ProcessPoolExecutor(8) as pool:
        data = {k.replace("\\", "/").rsplit("/", 1)[0]: v for k, v in pool.map(read, files)}
    arrays, index = {}, []
    for i, (key, segs) in enumerate(sorted(data.items())):
        index.append((key, len(segs)))
        for j, seg in enumerate(segs):
            for f, a in zip(("t", "F", "valid", "c", "near"), seg):
                arrays[f"{i}_{j}_{f}"] = a.astype(np.float16) if f == "F" else a
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    np.savez(CACHE, index=json.dumps(index), **arrays)
    return {k: [(t, F.astype(np.float32), v, c, n) for t, F, v, c, n in segs] for k, segs in data.items()}


def day_calibration(b1_segs):
    """lifefi.calibration on the first CAL_S of the day's b1, as the live engine would."""
    n = int(CAL_S * dsp.FS)
    for t, F, valid, c, near in b1_segs:
        if len(F) >= n and (c[:n] == 0).all():
            return calibration.from_empty(F[:n], valid[:n], "cal-e4", 0.0)
    return None


def b_multiplier(by_day, cals):
    """B / calibration P99 for still and empty windows; multiplier picked on 2 days, scored on the 3rd."""
    ratios = {}
    for day, sessions in by_day.items():
        cal = cals.get(day)
        if cal is None:
            continue
        w = [(b, c) for sess, segs in sessions.items() for b, c in breath_power(segs)]
        ratios[day] = {"empty": np.array([b / cal.b_p99 for b, c in w if c == 0]),
                       "still": np.array([b / cal.b_p99 for b, c in w if c in (2, 3)]),
                       "empty_p95": np.array([b / cal.b_p95 for b, c in w if c == 0]),
                       "still_p95": np.array([b / cal.b_p95 for b, c in w if c in (2, 3)])}

    def rates(days, k, key="", ):
        e = np.concatenate([ratios[d]["empty" + key] for d in days])
        s = np.concatenate([ratios[d]["still" + key] for d in days])
        return float((s > k).mean()), float((e > k).mean())

    out = {"grid": {}, "held_out": {}}
    for day in ratios:
        out["grid"][day] = {str(k): {"still_found": round(rates([day], k)[0], 3),
                                     "empty_flagged": round(rates([day], k)[1], 3)} for k in K_GRID}
    picks = []
    for test in sorted(ratios):
        train = [d for d in ratios if d != test]
        ok = [k for k in K_GRID if rates(train, k)[1] <= MAX_EMPTY_FLAGGED]
        k = max(ok, key=lambda k: rates(train, k)[0]) if ok else max(K_GRID)
        s, e = rates([test], k)
        picks.append(k)
        out["held_out"][test] = {"b_on_x": k, "still_found": round(s, 3), "empty_flagged": round(e, 3)}
    # b_off: the largest P95 multiple that still keeps >= 95 % of still windows above it (pooled)
    s95 = np.concatenate([r["still_p95"] for r in ratios.values()])
    out["b_on_x"] = float(np.median(picks))
    out["b_off_x"] = round(float(min(out["b_on_x"], np.percentile(s95, 5))), 3)
    return out


def motion_check(by_day, cals):
    """M per class against the day's calibration; fall-baseline units; t_still; motion level."""
    out, still_ratio = {}, []
    for day, sessions in sorted(by_day.items()):
        cal = cals.get(day)
        if cal is None:
            continue
        per = {name: [] for name in CLASS_NAMES}
        p10_still = []
        for sess, segs in sessions.items():
            for t, F, valid, c, near in segs:
                if len(F) < 2 * dsp.FS:
                    continue
                M = motion_mod.motion(F)
                keep = ~near & valid
                keep[: int(dsp.FS)] = False
                for k, name in enumerate(CLASS_NAMES):
                    m = M[keep & (c == k)]
                    if len(m):
                        per[name].append(m)
                still = keep & np.isin(c, (2, 3))
                if still.sum() > 30 * dsp.FS:
                    p10_still.append(float(np.percentile(M[still], 10)))
        row = {"cal_m_p10": cal.m_p10, "cal_m_p50": cal.m_p50, "cal_m_p99": cal.m_p99}
        for name, ms in per.items():
            if not ms:
                continue
            m = np.concatenate(ms)
            lvl = presence.motion_level(m, presence.Levels.from_calibration(cal).m_on)
            row[name] = {"median_over_p10": round(float(np.median(m) / cal.m_p10), 2),
                         "p95_over_p10": round(float(np.percentile(m, 95) / cal.m_p10), 2),
                         "log10_median_over_p50": round(float(np.log10(np.median(m) / cal.m_p50)), 3),
                         "log10_p95_over_p50": round(float(np.log10(np.percentile(m, 95) / cal.m_p50)), 3),
                         "level_median": round(float(np.median(lvl)), 3),
                         "level_p95": round(float(np.percentile(lvl, 95)), 3)}
            if name in ("sitting", "lying"):
                still_ratio.append(m / cal.m_p10)
        row["still_recording_p10_over_cal_p10"] = [round(p / cal.m_p10, 2) for p in p10_still]
        out[day] = row
    r = np.concatenate(still_ratio)
    out["t_still_p95_still_over_baseline"] = round(float(np.percentile(r, 95)), 2)
    out["t_still_p99_still_over_baseline"] = round(float(np.percentile(r, 99)), 2)
    return out


def replay(by_day, cals, cfg):
    """The engine's presence state machine over every E4 recording, scored per tick."""
    out = {}
    pooled = {name: [0, 0] for name in CLASS_NAMES}
    for day, sessions in sorted(by_day.items()):
        cal = cals.get(day)
        if cal is None:
            continue
        levels = presence.Levels.from_calibration(cal, {**presence.DEFAULTS, **cfg})
        day_out = {}
        for sess, segs in sorted(sessions.items()):
            if sess == "b1":
                continue                               # the calibration came from it
            right = {name: [0, 0] for name in CLASS_NAMES}
            first_present = None
            for t, F, valid, c, near in segs:
                p = presence.Presence(cfg)
                p.calibrate(levels, float(t[0]))
                M = motion_mod.motion(F)
                nB = int(presence.B_WIN_S * dsp.FS)
                step = int(TICK_S * dsp.FS)
                for i in range(int(dsp.FS), len(F), step):
                    B = presence.breath_energy(F[i - nB:i]) if i >= nB else None
                    st = p.update(float(t[i]), float(M[i]), B)
                    if near[i] or not valid[i]:
                        continue
                    k = int(c[i])
                    ok = (st == "empty") if k == 0 else (st == "present")
                    right[CLASS_NAMES[k]][0] += ok
                    right[CLASS_NAMES[k]][1] += 1
                    if first_present is None and st == "present":
                        first_present = round(float(t[i] - t[0]), 1)
            day_out[sess] = {"right_share": {n: round(a / b, 3) for n, (a, b) in right.items() if b},
                             "first_present_s": first_present}
            for n, (a, b) in right.items():
                pooled[n][0] += a
                pooled[n][1] += b
        out[day] = day_out
    out["pooled_right_share"] = {n: round(a / b, 3) for n, (a, b) in pooled.items() if b}
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
    data = load_all()
    by_day = {}
    for key, segs in data.items():
        day, sess = key.split("/")[:2]
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

    cals = {day: day_calibration(s["b1"]) for day, s in by_day.items() if "b1" in s}
    print("2-min calibrations:", {d: None if c is None else round(c.m_p10, 5) for d, c in cals.items()})
    bm = b_multiplier(by_day, cals)
    print(f"B from a 2-min calibration: b_on_x {bm['b_on_x']}, b_off_x {bm['b_off_x']}; held out:", bm["held_out"])
    mc = motion_check(by_day, cals)
    print(f"motion: t_still (P95 still / baseline) {mc['t_still_p95_still_over_baseline']}")
    for day in sorted(cals):
        print(f"   {day}:", {k: v for k, v in mc[day].items() if k.startswith("still") or k in CLASS_NAMES})
    rp = replay(by_day, cals, {})                    # the engine's own defaults (lifefi.presence.DEFAULTS)
    print("presence replay, share of ticks right (empty -> EMPTY, others -> PRESENT):", rp["pooled_right_share"])
    (HERE / "results").mkdir(exist_ok=True)
    (HERE / "results" / "presence_e4.json").write_text(json.dumps(
        {"static_profile": results, "breathing_energy": breath, "b_multiplier": bm, "motion": mc, "replay": rp},
        indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
