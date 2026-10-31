"""Motion level M (plan-v2 §6.2), offline on F.

M(t) = mean over subcarriers of the variance over the last 0.5 s of the
2-20 Hz band-passed F. The band removes breathing (< 0.5 Hz) and any
constant offset, so M is gain-free. Causal (sosfilt), like the live engine.

M is in dB²; the presence and fall rules use it divided by a baseline: the
empty-room P99 from the calibration live, or a stand-in on public data
(the clip's quiet level, see lifefi.fall).
"""

import numpy as np
from scipy import signal

FS = 50.0
BAND = (2.0, 20.0)
WIN_S = 0.5

_SOS = signal.butter(4, BAND, btype="band", fs=FS, output="sos")


def motion(F):
    """M [T] for one continuous segment F [T, 52] at 50 Hz (first 0.5 s is warm-up: 0)."""
    zi = signal.sosfilt_zi(_SOS)[:, :, None] * np.zeros((1, 1, F.shape[1]))
    bp, _ = signal.sosfilt(_SOS, F - F[:1], axis=0, zi=zi)
    k = int(WIN_S * FS)
    c = np.cumsum(np.pad(bp ** 2, ((1, 0), (0, 0))), axis=0)
    v = (c[k:] - c[:-k]) / k
    return np.r_[np.zeros(k - 1), v.mean(axis=1)]
