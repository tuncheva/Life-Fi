"""Presence, incl. a still person (plan-v2 §6.1), and the 0-1 motion level.

Features, all from F (50 Hz, dB):
- M, motion (lifefi.motion), divided by the calibration's levels;
- B, breathing-band energy: mean 0.1-0.5 Hz variance of the 8 strongest
  subcarriers over 30 s (`breath_energy`; ml/check_presence.py uses the
  same function);
- S, static deviation: 1 - corr of the 10 s mean profile with the empty
  profile, both mean-removed.

Two deviations from plan-v2 §6.1:
- From E4 (ml/check_presence.py, 2026-10-29): the static profile S
  drifts as much in 10 empty minutes as a still person changes it, while
  B separates a still person from an empty room on every day (AUC
  0.98-1.00). So B can also *start* presence (B > b_on for B_HOLD_S), and
  S is reported but only used when `use_static` is on.
- The exit tolerates noise: B is a 30 s window, so it is judged from 30 s
  after the burst, and over the next 60 s B must be below b_off on at
  least EXIT_SHARE of the ticks (plan-v2: on every one). An empty room's
  B is above its own P95 5 % of the time, so "every tick for 60 s" left
  the synthetic empty room PRESENT forever (engine/tests/test_engine.py).

```
EMPTY ──M > m_on for 1 s, or B > b_on for B_HOLD_S (or S > s_on for 10 s)──▶ PRESENT
PRESENT holds while B > b_off, or motion in the last 30 s (or S > s_off)
PRESENT ──exit──▶ EMPTY
   exit = a motion burst (>= 1 s above m_on) that decays below m_off, then no
          motion, and from 30 s to 90 s after it B < b_off (and S < s_off)
          on >= EXIT_SHARE of the ticks; otherwise the person stayed
PRESENT ──no motion 10 min, and valid breathing never seen since entry──▶ UNCERTAIN
UNCERTAIN ──motion or valid breathing──▶ PRESENT
```

Without a calibration only motion counts, against a provisional
baseline (P10 of M over the last 2 min): a still person then ends in
UNCERTAIN, never in EMPTY.
"""

from collections import deque
from dataclasses import dataclass

import numpy as np
from scipy import signal

FS = 50.0
B_WIN_S = 30.0
S_WIN_S = 10.0
TOP = 8

# [H] starting values; the engine reads them from engine/config/rules.yaml
DEFAULTS = {
    "m_on_x": 2.0,         # m_on = m_on_x x P99 of empty M (plan-v2: 1.5-2 x)
    "m_off_x": 1.0,        # m_off = m_off_x x P95 of empty M
    "b_on_x": 1.0,         # b_on = b_on_x x P99 of a 2-min calibration's B: E4, held-out days, 67-75 % of
                           # still 30 s windows found with 0-2.6 % of empty ones flagged (ml/check_presence.py)
    "b_off_x": 1.0,        # b_off = P95 of the calibration's B (plan-v2); E4: ~95 % of still windows above 0.82 x it
    "exit_share": 0.9,     # [H] share of exit-window ticks with B < b_off that means "left"
    "s_on_x": 2.0,
    "s_off_x": 1.0,
    "use_static": False,
    "enter_motion_s": 1.0,
    "b_hold_s": 5.0,
    "s_hold_s": 10.0,
    "motion_recent_s": 30.0,
    "burst_s": 1.0,
    "exit_quiet_s": 60.0,
    "uncertain_after_s": 600.0,
    "nocal_m_on_x": 10.0,  # without a calibration: m_on = this x provisional P10 of M (E4: P99/P10 of empty is 2.6-4.7)
    "motion_span": 50.0,   # motion level 0.1 at m_on, 0.9 at motion_span x m_on (log scale)
}

_SOS_B = signal.butter(2, [0.1, 0.5], btype="band", fs=FS, output="sos")


def breath_energy(F):
    """B for one window F [T, 52] (30 s at 50 Hz): mean 0.1-0.5 Hz variance of the top 8 subcarriers."""
    F = np.asarray(F, dtype=np.float64)
    bp = signal.sosfiltfilt(_SOS_B, F - F.mean(axis=0), axis=0)
    return float(np.sort(bp.var(axis=0))[-TOP:].mean())


def static_deviation(F, p_empty):
    """S for one window F [T, 52]: 1 - corr(mean profile, empty profile), both mean-removed."""
    p = np.asarray(F, dtype=np.float64).mean(axis=0)
    p = p - p.mean()
    c = np.corrcoef(p, p_empty)[0, 1]
    return float(1.0 - c) if np.isfinite(c) else 0.0


def motion_level(M, m_on, span=DEFAULTS["motion_span"]):
    """0-1 motion for the dashboard, on a log scale anchored at presence's motion threshold:
    0.1 at m_on, 0.9 at span x m_on.

    The server calls >= 0.1 "motion seen" (`MOTION_ON`, server/src/rules.ts)
    and the UI words switch at 0.06 / 0.2 / 0.6, so 0.1 must mean the same
    as presence's "someone moved". On E4 (ml/check_presence.py) an empty
    room and a still person then read 0 and walking peaks around 0.7, as
    the mock engine's scenes assume."""
    r = np.maximum(np.asarray(M, dtype=np.float64), 1e-12) / max(m_on, 1e-12)
    return np.clip(0.1 + 0.8 * np.log10(r) / np.log10(span), 0.0, 1.0)


