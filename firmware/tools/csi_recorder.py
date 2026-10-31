"""Record the board's raw CSI stream to a .csirec file and show live stats.

Over USB (any Wi-Fi network; close serial monitors first; needs pyserial):
    python firmware/tools/csi_recorder.py --serial COM3 --seconds 60

Over Wi-Fi (board in station mode on the PC's network; IP from the serial
log, "sta ip: ..."; without --esp the request is broadcast, which some
firewalls block):
    python firmware/tools/csi_recorder.py --esp 192.168.100.111 --seconds 60

Format (docs/plan/plan-v2.md §4.3):
    file   = b"CSIR" + uint16 version=1 + uint16 reserved=0
    record = uint32 len + uint64 host_rx_us + packet[len]
    packet = csi_frame_hdr_t (54 bytes, firmware/src/csi_frame.h) + int8 CSI
Load a recording for analysis with load_csirec() (needs numpy).
"""

import argparse
import base64
import collections
import datetime as dt
import pathlib
import socket
import struct
import sys
import time

STREAM_PORT = 5006
SUBSCRIBE = b"LFSUB"
USB_REQUEST = b"usbstream\n"
USB_PREFIX = b"@CSI "
CSI_MAGIC = 0x31495343
CSIREC_MAGIC = b"CSIR"

# Mirrors csi_frame_hdr_t in firmware/src/csi_frame.h (packed, little-endian)
HDR = struct.Struct("<IHHBBBBBBBBBbbbBB6sBBHfIQIH")
HDR_FIELDS = (
    "magic", "version", "hdr_len", "node_id", "source", "sig_mode", "mcs", "cwb", "stbc",
    "first_word_invalid", "gain_valid", "agc_gain", "fft_gain", "rssi_dbm", "noise_floor_dbm",
    "channel", "secondary_channel", "src_mac", "csi_parts", "csi_shift", "rx_seq", "gain_comp",
    "boot_id", "ts_us", "seq", "n_values",
)
assert HDR.size == 54, HDR.size
RECORD = struct.Struct("<IQ")

# Subcarrier k -> pair index j in one 64-pair LTF block, output order k = -26..-1, +1..+26
LLTF_PAIRS = list(range(38, 64)) + list(range(1, 27))


def parse_frame(packet):
    """Header dict plus the raw int8 CSI bytes, or None if it isn't a v2 CSI frame."""
    if len(packet) < HDR.size:
        return None
    hdr = dict(zip(HDR_FIELDS, HDR.unpack_from(packet)))
    if hdr["magic"] != CSI_MAGIC or hdr["version"] != 2 or hdr["hdr_len"] != HDR.size:
        return None
    data = packet[HDR.size:HDR.size + hdr["n_values"]]
    if len(data) != hdr["n_values"]:
        return None
    hdr["src_mac"] = hdr["src_mac"].hex(":")
    return hdr, data


def lltf_complex(data, first_word_invalid):
    """The 52 LLTF subcarriers as complex numbers, k = -26..-1, +1..+26."""
    out = []
    for j in LLTF_PAIRS:
        im = struct.unpack_from("b", data, 2 * j)[0]
        re = struct.unpack_from("b", data, 2 * j + 1)[0]
        out.append(complex(re, im))
    if first_word_invalid:          # bytes 0..3 (DC and k = +1) are garbage
        out[26] = out[27]
    return out


def iter_csirec(path):
    """Yield (host_rx_us, packet bytes) from a .csirec file."""
    with open(path, "rb") as f:
        head = f.read(8)
        if head[:4] != CSIREC_MAGIC:
            raise ValueError(f"{path} is not a .csirec file")
        while True:
            rec = f.read(RECORD.size)
            if len(rec) < RECORD.size:
                return
            length, host_us = RECORD.unpack(rec)
            packet = f.read(length)
            if len(packet) < length:
                return
            yield host_us, packet


def load_csirec(path):
    """Arrays for analysis: host_us, ts_us, seq, rssi [N], csi [N, 52] complex (LLTF).

    Amplitude is abs(csi), phase np.angle(csi). Phase from a single antenna
    carries a random offset and slope per packet: sanitise it before use.
    """
    import numpy as np

    host, ts, seq, rssi, csi = [], [], [], [], []
    for host_us, packet in iter_csirec(path):
        parsed = parse_frame(packet)
        if parsed is None:
            continue
        hdr, data = parsed
        if not hdr["csi_parts"] & 1 or hdr["cwb"] != 0:
            continue
        host.append(host_us)
        ts.append(hdr["ts_us"])
        seq.append(hdr["seq"])
        rssi.append(hdr["rssi_dbm"])
        csi.append(lltf_complex(data, hdr["first_word_invalid"]))
    return {
        "host_us": np.array(host, dtype=np.uint64),
        "ts_us": np.array(ts, dtype=np.uint64),
        "seq": np.array(seq, dtype=np.uint32),
        "rssi": np.array(rssi, dtype=np.int8),
        "csi": np.array(csi, dtype=np.complex64),
    }


