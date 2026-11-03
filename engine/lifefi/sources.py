"""Where the engine's frames come from: the board, live, or a .csirec, replayed.

Both run in a thread and call push(packet, host_us, source) for every
frame; lifefi.control drains them into the engine. The live side reuses
firmware/tools/csi_recorder.py's two transports (USB serial "@CSI" lines,
or UDP after an LFSUB subscribe), so the engine reads the board exactly
as the recorder does.

`serial="auto"` picks the board's USB serial port by itself. A live
source that cannot read the board (no port, port busy, cable pulled)
keeps its error in `error`, sets `state = "error"` and tries again every
RETRY_S, so plugging the board back in recovers without a restart.

Replay re-stamps each frame with the current host time, keeping the
recording's spacing (divided by `speed`; the ESP clock in the header is
scaled the same way, so breathing reads `speed` x faster). Each loop gets
a new boot_id, so the engine resets its clock and warms up as after a
real reboot.
"""

import pathlib
import re
import sys
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "firmware" / "tools"))
import csi_recorder  # noqa: E402

RETRY_S = 2.0
# USB-serial bridges on ESP32 boards: Silicon Labs CP210x, WCH CH340/CH9102, Espressif USB-JTAG, FTDI
BOARD_VIDS = {0x10C4, 0x1A86, 0x303A, 0x0403}

TS = csi_recorder.HDR_FIELDS.index("ts_us")
BOOT = csi_recorder.HDR_FIELDS.index("boot_id")


class _Thread:
    file, speed, loop = None, 1.0, False

    def __init__(self):
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self.error = None
        self.state = "running"

    def start(self):
        self._thread.start()
        return self

    def stop(self):
        self._stop.set()
        self._thread.join(timeout=2.0)

    def _run(self):
        try:
            self.run()
        except Exception as err:                     # shown in get_status (source_info), never kills the engine
            self.error = f"{type(err).__name__}: {err}"
            self.state = "error"

    def info(self):
        """get_status engine.source_info (contracts/control.md)."""
        return {"name": self.name, "state": self.state, "file": None if self.file is None else str(self.file),
                "speed": self.speed, "loop": self.loop, "error": self.error}


def find_board_port():
    """The one USB serial port that looks like an ESP32 board; ValueError saying why if not exactly one."""
    from serial.tools import list_ports

    ports = sorted(p.device for p in list_ports.comports() if p.vid in BOARD_VIDS)
    if not ports:
        raise ValueError("no USB serial port found: is the board plugged in?")
    if len(ports) > 1:
        raise ValueError(f"several USB serial ports ({', '.join(ports)}): start the engine with --serial <port>")
    return ports[0]


# The firmware's once-a-second estimator line (firmware/src/estimator.c):
#   I (12345) lifefi: t=   12s rate= 98Hz ... | PRESENT   people=1 (est)
BOARD_LINE = re.compile(r"\|\s*([A-Z_]+)\s+people=(\S+)")


# Board warnings that explain why no CSI arrives (firmware/src/main.c, estimator.c).
NO_AP = re.compile(r"link: disconnected \(reason (\d+)\)")
REASONS = {201: "Wi-Fi network not found", 15: "Wi-Fi password rejected", 2: "Wi-Fi authentication expired",
           8: "left the Wi-Fi network", 200: "Wi-Fi beacon timeout", 202: "Wi-Fi authentication failed"}
NO_CSI_S = 3.0               # this long without a CSI packet and the board's own reason is shown


def parse_board_note(text):
    """A short reason from a board warning that explains missing CSI, else None."""
    text = re.sub(r"\x1b\[[0-9;]*m", "", text)
    m = NO_AP.search(text)
    if m:
        code = int(m.group(1))
        return f"board: {REASONS.get(code, 'Wi-Fi disconnected')} (reason {code}), no CSI"
    if "waiting for the transmitter" in text:
        return "board: connected but no CSI packets, waiting for the transmitter"
    return None


def parse_board_line(text):
    """{"state": "present", "people": 1 | None} from an estimator log line, else None."""
    text = re.sub(r"\x1b\[[0-9;]*m", "", text)      # ESP_LOG colours
    m = BOARD_LINE.search(text)
    if m is None or " lifefi: t=" not in text:
        return None
    people = m.group(2).rstrip("+")
    return {"state": m.group(1).lower(), "people": int(people) if people.isdigit() else None}


