"""Breathing rate from raw CSI, offline (numpy only).

A simplified, non-streaming version of plan-v2 §6.3:

1. Amplitude in dB minus each packet's mean over subcarriers (cancels AGC).
2. Split at gaps > 1 s; never bridge a gap.
3. Box-average onto a 10 Hz grid (also the anti-alias low-pass).
4. Per 30 s window, every 5 s: remove the linear trend, keep 0.1-0.5 Hz
   (6-30 /min), and pick the 8 subcarriers with the highest ratio of
   breathing-band power to 0.6-2 Hz power.
5. PC1 of those subcarriers; FFT peak with 8x zero-padding and parabolic
   interpolation gives the rate; autocorrelation cross-checks it.
6. `valid` only when the rhythm is clear: peak share >= MIN_CONFIDENCE,
   band ratio >= MIN_BAND_RATIO, FFT and autocorrelation agree, and a
   peak at the 6 /min edge is not just slow drift leaking into the band.

Assumes one person, still, near the link (plan-v2 §13). Not a medical
device.
"""

from dataclasses import dataclass, field

import numpy as np

FS = 10.0                 # analysis rate, Hz
WINDOW_S = 30.0
STEP_S = 5.0
MAX_GAP_S = 1.0
BAND = (0.1, 0.5)         # 6-30 breaths/min
REF_BAND = (0.6, 2.0)     # motion / noise reference
TOP_SUBCARRIERS = 8
MIN_CONFIDENCE = 0.40     # [H] share of band power within +-0.02 Hz of the peak; E1 sweep (ml/tune_breathing.py)
MIN_BAND_RATIO = 2.0      # [H] breathing band vs 0.6-2 Hz, mean of the top subcarriers; 1.5 lets motion through (TS motion test)
MAX_DISAGREE_BPM = 2.0    # FFT vs autocorrelation


@dataclass
class BreathWindow:
    t_start: float        # s from the first packet
    bpm: float
    confidence: float
    band_ratio: float
    acf_bpm: float
    valid: bool
    reason: str           # why not valid ("" when valid)
    top: tuple = ()       # the TOP_SUBCARRIERS used
    v: np.ndarray = field(default=None, repr=False)   # [52] PC1 direction, zero outside `top` (lifefi.apnea freezes it)


def _features(csi):
    """Gain-free amplitude features [N, 52] in dB."""
    db = 20.0 * np.log10(np.abs(csi) + 1.0)
    return db - db.mean(axis=1, keepdims=True)


def _segments(t):
    cuts = np.where(np.diff(t) > MAX_GAP_S)[0]
    return list(zip(np.r_[0, cuts + 1], np.r_[cuts + 1, len(t)]))


def _resample(t, x, t0, t1, fs=FS):
    """Box average over +-0.5/fs around each grid point; interpolate empty bins."""
    grid = np.arange(t0, t1, 1.0 / fs)
    lo = np.searchsorted(t, grid - 0.5 / fs)
    hi = np.searchsorted(t, grid + 0.5 / fs)
    cum = np.vstack([np.zeros((1, x.shape[1])), np.cumsum(x, axis=0)])
    count = (hi - lo)[:, None]
    out = np.full((len(grid), x.shape[1]), np.nan)
    ok = count[:, 0] > 0
    out[ok] = (cum[hi[ok]] - cum[lo[ok]]) / count[ok]
    for i in range(x.shape[1]):
        bad = np.isnan(out[:, i])
        if bad.all():
            return grid, None
        out[bad, i] = np.interp(grid[bad], grid[~bad], out[~bad, i])
    return grid, out


def _detrend(x):
    n = np.arange(len(x))
    a = np.polyfit(n, x, 1)
    return x - (np.outer(n, a[0]) + a[1])


def _fft_peak(sig, band, fs=FS):
    n = 8 * len(sig)
    spec = np.abs(np.fft.rfft(sig * np.hanning(len(sig)), n=n)) ** 2
    f = np.fft.rfftfreq(n, 1.0 / fs)
    b = np.where((f >= band[0]) & (f <= band[1]))[0]
    i = b[np.argmax(spec[b])]
    if 0 < i < len(spec) - 1:   # parabolic interpolation on the log magnitude
        y0, y1, y2 = np.log(spec[i - 1:i + 2] + 1e-30)
        shift = 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2) if (y0 - 2 * y1 + y2) != 0 else 0.0
        peak = f[i] + shift * (f[1] - f[0])
    else:
        peak = f[i]
    near = b[np.abs(f[b] - peak) <= 0.02]
    confidence = spec[near].sum() / (spec[b].sum() + 1e-30)
    return peak, confidence


