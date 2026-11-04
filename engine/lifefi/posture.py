"""Posture state machine on the movement model (plan-v2 §6.7, with `rise`).

```
STANDING ──sit_down──▶ SITTING ──rise──▶ STANDING
STANDING / SITTING ──lie_down──▶ LYING ──rise──▶ SITTING
walking ⇒ STANDING ; not present ⇒ null ; start ⇒ unknown
```

`rise` is stand_up and get_up in one model class (ml/data.py); the
posture before it tells which one it was. A transition fires when its
probability, averaged over the last SMOOTH windows, has a local maximum
above THETA, at most once per REFRACTORY_S. `fall` is ignored here: the
fall alarm is the rule (lifefi.fall).

Hidden in the demo (decision 2026-10-30): the engine runs this but sends
`posture: null` unless rules.yaml sets `posture.publish: true`. On people
it has not seen, the model finds the right movement less often than a
constant guess (docs/models.md), so a shown posture would often be wrong.
"""

from collections import deque

import numpy as np

DEFAULTS = {"theta": 0.5, "smooth": 3, "refractory_s": 3.0, "walking_theta": 0.5}
AFTER = {("standing", "sit_down"): "sitting", ("unknown", "sit_down"): "sitting",
         ("sitting", "rise"): "standing", ("lying", "rise"): "sitting",
         ("standing", "lie_down"): "lying", ("sitting", "lie_down"): "lying", ("unknown", "lie_down"): "lying"}
EVENTS = ("sit_down", "lie_down", "rise")


class Posture:
    def __init__(self, classes, cfg=None):
        self.cfg = {**DEFAULTS, **(cfg or {})}
        self.classes = list(classes)
        self.label = None
        self.since = None
        self.src = None
        self.last_event = -np.inf
        self.hist = deque(maxlen=self.cfg["smooth"] + 2)
        self.smoothed = deque(maxlen=3)

    def update(self, t, p, present):
        """t in s, p = class probabilities [n_classes] or None. Returns (label, since_s, src) or None."""
        if not present:
            self.label = None
            self.hist.clear()
            self.smoothed.clear()
            return None
        if self.label is None:
            self.label, self.since, self.src = "unknown", t, "start"
        if p is not None:
            self.hist.append(np.asarray(p, dtype=np.float64))
            n = min(len(self.hist), self.cfg["smooth"])
            self.smoothed.append((t, np.mean(list(self.hist)[-n:], axis=0)))
            self._step()
        return self.label, self.since, self.src

    def _step(self):
        c = self.cfg
        t_now, s_now = self.smoothed[-1]
        if s_now[self.classes.index("walking")] > c["walking_theta"] and self.label != "standing":
            self._set("standing", t_now, "walking")
        if len(self.smoothed) < 3:
            return
        (_, a), (t_mid, b), (_, d) = self.smoothed
        for ev in EVENTS:
            i = self.classes.index(ev)
            if b[i] > c["theta"] and b[i] >= a[i] and b[i] > d[i] and t_mid - self.last_event >= c["refractory_s"]:
                self.last_event = t_mid
                nxt = AFTER.get((self.label, ev))
                if nxt is not None and nxt != self.label:
                    self._set(nxt, t_mid, "transitions")

    def _set(self, label, t, src):
        self.label, self.since, self.src = label, t, src
