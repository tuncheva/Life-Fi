"""lifefi.heart on synthetic raw CSI with known breathing and heart rates.

    python engine/tests/test_heart.py

The key case is breathing with strong harmonics and no heartbeat: those
harmonics fall in the heart band and must never be reported as a pulse.
Synthetic data checks the processing, not real-world accuracy.
"""

import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from lifefi.heart import estimate_heart, summarize  # noqa: E402

failures = 0


def check(cond, what):
    global failures
    print(("  ok   " if cond else "  FAIL ") + what)
    failures += 0 if cond else 1


def synth(seconds, breath_bpm=9, harmonics=0.25, dominant=None, heart_bpm=None, heart_db=0.15,
          motion=False, seed=1, rate=55.0):
    """Raw CSI as in test_breathing.synth, plus non-sinusoidal breathing
    (harmonics 2..14, each `harmonics` x the fundamental; `dominant` = (k, amp)
    makes harmonic k stand out, as the 6th did on the 2026-10-28 recording)
    and an optional heartbeat on its own ~40 % of subcarriers."""
    rng = np.random.default_rng(seed)
    n = int(seconds * rate)
    t = np.cumsum(rng.uniform(0.6, 1.4, n) / rate)
    static = rng.uniform(15, 60, 52) * np.exp(1j * rng.uniform(0, 2 * np.pi, 52))
    db = np.zeros((len(t), 52))
    if breath_bpm is not None:
        w = 2 * np.pi * breath_bpm / 60
        wave = np.sin(w * t)
        for k in range(2, 15):
            amp_k = dominant[1] if dominant and k == dominant[0] else harmonics
            wave += amp_k * np.sin(k * w * t + rng.uniform(0, 2 * np.pi))
        db += 0.5 * np.outer(wave, rng.choice([-1.0, 1.0], 52) * (rng.random(52) < 0.4))
    if heart_bpm is not None:
        db += heart_db * np.outer(np.sin(2 * np.pi * heart_bpm / 60 * t),
                                  rng.choice([-1.0, 1.0], 52) * (rng.random(52) < 0.4))
    if motion:
        for f in rng.uniform(0.15, 3.0, 12):
            db += 2.0 * np.outer(np.sin(2 * np.pi * f * t + rng.uniform(0, 6.3)), rng.normal(0, 1, 52))
    gain = rng.uniform(0.6, 1.4, len(t))[:, None]
    amp = np.abs(static) * 10 ** (db / 20) * gain
    csi = amp * np.exp(1j * np.angle(static)) + rng.normal(0, 0.7, (len(t), 52)) + 1j * rng.normal(0, 0.7, (len(t), 52))
    return (t * 1e6).astype(np.int64), csi


def run(seconds, **kw):
    ts, csi = synth(seconds, **kw)
    return summarize(estimate_heart(ts, csi))


print("== breathing 9 /min with strong harmonics, heartbeat 67.5 /min (between harmonics 63 and 72)")
s = run(90, heart_bpm=67.5)
check(s["bpm"] is not None and abs(s["bpm"] - 67.5) <= 2, f"rate 67.5 found ({s['bpm']}, {s['valid']}/{s['windows']} valid)")
check(s["valid"] >= 0.6 * s["windows"], f"most windows valid ({s['valid']}/{s['windows']})")

for heart, seed in ((52, 3), (80, 4), (102, 6)):
    s = run(90, heart_bpm=heart, breath_bpm=12, seed=seed)
    check(s["bpm"] is not None and abs(s["bpm"] - heart) <= 2, f"rate {heart} found ({s['bpm']})")

print("== pulse 1 /min from a breathing harmonic (85 vs 7 x 12 = 84): not separable in 30 s")
s = run(90, heart_bpm=85, breath_bpm=12, seed=4)
check(s["bpm"] is None or abs(s["bpm"] - 85) <= 2, f"never a wrong rate ({s['bpm']}, {s['valid']} valid)")

print("== breathing harmonics only, no heartbeat")
for seed in (1, 2, 3):
    s = run(90, seed=seed)
    check(s["valid"] == 0, f"harmonics never reported as a pulse (seed {seed}: {s['valid']}/{s['windows']} valid)")
for k, seed in ((6, 1), (7, 2), (10, 3)):    # one clean harmonic peak: only the notch removes it
    s = run(90, harmonics=0.02, dominant=(k, 0.4), seed=seed)
    check(s["valid"] == 0, f"dominant {k}th harmonic ({9 * k} /min) not reported ({s['valid']}/{s['windows']} valid)")

print("== heartbeat too weak (0.03 dB)")
s = run(90, heart_bpm=70, heart_db=0.03, seed=8)
check(s["bpm"] is None or abs(s["bpm"] - 70) <= 2, f"never a wrong rate ({s['bpm']}, {s['valid']} valid)")

print("== nobody: noise only")
s = run(90, breath_bpm=None, seed=7)
check(s["valid"] <= 0.1 * s["windows"], f"no heart reported ({s['valid']}/{s['windows']} valid)")

print("== a person moving")
s = run(90, heart_bpm=70, motion=True, seed=9)
check(s["valid"] <= 0.1 * s["windows"], f"motion blocks the estimate ({s['valid']}/{s['windows']} valid)")

print(f"\ntest_heart {'FAILED' if failures else 'PASSED'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
