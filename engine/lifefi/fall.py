"""Fall -> fainted, two-stage rule (plan-v2 §6.5), offline on F.

Stage 1, spike: M / baseline > t_fall at a local maximum, the burst
(M above half of its own peak) lasts 0.3-2 s, and the variance
of the last 1 s before the peak is > ratio x that of the 2 s before.
Stage 2, verify: within 1 s after the burst ends, M / baseline stays
below t_still for STILL_S seconds -> `fall` (alert latency ~ burst +
STILL_S). Escalation to `fainted_suspected` after 20 s more of stillness
happens in the engine's state machine, not here.

The five stage-1 numbers of plan-v2 §6.5 are returned with every candidate
so a verifier (T2) can be trained on them later.

The default thresholds are placeholders [H]. Public data cannot set them
(checked 2026-10-29, ml/tune_fall.py, ml/results/fall_stage1.json):
- E8 fall impacts (45-170x the quiet level) overlap walking and jumping
  (up to ~230x): with <= 10 % of other clips flagged, stage 1 alone finds
  ~7 % of the falls; and E8 subjects move again right after falling, so
  stage 2 (stillness) cannot be tested on it;
- E1 falls are gentler than E1's own sit-downs.
What separates a fall is impact *then lying still*, which only our mat
falls show. Set t_fall = P99.9 of M / baseline over our walking and
sit-downs (plan-v2 §6.5), and t_still from the stillness after our falls:
ml/tune_fall_own.py does both. Until then the defaults below are guesses,
and the best E8 setting caught 36 % of falls with 19 % of other clips
flagged (ml/results/fall_rule.json): do not demo the rule as tested.
"""

from dataclasses import dataclass

import numpy as np

from . import motion as motion_mod

FS = motion_mod.FS
T_FALL = 80.0        # [H] placeholder, NOT tuned: E8 cannot set it (module doc); set from ml/tune_fall_own.py
RATIO = 4.0          # plan-v2
T_STILL = 10.0       # [H] placeholder, NOT tuned; set from ml/tune_fall_own.py
STILL_S = 3.0        # plan-v2
BURST_S = (0.3, 2.0)


@dataclass
class Candidate:
    t_peak: float        # s from the segment start
    peak: float          # M / baseline at the peak
    ratio: float         # variance last 1 s / 2 s before
    burst_s: float
    max_diff: float      # max |dF| (mean over subcarriers) in the 3 s before the peak
    kurtosis: float      # of M over the 3 s before the peak
    hf_share: float      # share of 2-20 Hz energy in the 3 s before the peak
    still_s: float       # how long it stayed still after the burst (capped at the data)
    fall: bool           # passed stage 2


def baseline_quiet(M):
    """Stand-in baseline for public clips with no empty-room calibration: the clip's P10 of M."""
    return max(float(np.percentile(M[int(FS):], 10)), 1e-6)


def detect(F, baseline, t_fall=T_FALL, ratio=RATIO, t_still=T_STILL, still_s=STILL_S):
    M = motion_mod.motion(F) / baseline
    n = len(M)
    out = []
    i = int(FS)
    while i < n - 1:
        if not (M[i] > t_fall and M[i] >= M[i - 1] and M[i] >= M[i + 1]):
            i += 1
            continue
        half = M[i] / 2                  # burst = time above half of its own peak (scale-free)
        a = i
        while a > 0 and M[a - 1] > half:
            a -= 1
        b = i
        while b < n - 1 and M[b + 1] > half:
            b += 1
        burst = (b - a + 1) / FS
        lo = max(0, i - int(3 * FS))
        last, before = M[max(lo, i - int(FS)):i + 1], M[lo:max(lo + 1, i - int(FS))]
        r = float(last.mean() / max(before.mean(), 1e-9))
        seg = F[lo:i + 1]
        d = np.abs(np.diff(seg, axis=0)).mean(axis=1) if len(seg) > 1 else np.zeros(1)
        m3 = M[lo:i + 1]
        kurt = float(((m3 - m3.mean()) ** 4).mean() / max(m3.var() ** 2, 1e-12))
        spec = np.abs(np.fft.rfft(seg - seg.mean(axis=0), axis=0)) ** 2
        f = np.fft.rfftfreq(len(seg), 1 / FS)
        hf = float(spec[(f >= 2) & (f <= 20)].sum() / max(spec.sum(), 1e-12))
        # stage 2: stillness starting within 1 s after the burst
        still = 0.0
        for s0 in range(b + 1, min(n, b + 1 + int(FS))):
            q = s0
            while q < n and M[q] < t_still:
                q += 1
            still = max(still, (q - s0) / FS)
            if still >= still_s:
                break
        ok = BURST_S[0] <= burst <= BURST_S[1] and r > ratio
        if ok:
            out.append(Candidate(i / FS, float(M[i]), r, burst, float(d.max()), kurt, hf, still, still >= still_s))
        i = b + 1
    return out
