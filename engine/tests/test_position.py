"""lifefi.position: the live distance estimate, and the board's log line parsers.

    python engine/tests/test_position.py

The disturbance R must rise from an empty room to a breathing person to
someone moving; a moving person must come out closer than a still one
(R up means d down); a pause must reset the estimate.
"""

import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from lifefi import position  # noqa: E402
from lifefi.sources import parse_board_line, parse_board_note  # noqa: E402
from lifefi.synth import synth  # noqa: E402

failures = 0


def check(cond, what):
    global failures
    print(("  ok   " if cond else "  FAIL ") + what)
    failures += 0 if cond else 1


def run(**kw):
    """The last published estimate after feeding 20 s of synthetic packets."""
    ts, csi = synth(20, seed=4, agc=False, **kw)
    t = ts / 1e6
    p = position.Position()
    out = None
    for now in np.arange(t[0] + 1.0, t[-1], 0.5):
        k = int(np.searchsorted(t, now, side="right"))
        out = p.update(now, t[:k], np.abs(csi[:k]))
    return out


empty = run()
still = run(bpm=15, breath_db=1.0)
moving = run(motion=True)
check(empty is not None and still is not None and moving is not None, "an estimate once 10 s of packets are in")
print(f"       R empty {empty['R_db']:.1f}  breathing {still['R_db']:.1f}  moving {moving['R_db']:.1f} dB")
check(still["R_db"] > empty["R_db"], "breathing disturbs the link more than an empty room")
check(moving["R_db"] > still["R_db"], "moving disturbs it more than breathing")
check(moving["valid"] and moving["d_m"] is not None, "a moving person gets a distance")
check(not still["valid"] or moving["d_m"] <= still["d_m"], "more disturbance reads as closer")
check(moving["valid"] and position.D_MIN <= moving["d_m"] <= position.D_MAX, "distance inside 0.2..8 m")

# the empty-room calibration: its P50 is subtracted, P must exceed its P95
def levels_of(**kw):
    ts, csi = synth(60, seed=5, agc=False, **kw)
    t = ts / 1e6
    p = position.Position()
    for now in np.arange(t[0] + 1.0, t[-1], 0.5):
        k = int(np.searchsorted(t, now, side="right"))
        p.update(now, t[:k], np.abs(csi[:k]))
    return p.levels(t[0], t[-1])


p50, p95 = levels_of()
check(p50 is not None and p95 >= p50, f"empty-room levels from 60 s (P50 {p50:.3g}, P95 {p95:.3g})")
ts, csi = synth(20, seed=6, agc=False)
t = ts / 1e6
cal = position.Position()
cal.calibrate(p50, p95)
outs = []
for now in np.arange(t[0] + 1.0, t[-1], 0.5):
    k = int(np.searchsorted(t, now, side="right"))
    outs.append(cal.update(now, t[:k], np.abs(csi[:k])))
valid = [o["valid"] for o in outs if o is not None]
check(valid and sum(valid) <= 0.1 * len(valid), f"a calibrated empty room reads no distance ({sum(valid)}/{len(valid)} windows)")
ts, csi = synth(20, motion=True, seed=6, agc=False)
t = ts / 1e6
cal = position.Position()
cal.calibrate(p50, p95)
out = None
for now in np.arange(t[0] + 1.0, t[-1], 0.5):
    k = int(np.searchsorted(t, now, side="right"))
    out = cal.update(now, t[:k], np.abs(csi[:k]))
check(out is not None and out["valid"], "someone moving still gets a distance after calibration")

# fitting A at a measured distance: the same disturbance then reads as that distance
fit = position.Position()
fit.calibrate(p50, p95)
ts, csi = synth(30, motion=True, seed=7, agc=False)
t = ts / 1e6
for now in np.arange(t[0] + 1.0, t[-1], 0.5):
    k = int(np.searchsorted(t, now, side="right"))
    fit.update(now, t[:k], np.abs(csi[:k]))
