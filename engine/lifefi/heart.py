"""Heart rate from raw CSI, offline (numpy only). EXPERIMENTAL.

Same skeleton as lifefi.breathing, at 20 Hz and in the 0.75-2 Hz band
(45-120 /min), with two extra protections found on real data (2026-10-28):

- Breathing is not a pure sine. Its harmonics (a 9 /min breath has them at
  54, 63, ..., 117 /min) land in the heart band and are often stronger than
  any pulse. Per window the breathing fundamental fb is estimated with the
  breathing pipeline. Sinusoids at k*fb are fitted and subtracted, and
  every bin within NOTCH_HZ of k*fb is also removed before the subcarrier
  choice, the PCA and the peak search.
- A single ESP32 antenna is near its limit for 0.1-0.5 mm chest motion, so a
  "largest peak" on a flat noise floor is meaningless. `valid` needs the peak
  to stand MIN_SNR above the mean of the remaining band, away from its edges
  and at least HARMONIC_GUARD_HZ (3.6 /min) from a breathing harmonic: a sweep
  showed closer peaks are pulled by leakage (errors up to 2.4 /min), the
  resolution limit of a 30 s window. Depending on the breathing rate this
  leaves 20-40 % of the band measurable.

Per 30 s window, every 5 s:
1. Gain-free dB amplitude on a 20 Hz grid; split at gaps; remove the trend.
2. fb from the breathing band (0.1-0.5 Hz), PC1 of its top 8 subcarriers.
3. Subtract the fitted breathing harmonics. Heart band minus the
   breathing-harmonic notches; top 8 subcarriers by
   that power vs 2.5-5 Hz; PC1.
4. FFT peak (8x zero-padding, parabolic interpolation) over the allowed bins,
   cross-checked by an interpolated autocorrelation.
5. `valid` only when: peak >= MIN_SNR x mean band power and not on a band
   or notch edge, peak share >=
   MIN_CONFIDENCE, not near a breathing harmonic, no second peak >= SECOND_PEAK_MAX of the first, FFT and
   autocorrelation within MAX_DISAGREE_BPM, and the window is still enough
   for breathing (breathing band ratio >= breathing.MIN_BAND_RATIO).

Validate against a pulse sensor before trusting any number. Not a medical
device.
"""

from dataclasses import dataclass

import numpy as np

from . import breathing as B

FS = 20.0                 # analysis rate, Hz
WINDOW_S = 30.0
STEP_S = 5.0
BAND = (0.75, 2.0)        # 45-120 /min
REF_BAND = (2.5, 5.0)     # noise reference above the heart band
TOP_SUBCARRIERS = 8
NOTCH_HZ = 0.035          # [H] around every breathing harmonic (about one 30 s bin each side)
HARMONIC_GUARD_HZ = 0.06  # [H] peaks closer to a breathing harmonic are leakage-shifted (sweep, 2026-10-28)
PEAK_HALF_HZ = 0.05       # "near the peak" for the confidence share
MIN_SNR = 6.0             # [H] peak vs mean power of the allowed band (pure noise: ~4)
MIN_CONFIDENCE = 0.35     # [H] share of allowed band power near the peak
SECOND_PEAK_MAX = 0.5     # [H] largest peak > 0.1 Hz away, relative to the main peak
MAX_DISAGREE_BPM = 5.0    # FFT vs autocorrelation
CONSISTENT_BPM = 8.0      # valid windows must agree within this to give a rate
MIN_VALID_SHARE = 0.3     # [H] a rate needs at least this share of windows valid


@dataclass
class HeartWindow:
    t_start: float        # s from the first packet
    bpm: float
    snr: float
    confidence: float
    acf_bpm: float
    breath_bpm: float     # breathing fundamental whose harmonics were removed
    valid: bool
    reason: str           # why not valid ("" when valid)


def _harmonic_notch(f, fb):
    """True for frequencies within NOTCH_HZ of a harmonic k*fb (k >= 1)."""
    k = np.maximum(np.round(f / fb), 1.0)
    return np.abs(f - k * fb) <= NOTCH_HZ


def _remove_harmonics(seg, fb):
    """Least-squares fit and subtract sinusoids at k*fb up to just above the
    heart band, per subcarrier. Notching bins alone leaves a harmonic that
    falls between two bins leaking into their neighbours as fake peaks."""
    n = np.arange(len(seg)) / FS
    k = np.arange(1, int((BAND[1] + 0.1) / fb) + 1)
    ph = 2 * np.pi * np.outer(n, k * fb)
    a = np.hstack([np.cos(ph), np.sin(ph)])
    coef = np.linalg.lstsq(a, seg, rcond=None)[0]
    return seg - a @ coef


def _band_pc1(seg, spec, keep, ref):
    """PC1 of the top subcarriers (by `keep` vs `ref` power), band-limited to `keep`; and the top."""
    ratio = spec[keep].sum(axis=0) / (spec[ref].sum(axis=0) + 1e-30)
    top = np.argsort(ratio)[-TOP_SUBCARRIERS:]
    sb = np.fft.rfft(seg[:, top], axis=0)
    sb[~keep] = 0
    xb = np.fft.irfft(sb, n=len(seg), axis=0)
    _, _, vt = np.linalg.svd(xb - xb.mean(axis=0), full_matrices=False)
    return xb @ vt[0], top


def _motion_ratio(spec, top, br, br_ref, notch):
    """breathing.py's band ratio (breathing band vs 0.6-2 Hz, summed) for the
    breathing subcarriers, with the breathing harmonics left out of the
    reference: they are breathing, not movement. Per-bin powers are scaled
    back to the full reference width so breathing.MIN_BAND_RATIO still applies."""
    ref = br_ref & ~notch
    per_bin = spec[br][:, top].mean(axis=0) / (spec[ref][:, top].mean(axis=0) + 1e-30)
    return float((per_bin * br.sum() / br_ref.sum()).mean())


