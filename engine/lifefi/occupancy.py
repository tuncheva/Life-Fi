"""Room occupancy: is anybody in the link area at all (empty / occupied / unsure).

The one signal that carried from one labelled spot session to the other
(docs/models.md, ml/eval_position.py): the body disturbance P of
lifefi.position over the last `window_s` (4 s), as an absolute level. No
empty-room calibration is needed; a level relative to one was worse on
the two sessions.

    p = 1 / (1 + exp(-(log10 P - offset) / scale))

offset and scale come from ml/eval_position.py --fit-occupancy (both
sessions pooled). p is that logistic, not a calibrated probability for
another room. States:

- occupied when p >= p_on;
- empty when p <= p_off and presence is not `present`: a still, breathing
  person disturbs the link very little, so "empty" must never be said
  while presence still sees someone;
- unsure otherwise.

A new state is taken only after the same raw state for `hold_ticks` ticks
(no flicker); leaving `empty` because presence says `present` is immediate.
None when the window has too few packets (MIN_HZ x window_s) or a gap.
"""

import numpy as np

from .position import MAX_GAP_S, disturbance, gain_free_db

MIN_HZ = 8.0             # S1's worst spot ran at 11.6 Hz; 8 Hz x 4 s = 32 packets
P_FLOOR = 1e-4           # dB²: log10 of anything below is -4


class Occupancy:
    def __init__(self, cfg):
        self.window_s = float(cfg["window_s"])
        self.offset, self.scale = float(cfg["offset"]), float(cfg["scale"])
        self.p_on, self.p_off = float(cfg["p_on"]), float(cfg["p_off"])
        self.hold_ticks = int(cfg["hold_ticks"])
        self.state = "unsure"
        self.cand, self.run = None, 0

    def prob(self, P):
        z = (np.log10(max(P, P_FLOOR)) - self.offset) / self.scale
        return float(1.0 / (1.0 + np.exp(-np.clip(z, -50.0, 50.0))))

    def update(self, now, t, amp, presence_state=None):
        """t s [N], |csi| [N, 52] (the last window_s of packets or more): {state, p} or None."""
        if len(t) == 0 or now - t[-1] > MAX_GAP_S:
            return None
        k = int(np.searchsorted(t, t[-1] - self.window_s))
        tw = t[k:]
        if tw[-1] - tw[0] < 0.9 * self.window_s:
            return None
        r = disturbance(tw, gain_free_db(amp[k:]), self.window_s, int(MIN_HZ * self.window_s))
        if r is None:
            return None
        p = self.prob(r[0])
        raw = "occupied" if p >= self.p_on else "empty" if p <= self.p_off and presence_state != "present" else "unsure"
        if raw == self.state:
            self.cand, self.run = None, 0
        elif raw == self.cand:
            self.run += 1
        else:
            self.cand, self.run = raw, 1
        if self.cand is not None and self.run >= self.hold_ticks:
            self.state, self.cand, self.run = raw, None, 0
        if self.state == "empty" and presence_state == "present":
            self.state = "unsure"                    # never "empty" while presence sees someone
        return {"state": self.state, "p": round(p, 3)}
