"""Distance of the moving/breathing body from the link, live (experimental).

A port of engine/viz/position.html (the offline 3D view) to the engine:

1. every STEP_S, over the last WIN_S of raw packets, the per-subcarrier
   gain-free dB (20·log10(|csi|+1) minus the frame mean, as the page does);
2. P = variance of BIN_S bin means around a linear trend, minus the white
   noise N left in a bin mean (from neighbour differences), mean over the
   52 subcarriers: the body disturbance in dB²;
3. R = 10·log10(P) and d = 10^((A − R) / (10·n)), clamped to D_MIN..D_MAX,
   when P stands above the noise (PRESENT_SNR);
4. a constant-velocity Kalman filter on d, reset after a pause.

The empty-room calibration gives the room's own disturbance (Wi-Fi
flicker, the router's traffic): its median is subtracted from P, and
only P above its 95th percentile counts as a body. Without one, only
the white noise is removed and an empty room can read as someone close.

A (the disturbance at 1 m) depends on the board, the router and the
room. `fit(d_m, t0, t1)` sets it from someone moving at a measured
distance: A = R + 10·n·log10(d). The engine saves it (position_fit).

Standing still lowers the disturbance, which would read as walking away.
So the distance is only measured while someone moves (the engine's motion,
or the disturbance of the last FAST_S standing above the room's gate,
which breathing in place does not reach); while the
person stays (still, but present) the last measured distance is held, and
it is dropped when they leave. Without a calibration the floor and gate
come from the last 10 minutes of P itself (its P10 and P30): best effort,
so nobody has to calibrate.

One link has no direction: d is a radius around the board, and movement
raises R as much as closeness does (engine/README.md "3D position view").
A and n are guesses until someone calibrates them for the room.
"""

import os
from collections import deque

import numpy as np

WIN_S, STEP_S, BIN_S, MAX_GAP_S, MIN_FRAMES = 10.0, 1.0, 0.25, 1.0, 200
PRESENT_SNR, D_MIN, D_MAX = 1.0, 0.2, 8.0
HIST_S = 600.0               # P kept this long, so a calibration can take its levels from it
AUTO_MIN = 60                # P values needed before the rolling floor is trusted
HOLD_S = 20.0                # still and nothing above the gate this long (and not "present"): gone
FAST_S, FAST_MIN = 2.0, 40   # the quick movement check: disturbance of the last 2 s (40 packets: 20 Hz)
FAST_X = 10.0                # moving above 10 x the gate: live 2026-10-31, still 0-0.03, sway 0.1-0.4, walking 1-8 (gate 0.05)
DEBUG = bool(os.environ.get("LIFEFI_POS_DEBUG"))
# fitted at 2 m on the development board (2026-10-31, position_fit); a saved fit overrides it
A_DEFAULT, N_DEFAULT = 16.1, 2.0
ZONES = ((1.5, "near"), (3.5, "middle"), (np.inf, "far"))


def zone_of(d):
    """near < 1.5 m, middle 1.5..3.5 m, far beyond; None without a distance."""
    if d is None:
        return None
    return next(name for top, name in ZONES if d < top)


def gain_free_db(amp):
    """|csi| [N, 52] -> dB with the per-frame mean removed (AGC steps cancel)."""
    x = 20.0 * np.log10(np.asarray(amp, np.float64) + 1.0)
    return x - x.mean(axis=1, keepdims=True)


def disturbance(t, x, win=WIN_S, min_frames=MIN_FRAMES):
    """(P, N) in dB² for one window of packets (t s [n], x gain-free dB [n, 52]), or None."""
    n = len(t)
    if n < min_frames or np.max(np.diff(t)) > MAX_GAP_S:
        return None
    nb = int(round(win / BIN_S))
    k = np.minimum(nb - 1, ((t - t[0]) / BIN_S).astype(int))
    cnt = np.bincount(k, minlength=nb).astype(np.float64)
    sums = np.zeros((nb, x.shape[1]))
    np.add.at(sums, k, x)
    used = cnt > 0
    ks = np.nonzero(used)[0].astype(np.float64)
    means = sums[used] / cnt[used][:, None]
    # variance around a linear trend, per subcarrier
    kc = ks - ks.mean()
    yc = means - means.mean(axis=0)
    slope = (kc[:, None] * yc).sum(axis=0) / max((kc ** 2).sum(), 1e-12)
    V = ((yc - slope * kc[:, None]) ** 2).mean(axis=0)
    # white noise per frame from neighbour differences, as left in a bin mean
    inv_cnt = (1.0 / cnt[used]).mean()
    Nv = (np.diff(x, axis=0) ** 2).sum(axis=0) / (n - 1) / 2.0 * inv_cnt
    N = float(Nv.mean())
    return max(0.0, float(V.mean()) - N), N


