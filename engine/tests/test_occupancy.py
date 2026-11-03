"""lifefi.occupancy: room empty / occupied / unsure from the 4 s disturbance.

    python engine/tests/test_occupancy.py

The thresholds in rules.yaml come from the two real spot sessions
(ml/eval_position.py --fit-occupancy) and are NOT tuned to the synthetic
signal: an empty room must never read occupied, motion must read
occupied, a still breathing person must never read empty while presence
says present, and a permanent change of the static multipath may read
occupied for at most window + hysteresis. Then the hysteresis, the
presence guard, the per-update cost, and the whole engine on the
`leave` scenario (every result valid against the schema).
"""

import json
import pathlib
import sys
import time

import numpy as np
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))
sys.path.insert(0, str(ROOT / "engine" / "tests"))
sys.path.insert(0, str(ROOT / "ml"))
import scenarios  # noqa: E402
from lifefi.engine import RULES, Engine  # noqa: E402
from lifefi.occupancy import Occupancy  # noqa: E402
from lifefi.synth import synth  # noqa: E402
from eval_position import drive, synthetic_checks  # noqa: E402

try:
    import jsonschema
    SCHEMA = jsonschema.Draft202012Validator(json.loads((ROOT / "contracts" / "results.schema.json").read_text()))
except ImportError:
    SCHEMA = None
    print("  (jsonschema not installed: results are not validated against the schema)")

failures = 0


def check(cond, what):
    global failures
    print(("  ok   " if cond else "  FAIL ") + what)
    failures += 0 if cond else 1


CFG = yaml.safe_load(RULES.read_text(encoding="utf-8"))["occupancy"]

# the four synthetic checks (plan A §2.8), AGC on and off
for name, r in synthetic_checks(CFG).items():
    check(r["pass"], f"{name}: {r['detail']}")

# hysteresis: a constant input never flips; a new state needs hold_ticks ticks
ts, csi = synth(40, seed=31, agc=False, motion=True)
states = [r["state"] for _, r in drive(Occupancy(CFG), ts, csi) if r is not None]
flips = sum(a != b for a, b in zip(states, states[1:]))
check(flips <= 1, f"constant motion: {flips} state change(s) (unsure -> occupied at most)")
occ = Occupancy(CFG)
check(occ.state == "unsure", "it starts unsure")
seen = [r["state"] for _, r in drive(occ, ts, csi)[:12] if r is not None]
check(seen[:CFG["hold_ticks"] - 1] == ["unsure"] * (CFG["hold_ticks"] - 1), f"occupied only after {CFG['hold_ticks']} ticks: {seen[:5]}")

# unsure exists: p between p_off and p_on gives unsure, not a forced answer
mid = Occupancy(CFG)
P_mid = 10 ** mid.offset                          # p = 0.5
check(abs(mid.prob(P_mid) - 0.5) < 1e-6 and CFG["p_off"] < 0.5 < CFG["p_on"], "p = 0.5 at the offset, inside the unsure band")

# presence guard: an empty-looking signal is unsure while presence says present, and leaves empty at once
ts, csi = synth(40, seed=32, agc=False)
rows = drive(Occupancy(CFG), ts, csi, lambda now: "present")
check(all(r["state"] != "empty" for _, r in rows if r), "never empty while presence is present")
guard = Occupancy(CFG)
rows = drive(guard, ts, csi, lambda now: "present" if now >= ts[0] / 1e6 + 30.0 else "empty")
before = [r["state"] for now, r in rows if r and now < ts[0] / 1e6 + 30.0]
after = [r["state"] for now, r in rows if r and now >= ts[0] / 1e6 + 30.0]
check(before[-1] == "empty" and after and after[0] == "unsure", f"empty, then unsure on the first present tick ({before[-1]} -> {after[:1]})")

# too few packets or a gap: no answer
t, amp = ts / 1e6, np.abs(csi)
k = int(np.searchsorted(t, t[0] + 4.5))
check(Occupancy(CFG).update(t[k - 1], t[:k:20], amp[:k:20]) is None, "under 8 Hz: no answer")
check(Occupancy(CFG).update(t[k - 1] + 3.0, t[:k], amp[:k]) is None, "nothing for > 1 s: no answer")

# cost of one update on 4 s at 90 Hz
o = Occupancy(CFG)
a = int(np.searchsorted(t, t[k - 1] - 5.0))
t0 = time.perf_counter()
for _ in range(200):
    o.update(t[k - 1], t[a:k], amp[a:k])
ms = (time.perf_counter() - t0) / 200 * 1e3
check(ms < 5.0, f"one update takes {ms:.2f} ms (< 5 ms)")

# the whole engine: occupancy in every result, never empty while presence is present
for name in ("leave",):                         # walks in, sits breathing, walks out
    ts_us, csi, expect = scenarios.scenario(name)
    frames = list(scenarios.frames(ts_us, csi))
    eng = Engine()
    acks, results, bad = [], [], []
    start = frames[0][0] / 1e6
    now, i = start + 0.5, 0
    eng.handle({"type": "calibrate", "id": 1, "kind": "empty", "duration_s": 120}, acks.append, now)
    while i < len(frames):
        while i < len(frames) and frames[i][0] / 1e6 <= now:
            eng.feed(frames[i][1], frames[i][0])
            i += 1
        r = eng.tick(now)
        if SCHEMA is not None:
            errs = list(SCHEMA.iter_errors(r))
            if errs:
                bad.append(errs[0].message)
        results.append((now - start, r))
        now += 0.5
    check(not bad, f"{name}: every result valid against the schema {bad[:1]}")
    check(all("occupancy" in r for _, r in results), f"{name}: occupancy in every result")
    lie = [t for t, r in results if r["presence"]["state"] == "present" and (r["occupancy"] or {}).get("state") == "empty"]
    check(not lie, f"{name}: never empty while presence is present ({len(lie)} ticks)")
    walk = [(r["occupancy"] or {}).get("state") for t, r in results if scenarios.ENTER[0] <= t <= scenarios.ENTER[1] + 6.0]
    check("occupied" in walk, f"{name}: walking in reads occupied ({walk})")
    q = {(r["position"] or {}).get("quality") for _, r in results} - {None}
    check(q <= {"none", "low"}, f"{name}: distance quality {sorted(q)} (never medium with a moving transmitter)")

print(f"\ntest_occupancy {'PASSED' if not failures else 'FAILED'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