class UdpSource:
    """Frames over Wi-Fi: subscribe with LFSUB, receive UDP datagrams."""

    def __init__(self, esp):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        self.sock.bind(("", 0))
        self.sock.settimeout(0.2)
        self.target = (esp or "255.255.255.255", STREAM_PORT)
        self.name = f"udp {self.target[0]}:{STREAM_PORT}"
        self.hint = "board on the PC's network, station mode?" + ("" if esp else " try --esp <board IP>")

    def request(self):
        self.sock.sendto(SUBSCRIBE, self.target)

    def receive(self):
        try:
            return self.sock.recvfrom(2048)[0]
        except socket.timeout:
            return None

    def close(self):
        self.sock.close()

    def summary(self):
        return ""


class SerialSource:
    """Frames over USB: send `usbstream`, read "@CSI <base64>" lines. Other
    lines are the board's log; errors among them are shown."""

    def __init__(self, port, baud):
        import serial   # pyserial: PlatformIO's Python has it, else pip install pyserial

        self.ser = serial.Serial()
        self.ser.port, self.ser.baudrate, self.ser.timeout = port, baud, 0.05
        self.ser.dtr = self.ser.rts = False   # don't reset the board
        self.ser.open()
        self.name = f"usb {port} @ {baud}"
        self.hint = "right port? board running? try a serial monitor at 921600"
        self.buf = b""
        self.log_lines = self.bad_lines = 0
        self.on_log = None   # optional callback(text) for the board's own log lines

    def request(self):
        self.ser.write(USB_REQUEST)

    def receive(self):
        while b"\n" not in self.buf:
            chunk = self.ser.read(self.ser.in_waiting or 1)
            if not chunk:
                return None
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        line = line.rstrip(b"\r")
        if line.startswith(USB_PREFIX):
            try:
                return base64.b64decode(line[len(USB_PREFIX):], validate=True)
            except ValueError:
                self.bad_lines += 1
                return None
        self.log_lines += 1
        text = line.decode("utf-8", "replace")
        if self.on_log is not None:
            self.on_log(text)
        if text.startswith(("E (", "\x1b[0;31mE (")):
            print(f"  board: {text}", file=sys.stderr)
        return None

    def close(self):
        self.ser.close()

    def summary(self):
        return f", {self.log_lines} board log lines, {self.bad_lines} corrupt CSI lines"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--serial", default=None, help="record over USB from this port (e.g. COM3) instead of Wi-Fi")
    ap.add_argument("--baud", type=int, default=921600, help="USB serial speed (firmware default 921600)")
    ap.add_argument("--esp", default=None, help="board IP for Wi-Fi recording (default: broadcast)")
    ap.add_argument("--seconds", type=float, default=0, help="stop after this long (0 = until Ctrl+C)")
    ap.add_argument("--out", type=pathlib.Path, default=None, help="default firmware/recordings/<time>.csirec")
    args = ap.parse_args()

    recordings = pathlib.Path(__file__).resolve().parents[1] / "recordings"
    out = args.out or recordings / dt.datetime.now().strftime("lifefi-%Y%m%d-%H%M%S.csirec")
    out.parent.mkdir(parents=True, exist_ok=True)

    source = SerialSource(args.serial, args.baud) if args.serial else UdpSource(args.esp)

    start = time.monotonic()
    last_sub = 0.0
    last_report = start
    frames = total = lost = bad = 0
    last_seq = None
    rssi_sum = 0
    types = collections.Counter()
    print(f"recording {source.name} -> {out}  (Ctrl+C to stop)", file=sys.stderr)

    with out.open("wb") as f:
        f.write(CSIREC_MAGIC + struct.pack("<HH", 1, 0))
        try:
            while not args.seconds or time.monotonic() - start < args.seconds:
                now = time.monotonic()
                if now - last_sub >= 1.0:
                    source.request()
                    last_sub = now
                packet = source.receive()
                if packet is not None:
                    host_us = time.time_ns() // 1000
                    parsed = parse_frame(packet)
                    if parsed is None:
                        bad += 1
                    else:
                        hdr, _data = parsed
                        f.write(RECORD.pack(len(packet), host_us) + packet)
                        frames += 1
                        total += 1
                        rssi_sum += hdr["rssi_dbm"]
                        types["HT" if hdr["sig_mode"] else "non-HT"] += 1
                        if last_seq is not None and hdr["seq"] > last_seq + 1:
                            lost += hdr["seq"] - last_seq - 1
                        last_seq = hdr["seq"]
                if now - last_report >= 1.0:
                    if frames:
                        mix = ", ".join(f"{k} {v}" for k, v in sorted(types.items()))
                        print(f"{now - start:6.0f}s  {frames:4d} frames/s  rssi {rssi_sum / frames:5.1f}  "
                              f"lost {lost}  ({mix})", flush=True)
                    elif now - start > 3:
                        print(f"{now - start:6.0f}s  no frames yet ({source.hint})", flush=True)
                    frames = rssi_sum = 0
                    types.clear()
                    last_report = now
        except KeyboardInterrupt:
            pass
    source.close()
    print(f"saved {total} frames to {out} ({lost} lost, {bad} unparsable{source.summary()})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
