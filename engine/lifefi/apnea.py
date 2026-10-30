"""Breathing cessation, the `no_breathing` event (plan-v2 §6.4).

```
y      = 0.1-0.5 Hz breathing signal projected on v_valid (frozen, NOT re-selected)
breath = a peak in y with prominence >= PROMINENCE_X * A_ref, >= MIN_GAP_S after the previous one
no_breathing ACTIVE when, all at once:
    presence PRESENT, still (M / baseline < t_still) for the whole interval,
    breathing was valid within the last VALID_WITHIN_S, in a 30 s window that
        lies inside the current stillness (deviation from plan-v2, below),
    no breath for >= HOLD_S (15 s)                            [H; apnea is defined as >= 10 s]
CLEARED when CLEAR_BREATHS breaths within CLEAR_WITHIN_S, or motion
```

The signal is lifefi.breathing's own (dB minus each packet's mean, box
average to 10 Hz, 0.1-0.5 Hz), so `v` from its last valid window fits it;
the band-pass here is causal, as live. Why freeze v: during a hold there
is no breathing for PCA to find, so re-selecting would pick noise and
"find" breaths in it. Why count breaths: an RMS envelope lags ~9 s.

A Wi-Fi pause is not a breath-hold: no decision is taken across a gap
> 1 s (lifefi.breathing.MAX_GAP_S); the interval restarts after it.

Someone walking out is not a breath-hold either, although the signal
looks the same (breathing gone, nothing moving) and presence still says
PRESENT for the next ~90 s. So the rule is armed only by a valid
breathing window that lies entirely inside the current stillness: it
must have seen this person breathe since they last moved (found by the
engine test's "leave" scenario, 2026-10-30).

No public breath-hold data exists (datasets/README.md), so only
synthetic tests check the latency (engine/tests/test_apnea.py), and
ml/check_apnea.py counts false alerts on E1's paced-breathing files (the
thresholds below were moved from plan-v2's 12 s / 0.4 to cut those).
Not a medical device.
"""

import numpy as np
from scipy import signal

from . import breathing

FS = breathing.FS
# plan-v2 starts at 12 s / 0.4; on E1's paced-breathing files that gave 2 false alerts in the
# 0.47 h the rule was armed (4.3 per hour; breathing fades into noise and stops being
# "counted"). 15 s / 0.25 gave 0 there and still caught every synthetic 25 s hold, ~15 s
# after it began (2026-10-30, picked and scored on the same E1 files: ml/check_apnea.py)
DEFAULTS = {
    "hold_s": 15.0,
    "prominence_x": 0.25,
    "min_gap_s": 1.5,
    "valid_within_s": 60.0,
    "clear_breaths": 2,
    "clear_within_s": 10.0,
    "settle_s": 10.0,          # causal band-pass start-up at the buffer start: no peaks counted there
}
_SOS = signal.butter(2, breathing.BAND, btype="band", fs=FS, output="sos")


def projected(ts_s, csi, v):
    """(grid s [n], y [n]) at 10 Hz on direction v [52], causal band-pass; None if unusable."""
    ts_s = np.asarray(ts_s, dtype=np.float64)
    if len(ts_s) < 2 or ts_s[-1] - ts_s[0] < 2.0:
        return None
    x = breathing._features(np.asarray(csi))
    grid, y10 = breathing._resample(ts_s, x, ts_s[0], ts_s[-1])
    if y10 is None:
        return None
    y10 = y10 - y10[: int(5 * FS)].mean(axis=0)
    zi = signal.sosfilt_zi(_SOS)[:, :, None] * y10[0][None, None, :]
    bp, _ = signal.sosfilt(_SOS, y10, axis=0, zi=zi)
    return grid, bp @ v


def _after_last_gap(ts_s, csi):
    ts_s = np.asarray(ts_s, dtype=np.float64)
    gaps = np.where(np.diff(ts_s) > breathing.MAX_GAP_S)[0]
    if len(gaps):
        k = gaps[-1] + 1
        return ts_s[k:], np.asarray(csi)[k:]
    return ts_s, np.asarray(csi)