def _drift_at_edge(sig, peak):
    """True when a peak near the low band edge is only slow drift leaking in.

    Body shifts and RSSI changes put most power at 1-4 /min. After the band
    filter that leakage looks like a peak at the 6 /min edge, so a peak within
    one resolution bin of the edge must beat the power one bin below the band
    in the unfiltered signal.
    """
    if peak - BAND[0] >= 1.0 / WINDOW_S:
        return False
    n = 8 * len(sig)
    spec = np.abs(np.fft.rfft(sig * np.hanning(len(sig)), n=n)) ** 2
    f = np.fft.rfftfreq(n, 1.0 / FS)
    below = spec[np.argmin(np.abs(f - (BAND[0] - 1.0 / WINDOW_S)))]
    return below > spec[np.argmin(np.abs(f - peak))]


def _acf_rate(sig):
    s = sig - sig.mean()
    acf = np.correlate(s, s, mode="full")[len(s) - 1:]
    lo, hi = int(FS / BAND[1]), int(FS / BAND[0])   # periods of 2-10 s
    if hi >= len(acf):
        return float("nan")
    lag = lo + np.argmax(acf[lo:hi])
    return 60.0 * FS / lag


def estimate_breathing(ts_us, csi):
    """Breathing windows from packet timestamps (us) and LLTF CSI [N, 52] complex."""
    t = (np.asarray(ts_us, dtype=np.int64) - int(ts_us[0])) / 1e6
    x = _features(np.asarray(csi))
    win, step = int(WINDOW_S * FS), int(STEP_S * FS)
    out = []
    for s, e in _segments(t):
        if t[e - 1] - t[s] < WINDOW_S:
            continue
        grid, y = _resample(t[s:e], x[s:e], t[s], t[e - 1])
        if y is None:
            continue
        for w0 in range(0, len(y) - win + 1, step):
            seg = _detrend(y[w0:w0 + win])
            spec = np.abs(np.fft.rfft(seg * np.hanning(win)[:, None], axis=0)) ** 2
            f = np.fft.rfftfreq(win, 1.0 / FS)
            br = (f >= BAND[0]) & (f <= BAND[1])
            ref = (f >= REF_BAND[0]) & (f <= REF_BAND[1])
            ratio = spec[br].sum(axis=0) / (spec[ref].sum(axis=0) + 1e-30)
            top = np.argsort(ratio)[-TOP_SUBCARRIERS:]
            spec_b = np.fft.rfft(seg[:, top], axis=0)
            spec_b[~br] = 0
            xb = np.fft.irfft(spec_b, n=win, axis=0)
            _, _, vt = np.linalg.svd(xb - xb.mean(axis=0), full_matrices=False)
            pc1 = xb @ vt[0]
            peak, conf = _fft_peak(pc1, BAND)
            bpm = 60.0 * peak
            acf_bpm = _acf_rate(pc1)
            band_ratio = float(ratio[top].mean())
            reasons = []
            if conf < MIN_CONFIDENCE:
                reasons.append(f"no clear peak ({conf:.2f})")
            if band_ratio < MIN_BAND_RATIO:
                reasons.append(f"motion/noise ({band_ratio:.1f})")
            if not abs(acf_bpm - bpm) <= MAX_DISAGREE_BPM:
                reasons.append("FFT/ACF disagree")
            if _drift_at_edge(seg[:, top] @ vt[0], peak):
                reasons.append("drift at band edge")
            v = np.zeros(x.shape[1])
            v[top] = vt[0]
            out.append(BreathWindow(float(grid[w0]), bpm, conf, band_ratio, acf_bpm,
                                    not reasons, "; ".join(reasons), tuple(int(i) for i in top), v))
    return out


def summarize(windows):
    """Median rate over valid windows, the share that are valid, and whether
    they agree (a median of two rate groups is not a breathing rate)."""
    valid = [w.bpm for w in windows if w.valid]
    return {
        "windows": len(windows),
        "valid": len(valid),
        "bpm": float(np.median(valid)) if valid else None,
        "spread": float(max(valid) - min(valid)) if valid else None,
        "consistent": bool(valid) and max(valid) - min(valid) <= 2 * MAX_DISAGREE_BPM,
    }