def _acf_rate(sig):
    """Rate from the autocorrelation maximum over the band's lags, parabolic-interpolated."""
    s = sig - sig.mean()
    acf = np.correlate(s, s, mode="full")[len(s) - 1:]
    lo, hi = int(FS / BAND[1]), int(FS / BAND[0])
    lag = lo + int(np.argmax(acf[lo:hi]))
    y0, y1, y2 = acf[lag - 1], acf[lag], acf[lag + 1]
    den = y0 - 2 * y1 + y2
    shift = 0.5 * (y0 - y2) / den if den != 0 else 0.0
    return 60.0 * FS / (lag + shift)


def estimate_heart(ts_us, csi):
    """Heart windows from packet timestamps (us) and LLTF CSI [N, 52] complex."""
    t = (np.asarray(ts_us, dtype=np.int64) - int(ts_us[0])) / 1e6
    x = B._features(np.asarray(csi))
    win, step = int(WINDOW_S * FS), int(STEP_S * FS)
    f = np.fft.rfftfreq(win, 1.0 / FS)
    br = (f >= B.BAND[0]) & (f <= B.BAND[1])
    br_ref = (f >= B.REF_BAND[0]) & (f <= B.REF_BAND[1])
    hb = (f >= BAND[0]) & (f <= BAND[1])
    ref = (f >= REF_BAND[0]) & (f <= REF_BAND[1])
    n = 8 * win
    ff = np.fft.rfftfreq(n, 1.0 / FS)
    hb_pad = (ff >= BAND[0]) & (ff <= BAND[1])
    out = []
    for s, e in B._segments(t):
        if t[e - 1] - t[s] < WINDOW_S:
            continue
        grid, y = B._resample(t[s:e], x[s:e], t[s], t[e - 1], FS)
        if y is None:
            continue
        for w0 in range(0, len(y) - win + 1, step):
            seg = B._detrend(y[w0:w0 + win])
            spec = np.abs(np.fft.rfft(seg * np.hanning(win)[:, None], axis=0)) ** 2
            pcb, top_b = _band_pc1(seg, spec, br, br_ref)
            fb, _ = B._fft_peak(pcb, B.BAND, FS)
            notch = _harmonic_notch(f, fb)
            breath_ratio = _motion_ratio(spec, top_b, br, br_ref, notch)
            keep = hb & ~notch
            seg = _remove_harmonics(seg, fb)
            spec = np.abs(np.fft.rfft(seg * np.hanning(win)[:, None], axis=0)) ** 2
            pc1, _ = _band_pc1(seg, spec, keep, ref)
            ps = np.abs(np.fft.rfft(pc1 * np.hanning(win), n=n)) ** 2
            allowed = np.where(hb_pad & ~_harmonic_notch(ff, fb))[0]
            i = allowed[np.argmax(ps[allowed])]
            y0, y1, y2 = np.log(ps[i - 1:i + 2] + 1e-30)
            den = y0 - 2 * y1 + y2
            shift = 0.5 * (y0 - y2) / den if den != 0 else 0.0
            peak = ff[i] + shift * (ff[1] - ff[0])
            pa = ps[allowed]
            snr = float(ps[i] / (pa.mean() + 1e-30))
            # A true peak has allowed bins on both sides. At a band or notch edge it is
            # leakage, or a pulse within ~2 /min of a breathing harmonic, which
            # a 30 s window cannot separate from it.
            ok = set(allowed.tolist())
            at_edge = (i - 1) not in ok or (i + 1) not in ok
            conf = float(pa[np.abs(ff[allowed] - peak) <= PEAK_HALF_HZ].sum() / (pa.sum() + 1e-30))
            far = np.abs(ff[allowed] - peak) > 0.1
            second = float(pa[far].max() / ps[i]) if far.any() else 0.0
            bpm = 60.0 * peak
            harmonic = max(round(peak / fb), 1) * fb
            acf_bpm = _acf_rate(pc1)
            reasons = []
            if abs(peak - harmonic) < HARMONIC_GUARD_HZ:
                reasons.append(f"near breathing harmonic ({60 * harmonic:.0f})")
            if snr < MIN_SNR:
                reasons.append(f"at noise floor (snr {snr:.1f})")
            if at_edge:
                reasons.append("peak at band/notch edge")
            if conf < MIN_CONFIDENCE:
                reasons.append(f"no clear peak ({conf:.2f})")
            if second >= SECOND_PEAK_MAX:
                reasons.append(f"several peaks ({second:.2f})")
            if not abs(acf_bpm - bpm) <= MAX_DISAGREE_BPM:
                reasons.append("FFT/ACF disagree")
            if breath_ratio < B.MIN_BAND_RATIO:
                reasons.append(f"motion ({breath_ratio:.1f})")
            out.append(HeartWindow(float(grid[w0]), bpm, snr, conf, acf_bpm, 60.0 * fb,
                                   not reasons, "; ".join(reasons)))
    return out


def summarize(windows):
    """Median rate over valid windows (None below MIN_VALID_SHARE), the share
    that are valid, and whether they agree."""
    valid = [w.bpm for w in windows if w.valid]
    enough = bool(valid) and len(valid) >= MIN_VALID_SHARE * len(windows)
    return {
        "windows": len(windows),
        "valid": len(valid),
        "bpm": float(np.median(valid)) if enough else None,
        "spread": float(max(valid) - min(valid)) if valid else None,
        "consistent": bool(valid) and max(valid) - min(valid) <= CONSISTENT_BPM,
    }