got = fit.fit(2.0, t[0], t[-1])
check(got["windows"] >= 5, f"fit uses the moving windows ({got})")
check(abs(fit.to_distance(got["R_db"]) - 2.0) < 0.01, "after the fit, the measured disturbance reads 2 m")
try:
    position.Position().fit(2.0, 0.0, 1.0)
    check(False, "a fit with nothing seen is refused")
except ValueError:
    check(True, "a fit with nothing seen is refused")

# still after moving: the distance is held, not read as "far"; leaving drops it
def feed(p, seconds, seed, moving, present, t_off=0.0, **kw):
    ts, csi = synth(seconds, seed=seed, agc=False, **kw)
    t = ts / 1e6 + t_off
    out = None
    for now in np.arange(t[0] + 1.0, t[-1], 0.5):
        k = int(np.searchsorted(t, now, side="right"))
        out = p.update(now, t[:k], np.abs(csi[:k]), moving=moving, present=present)
    return out


hold = position.Position()
hold.calibrate(p50, p95)
walked = feed(hold, 20, 8, True, True, motion=True)
still = feed(hold, 20, 9, False, True, t_off=1000.0)   # present, not moving (live still levels: FAST_X)
check(walked["valid"] and not walked["held"], f"walking is measured ({walked['d_m']} m)")
check(still["valid"] and still["held"] and still["d_m"] == walked["d_m"], f"standing still holds {still['d_m']} m")
gone = feed(hold, 20, 10, False, False, t_off=2000.0)
check(gone is not None and not gone["valid"], "an empty room drops the held distance")

# no calibration: after enough P, the rolling floor stops an empty room from reading as someone
auto = position.Position()
ts, csi = synth(90, seed=11, agc=False)
t = ts / 1e6
outs = []
for now in np.arange(t[0] + 1.0, t[-1], 0.5):
    k = int(np.searchsorted(t, now, side="right"))
    outs.append(auto.update(now, t[:k], np.abs(csi[:k]), moving=False, present=None))
late = [o["valid"] for o in outs[-40:] if o is not None]
check(auto.levels_now()[1] is not None, "a rolling gate without calibration")
check(late and sum(late) <= 0.2 * len(late), f"an uncalibrated empty room settles to no distance ({sum(late)}/{len(late)})")

check([position.zone_of(d) for d in (0.8, 2.0, 5.0, None)] == ["near", "middle", "far", None], "zones near / middle / far")

# a pause longer than MAX_GAP_S inside the window: no estimate
ts, csi = synth(20, motion=True, gap=(12, 14), seed=4, agc=False)
t = ts / 1e6
p = position.Position()
out = p.update(t[-1], t, np.abs(csi))
check(out is None, "a Wi-Fi pause in the window gives no estimate")

# the firmware's once-a-second estimator line
line = "I (123456) lifefi: t=  123s rate= 98Hz rssi= -52 motion= 0.31 active= 12% dev=0.0123 score= 1.20 | PRESENT   people=1 (est)"
check(parse_board_line(line) == {"state": "present", "people": 1}, "present, 1 person")
check(parse_board_line("\x1b[0;32m" + line.replace("people=1 (est)", "people=2+") + "\x1b[0m") == {"state": "present", "people": 2}, "colours stripped, 2+ -> 2")
check(parse_board_line(line.replace("PRESENT  ", "EMPTY    ").replace("people=1 (est)", "people=?")) == {"state": "empty", "people": None}, "empty, unknown count")
check(parse_board_line("I (99) lifefi: presence: EMPTY -> PRESENT (motion)") is None, "other log lines are ignored")
check(parse_board_note("W (4041685) link: disconnected (reason 201), reconnecting") == "board: Wi-Fi network not found (reason 201), no CSI", "no-AP warning becomes a reason")
check(parse_board_note("W (4040792) lifefi: t= 4040s only 0 CSI packets in the last second, waiting for the transmitter") is not None, "waiting-for-transmitter warning becomes a reason")
check(parse_board_note("I (4048797) main: wifi CONNECTED to \"x\"") is None, "a healthy line is no reason")

print(f"\ntest_position {'PASSED' if not failures else 'FAILED'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
