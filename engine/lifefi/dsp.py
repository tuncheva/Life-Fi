"""Canonical feature stream F, offline (plan-v2 §5, csi-for-models §4).

amplitude [N, 52] at irregular times -> F [T, 52] in dB on a 50 Hz grid,
split into continuous segments. The readers of the public datasets and the
training code use this; the live engine must produce the same F.

1. L = 20*log10(max(1, amp)).
2. Hampel per subcarrier (half-window 3, k = 3) removes single-packet
   spikes. Offline it is centred; the live version runs 3 samples late.
3. Split at gaps > 1 s: a long gap is a discontinuity, not data.
4. Per segment: linear interpolation onto 100 Hz, 4th-order Butterworth
   low-pass at 20 Hz (causal SOS, started in steady state), every 2nd
   sample -> 50 Hz. Resampling straight to 50 Hz would fold 25-44 Hz
   noise into the band.
5. valid = False for grid samples inside a gap of 50 ms - 1 s (they are
   interpolated so the filter stays stable, but nobody should trust them).

No gain compensation: public data has none, and every model input removes
a constant offset anyway (plan-v2 D3).
"""

from dataclasses import dataclass

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from scipy import signal

PIPELINE_VERSION = 2
FS = 50.0
GRID_HZ = 100.0
LOWPASS_HZ = 20.0
HAMPEL_HALF = 3
HAMPEL_K = 3.0
MAX_GAP_S = 1.0
HOLD_GAP_S = 0.05
MIN_SEGMENT_S = 3.0

_SOS = signal.butter(4, LOWPASS_HZ, fs=GRID_HZ, output="sos")


@dataclass
class Segment:
    t: np.ndarray        # [T] s, on the 50 Hz grid, from the recording's first sample
    F: np.ndarray        # [T, 52] float32 dB
    valid: np.ndarray    # [T] bool


def to_db(amp):
    return 20.0 * np.log10(np.maximum(1.0, amp)).astype(np.float32)


def hampel(L, half=HAMPEL_HALF, k=HAMPEL_K):
    """Replace samples more than k scaled MADs from the local median."""
    if len(L) < 2 * half + 1:
        return L
    pad = np.pad(L, ((half, half), (0, 0)), mode="edge")
    win = sliding_window_view(pad, 2 * half + 1, axis=0)        # [N, 52, 7]
    med = np.median(win, axis=-1)
    mad = 1.4826 * np.median(np.abs(win - med[..., None]), axis=-1)
    out = L.copy()
    bad = np.abs(L - med) > k * np.maximum(mad, 1e-6)
    out[bad] = med[bad]
    return out


def _segment_bounds(t):
    cuts = np.where(np.diff(t) > MAX_GAP_S)[0]
    return list(zip(np.r_[0, cuts + 1], np.r_[cuts + 1, len(t)]))


def _resample(t, L, origin=None):
    start = t[0] if origin is None else origin + np.ceil((t[0] - origin) * FS - 1e-9) / FS
    grid = np.arange(start, t[-1], 1.0 / GRID_HZ)
    X = np.empty((len(grid), L.shape[1]), dtype=np.float64)
    for i in range(L.shape[1]):
        X[:, i] = np.interp(grid, t, L[:, i])
    zi = signal.sosfilt_zi(_SOS)[:, :, None] * X[0][None, None, :]    # [sections, 2, 52], steady state
    X, _ = signal.sosfilt(_SOS, X, axis=0, zi=zi)
    grid, X = grid[::2], X[::2]
    # a grid point is invalid when the packets around it are more than HOLD_GAP_S apart
    j = np.clip(np.searchsorted(t, grid), 1, len(t) - 1)
    valid = (t[j] - t[j - 1]) <= HOLD_GAP_S
    return grid, X.astype(np.float32), valid


def to_features(t_s, amp, origin=None):
    """List of Segments (>= MIN_SEGMENT_S each) from times [N] s and linear amplitude [N, 52].

    origin=None starts each segment's grid at its first packet (training, the
    processed store). With an origin, the 50 Hz grid sits on origin + k / FS,
    so the live engine (lifefi.live), which re-runs this on a sliding buffer,
    gets the same sample times on every call."""
    t_s = np.asarray(t_s, dtype=np.float64)
    order = np.argsort(t_s, kind="stable")
    t_s, amp = t_s[order], np.asarray(amp)[order]
    keep = np.r_[True, np.diff(t_s) > 0]                 # duplicate times carry no new sample
    t_s, L = t_s[keep], hampel(to_db(amp[keep]))
    out = []
    for a, b in _segment_bounds(t_s):
        if t_s[b - 1] - t_s[a] < MIN_SEGMENT_S:
            continue
        grid, F, valid = _resample(t_s[a:b], L[a:b], origin)
        out.append(Segment(grid, F, valid))
    return out