@dataclass
class Levels:
    m_on: float
    m_off: float
    b_on: float = float("inf")
    b_off: float = float("inf")
    s_on: float = float("inf")
    s_off: float = float("inf")

    @classmethod
    def from_calibration(cls, cal, cfg=DEFAULTS):
        return cls(cfg["m_on_x"] * cal.m_p99, cfg["m_off_x"] * cal.m_p95,
                   cfg["b_on_x"] * cal.b_p99, cfg["b_off_x"] * cal.b_p95,
                   cfg["s_on_x"] * cal.s_p99, cfg["s_off_x"] * cal.s_p95)


class Presence:
    """State machine, one update per tick (default 0.5 s)."""

    def __init__(self, cfg=None):
        self.cfg = {**DEFAULTS, **(cfg or {})}
        self.levels = None                     # None until calibrated
        self.state = "empty"
        self.reset_timers(0.0)
        self._m_hist = deque()                 # (t, M) for the provisional baseline

    def reset_timers(self, t):
        self.t_state = t
        self.m_above_since = None
        self.b_above_since = None
        self.s_above_since = None
        self.last_motion = None
        self.burst_start = None
        self.burst_end = None                  # when the last burst decayed
        self.exit_n = self.exit_low = 0
        self.breathing_seen = False
        self.entered = t

    def calibrate(self, levels, t):
        """New calibration: re-evaluate from EMPTY (plan-v2 §6.1, UNCERTAIN ──new calibration──▶)."""
        self.levels = levels
        self.state = "empty"
        self.reset_timers(t)

    def _provisional(self, t, M):
        self._m_hist.append((t, M))
        while self._m_hist and self._m_hist[0][0] < t - 120.0:
            self._m_hist.popleft()
        base = float(np.percentile([m for _, m in self._m_hist], 10))
        on = self.cfg["nocal_m_on_x"] * max(base, 1e-12)
        return Levels(on, on / 2)

    def update(self, t, M, B=None, S=None, breathing_valid=False):
        """t in s, M raw motion (dB²), B / S or None when not computable. Returns the state."""
        c = self.cfg
        lv = self.levels or self._provisional(t, M)
        moving = M > lv.m_on
        if moving:
            self.last_motion = t
            self.m_above_since = self.m_above_since if self.m_above_since is not None else t
            self.burst_start = self.burst_start if self.burst_start is not None else t
        else:
            self.m_above_since = None
        if self.burst_start is not None and M < lv.m_off:
            if t - self.burst_start >= c["burst_s"]:
                self.burst_end = t
                self.exit_n = self.exit_low = 0
            self.burst_start = None
        b_hi = B is not None and self.levels is not None and B > lv.b_on
        self.b_above_since = (self.b_above_since if self.b_above_since is not None else t) if b_hi else None
        s_hi = c["use_static"] and S is not None and self.levels is not None and S > lv.s_on
        self.s_above_since = (self.s_above_since if self.s_above_since is not None else t) if s_hi else None
        holding_b = B is not None and self.levels is not None and B > lv.b_off
        holding_s = c["use_static"] and S is not None and self.levels is not None and S > lv.s_off
        recent = self.last_motion is not None and t - self.last_motion <= c["motion_recent_s"]
        if breathing_valid:
            self.breathing_seen = True

        if self.state == "empty":
            if ((self.m_above_since is not None and t - self.m_above_since >= c["enter_motion_s"] - 1e-9)
                    or (self.b_above_since is not None and t - self.b_above_since >= c["b_hold_s"] - 1e-9)
                    or (self.s_above_since is not None and t - self.s_above_since >= c["s_hold_s"] - 1e-9)):
                self._go("present", t)
            return self.state

        if self.state == "uncertain":
            if moving or breathing_valid:
                self._go("present", t)
            return self.state

        # present: exit is judged once per burst. B is a 30 s window, so after someone walks out it
        # stays high for up to 30 s; from then on, exit_quiet_s of mostly-low B means they left.
        # A still person whose B dips long after their last move never gets here: no burst.
        if self.burst_end is not None:
            if moving:
                self.burst_end = None
            else:
                age = t - self.burst_end
                if age >= B_WIN_S:
                    self.exit_n += 1
                    self.exit_low += not holding_b and not holding_s
                if age >= B_WIN_S + c["exit_quiet_s"] - 1e-9:
                    if self.exit_low >= c["exit_share"] * self.exit_n:
                        self._go("empty", t)
                        return self.state
                    self.burst_end = None              # B stayed up: the person is still here
        still_for = t - (self.last_motion if self.last_motion is not None else self.entered)
        if still_for >= c["uncertain_after_s"] and not self.breathing_seen and not recent:
            self._go("uncertain", t)
        return self.state

    def _go(self, state, t):
        was = self.state
        self.state = state
        self.t_state = t
        if state == "present" and was == "empty":
            self.entered = t
            self.breathing_seen = False
            self.burst_end = None
        self.exit_n = self.exit_low = 0
