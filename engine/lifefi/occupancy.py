"""Room occupancy: is anybody in the link area at all (empty / occupied / unsure).

The one signal that carried from one labelled spot session to the other
(docs/models.md, ml/eval_position.py): the body disturbance P of
lifefi.position over the last `window_s` (4 s), as an absolute level. No
empty-room calibration is needed for `occupied` (a level relative to one
was worse on the two sessions); `empty` needs one, see below.

    p = 1 / (1 + exp(-(log10 P - offset) / scale))

offset and scale come from ml/eval_position.py --fit-occupancy (both
sessions pooled). p is that logistic, not a calibrated probability for
another room. States:

- occupied when p >= p_on;
- empty only on high evidence, never from a low P alone (a still,
  breathing person also gives a low P, and without an empty-room
  calibration presence says `empty` next to a person too): p <= p_off
  AND presence says `empty` AND an empty-room calibration is loaded
  (`calibrated`), all three without a break for `empty_hold_s` (30 s,
  presence's breathing window: a still person has had one full breathing
  look). Anything less is `unsure`;
- unsure otherwise.

A new state is taken only after the same raw state for `hold_ticks` ticks
(no flicker); leaving `empty` is immediate when presence says `present`,
the calibration goes, or P rises out of the empty band. No update for
longer than STALE_S (a signal gap, the engine's warm-up after it) starts
again from `unsure`. None when the window has too few packets
(MIN_HZ x window_s) or a gap.
"""

import numpy as np

from .position import MAX_GAP_S, disturbance, gain_free_db

MIN_HZ = 8.0             # S1's worst spot ran at 11.6 Hz; 8 Hz x 4 s = 32 packets
P_FLOOR = 1e-4           # dB²: log10 of anything below is -4
STALE_S = 2.0            # no update for longer than this: the state is old news (ticks are 0.5 s)
EMPTY_HOLD_S = 30.0      # default empty_hold_s: presence.B_WIN_S, one full breathing window


class Occupancy:
    def __init__(self, cfg):
        self.window_s = float(cfg["window_s"])
        self.offset, self.scale = float(cfg["offset"]), float(cfg["scale"])
        self.p_on, self.p_off = float(cfg["p_on"]), float(cfg["p_off"])
        self.hold_ticks = int(cfg["hold_ticks"])
        self.empty_hold_s = float(cfg.get("empty_hold_s", EMPTY_HOLD_S))
        self.reset()

    def reset(self):
        self.state = "unsure"
        self.cand, self.run = None, 0
        self.low_since = None                    # since when the empty evidence has held without a break
        self.last_now = None

    def prob(self, P):
        z = (np.log10(max(P, P_FLOOR)) - self.offset) / self.scale
        return float(1.0 / (1.0 + np.exp(-np.clip(z, -50.0, 50.0))))

    def update(self, now, t, amp, presence_state=None, calibrated=False):
        """t s [N], |csi| [N, 52] (the last window_s of packets or more): {state, p} or None.

        calibrated: an empty-room calibration is loaded (presence's `empty` then means something);
        without it the answer is never `empty`."""
        if self.last_now is not None and now - self.last_now > STALE_S:
            self.reset()
        self.last_now = now
        r = None
        if len(t) and now - t[-1] <= MAX_GAP_S:
            k = int(np.searchsorted(t, t[-1] - self.window_s))
            if t[-1] - t[k] >= 0.9 * self.window_s:
                r = disturbance(t[k:], gain_free_db(amp[k:]), self.window_s, int(MIN_HZ * self.window_s))
        if r is None:
            self.low_since = None                    # no look at the room: the empty evidence starts again
            return None
        p = self.prob(r[0])
        evidence = p <= self.p_off and presence_state == "empty" and bool(calibrated)
        if not evidence:
            self.low_since = None
        elif self.low_since is None:
            self.low_since = now
        empty_ok = evidence and now - self.low_since >= self.empty_hold_s
        raw = "occupied" if p >= self.p_on else "empty" if empty_ok else "unsure"
        if raw == self.state:
            self.cand, self.run = None, 0
        elif raw == self.cand:
            self.run += 1
        else:
            self.cand, self.run = raw, 1
        if self.cand is not None and self.run >= self.hold_ticks:
            self.state, self.cand, self.run = raw, None, 0
        if self.state == "empty" and not evidence:
            self.state = "unsure"                    # the evidence for "empty" broke: at once, no hold
        return {"state": self.state, "p": round(p, 3)}
