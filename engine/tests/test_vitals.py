"""Vital signs in the engine: `breathing.reason` and the EXPERIMENTAL `heart` (results.schema.json).

    python engine/tests/test_vitals.py

Synthetic board recordings (engine/tests/scenarios.py) with a pulse from
lifefi.synth (`heart_bpm`, a pure sine: much easier than a real pulse, so
this checks the engine's wiring and gating, not heart-rate accuracy). All
runs use seed 1, the timings test_engine.py already checks:

- A sitting + 82 /min: the rate once still >= 30 s, warm-up, the empty
  start, the walk-in, then a gap and a source switch at its end;
- C sitting without a pulse: never a heart value;
- D leave + 66 /min: the rate while sitting, no value after leaving;
- the reason-text mapping (lifefi.engine._window_reason) and heart.publish false.

Every result must validate against contracts/results.schema.json.
"""

import dataclasses
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))
sys.path.insert(0, str(ROOT / "engine" / "tests"))
import scenarios  # noqa: E402
import numpy as np  # noqa: E402
from lifefi import breathing, heart  # noqa: E402
from lifefi.engine import Engine, _window_reason  # noqa: E402

try:
    import jsonschema
    SCHEMA = jsonschema.Draft202012Validator(json.loads((ROOT / "contracts" / "results.schema.json").read_text()))
except ImportError:
    SCHEMA = None

failures = 0
VITALS = ("warming_up", "no_person", "motion", "noise", "unstable")


def check(cond, what):
    global failures
    print(("  ok   " if cond else "  FAIL ") + what)
    failures += 0 if cond else 1


def run(name, tick=0.5, eng=None, limit_s=None, **synth_kw):
    """test_engine.run with synth arguments; returns (results, engine, now, frames, bad)."""
    ts_us, csi, _ = scenarios.scenario(name, **synth_kw)
    frames = list(scenarios.frames(ts_us, csi))
    eng = eng or Engine()
    acks, results, bad = [], [], []
    t0 = frames[0][0] / 1e6
    now, i = t0 + tick, 0
    eng.handle({"type": "calibrate", "id": 1, "kind": "empty", "duration_s": 120}, acks.append, now)
    while i < len(frames) and (limit_s is None or now - t0 <= limit_s):
        while i < len(frames) and frames[i][0] / 1e6 <= now:
            eng.feed(frames[i][1], frames[i][0])
            i += 1
        r = eng.tick(now)
        if SCHEMA is not None:
            errs = list(SCHEMA.iter_errors(r))
            if errs:
                bad.append((round(now - t0, 1), errs[0].message))
        results.append((now - t0, r))
        now += tick
    return results, eng, now, bad


def timing(name, eng):
    ms = list(eng.heart_ms)
    print(f"  lifefi.heart per call: mean {np.mean(ms):.1f} ms, max {max(ms):.1f} ms ({len(ms)} calls) [{name}]")


def consistency(name, results, bad):
    """Check 7, every result of a run."""
    check(not bad, f"{name}: every result validates" + (f" (first bad {bad[0]})" if bad else ""))
    errs = []
    for t, r in results:
        b, h = r["breathing"], r["heart"]
        for what, v in (("breathing", b), ("heart", h)):
            if (v["bpm"] is None) != (v["reason"] is not None) or v["valid"] != (v["bpm"] is not None):
                errs.append((t, what, "bpm/reason/valid"))
            if v["reason"] not in VITALS + (None,):
                errs.append((t, what, v["reason"]))
        if not (0 <= h["confidence"] <= 1 and 0 <= h["valid_share"] <= 1):
            errs.append((t, "heart", "range"))
        if r["presence"]["state"] != "present" and not {b["reason"], h["reason"]} <= {"warming_up", "no_person"}:
            errs.append((t, "reason while not present", b["reason"], h["reason"]))
        if h["valid"] and not b["valid"]:
            errs.append((t, "heart without breathing"))
    check(not errs, f"{name}: bpm None <=> reason, valid <=> bpm, ranges, not present => warming_up/no_person, "
                    f"heart => breathing" + (f" (first {errs[0]})" if errs else ""))


def pulse_checks(name, results, bpm, span):
    """Check 1: the rate once still, and nothing else."""
    late = [r["heart"] for t, r in results if span[0] <= t <= span[1] and r["heart"]["valid"]]
    shown = [r["heart"] for _, r in results if r["heart"]["valid"]]
    check(len(late) >= 20, f"{name}: >= 20 heart values in {span[0]:.0f}-{span[1]:.0f} s ({len(late)})")
    check(all(abs(h["bpm"] - bpm) <= 3 for h in shown),
          f"{name}: every heart value within 3 of {bpm} /min ({sorted({h['bpm'] for h in shown})[:6]})")
    check(all(h["valid_share"] >= 0.5 and h["reason"] is None for h in shown), f"{name}: valid => share >= 0.5, no reason")


