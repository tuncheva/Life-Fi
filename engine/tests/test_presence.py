"""lifefi.presence state machine on synthetic M / B sequences.

    python engine/tests/test_presence.py

E4 never shows anyone leaving the room (ml/check_presence.py), so the
exit rule is only checked here.
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from lifefi import presence  # noqa: E402

failures = 0
TICK = 0.5
LV = presence.Levels(m_on=1.0, m_off=0.5, b_on=1.0, b_off=0.8)


def check(cond, what):
    global failures
    print(("  ok   " if cond else "  FAIL ") + what)
    failures += 0 if cond else 1


def run(p, t0, seconds, M, B, breathing_valid=False):
    """Feeds constant M / B for `seconds`; returns [(t, state)]."""
    out = []
    t = t0
    while t < t0 + seconds - 1e-9:
        out.append((t, p.update(t, M, B, breathing_valid=breathing_valid)))
        t += TICK
    return out


def first(states, want):
    return next((t for t, s in states if s == want), None)


def fresh(cfg=None):
    p = presence.Presence(cfg)
    p.calibrate(LV, 0.0)
    return p


print("== empty room stays empty")
p = fresh()
s = run(p, 0, 600, M=0.1, B=0.2)
check(all(st == "empty" for _, st in s), "10 min of empty: never PRESENT")

print("== someone walks in")
p = fresh()
run(p, 0, 30, M=0.1, B=0.2)
s = run(p, 30, 5, M=5.0, B=0.2)
t = first(s, "present")
check(t is not None and t - 30 <= 1.5, f"PRESENT {t and t - 30:.1f} s after the motion starts (<= 1.5)")

print("== a still person who breathes stays present")
s = run(p, 35, 900, M=0.1, B=2.0, breathing_valid=True)
check(all(st == "present" for _, st in s), "15 min still with breathing energy: PRESENT throughout")

print("== still, no breathing ever seen -> UNCERTAIN after 10 min")
p = fresh()
run(p, 0, 3, M=5.0, B=0.2)
s = run(p, 3, 700, M=0.1, B=2.0)
t = first(s, "uncertain")
check(t is not None and 595 <= t <= 610, f"UNCERTAIN at {t} s (10 min after the last motion)")
s = run(p, 703, 2, M=0.1, B=2.0, breathing_valid=True)
check(s[-1][1] == "present", "valid breathing brings it back to PRESENT")

print("== the person leaves: burst, then quiet -> EMPTY after 60 s")
p = fresh()
run(p, 0, 3, M=5.0, B=2.0)
run(p, 3, 120, M=0.1, B=2.0, breathing_valid=True)
run(p, 123, 3, M=5.0, B=2.0)                  # walks out
s = run(p, 126, 30, M=0.1, B=2.0)             # B still high: its 30 s window holds the walk
s += run(p, 156, 120, M=0.1, B=0.2)
t = first(s, "empty")
check(t is not None and 215 <= t <= 217, f"EMPTY at {t} s (60 s after B fell at 156 s)")

print("== a still person whose B dips long after their last move does not 'leave'")
p = fresh()
run(p, 0, 3, M=5.0, B=2.0)
run(p, 3, 120, M=0.1, B=2.0, breathing_valid=True)
s = run(p, 123, 300, M=0.1, B=0.2)
check(all(st != "empty" for _, st in s), "no exit without a burst before the quiet")

print("== breathing energy alone starts presence (someone already sitting still)")
p = fresh()
s = run(p, 0, 20, M=0.1, B=2.0)
t = first(s, "present")
check(t is not None and t <= 5.5, f"PRESENT at {t} s from B alone (b_hold_s 5)")

print("== no calibration: motion only, against the provisional baseline")
p = presence.Presence()
s = run(p, 0, 120, M=0.1, B=5.0)
check(all(st == "empty" for _, st in s), "B is ignored without a calibration")
s = run(p, 120, 3, M=5.0, B=None)
check(first(s, "present") is not None, "motion 50x the provisional baseline: PRESENT")

print("== motion level")
lv = presence.motion_level([0.5, 1.0, 50.0, 1e4], m_on=1.0)
check(lv[0] < 0.1 and abs(lv[1] - 0.1) < 1e-9 and abs(lv[2] - 0.9) < 1e-9 and lv[3] == 1.0,
      f"0.1 at m_on, 0.9 at 50 x m_on, clipped ({[round(float(x), 3) for x in lv]})")

print(f"\ntest_presence {'PASSED' if not failures else 'FAILED'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
