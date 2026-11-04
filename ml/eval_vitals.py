"""Vital signs on the recorded spot sessions: plausibility, not accuracy.

    python ml/eval_vitals.py

Replays every data/sessions/spots-* session through the engine as
ml/eval_position.py does (no calibration, and a fresh 30 s one from the
empty minute) and reports, per spot, how often breathing and the
EXPERIMENTAL heart rate are shown, why not (the results' `reason`), the
published rates and their jumps. It also runs lifefi.breathing and
lifefi.heart ungated on each spot's packets, to tell whether the engine's
gating or the estimator is the bottleneck.

No pulse-oximeter or breathing-belt reference was recorded, so nothing here
is an accuracy figure. lifefi.heart's thresholds are not changed for this.
Writes ml/results/vitals_eval.json; prints SKIPPED without sessions.
"""

import json
import sys
import time
from collections import Counter

import numpy as np

import eval_position as ep
from csi_recorder import load_csirec
from lifefi import breathing, heart

OUT = ep.ROOT / "ml" / "results" / "vitals_eval.json"
JUMP = {"breathing": 3.0, "heart": 8.0}          # /min between consecutive published values
NOTE = ("No pulse-oximeter or breathing-belt reference was recorded: plausibility only (resting adult ranges "
        "6-30 breaths/min, 45-120 /min), not accuracy. Spots are 60 s each; heart needs 30 s still after the last "
        "motion plus a valid breathing window, so at most ~25 s per spot can show a value. The transmitter was a "
        "phone hotspot.")


def pct(xs):
    if not xs:
        return None
    p10, p50, p90 = np.percentile(xs, [10, 50, 90])
    return {"p10": round(float(p10), 1), "p50": round(float(p50), 1), "p90": round(float(p90), 1),
            "min": round(float(min(xs)), 1), "max": round(float(max(xs)), 1), "n": len(xs)}


def jumps(xs, size):
    return int(sum(abs(b - a) > size for a, b in zip(xs, xs[1:])))


def score(s, rows):
    """Per spot: shares, reasons, published rates (results with t0 + 2 <= now <= t1 - 2)."""
    out = {}
    for sp in s["spots"]:
        rs = [r for now, r in rows if sp["t0"] + 2 <= now <= sp["t1"] - 2]
        present = [r for r in rs if r["presence"]["state"] == "present"]
        m = {"ticks": len(rs), "present_ticks": len(present)}
        for key in ("breathing", "heart"):
            vals = [r[key] for r in rs if r.get(key) is not None]
            shown = [v["bpm"] for v in vals if v["valid"]]
            m[key] = {"valid_share_present": round(sum(1 for r in present if r[key] and r[key]["valid"]) / len(present), 3)
                      if present else None,
                      "reasons": dict(Counter(str(v["reason"]) for v in vals)),
                      "bpm": pct(shown), "jumps": jumps(shown, JUMP[key])}
        vs = [r["heart"]["valid_share"] for r in present if r.get("heart")]
        m["heart"]["valid_share_median_present"] = round(float(np.median(vs)), 3) if vs else None
        out[sp["name"]] = m
    return out


def raw(s):
    """lifefi.breathing / lifefi.heart on each spot's packets, every window, no engine gate."""
    rec = load_csirec(s["path"])
    t = rec["host_us"].astype(np.int64)
    out = {}
    for sp in s["spots"]:
        sel = (t >= sp["t0"] * 1e6) & (t <= sp["t1"] * 1e6)
        row = {}
        for key, fn in (("breathing", breathing.estimate_breathing), ("heart", heart.estimate_heart)):
            w = fn(t[sel], rec["csi"][sel]) if sel.sum() > 10 else []
            ok = [x.bpm for x in w if x.valid]
            row[key] = {"windows": len(w), "valid_share": round(len(ok) / len(w), 3) if w else None,
                        "bpm_valid": [round(float(b), 1) for b in ok],
                        "reasons": dict(Counter(part.split(" (")[0] for x in w if not x.valid
                                                for part in x.reason.split("; ")))}
        out[sp["name"]] = row
    return out


def main():
    sessions = [ep.load_session(d) for d in ep.find_sessions()]
    if not sessions:
        print("SKIPPED (no data/sessions/spots-*)")
        return 0
    calls = []
    original = heart.estimate_heart

    def timed(*a, **k):
        t0 = time.perf_counter()
        r = original(*a, **k)
        calls.append((time.perf_counter() - t0) * 1e3)
        return r

    heart.estimate_heart = timed                    # the engine calls heart.estimate_heart: replay() sees this
    out = {"note": NOTE, "thresholds": "heart.py unchanged", "sessions": {}}
    real_min = ep.calibration_mod.MIN_S
    try:
        for s in sessions:
            e = ep.empty_spot(s)
            ep.calibration_mod.MIN_S = ep.CAL_S - 10.0   # harness only, as ep.eval_engine
            try:
                _, _, cal, _ = ep.replay(s, cal_at=e["t0"])
            finally:
                ep.calibration_mod.MIN_S = real_min
            res = {}
            for tag, c in (("nocal", None), ("fresh", cal)):
                if tag == "fresh" and (c is None or isinstance(c, str)):
                    res[tag] = {"error": f"calibration refused by the engine: {c}"}
                    continue
                calls.clear()
                rows, ms, _, _ = ep.replay(s, cal=c)
                res[tag] = {"spots": score(s, rows), "ticks": len(rows),
                            "heart_ms_mean": round(float(np.mean(calls)), 2) if calls else None,
                            "heart_ms_max": round(float(np.max(calls)), 2) if calls else None,
                            "tick_ms_mean": round(float(np.mean(ms)), 2), "tick_ms_max": round(float(np.max(ms)), 2)}
            heart.estimate_heart = original
            res["raw_estimators"] = raw(s)
            heart.estimate_heart = timed
            out["sessions"][s["short"]] = res
    finally:
        heart.estimate_heart = original
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=1), encoding="utf-8")

    print(f"{'session':8} {'variant':6} {'spot':7} {'present':>7} {'breath%':>7} {'heart%':>7} {'raw b%':>7} {'raw h%':>7}  heart reasons")
    for name, res in out["sessions"].items():
        for tag in ("nocal", "fresh"):
            if "spots" not in res.get(tag, {}):
                continue
            for spot, m in res[tag]["spots"].items():
                rw = res["raw_estimators"][spot]
                f = lambda v: "-" if v is None else f"{100 * v:.0f}"  # noqa: E731
                print(f"{name:8} {tag:6} {spot:7} {m['present_ticks']:>7} {f(m['breathing']['valid_share_present']):>7} "
                      f"{f(m['heart']['valid_share_present']):>7} {f(rw['breathing']['valid_share']):>7} "
                      f"{f(rw['heart']['valid_share']):>7}  {m['heart']['reasons']}")
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
