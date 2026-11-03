"""Spot model: which taught place the person is at (one board, one room).

One link cannot measure where someone is, but a body at a given spot
changes the static multipath in its own way, still or moving. So the
model learns the spots of this room from a short labelled recording
(ml/record_spots.py, ml/train_spots.py) and names the closest one.

Features of a WIN_S window of packets (the same code in training and
live): per subcarrier, the mean gain-free dB (20·log10(|csi|+1) minus the
frame mean) and its log standard deviation; then the mean RSSI, the mean
raw level and the log spread of each frame's level. The last three tell a
body near the board from one across the room (picked on the first spots
recording: 93 % on its hold-out, 72 % without them). Classifier: linear
discriminant with a shrunk shared covariance, all numbers in a JSON file
(data/spots_model.json), no extra library. Probabilities are averaged over
SMOOTH_S so the answer does not flicker.

It knows only the spots it was taught, for one person, with the board
and router where they were during the recording.
"""

import json
import pathlib
from collections import deque

import numpy as np

WIN_S = 2.0
MIN_PACKETS = 40
SMOOTH_S = 3.0


def features(amp, rssi_dbm):
    """|csi| [n, 52] of one window and its mean RSSI -> feature vector [107]."""
    raw = 20.0 * np.log10(np.asarray(amp, np.float64) + 1.0)
    level = raw.mean(axis=1)
    x = raw - level[:, None]
    return np.concatenate([x.mean(axis=0), np.log(x.std(axis=0) + 1e-3),
                           [float(rssi_dbm), float(level.mean()), float(np.log(level.std() + 1e-3))]])


class SpotModel:
    def __init__(self, d):
        self.labels = list(d["labels"])
        self.dist = dict(d["distances"])
        self.mu, self.sd = np.asarray(d["mu"]), np.asarray(d["sd"])
        self.W = np.asarray(d["W"])                  # [k, 107] linear weights
        self.b = np.asarray(d["b"])                  # [k]
        self.meta = {k: d[k] for k in ("session", "trained_at", "holdout_accuracy") if k in d}
        self.hist = deque()                          # (t, p [k]) for smoothing

    @classmethod
    def load(cls, path):
        path = pathlib.Path(path)
        return cls(json.loads(path.read_text(encoding="utf-8"))) if path.exists() else None

    def proba(self, f):
        z = self.W @ ((f - self.mu) / self.sd) + self.b
        z = np.exp(z - z.max())
        return z / z.sum()

    def update(self, now, t, amp, rssi_dbm):
        """The smoothed spot for the last WIN_S of packets (mean RSSI over them): {name, p, d_m} or None."""
        if len(t) == 0 or rssi_dbm is None:
            return None
        k = int(np.searchsorted(t, t[-1] - WIN_S))
        if len(t) - k < MIN_PACKETS:
            self.hist.clear()
            return None
        self.hist.append((now, self.proba(features(amp[k:], rssi_dbm))))
        while self.hist and self.hist[0][0] < now - SMOOTH_S:
            self.hist.popleft()
        p = np.mean([q for _, q in self.hist], axis=0)
        i = int(np.argmax(p))
        name = self.labels[i]
        return {"name": name, "p": round(float(p[i]), 3), "d_m": self.dist.get(name)}
