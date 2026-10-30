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
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))
sys.path.insert(0, str(ROOT / "engine" / "tools"))
import fakesensor  # noqa: E402
import numpy as np  # noqa: E402
from lifefi import calibration  # noqa: E402
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


def run(name, tick=0.5, until=None):
    """until(eng, result) -> True stops early and returns (engine, now) instead (the source-switch check)."""
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
        if until is not None and until(eng, r):
            return eng, now
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
    eng_status = status["data"]["engine"] if status else {}
    check(eng_status.get("outputs", {}).get("posture") is False and "source_info" in eng_status,
          f"get_status says what is published ({eng_status.get('outputs')})")
    if eng_status.get("outputs", {}).get("activity"):
        acts = [r["activity"] for _, r in results if r["activity"] is not None]
        check(len(acts) > len(results) // 2 and all(abs(sum(a["probs"].values()) - 1) < 0.02 for a in acts),
              f"the model's guess is sent ({len(acts)} of {len(results)} results)")
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

if "fall" in wanted:
    print("== switching the source during a fall")
    eng, now = run("fall", until=lambda e, r: "fainted_suspected" in e.events.active)
    acks = []
    eng.handle({"type": "set_source", "id": 9, "mode": "replay", "speed": 0}, acks.append, now)
    check(acks and not acks[-1]["ok"], f"speed 0 refused ({acks and acks[-1]['error']})")
    eng.handle({"type": "set_source", "id": 10, "mode": "replay"}, acks.append, now)
    r = eng.tick(now + 0.5)
    cleared = {e["type"] for e in r["events"] if e["state"] == "cleared" and e["data"] == {"reason": "source changed"}}
    check(acks[-1]["ok"] and cleared == {"fall", "fainted_suspected"} and r["active"] == [],
          f"fall and fainted cleared with the old signal, reason given ({sorted(cleared)}, active {r['active']})")
    try:
        for k in range(120):                      # 60 s without frames: used to crash on fall_t = None
            eng.tick(now + 1.0 + 0.5 * k)
        check(True, "60 s of ticks after the switch, no crash")
    except Exception as err:                      # noqa: BLE001
        check(False, f"ticks after the switch crashed: {err!r}")
    eng.handle({"type": "calibrate", "id": 11, "kind": "empty", "duration_s": None}, acks.append, now)
    check(not acks[-1]["ok"], f"a bad argument is refused, not raised ({acks[-1]['error']})")

print("== calibration saved and loaded again")
tmp = pathlib.Path(tempfile.mkdtemp()) / "calibration.json"
cal = calibration.Calibration("cal-0007", 1000.0, 120.0, 1, 2, 3, 4, 5, 6, 7, 8, np.linspace(-1, 1, 52, dtype=np.float32))
Engine(calibration_path=tmp)._save_calibration(cal)
e2 = Engine(calibration_path=tmp)
r = e2.tick(1000.0 + 60)
check(r["calibration"] == {"state": "ok", "id": "cal-0007", "age_s": 60.0} and e2.cal_seq == 7,
      f"loaded at start ({r['calibration']})")
r = e2.tick(1000.0 + 25 * 3600)
check(r["calibration"]["state"] == "stale", "older than stale_after_h: stale")
e3 = Engine(mode="replay", calibration_path=tmp)
check(e3.tick(1060.0)["calibration"]["state"] == "none", "a replay does not use the live calibration")
tmp.write_text("{not json")
check(Engine(calibration_path=tmp).calibration is None, "a broken file is ignored")

print(f"\ntest_engine {'PASSED' if not failures else 'FAILED'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
