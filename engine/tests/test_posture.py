"""lifefi.posture on hand-made probability sequences.

    python engine/tests/test_posture.py
"""

import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from lifefi.posture import Posture  # noqa: E402

CLASSES = ["none", "walking", "sit_down", "lie_down", "rise", "fall"]
failures = 0


def check(cond, what):
    global failures
    print(("  ok   " if cond else "  FAIL ") + what)
    failures += 0 if cond else 1


def p(**kw):
    v = np.full(len(CLASSES), 0.0)
    for k, x in kw.items():
        v[CLASSES.index(k)] = x
    v[0] = max(0.0, 1.0 - v.sum())
    return v


def bump(post, t, cls, peak=0.9, n=5):
    """A transition: cls rises to `peak` and falls again, one window per 0.5 s."""
    for k, x in enumerate(np.r_[np.linspace(0.1, peak, n // 2 + 1), np.linspace(peak, 0.1, n // 2 + 1)[1:]]):
        out = post.update(t + 0.5 * k, p(**{cls: x}), True)
    return out, t + 0.5 * n


post = Posture(CLASSES)
out = post.update(0.0, p(), True)
check(out[0] == "unknown" and out[2] == "start", f"start: unknown ({out})")
out, t = bump(post, 1.0, "sit_down")
check(out[0] == "sitting", f"sit_down from unknown -> sitting ({out})")
out, t = bump(post, t + 4, "rise")
check(out[0] == "standing", f"rise from sitting -> standing ({out})")
out, t = bump(post, t + 4, "lie_down")
check(out[0] == "lying", f"lie_down from standing -> lying ({out})")
out, t = bump(post, t + 4, "rise")
check(out[0] == "sitting", f"rise from lying -> sitting ({out})")
for k in range(4):
    out = post.update(t + 4 + 0.5 * k, p(walking=0.9), True)
check(out[0] == "standing" and out[2] == "walking", f"walking -> standing ({out})")

print("== refractory: two sit_down peaks 1 s apart count once")
post = Posture(CLASSES)
post.update(0.0, p(), True)
out, t = bump(post, 0.5, "lie_down")
out, t = bump(post, t, "rise", n=3)                  # within 3 s of the lie_down peak
check(out[0] == "lying", f"second event inside the refractory period ignored ({out})")

print("== weak or absent evidence changes nothing")
post = Posture(CLASSES)
post.update(0.0, p(), True)
out, t = bump(post, 0.5, "sit_down", peak=0.4)
check(out[0] == "unknown", f"peak 0.4 < theta 0.5: no transition ({out})")
out = post.update(t, None, True)
check(out[0] == "unknown", f"no model output (invalid window): unchanged ({out})")

print("== not present -> null, then unknown again")
check(post.update(t + 1, p(), False) is None, "not present: None")
out = post.update(t + 2, p(), True)
check(out[0] == "unknown", f"back: unknown ({out})")

print(f"\ntest_posture {'PASSED' if not failures else 'FAILED'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
