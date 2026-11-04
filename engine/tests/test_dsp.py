"""lifefi.dsp on synthetic amplitude with jittered packet times.

    python engine/tests/test_dsp.py
"""

import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from lifefi import dsp  # noqa: E402


def packets(seconds, rate=88.0, seed=0):
    rng = np.random.default_rng(seed)
    dt = rng.uniform(0.5, 1.5, int(seconds * rate)) / rate
    return np.cumsum(dt)


def test_rate_level_and_tone():
    t = packets(20)
    amp = 40 * (1 + 0.2 * np.sin(2 * np.pi * 1.0 * t))[:, None] * np.ones((1, 52))
    (seg,) = dsp.to_features(t, amp)
    assert abs(np.median(np.diff(seg.t)) - 1 / dsp.FS) < 1e-9
    assert seg.F.shape[1] == 52 and seg.F.dtype == np.float32
    assert abs(np.median(seg.F) - 20 * np.log10(40)) < 0.2
    f, p = np.fft.rfftfreq(len(seg.F), 1 / dsp.FS), np.abs(np.fft.rfft(seg.F[:, 0] - seg.F[:, 0].mean()))
    assert abs(f[p.argmax()] - 1.0) < 0.06, f[p.argmax()]


def test_spikes_removed():
    t = packets(10)
    amp = np.full((len(t), 52), 40.0)
    amp[100, 5] = 120.0                       # one-packet spike
    (seg,) = dsp.to_features(t, amp)
    assert np.abs(seg.F[:, 5] - 20 * np.log10(40)).max() < 0.01


def test_gaps():
    t = packets(30)
    t = np.r_[t[t < 10], t[(t > 10.3) & (t < 15)], t[t > 17]]     # 0.3 s hold, 2 s split
    amp = np.full((len(t), 52), 40.0)
    segs = dsp.to_features(t, amp)
    assert len(segs) == 2, len(segs)
    a = segs[0]
    inside = (a.t > 10.02) & (a.t < 10.28)
    assert not a.valid[inside].any() and a.valid[a.t < 9.9].all()


def test_floor_at_one():
    t = packets(5)
    (seg,) = dsp.to_features(t, np.zeros((len(t), 52)))
    assert np.allclose(seg.F, 0.0, atol=1e-4)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
