"""Synthetic raw CSI for tests and dry runs (plan-v2 §6.12).

Never for training or evaluation: a hand-written signal teaches a model
the generator's assumptions, not the room.
"""

import numpy as np


def synth(seconds, bpm=None, breath_db=0.5, motion=False, gap=None, seed=1, rate=90.0, agc=True,
          breath_off=None, bursts=(), moving=()):
    """Raw CSI like the ESP32 delivers it: static multipath, an optional
    breathing modulation on ~40 % of subcarriers, per-packet AGC gain,
    receiver noise, jittered timing, and an optional gap.

    Returns (ts_us int64 [N], csi complex [N, 52]).

    agc=False keeps the gain constant (the engine's F has no per-packet
    normalisation, so the motion rules need it off); breath_off = (t0, t1)
    s, or a list of them, stops the breathing in between (a breath-hold, or
    nobody there; t1 may be inf); bursts is a list of (t0, t1) s of strong
    broadband change, e.g. an impact; moving is a list of (t0, t1) s in
    which a person moves as with motion=True (walking in or out)."""
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
        wave = np.sin(2 * np.pi * bpm / 60 * t)
        if breath_off is not None:
            for a, b in ([breath_off] if np.isscalar(breath_off[0]) else breath_off):
                wave = np.where((t >= a) & (t < b), 0.0, wave)
        db += breath_db * np.outer(wave, sign * affected)
    if motion:
        for f in rng.uniform(0.15, 3.0, 12):    # a person moving: broadband, many components
            db += 2.0 * np.outer(np.sin(2 * np.pi * f * t + rng.uniform(0, 6.3)), rng.normal(0, 1, 52))
    if moving:
        inside = np.zeros(len(t), bool)
        for a, b in moving:
            inside |= (t >= a) & (t < b)
        for f in rng.uniform(0.15, 3.0, 12):
            db += 2.0 * np.outer(np.sin(2 * np.pi * f * t + rng.uniform(0, 6.3)) * inside, rng.normal(0, 1, 52))
    for t0, t1 in bursts:                        # an impact: strong broadband change for (t1 - t0) s
        inside = (t >= t0) & (t < t1)
        db[inside] += 6.0 * rng.normal(0, 1, (int(inside.sum()), 52))
    gain = rng.uniform(0.6, 1.4, len(t))[:, None] if agc else np.ones((len(t), 1))   # AGC / auto-scale per packet
    amp = np.abs(static) * 10 ** (db / 20) * gain
    csi = amp * np.exp(1j * np.angle(static)) + rng.normal(0, 0.7, (len(t), 52)) + 1j * rng.normal(0, 0.7, (len(t), 52))
    return (t * 1e6).astype(np.int64), csi