def empty_start(name, results):
    """Check 4: the 130 s empty room before the walk-in."""
    span = [r for t, r in results if 35 <= t <= 128]
    away = [r for r in span if r["presence"]["state"] != "present"]
    check(len(away) >= 0.9 * len(span), f"{name}: the empty start is not present on >= 90 % of ticks ({len(away)}/{len(span)})")
    check(all(r["heart"]["reason"] == r["breathing"]["reason"] == "no_person" for r in away),
          f"{name}: empty start => both reasons no_person")


# ---- A: sitting, 82 /min ------------------------------------------------------
print("A: sitting + 82 /min")
res_a, eng_a, now_a, bad = run("sitting", heart_bpm=82)
consistency("A", res_a, bad)
pulse_checks("A", res_a, 82, (200, 260))
first = res_a[0][1]["heart"]
check(first == {"bpm": None, "valid": False, "confidence": 0.0, "snr": None, "valid_share": 0.0, "reason": "warming_up"},
      f"A: first result heart is the warming_up object ({first})")
check(all(r["heart"]["reason"] == r["breathing"]["reason"] == "warming_up" and r["heart"]["bpm"] is None
          for t, r in res_a if t < 30), "A: under 30 s both reasons warming_up")
empty_start("A", res_a)
walk = [r for t, r in res_a if scenarios.ENTER[0] + 2 <= t <= scenarios.ENTER[1] + 15 and r["presence"]["state"] == "present"]
check(walk and all(r["heart"]["reason"] == r["breathing"]["reason"] == "motion" for r in walk),
      f"A: walking in => both reasons motion ({len(walk)} ticks)")
early = [t for t, r in res_a if r["heart"]["valid"] and t < scenarios.ENTER[1] + 30]
check(not early, f"A: no heart value before 30 s still after the walk-in ({early[:3]})")
timing("A", eng_a)
# check 9: a gap (> MAX_GAP_S, or a new boot) empties the heart history, no extra replay
check(len(eng_a.heart_hist) > 0, "A: heart history filled before the gap")
eng_a.live.new_segment()
r = eng_a.tick(now_a)
check(r["heart"]["bpm"] is None and r["heart"]["valid_share"] == 0 and len(eng_a.heart_hist) == 0
      and r["heart"]["reason"] == "warming_up", f"A: after a gap no heart value, history empty ({r['heart']})")
# check 8: a source switch empties everything, no extra replay
acks = []
eng_a.handle({"type": "set_source", "id": 9, "mode": "replay"}, acks.append, now_a)
r = eng_a.tick(now_a + 0.5)
check(acks and acks[0]["ok"] and r["heart"]["reason"] == "warming_up" and r["heart"]["valid_share"] == 0
      and r["heart"]["confidence"] == 0.0 and r["breathing"]["reason"] == "warming_up",
      f"A: after set_source both warming_up, heart history empty ({r['heart']})")

# ---- C: sitting, no pulse --------------------------------------------------------
print("C: sitting, no pulse")
res_c, eng_c, now_c, bad = run("sitting")
consistency("C", res_c, bad)
check(not any(r["heart"]["valid"] for _, r in res_c), "C: no pulse => never a heart value")
# breathing is shown after 20 s still, heart needs 30 s: "motion" in between
check(all(r["heart"]["reason"] in ("noise", "unstable") for t, r in res_c
          if r["breathing"]["valid"] and t >= scenarios.ENTER[1] + 40),
      "C: breathing valid and still => heart reason noise/unstable")
check(all(r["heart"]["reason"] in ("noise", "unstable", "motion") for _, r in res_c if r["breathing"]["valid"]),
      "C: breathing valid => heart reason noise/unstable/motion")
check(any(r["breathing"]["valid"] for _, r in res_c), "C: breathing is still shown")
empty_start("C", res_c)
timing("C", eng_c)
# a NaN window (real data can give one: an empty-slice mean in lifefi.heart) never reaches the JSON
real_estimate = heart.estimate_heart
heart.estimate_heart = lambda ts, csi: [heart.HeartWindow(0.0, 70.0, float("nan"), float("nan"), 70.0, 15.0, True, "")]
try:
    eng_c.next_breath = -np.inf
    r = eng_c.tick(now_c)
finally:
    heart.estimate_heart = real_estimate
