"""The whole engine on synthetic board recordings (engine/tools/fakesensor.py).

    python engine/tests/test_engine.py [scenario ...]

Each scenario runs through lifefi.engine.Engine faster than real time:
real frames are parsed, the clock is mapped, F is built, a 2-min empty
calibration is taken through the `calibrate` command, and every rule
runs. Every result must validate against contracts/results.schema.json,
and each scenario's events and presence must come at the expected times.
Uses the trained model when ml/models/ exists (it is hidden either way).
"""

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))
sys.path.insert(0, str(ROOT / "engine" / "tools"))
import fakesensor  # noqa: E402
from lifefi.engine import Engine  # noqa: E402

try:
    import jsonschema
    SCHEMA = jsonschema.Draft202012Validator(json.loads((ROOT / "contracts" / "results.schema.json").read_text()))
except ImportError:
    SCHEMA = None

failures = 0


def check(cond, what):
    global failures
    print(("  ok   " if cond else "  FAIL ") + what)
    failures += 0 if cond else 1


def run(name, tick=0.5):
    ts_us, csi, expect = fakesensor.scenario(name)
    frames = list(fakesensor.frames(ts_us, csi))
    eng = Engine()
    acks, results, bad = [], [], []
    t0 = frames[0][0] / 1e6
    now, i = t0 + tick, 0
    eng.handle({"type": "calibrate", "id": 1, "kind": "empty", "duration_s": 120}, acks.append, now)
    while i < len(frames):
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
    eng.handle({"type": "get_status", "id": 2}, acks.append, now)
    return results, acks, bad, expect


def first_event(results, kind, state="active"):
    return next((t for t, r in results for e in r["events"] if e["type"] == kind and e["state"] == state), None)


def events(results):
    return sorted({e["type"] for _, r in results for e in r["events"]})


def first_state(results, state, after=0.0):
    return next((t for t, r in results if t >= after and r["presence"]["state"] == state), None)


wanted = sys.argv[1:] or list(fakesensor.SCENARIOS)
for name in wanted:
    print(f"== {name}")
    results, acks, bad, ex = run(name)
    check(SCHEMA is None or not bad, f"all {len(results)} results match results.schema.json"
          + (f" (first: {bad[0]})" if bad else "") + (" (jsonschema missing: not checked)" if SCHEMA is None else ""))
    cal = next((a for a in acks if a["id"] == 1), None)
    check(cal is not None and cal["ok"], f"2-min calibration accepted ({cal})")
    status = next((a for a in acks if a["id"] == 2), None)
    check(status is not None and status["ok"] and status["data"]["device"]["rate_hz"] > 50,
          f"get_status: device seen at {status and status['data']['device']['rate_hz']} Hz")
    check(all(r["posture"] is None for _, r in results), "posture hidden (posture.publish: false)")
    during_cal = [r["presence"]["state"] for t, r in results if 5 < t < 125]
    check(all(s == "empty" for s in during_cal), "empty during the empty start")
    allowed = {"fall": {"fall", "fainted_suspected"}, "breath_hold": {"no_breathing"}}.get(name, set())
    check(set(events(results)) <= allowed, f"no unexpected events ({events(results)})")
    if "present_after" in ex:
        t = first_state(results, "present", after=fakesensor.ENTER[0] - 1)
        check(t is not None and t <= ex["present_after"], f"PRESENT {t and t - fakesensor.ENTER[0]:.1f} s after walking in")
        breathing = [r["breathing"]["bpm"] for t, r in results if 175 < t < 195 and r["breathing"]["valid"]]
        check(len(breathing) > 10 and all(abs(b - 15) <= 1 for b in breathing),
              f"breathing 15 /min shown while sitting ({len(breathing)} results, {sorted(set(breathing))[:4]})")
    if name == "empty":
        check(all(r["presence"]["state"] == "empty" for _, r in results), "empty throughout")
        check(max(r["motion"] for t, r in results if t > 130) < 0.1, "motion stays below the server's 0.1")
    if "fall_at" in ex:
        t = first_event(results, "fall")
        check(t is not None and ex["fall_at"][0] <= t <= ex["fall_at"][1], f"fall at {t and round(t, 1)} s (impact at 200 s)")
        t2 = first_event(results, "fainted_suspected")
        check(t2 is not None and ex["fainted_at"][0] <= t2 <= ex["fainted_at"][1],
              f"fainted_suspected at {t2 and round(t2, 1)} s (20 s more stillness)")
    if "no_breathing_at" in ex:
        t = first_event(results, "no_breathing")
        check(t is not None and ex["no_breathing_at"][0] <= t <= ex["no_breathing_at"][1],
              f"no_breathing at {t and round(t, 1)} s (hold 200-225 s)")
        c = first_event(results, "no_breathing", "cleared")
        check(c is not None and c <= ex["cleared_by"], f"cleared at {c and round(c, 1)} s (breathing again at 225 s)")
    if "empty_at" in ex:
        t = first_state(results, "empty", after=205)
        check(t is not None and ex["empty_at"][0] <= t <= ex["empty_at"][1], f"EMPTY again at {t and round(t, 1)} s (left at 205 s)")

print(f"\ntest_engine {'PASSED' if not failures else 'FAILED'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