class LiveSource(_Thread):
    def __init__(self, push, serial=None, baud=921600, esp=None):
        super().__init__()
        self.push = push
        self.args = (serial, baud, esp)
        self.name = f"usb {serial}" if serial else f"udp {esp or 'broadcast'}"
        self.board = None                            # the board's own estimate, from its USB log: {state, people, t}
        self.note = None                             # (monotonic s, text): the board's last reason for missing CSI
        self.last_packet = 0.0                       # monotonic s of the last CSI packet

    def _board_line(self, text):
        est = parse_board_line(text)
        if est is not None:
            self.board = {**est, "t": time.time()}   # one assignment: safe to read from the engine thread
            return
        note = parse_board_note(text)
        if note is not None:
            # "network not found" says more than the "waiting" line that follows it every second
            if self.note is None or "waiting" not in note or time.monotonic() - self.note[0] > 5.0:
                self.note = (time.monotonic(), note)

    def info(self):
        """As _Thread.info, but a port that is open with no CSI coming says why, in the board's words."""
        out = super().info()
        now = time.monotonic()
        if out["state"] == "running" and self.note is not None and now - self.last_packet > NO_CSI_S and now - self.note[0] < 10.0:
            out["state"], out["error"] = "error", self.note[1]
        return out

    def run(self):
        while not self._stop.is_set():
            try:
                self._read()
            except Exception as err:                 # no port, port busy, cable pulled: say so and try again
                self.error = f"{err}" if isinstance(err, ValueError) else f"{type(err).__name__}: {err}"
                self.state = "error"
                self._stop.wait(RETRY_S)

    def _read(self):
        serial, baud, esp = self.args
        if serial == "auto":
            serial = find_board_port()
        src = csi_recorder.SerialSource(serial, baud) if serial else csi_recorder.UdpSource(esp)
        if serial:
            src.on_log = self._board_line
        self.name = f"usb {serial}" if serial else f"udp {esp or 'broadcast'}"
        self.state, self.error = "running", None
        last_sub = 0.0
        try:
            while not self._stop.is_set():
                now = time.monotonic()
                if now - last_sub >= 1.0:              # the board stops streaming without it
                    src.request()
                    last_sub = now
                packet = src.receive()
                if packet is not None:
                    self.last_packet = time.monotonic()
                    self.push(packet, time.time_ns() // 1000, "live")
        finally:
            src.close()


class ReplaySource(_Thread):
    def __init__(self, push, path, speed=1.0, loop=False):
        super().__init__()
        self.path = pathlib.Path(path)
        if not self.path.exists():
            raise ValueError(f"replay file not found: {self.path}")
        if speed <= 0:
            raise ValueError("speed must be > 0")
        self.push, self.speed, self.loop = push, float(speed), bool(loop)
        self.file = self.path
        self.name = f"replay {self.path.name} x{self.speed:g}" + (" loop" if loop else "")
        self.finished = False

    def run(self):
        n = 0
        while not self._stop.is_set():
            start = time.time()
            h0 = ts0 = None
            for host_us, packet in csi_recorder.iter_csirec(self.path):
                if self._stop.is_set():
                    return
                parsed = csi_recorder.parse_frame(packet)
                if parsed is not None:
                    vals = list(csi_recorder.HDR.unpack_from(packet))
                    ts0 = vals[TS] if ts0 is None else ts0
                    vals[TS] = ts0 + int((vals[TS] - ts0) / self.speed)
                    vals[BOOT] = (vals[BOOT] + n) & 0xFFFFFFFF
                    packet = csi_recorder.HDR.pack(*vals) + packet[csi_recorder.HDR.size:]
                h0 = host_us if h0 is None else h0
                due = start + (host_us - h0) / 1e6 / self.speed
                wait = due - time.time()
                if wait > 0:
                    self._stop.wait(wait)
                self.push(packet, time.time_ns() // 1000, "replay")
            n += 1
            if not self.loop:
                self.finished = True
                self.state = "finished"
                return
