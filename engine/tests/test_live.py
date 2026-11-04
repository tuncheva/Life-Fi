"""lifefi.live: F stitched tick by tick equals one offline lifefi.dsp run.

    python engine/tests/test_live.py

The engine and the training data must see the same F (plan-v2 design
rule 1); this is the check for the live side.
"""

import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from lifefi import dsp  # noqa: E402
from lifefi.live import LiveF  # noqa: E402
from lifefi.synth import synth  # noqa: E402

failures = 0


def check(cond, what):
    global failures
    print(("  ok   " if cond else "  FAIL ") + what)
    failures += 0 if cond else 1


def stitched(t, csi, tick=0.5):
    live = LiveF()
    i = 0
    now = t[0] + tick
    while i < len(t):
        while i < len(t) and t[i] <= now:
            live.add(t[i], csi[i])
            i += 1
        live.update()
        now += tick
    return live


print("== 60 s, someone breathing and moving, 90 Hz with jitter")
ts, csi = synth(60, bpm=15, motion=True, seed=2, agc=False)
t = ts / 1e6 + 1000.0                                  # host-like seconds, not near 0
live = stitched(t, csi)
ref = dsp.to_features(t, np.abs(csi), origin=0.0)[0]
common, a, b = np.intersect1d(np.round(live.t * dsp.FS).astype(int), np.round(ref.t * dsp.FS).astype(int),
                              return_indices=True)
check(len(common) >= len(live.t) - 1 and len(live.t) > 50 * 50,
      f"same 50 Hz grid ({len(common)} common samples of {len(live.t)} live, {len(ref.t)} offline)")
d = np.abs(live.F[a] - ref.F[b])
check(d.max() <= 0.05, f"F within 0.05 dB of the offline run (max {d.max():.4f} dB)")
check((live.valid[a] == ref.valid[b]).mean() > 0.99, "same valid flags")
check(np.all(np.diff(live.t) > 0) and np.allclose(np.diff(live.t), 1 / dsp.FS), "no repeated or missing samples")

print("== a 3 s Wi-Fi pause starts a new segment")
ts, csi = synth(40, bpm=15, gap=(20, 23), seed=3, agc=False)
t = ts / 1e6 + 1000.0
live = stitched(t, csi)
check(live.segment == 1, f"one new segment (segment = {live.segment})")
check(live.t[0] > 1023.0, f"F restarts after the pause (first sample at {live.t[0] - 1000:.2f} s)")

print(f"\ntest_live {'PASSED' if not failures else 'FAILED'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
