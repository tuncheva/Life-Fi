"""Hand-made window features for the gradient-boosting baseline (plan-v2 §6.8).

Only summaries across subcarriers and principal components, never one
value per subcarrier: which subcarrier moves is a property of the room
(model-training-plan §4), how the movement unfolds in time is not.

Input: model view x [B, 52, 150] (mean removed per subcarrier) and the raw
window F [B, 52, 150] in dB (for turbulence only).
"""

import numpy as np

FS = 50
BANDS = [(0.3, 0.7), (0.7, 2.0), (2.0, 10.0), (10.0, 25.0)]
ENV_BINS = 12


def _kurt(a, axis=-1):
    a = a - a.mean(axis=axis, keepdims=True)
    v = (a ** 2).mean(axis=axis)
    return (a ** 4).mean(axis=axis) / np.maximum(v ** 2, 1e-9)


def _series_stats(s):
    """var, max |diff|, kurtosis, range of [B, T] series."""
    return [s.var(axis=1), np.abs(np.diff(s, axis=1)).max(axis=1), _kurt(s), np.ptp(s, axis=1)]


def _band_shares(s):
    p = np.abs(np.fft.rfft(s - s.mean(axis=-1, keepdims=True), axis=-1)) ** 2
    f = np.fft.rfftfreq(s.shape[-1], 1 / FS)
    tot = np.maximum(p.sum(axis=-1), 1e-12)
    return [p[..., (f >= lo) & (f < hi)].sum(axis=-1) / tot for lo, hi in BANDS]


def _change_env(x):
    """[B, T] how fast the 0.5 s-smoothed profile changes (as ml.data.change_envelope)."""
    k = FS // 2
    c = np.cumsum(np.pad(x, ((0, 0), (0, 0), (1, 0))), axis=-1)
    lp = (c[..., k:] - c[..., :-k]) / k                       # [B, 52, T - k + 1]
    h = FS // 4
    return np.abs(lp[..., 2 * h:] - lp[..., :-2 * h]).mean(axis=1)


def window_features(x, F):
    x = x.astype(np.float32)
    B = len(x)
    feats, names = [], []

    def add(name, v):
        feats.append(np.asarray(v, dtype=np.float32).reshape(B))
        names.append(name)

    sd = x.std(axis=-1)                                        # per-subcarrier movement [B, 52]
    for q, v in zip(["mean", "std", "max", "min", "p25", "p75"],
                    [sd.mean(1), sd.std(1), sd.max(1), sd.min(1), np.percentile(sd, 25, 1), np.percentile(sd, 75, 1)]):
        add(f"sc_std_{q}", v)

    m = x.mean(axis=1)                                         # common-mode signal [B, 150]
    for n, v in zip(["var", "maxdiff", "kurt", "range"], _series_stats(m)):
        add(f"common_{n}", v)

    u, s, _ = np.linalg.svd(np.transpose(x, (0, 2, 1)), full_matrices=False)   # [B, 150, 52]
    share = s ** 2 / np.maximum((s ** 2).sum(axis=1, keepdims=True), 1e-9)
    for i in range(3):
        add(f"pc{i + 1}_share", share[:, i])
        pc = u[:, :, i] * s[:, i:i + 1]
        for n, v in zip(["var", "maxdiff", "kurt", "range"], _series_stats(pc)):
            add(f"pc{i + 1}_{n}", v)
    pc1 = u[:, :, 0] * s[:, :1]
    for (lo, hi), v in zip(BANDS, _band_shares(pc1)):
        add(f"pc1_band_{lo}_{hi}", v)
    for (lo, hi), v in zip(BANDS, _band_shares(x)):
        add(f"sc_band_{lo}_{hi}", v.mean(axis=1))

    e = _change_env(x)                                         # [B, ~113]
    emax = np.maximum(e.max(axis=1), 1e-9)
    edges = np.linspace(0, e.shape[1], ENV_BINS + 1).astype(int)
    for i in range(ENV_BINS):
        add(f"env_{i}", e[:, edges[i]:edges[i + 1]].mean(axis=1) / emax)
    add("env_peak_pos", e.argmax(axis=1) / e.shape[1])
    add("env_peak", emax)
    add("env_peak_ratio", emax / np.maximum(np.median(e, axis=1), 1e-9))
    add("env_burst", (e > 0.5 * emax[:, None]).mean(axis=1))
    add("profile_step", np.abs(x[..., :FS // 2].mean(-1) - x[..., -FS // 2:].mean(-1)).mean(axis=1))

    d = np.diff(x, axis=-1)
    d = (d - d.mean(-1, keepdims=True)) / np.maximum(d.std(-1, keepdims=True), 1e-6)
    corr = np.einsum("bit,bjt->bij", d, d) / d.shape[-1]
    add("diff_corr", (corr.sum(axis=(1, 2)) - 52) / (52 * 51))

    lin = 10 ** (F.astype(np.float32) / 20)
    turb = lin.std(axis=1) / np.maximum(lin.mean(axis=1), 1e-6)        # [B, 150]
    add("turb_mean", turb.mean(axis=1))
    add("turb_std", turb.std(axis=1))
    return np.stack(feats, axis=1), names
