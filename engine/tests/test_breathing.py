"""lifefi.breathing on synthetic raw CSI with a known breathing rate.

    python engine/tests/test_breathing.py

Synthetic data checks the processing, not real-world accuracy: that needs
recordings with a reference (counted breaths or a chest sensor).
"""

import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from lifefi.breathing import estimate_breathing, summarize  # noqa: E402

failures = 0


def check(cond, what):
    global failures
    print(("  ok   " if cond else "  FAIL ") + what)
    failures += 0 if cond else 1


def synth(seconds, bpm=None, breath_db=0.5, motion=False, gap=None, seed=1, rate=90.0):
    """Raw CSI like the ESP32 delivers it: static multipath, an optional
    breathing modulation on ~40 % of subcarriers, per-packet AGC gain,
    receiver noise, jittered timing, and an optional gap."""
    rng = np.random.default_rng(seed)
    n = int(seconds * rate)
    t = np.cumsum(rng.uniform(0.6, 1.4, n) / rate)
    if gap is not None:
        t = t[(t < gap[0]) | (t > gap[1])]
    static = rng.uniform(15, 60, 52) * np.exp(1j * rng.uniform(0, 2 * np.pi, 52))
    db = np.zeros((len(t), 52))
    if bpm is not None:
        affected = rng.random(52) < 0.4
        sign = rng.choice([-1.0, 1.0], 52)
        db += breath_db * np.outer(np.sin(2 * np.pi * bpm / 60 * t), sign * affected)
    if motion:
        for f in rng.uniform(0.15, 3.0, 12):    # a person moving: broadband, many components
            db += 2.0 * np.outer(np.sin(2 * np.pi * f * t + rng.uniform(0, 6.3)), rng.normal(0, 1, 52))
    gain = rng.uniform(0.6, 1.4, len(t))[:, None]          # AGC / auto-scale per packet
    amp = np.abs(static) * 10 ** (db / 20) * gain
    csi = amp * np.exp(1j * np.angle(static)) + rng.normal(0, 0.7, (len(t), 52)) + 1j * rng.normal(0, 0.7, (len(t), 52))
    return (t * 1e6).astype(np.int64), csi


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
