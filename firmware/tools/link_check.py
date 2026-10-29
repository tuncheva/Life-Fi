"""Check a board placement: RSSI and CSI pauses over the raw stream.

    python firmware/tools/link_check.py --esp 192.168.100.111 --seconds 60

A "pause" is a second with fewer than 20 CSI frames. On a weak link the
router falls back to 802.11b rates, which carry no CSI, and the stream
pauses for seconds even though the Wi-Fi link stays up. Move the board
(closer to the router, higher, clear line of sight) until it reports
RSSI better than about -60 dBm and 0 pauses.
"""

import argparse
import pathlib
import socket
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from csi_recorder import STREAM_PORT, SUBSCRIBE, parse_frame  # noqa: E402

PAUSE_BELOW = 20


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--esp", required=True, help="board IP (serial log: sta ip)")
    ap.add_argument("--seconds", type=int, default=60)
    args = ap.parse_args()

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("", 0))
    sock.settimeout(0.2)
    start = time.monotonic()
    last_sub = 0.0
    per_sec = [0] * args.seconds
    rssi = []
    while time.monotonic() - start < args.seconds:
        now = time.monotonic()
        if now - last_sub >= 1.0:
            sock.sendto(SUBSCRIBE, (args.esp, STREAM_PORT))
            last_sub = now
        try:
            packet, _ = sock.recvfrom(2048)
        except socket.timeout:
            continue
        parsed = parse_frame(packet)
        if parsed:
            per_sec[min(int(now - start), args.seconds - 1)] += 1
            rssi.append(parsed[0]["rssi_dbm"])

    timeline = "".join("." if n >= PAUSE_BELOW else "X" for n in per_sec)
    pauses = timeline.count("X")
    longest = max((len(r) for r in timeline.split(".")), default=0)
    avg_rssi = sum(rssi) / len(rssi) if rssi else float("nan")
    print(f"timeline (. ok, X pause): {timeline}")
    print(f"frames {sum(per_sec)} ({sum(per_sec) / args.seconds:.0f}/s)  rssi {avg_rssi:.1f} dBm  "
          f"pauses {pauses} s, longest {longest} s")
    if not rssi:
        verdict = "no frames: is the board connected (serial log: wifi CONNECTED)?"
    elif pauses == 0 and avg_rssi > -62:
        verdict = "GOOD placement"
    elif pauses <= 3:
        verdict = "OK, but a stronger signal would help breathing recordings"
    else:
        verdict = "WEAK: move the board closer to the router or raise it"
    print(verdict)
    return 0


if __name__ == "__main__":
    sys.exit(main())
