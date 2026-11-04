"""lifefi.apnea (`no_breathing`) on synthetic raw CSI with a breath-hold.

    python engine/tests/test_apnea.py

Synthetic data checks the logic and the latency, not real-world accuracy:
no public breath-hold recordings exist (datasets/README.md).
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from lifefi import apnea  # noqa: E402
from lifefi.synth import synth  # noqa: E402

failures = 0


def check(cond, what):
    global failures
    print(("  ok   " if cond else "  FAIL ") + what)
    failures += 0 if cond else 1


def run(ts_us, csi, still=None):
    """The engine's loop (lifefi.apnea.run_offline); synth's clock starts near 0, so times match."""
    return apnea.run_offline(ts_us, csi, still)[0]


print("== 15 /min, a 20 s breath-hold from 60 s")
ts, csi = synth(110, bpm=15, breath_off=(60, 80), seed=3)
ch = run(ts, csi)
on = [t for t, c in ch if c == "active"]
off = [t for t, c in ch if c == "cleared"]
# the last breath peak comes up to one period (4 s) before the hold starts, and the
# alert follows it by hold_s (15 s) plus 0-3 s of filter ringing (plan-v2 §6.4)
hold = apnea.DEFAULTS["hold_s"]
check(len(on) == 1 and 56 + hold <= on[0] <= 63 + hold, f"alert once, {hold:.0f}-{hold + 3:.0f} s after the last breath ({on})")
check(len(off) >= 1 and on and off[0] > on[0] and off[0] - 80 <= 12, f"cleared within 12 s of breathing again ({off})")

print("== 3 min of normal breathing")
for bpm, seed in ((10, 4), (15, 5), (22, 6)):
    ts, csi = synth(180, bpm=bpm, seed=seed)
    ch = run(ts, csi)
    check(not ch, f"{bpm} /min: no alert ({ch})")

print("== moving during the hold: no alert (motion is not a stopped breath)")
ts, csi = synth(110, bpm=15, breath_off=(60, 80), seed=3)
t0 = ts[0] / 1e6                                   # run_offline counts from the first packet
ch = run(ts, csi, still=lambda t: not (62 - t0 <= t <= 82 - t0))
check(not [c for t, c in ch if c == "active"], f"no alert ({ch})")

print("== a Wi-Fi pause is not a breath-hold")
ts, csi = synth(110, bpm=15, gap=(60, 66), seed=7)
ch = run(ts, csi)
check(not [c for t, c in ch if c == "active"], f"no alert across a 6 s gap ({ch})")

print("== never valid breathing: nothing to compare against, no alert")
ts, csi = synth(100, bpm=None, seed=8)
ch = run(ts, csi)
check(not ch, f"no alert on noise ({ch})")

print(f"\ntest_apnea {'PASSED' if not failures else 'FAILED'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
