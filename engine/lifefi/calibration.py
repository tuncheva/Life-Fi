"""Empty-room calibration (plan-v2 §6.6), on F.

`calibrate kind=empty` records 2 minutes with nobody in the link area and
stores the empty-room levels every rule is scaled by:

- M (lifefi.motion): P10 / P50 / P95 / P99. P10 is the fall rule's
  baseline: the same statistic as lifefi.fall.baseline_quiet on public
  clips, so thresholds tuned there carry over (checked on E4, ml/check_presence.py);
- B (breathing-band energy, lifefi.presence.breath_energy) over 30 s
  windows every 5 s: P95 / P99;
- S (static deviation) over 10 s windows: P95 / P99, and the empty
  profile p_empty itself.

It is refused when someone moves during it: any 1 s with mean M above
MOTION_X x the median (an empty E4 recording passes, walking fails).
"""

from dataclasses import dataclass, field

import numpy as np

from . import motion as motion_mod
from . import presence

FS = motion_mod.FS
MOTION_X = 10.0          # [H] 1 s mean M above this x median M = someone moved
MIN_S = 60.0             # shorter calibrations are refused
B_WIN_S, B_HOP_S = presence.B_WIN_S, 5.0
S_WIN_S = presence.S_WIN_S


class Refused(Exception):
    pass


@dataclass
class Calibration:
    id: str
    at: float                                  # host time, s
    seconds: float
    m_p10: float
    m_p50: float
    m_p95: float
    m_p99: float
    b_p95: float
    b_p99: float
    s_p95: float
    s_p99: float
    p_empty: np.ndarray = field(repr=False)    # [52] mean-removed dB profile

    def to_dict(self):
        d = {k: getattr(self, k) for k in ("id", "at", "seconds", "m_p10", "m_p50", "m_p95", "m_p99",
                                            "b_p95", "b_p99", "s_p95", "s_p99")}
        d["p_empty"] = [round(float(v), 4) for v in self.p_empty]
        return d


def _windows(n, win, hop):
    return range(0, n - win + 1, hop)


def from_empty(F, valid, cal_id, at):
    """Calibration from one continuous empty-room segment F [T, 52] (50 Hz) and valid [T]."""
    F = np.asarray(F, dtype=np.float32)
    seconds = len(F) / FS
    if seconds < MIN_S:
        raise Refused(f"calibration needs {MIN_S:.0f} s of continuous signal, got {seconds:.0f} s")
    if np.mean(valid) < 0.9:
        raise Refused(f"only {100 * np.mean(valid):.0f} % of the calibration signal is valid")
    M = motion_mod.motion(F)[int(FS):]                      # first 1 s is filter warm-up
    blocks = M[: len(M) // int(FS) * int(FS)].reshape(-1, int(FS)).mean(axis=1)
    med = max(float(np.median(M)), 1e-12)
    if blocks.max() > MOTION_X * med:
        raise Refused("motion seen during calibration")
    p = F.mean(axis=0)
    p_empty = p - p.mean()
    S = [presence.static_deviation(F[a:a + int(S_WIN_S * FS)], p_empty)
         for a in _windows(len(F), int(S_WIN_S * FS), int(S_WIN_S * FS))]
    B = [presence.breath_energy(F[a:a + int(B_WIN_S * FS)])
         for a in _windows(len(F), int(B_WIN_S * FS), int(B_HOP_S * FS))]
    q = lambda a, pc: float(np.percentile(a, pc))  # noqa: E731
    return Calibration(cal_id, at, round(seconds, 1), q(M, 10), q(M, 50), q(M, 95), q(M, 99),
                       q(B, 95), q(B, 99), q(S, 95), q(S, 99), p_empty.astype(np.float32))