try:
    json.dumps(r, allow_nan=False)
    finite = True
except ValueError:
    finite = False
check(finite and not eng_c.heart_last.valid and r["heart"]["reason"] in ("noise", "unstable"),
      f"C: a non-finite heart window is invalid and the result stays finite JSON ({r['heart']})")

# ---- D: leave, 66 /min ---------------------------------------------------------------
print("D: leave + 66 /min")
res_d, eng_d, _, bad = run("leave", heart_bpm=66)
consistency("D", res_d, bad)
pulse_checks("D", res_d, 66, (170, 200))
check(not any(r["heart"]["valid"] or r["breathing"]["valid"] for t, r in res_d if t >= 210),
      "D: no heart and no breathing value from 210 s (left at 200-205 s)")
gone = [r for t, r in res_d if t >= 240 and r["presence"]["state"] != "present"]
check(gone and all(r["heart"]["reason"] == r["breathing"]["reason"] == "no_person" for r in gone),
      f"D: after leaving, not present => both no_person ({len(gone)} ticks)")
timing("D", eng_d)

# ---- reason texts (check 10): the only place that reads them is engine._window_reason ----
print("window reasons")
hw = heart.HeartWindow(0.0, 70.0, 9.0, 0.5, 70.0, 15.0, True, "")
bw = breathing.BreathWindow(0.0, 15.0, 0.6, 5.0, 15.0, True, "")
cases = [(hw, None), (bw, None)]
for text in ("near breathing harmonic (75)", "at noise floor (snr 3.1)", "peak at band/notch edge",
             "no clear peak (0.20)", "several peaks (0.61)", "motion (1.2)",
             "FFT/ACF disagree; no clear peak (0.20)"):
    cases.append((dataclasses.replace(hw, valid=False, reason=text), "noise"))
for text in ("no clear peak (0.30)", "motion/noise (1.4)", "drift at band edge"):
    cases.append((dataclasses.replace(bw, valid=False, reason=text), "noise"))
cases += [(dataclasses.replace(hw, valid=False, reason="FFT/ACF disagree"), "unstable"),
          (dataclasses.replace(bw, valid=False, reason="FFT/ACF disagree"), "unstable")]
wrong = [(w.reason, want, _window_reason(w)) for w, want in cases if _window_reason(w) != want]
check(not wrong, f"_window_reason maps every estimator text ({wrong})")

# ---- heart.publish false (check 11): 40 s, no calibration needed ----
print("heart.publish false")
eng = Engine()
eng.rules["heart"]["publish"] = False
res_off, _, _, bad = run("sitting", eng=eng, limit_s=40.0)
check(not bad and all(r["heart"] is None for _, r in res_off) and res_off[-1][1]["breathing"]["reason"] is not None,
      f"publish false => heart null in every result, still valid ({len(res_off)} results)")

# ---- breathing.hold_s / quiet_m_x: the shown rate (display only) ----
print("breathing hold and the vital-signs stillness bar")
eng = Engine()
eng.rules["breathing"].update(hold_s=20.0, low_motion_s=20.0)
eng.started, eng.vitals_since = 0.0, -np.inf
eng.breath = dataclasses.replace(bw, bpm=12.0, valid=True, reason="")
eng.breath_valid = True
eng._breath_hold(100.0, True, False, 30.0)
eng.breath_valid = False                          # the next window is too weak
eng._breath_hold(110.0, True, False, 40.0)
check(eng.breath_show == 12.0, f"a weak window inside hold_s keeps the last rate ({eng.breath_show})")
eng._breath_hold(121.0, True, False, 51.0)
check(eng.breath_show is None, "after hold_s it is cleared")
eng.breath_valid = True
eng._breath_hold(130.0, True, False, 60.0)
eng.breath_valid = False
eng._breath_hold(131.0, False, False, 61.0)
check(eng.breath_show is None, "never held once the person is gone")
eng._breath_hold(132.0, True, False, 5.0)
check(eng.breath_show is None, "never held after motion (quiet_for < low_motion_s)")
eng.last_vital_motion = 133.0
eng._breath_hold(160.0, True, False, 27.0)
check(eng.breath_show is None, "a rate from before the last motion is not brought back")
eng.rules["breathing"]["hold_s"] = 0.0
eng.breath_valid, eng.last_vital_motion = True, None
eng._breath_hold(200.0, True, False, 60.0)
eng.breath_valid = False
eng._breath_hold(200.5, True, False, 60.5)
check(eng.breath_show is None, "hold_s 0: only the current window is shown")

print("PASSED" if failures == 0 else f"FAILED ({failures})")
sys.exit(1 if failures else 0)
