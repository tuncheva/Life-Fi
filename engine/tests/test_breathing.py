"""lifefi.breathing on synthetic raw CSI with a known breathing rate.

    python engine/tests/test_breathing.py

Synthetic data checks the processing, not real-world accuracy: that needs
recordings with a reference (counted breaths or a chest sensor).
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from lifefi.breathing import estimate_breathing, summarize  # noqa: E402
from lifefi.synth import synth  # noqa: E402  (shared with the engine tests)

failures = 0


def check(cond, what):
    global failures
    print(("  ok   " if cond else "  FAIL ") + what)
    failures += 0 if cond else 1


print("== still person breathing 15 /min, 2 min, a 10 s Wi-Fi pause")
ts, csi = synth(120, bpm=15, gap=(50, 60))
s = summarize(estimate_breathing(ts, csi))
check(s["bpm"] is not None and abs(s["bpm"] - 15) <= 1, f"rate 15 found ({s['bpm']})")
check(s["valid"] >= 0.8 * s["windows"], f"most windows valid ({s['valid']}/{s['windows']})")

for bpm in (8, 22):
    ts, csi = synth(90, bpm=bpm, seed=bpm)
    s = summarize(estimate_breathing(ts, csi))
    check(s["bpm"] is not None and abs(s["bpm"] - bpm) <= 1, f"rate {bpm} found ({s['bpm']})")

print("== shallow breathing (0.2 dB), close to the noise")
ts, csi = synth(90, bpm=12, breath_db=0.2, seed=5)
s = summarize(estimate_breathing(ts, csi))
check(s["bpm"] is None or abs(s["bpm"] - 12) <= 1, f"never a wrong rate ({s['bpm']}, {s['valid']} valid)")

print("== nobody: noise only")
ts, csi = synth(120, bpm=None, seed=7)
s = summarize(estimate_breathing(ts, csi))
check(s["valid"] <= 0.1 * s["windows"], f"no breathing reported ({s['valid']}/{s['windows']} valid)")

print("== a person moving")
ts, csi = synth(120, bpm=15, motion=True, seed=9)
s = summarize(estimate_breathing(ts, csi))
check(s["valid"] <= 0.1 * s["windows"], f"motion blocks the estimate ({s['valid']}/{s['windows']} valid)")

print("== recording split by long pauses")
ts, csi = synth(60, bpm=15, gap=(20, 40), seed=11)
check(estimate_breathing(ts, csi) == [], "no window bridges a gap; 20 s pieces give nothing")

print(f"\ntest_breathing {'FAILED' if failures else 'PASSED'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