class NoBreathing:
    def __init__(self, cfg=None):
        self.cfg = {**DEFAULTS, **(cfg or {})}
        self.v = None
        self.a_ref = None
        self.t_valid = None
        self.armed = False                  # this tick: a long enough silence would raise the alert
        self.active = False
        self.t_active = None
        self.still_since = None
        self.last_breath = None

    def on_breathing(self, t, window, ts_s, csi):
        """A new lifefi.breathing window; ts_s / csi = the raw packets it came from (host s).
        A valid one (re)freezes v and A_ref, except during an alert."""
        if not window.valid or self.active or window.v is None:
            return
        ts_s, csi = _after_last_gap(ts_s, csi)
        r = projected(ts_s, csi, window.v)
        if r is None:
            return
        g, y = r
        y = y[g >= g[0] + self.cfg["settle_s"]]
        if len(y) < 10 * FS:
            return
        self.v = window.v
        self.a_ref = float(np.percentile(y, 95) - np.percentile(y, 5))
        self.t_valid = t

    def update(self, t, ts_s, csi, present, still):
        """One tick. ts_s / csi: the raw packets of the last ~45 s (host s). Returns
        "active" / "cleared" on a change, else None."""
        c = self.cfg
        self.armed = False
        if not (present and still):
            self.still_since = None
            if self.active:
                return self._clear()
            return None
        if self.still_since is None:
            self.still_since = t
        if self.v is None or self.a_ref is None or self.a_ref <= 0:
            return None
        ts_s, csi = _after_last_gap(ts_s, csi)
        r = projected(ts_s, csi, self.v)
        if r is None:
            return None
        g, y = r
        ok = g >= g[0] + c["settle_s"]
        if not ok.any():                    # just after a gap: the filter has not settled, no decision
            return None
        peaks, _ = signal.find_peaks(y, prominence=c["prominence_x"] * self.a_ref,
                                     distance=max(1, int(c["min_gap_s"] * FS)))
        times = g[peaks[ok[peaks]]]
        if len(times):
            self.last_breath = float(times[-1])
        # the silent interval starts at the last breath, the start of stillness, or the first usable
        # sample after a gap, whichever is latest (a breath before a gap says nothing about after it)
        start = max(x for x in (self.last_breath, self.still_since, float(g[ok][0])) if x is not None)
        if self.active:
            after = times[times > self.t_active]
            if len(after) >= c["clear_breaths"] and after[-1] - after[-c["clear_breaths"]] <= c["clear_within_s"]:
                return self._clear()
            return None
        # armed only by a valid window that lies inside the current stillness: someone who just
        # walked out also "stops breathing" in the signal, but was never seen breathing since moving
        recent_valid = (self.t_valid is not None and t - self.t_valid <= c["valid_within_s"]
                        and self.t_valid - breathing.WINDOW_S >= self.still_since - 1.0)
        self.armed = recent_valid
        if recent_valid and t - start >= c["hold_s"]:
            self.active = True
            self.t_active = t
            self.since_s = round(t - start, 1)
            return "active"
        return None

    def _clear(self):
        self.active = False
        self.t_active = None
        return "cleared"


def run_offline(ts_us, csi, still=None, start_s=35.0, tick_s=0.5, buffer_s=45.0, cfg=None):
    """The engine's loop over a whole recording, for tests and checks: breathing every
    STEP_S on the last WINDOW_S, NoBreathing every tick, the person present throughout.
    still(t) -> bool (default: always still). Returns ([(t s from the first packet, change)],
    the NoBreathing, seconds it was armed: the time an alert could have started)."""
    t_s = (np.asarray(ts_us, dtype=np.int64) - int(ts_us[0])) / 1e6
    csi = np.asarray(csi)
    nb = NoBreathing(cfg)
    changes, t, next_breath, armed_s = [], start_s, start_s, 0.0
    while t <= t_s[-1]:
        buf = (t_s > t - buffer_s) & (t_s <= t)
        if t >= next_breath:
            sel = (t_s > t - breathing.WINDOW_S - 0.5) & (t_s <= t)
            w = breathing.estimate_breathing((t_s[sel] * 1e6).astype(np.int64), csi[sel])
            if w:
                nb.on_breathing(t, w[-1], t_s[buf], csi[buf])
            next_breath += breathing.STEP_S
        ch = nb.update(t, t_s[buf], csi[buf], present=True, still=True if still is None else still(t))
        if ch:
            changes.append((round(t, 1), ch))
        armed_s += tick_s if nb.armed else 0.0
        t += tick_s
    return changes, nb, armed_s
