"""Live F: raw packets in, the training pipeline's F out (plan-v2 §5).

The streaming filters of plan-v2 §5.3 are not written yet. Instead, every
tick re-runs lifefi.dsp.to_features (the exact code the public data went
through) on the last BUFFER_S of packets, on a grid anchored to absolute
time, and appends the samples it has not produced before. The Butterworth
starts in steady state and settles in well under a second, so only the
newest EDGE_S differs from an offline run (Hampel is centred and needs 3
future packets): those samples wait for the next tick.
engine/tests/test_live.py checks the stitched F against one offline run.

A gap > MAX_GAP_S, or a new segment from dsp, starts a new segment here
too: the F history is cleared and `segment` goes up, so every rule that
looks back resets with it (plan-v2 §5.4).
"""

from collections import deque

import numpy as np

from . import dsp

FS = dsp.FS
BUFFER_S = 12.0
EDGE_S = 0.2
KEEP_S = 180.0           # F history: a 2-min calibration plus margin
RAW_KEEP_S = 60.0        # raw packets kept for breathing (30 s) and lifefi.apnea (45 s)


class LiveF:
    def __init__(self, buffer_s=BUFFER_S, keep_s=KEEP_S, raw_keep_s=RAW_KEEP_S):
        self.buffer_s, self.keep_s, self.raw_keep_s = buffer_s, keep_s, raw_keep_s
        self.pt, self.pamp, self.pcsi = deque(), deque(), deque()   # raw packets: time s, |csi|, csi
        self.t = np.zeros(0)
        self.F = np.zeros((0, 52), np.float32)
        self.valid = np.zeros(0, bool)
        self.segment = 0

    def add(self, t, csi):
        """One packet: host time t (s, monotonic per segment) and LLTF csi [52] complex."""
        if self.pt and t - self.pt[-1] > dsp.MAX_GAP_S:
            self.new_segment()
        if self.pt and t <= self.pt[-1]:
            return                                    # duplicate or out of order: no new sample
        self.pt.append(t)
        self.pcsi.append(csi)
        self.pamp.append(np.abs(csi).astype(np.float32))
        while self.pt and self.pt[0] < t - self.raw_keep_s:
            self.pt.popleft()
            self.pcsi.popleft()
            self.pamp.popleft()

    def new_segment(self):
        self.pt.clear()
        self.pcsi.clear()
        self.pamp.clear()
        self.t = np.zeros(0)
        self.F = np.zeros((0, 52), np.float32)
        self.valid = np.zeros(0, bool)
        self.segment += 1

    def update(self):
        """Append the new F samples; returns how many were added."""
        if len(self.pt) < 10:
            return 0
        pt = np.fromiter(self.pt, float, len(self.pt))
        newest = pt[-1]
        k = int(np.searchsorted(pt, newest - self.buffer_s))
        amp = np.array(list(self.pamp)[k:])
        segs = dsp.to_features(pt[k:], amp, origin=0.0)   # add() resets at gaps, so one segment
        if not segs:                                       # (none until it is MIN_SEGMENT_S long)
            return 0
        s = segs[-1]
        last = self.t[-1] if len(self.t) else -np.inf
        take = (s.t > last + 0.5 / FS) & (s.t <= newest - EDGE_S)
        if not take.any():
            return 0
        self.t = np.r_[self.t, s.t[take]]
        self.F = np.vstack([self.F, s.F[take]])
        self.valid = np.r_[self.valid, s.valid[take]]
        cut = int(np.searchsorted(self.t, self.t[-1] - self.keep_s))
        if cut:
            self.t, self.F, self.valid = self.t[cut:], self.F[cut:], self.valid[cut:]
        return int(take.sum())

    def seconds(self):
        return float(self.t[-1] - self.t[0]) if len(self.t) > 1 else 0.0

    def last(self, seconds):
        """(t, F, valid) of the last `seconds` of F."""
        n = int(round(seconds * FS))
        return self.t[-n:], self.F[-n:], self.valid[-n:]

    def raw_amp(self, seconds):
        """(t s [N], |csi| [N, 52]) of the last `seconds` of packets."""
        if not self.pt:
            return np.zeros(0), np.zeros((0, 52), np.float32)
        pt = np.fromiter(self.pt, float, len(self.pt))
        k = int(np.searchsorted(pt, pt[-1] - seconds))
        return pt[k:], np.array(list(self.pamp)[k:])

    def raw(self, seconds, now=None):
        """(t s [N], csi complex [N, 52]) of the last `seconds` of packets."""
        if not self.pt:
            return np.zeros(0), np.zeros((0, 52), np.complex64)
        pt = np.fromiter(self.pt, float, len(self.pt))
        end = pt[-1] if now is None else now
        k = int(np.searchsorted(pt, end - seconds))
        return pt[k:], np.array(list(self.pcsi)[k:])
