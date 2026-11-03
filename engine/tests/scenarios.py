"""Synthetic board recordings for the engine tests only (plan-v2 §6.12).

Every packet is a real csi_frame_hdr_t v2 frame (firmware/src/csi_frame.h)
with the LLTF bytes the board would send, built from lifefi.synth, so the
whole engine path (parsing, clock, F, rules) runs on it. Test input only:
never for the dashboard, training or evaluation. The app reads the board
over USB (engine/run.py --serial auto).

Each scenario starts with SETUP_S of an empty room, for a 2-min
calibration (send `calibrate` in the first seconds), then:

| Scenario | After the empty start |
|---|---|
| empty | nothing: the room stays empty |
| sitting | walks in, sits breathing 15 /min |
| fall | walks in, sits, a hard impact, then lies still breathing |
| breath_hold | walks in, sits breathing, holds the breath 25 s, breathes again |
| leave | walks in, sits breathing, walks out, the room is empty again |
"""

import pathlib
import struct
import sys

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))
sys.path.insert(0, str(ROOT / "firmware" / "tools"))
import csi_recorder  # noqa: E402
from lifefi.synth import synth  # noqa: E402

SETUP_S = 130.0
ENTER = (SETUP_S, SETUP_S + 5.0)
SCALE = 0.6                                  # int8 headroom for the impact
# scenario -> (seconds, synth arguments beyond the empty start, expected events / states for the tests)
SCENARIOS = {
    "empty": (200.0, {}, {}),
    "sitting": (260.0, {"moving": [ENTER]}, {"present_after": ENTER[0] + 2}),
    "fall": (300.0, {"moving": [ENTER], "bursts": [(200.0, 200.6)]},
             {"present_after": ENTER[0] + 2, "fall_at": (201.0, 210.0), "fainted_at": (221.0, 232.0)}),
    "breath_hold": (280.0, {"moving": [ENTER], "breath_off_extra": [(200.0, 225.0)]},
                    {"present_after": ENTER[0] + 2, "no_breathing_at": (205.0, 222.0), "cleared_by": 240.0}),
    "leave": (330.0, {"moving": [ENTER, (200.0, 205.0)], "breath_off_extra": [(205.0, 1e9)]},
              {"present_after": ENTER[0] + 2, "empty_at": (240.0, 305.0)}),
}


def scenario(name, seed=1):
    """(ts_us [N], csi [N, 52], expectations) for one scenario."""
    seconds, extra, expect = SCENARIOS[name]
    extra = dict(extra)
    off = [(0.0, ENTER[1])] + extra.pop("breath_off_extra", [])
    bpm = None if name == "empty" else 15
    ts_us, csi = synth(seconds, bpm=bpm, seed=seed, agc=False, breath_off=off if bpm else None, **extra)
    return ts_us, csi * SCALE, expect


def frames(ts_us, csi, boot_id=0x5EED, host_start_us=1_767_225_600_000_000, uptime_us=5_000_000, seed=0):
    """(host_rx_us, packet bytes) per packet, as csi_recorder receives them."""
    rng = np.random.default_rng(seed)
    pairs = np.zeros((64, 2), np.int8)
    idx = np.array(csi_recorder.LLTF_PAIRS)
    for i, (t, c) in enumerate(zip(ts_us, csi)):
        pairs[idx, 0] = np.clip(np.round(c.imag), -127, 127)
        pairs[idx, 1] = np.clip(np.round(c.real), -127, 127)
        data = pairs.tobytes()
        ts = int(t) + uptime_us
        hdr = csi_recorder.HDR.pack(csi_recorder.CSI_MAGIC, 2, csi_recorder.HDR.size, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0,
                                    -50, -95, 6, 0, bytes.fromhex("a0b1c2d3e4f5"), 1, 0, i % 4096, 1.0,
                                    boot_id, ts, i, len(data))
        yield host_start_us + int(t) + int(rng.uniform(500, 3000)), hdr + data


def write(path, ts_us, csi, **kw):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with open(path, "wb") as fh:
        fh.write(csi_recorder.CSIREC_MAGIC + struct.pack("<HH", 1, 0))
        for host_us, packet in frames(ts_us, csi, **kw):
            fh.write(csi_recorder.RECORD.pack(len(packet), host_us) + packet)
            n += 1
    return n

