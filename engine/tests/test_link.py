"""lifefi.link: is the board locked to the fixed Life-Fi transmitter?

    python engine/tests/test_link.py

The parse of rules.yaml position.transmitter_fixed (auto|true|false), the MAC
prefix match, and an Engine fed real v2 frames whose source MAC switches between
a phone hotspot and the Life-Fi transmitter (as on a re-lock).
"""

import pathlib
import sys

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))
sys.path.insert(0, str(ROOT / "engine" / "tests"))
import scenarios  # noqa: E402
from lifefi import link  # noqa: E402
from lifefi.engine import Engine, csi_recorder  # noqa: E402

failures = 0


def check(cond, what):
    global failures
    print(("  ok   " if cond else "  FAIL ") + what)
    failures += 0 if cond else 1


LFTX = "1a:4c:46:54:58:01"
HOTSPOT = "a0:b1:c2:d3:e4:f5"

print("== is_fixed_tx")
check(link.is_fixed_tx(LFTX), "Life-Fi TX, lower case")
check(link.is_fixed_tx(LFTX.upper()), "Life-Fi TX, upper case")
check(not link.is_fixed_tx(None), "None: not fixed")
check(not link.is_fixed_tx(HOTSPOT), "hotspot MAC: not fixed")
check(not link.is_fixed_tx("1a:4c:46:54"), "truncated prefix: not fixed")
check(not link.is_fixed_tx("1a:4c:46:54:58"), "prefix without the last byte: not fixed")

print("== transmitter_fixed(setting, mac)")
check(link.transmitter_fixed(True, HOTSPOT) is True, "true forces fixed")
check(link.transmitter_fixed(False, LFTX) is False, "false forces not fixed")
for s in ("auto", None, "true", 1, "junk"):
    check(link.transmitter_fixed(s, LFTX) is True and link.transmitter_fixed(s, HOTSPOT) is False,
          f"{s!r} means auto")
y = yaml.safe_load("a: auto\nb: true\nc: false\nd: yes")
check([link.transmitter_fixed(y[k], HOTSPOT) for k in "abcd"] == [False, True, False, True], "YAML auto/true/false/yes round trip")

print("== engine: hotspot -> Life-Fi TX -> hotspot")
SRC_MAC = csi_recorder.HDR_FIELDS.index("src_mac")


def with_mac(packet, mac):
    """The same frame with its 6 source MAC bytes replaced (header repacked through csi_recorder.HDR)."""
    f = list(csi_recorder.HDR.unpack_from(packet))
    f[SRC_MAC] = bytes.fromhex(mac.replace(":", ""))
    return csi_recorder.HDR.pack(*f) + packet[csi_recorder.HDR.size:]


ts, csi, _ = scenarios.scenario("empty")
frames = list(scenarios.frames(ts[:900], csi[:900]))
eng = Engine()
check(eng.position.transmitter_fixed is False and eng.status(0.0)["device"] is None, "before the first frame: not fixed, no device")


def phase(mac, part):
    for host_us, pkt in frames[part * 300:(part + 1) * 300]:
        eng.feed(with_mac(pkt, mac), host_us)
    reasons = eng.position.quality(True, 90.0)["quality_reasons"]
    return eng.position.transmitter_fixed, "transmitter_not_fixed" in reasons, eng.status(frames[0][0] / 1e6)["device"]


fixed, flagged, dev = phase(HOTSPOT, 0)
check(not fixed and flagged and dev["transmitter"] == "other" and dev["src_mac"] == HOTSPOT, "hotspot: not fixed, transmitter_not_fixed")
fixed, flagged, dev = phase(LFTX, 1)
check(fixed and not flagged and dev["transmitter"] == "fixed" and dev["src_mac"] == LFTX, "Life-Fi TX: fixed, reason gone")
fixed, flagged, dev = phase(HOTSPOT, 2)
check(not fixed and flagged and dev["transmitter"] == "other", "back to the hotspot (mixed stream): not fixed again")

print("== engine: rules force false")
eng = Engine()
eng.rules["position"]["transmitter_fixed"] = False
fixed, flagged, dev = phase(LFTX, 1)
check(not fixed and flagged and dev["transmitter"] == "fixed", "forced false: Life-Fi TX frames stay not fixed (device still says fixed)")

print(f"\ntest_link {'FAILED' if failures else 'PASSED'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