class Position:
    """Feeds on the raw packet buffer; `update(now, t, amp)` returns the published dict or None."""

    def __init__(self, A=A_DEFAULT, n=N_DEFAULT, floor=0.0, gate=None):
        self.A, self.n = A, n
        self.floor, self.gate = floor, gate          # empty-room P50 (subtracted) and P95 (to exceed)
        self.hist = deque()                          # (now, P) per update, for the calibration
        self.next_at = -np.inf
        self.out = None
        self.x = None                                # Kalman state [d, v]
        self.P = None
        self.last_above = -np.inf                    # last time P stood above the gate

    def levels_now(self):
        """(floor, gate) in use: the calibration's, else the rolling P10 / P30 of P, else (0, None)."""
        if self.gate is not None:
            return self.floor, self.gate
        if len(self.hist) >= AUTO_MIN:
            Ps = np.fromiter((P for _, P in self.hist), float, len(self.hist))
            return float(np.percentile(Ps, 10)), float(np.percentile(Ps, 30))
        return self.floor, None

    def calibrate(self, p50, p95):
        """The empty room's disturbance levels (None, None: white noise only)."""
        self.floor = 0.0 if p50 is None else float(p50)
        self.gate = None if p95 is None else float(p95)

    def levels(self, t0, t1):
        """(P50, P95) of the P computed from windows wholly inside [t0, t1], or (None, None) if under 10."""
        Ps = [P for t, P in self.hist if t0 + WIN_S <= t <= t1]
        if len(Ps) < 10:
            return None, None
        return float(np.percentile(Ps, 50)), float(np.percentile(Ps, 95))

    def fit(self, d_m, t0, t1):
        """Sets A from someone moving d_m from the board during [t0, t1]; ValueError if too little was seen."""
        if not 0.3 <= d_m <= D_MAX:
            raise ValueError(f"distance must be 0.3 to {D_MAX:.0f} m")
        Ps = [P for t, P in self.hist if t0 + WIN_S / 2 <= t <= t1]
        floor, gate = self.levels_now()
        body = [P - floor for P in Ps if gate is None or P > gate]
        if len(body) < 5:
            raise ValueError(f"only {len(body)} s with movement above the empty room: move around at the spot and try again")
        R = 10.0 * np.log10(max(float(np.median(body)), 1e-4))
        self.A = R + 10.0 * self.n * np.log10(d_m)
        self.x = self.P = None                       # the old track was on the old scale
        return {"A": round(float(self.A), 2), "n": self.n, "R_db": round(float(R), 2), "windows": len(body)}

    def reset(self):
        self.next_at = -np.inf
        self.out = None
        self.x = self.P = None
        self.last_above = -np.inf

    def to_distance(self, R):
        return float(np.clip(10 ** ((self.A - R) / (10 * self.n)), D_MIN, D_MAX))

    def update(self, now, t, amp, moving=True, present=None):
        """moving: the engine sees motion now; present: its presence (True / False / None = unknown)."""
        if now < self.next_at:
            return self.out
        self.next_at = now + STEP_S
        if len(t) == 0 or t[-1] - t[0] < WIN_S * 0.9:
            self.out = None
            return None
        k = int(np.searchsorted(t, t[-1] - WIN_S))
        tw, xw = t[k:], gain_free_db(amp[k:])
        r = disturbance(tw, xw)
        if r is None:
            self.x = None
            self.out = None
            return None
        P, N = r
        self.hist.append((now, P))
        while self.hist and self.hist[0][0] < now - HIST_S:
            self.hist.popleft()
        floor, gate = self.levels_now()
        body = max(1e-4, P - floor)
        R = 10.0 * np.log10(body)
        above = body >= PRESENT_SNR * N and (gate is None or P > gate)
        if above:
            self.last_above = now
        kf = int(np.searchsorted(tw, tw[-1] - FAST_S))
        fast = disturbance(tw[kf:], xw[kf:], FAST_S, FAST_MIN)
        fast_moving = fast is not None and gate is not None and fast[0] > FAST_X * gate
        if DEBUG:
            print(f"position P={P:.3g} fast={fast[0] if fast else float('nan'):.3g} gate={gate if gate is not None else float('nan'):.3g} "
                  f"above={above} engine_moving={moving} fast_moving={fast_moving} present={present}", flush=True)
        moving = moving or fast_moving
        held = False
        if present is False and not above:          # empty by the engine and by the link: nobody to place
            ds, sd = self._smooth(None)
        elif above and moving:                       # a real measurement (the link outvotes presence)
            ds, sd = self._smooth(self.to_distance(R))
        elif self.x is not None and (present is True or now - self.last_above <= HOLD_S):
            self.x[1] = 0.0                          # still: hold the last measured distance
            ds, sd, held = float(np.clip(self.x[0], D_MIN, D_MAX)), float(np.sqrt(max(self.P[0, 0], 0.0))), True
        else:
            ds, sd = self._smooth(None)
        self.out = {
            "valid": ds is not None,
            "d_m": round(ds, 2) if ds is not None else None,
            "d_sd": round(sd, 2) if sd is not None else None,
            "R_db": round(float(R), 2),
            "noise_db": round(float(10.0 * np.log10(max(N, 1e-6))), 2),
            "held": held,
            "zone": zone_of(ds),
        }
        return self.out

    def _smooth(self, d):
        """Constant-velocity Kalman filter on d (as position.html); (d, sd) or (None, None)."""
        if d is None:
            self.x = None
            return None, None
        q, r, dt = 0.05, 0.3, STEP_S
        if self.x is None:
            self.x = np.array([d, 0.0])
            self.P = np.eye(2)
            return d, 1.0
        F = np.array([[1.0, dt], [0.0, 1.0]])
        Q = q * np.array([[dt ** 3 / 3, dt ** 2 / 2], [dt ** 2 / 2, dt]])
        self.x = F @ self.x
        self.P = F @ self.P @ F.T + Q
        S = self.P[0, 0] + r
        K = self.P[:, 0] / S
        self.x = self.x + K * (d - self.x[0])
        self.P = self.P - np.outer(K, self.P[0, :])
        return float(np.clip(self.x[0], D_MIN, D_MAX)), float(np.sqrt(max(self.P[0, 0], 0.0)))
