"""Where the engine's frames come from: the board, live, or a .csirec, replayed.

Both run in a thread and call push(packet, host_us, source) for every
frame; lifefi.control drains them into the engine. The live side reuses
firmware/tools/csi_recorder.py's two transports (USB serial "@CSI" lines,
or UDP after an LFSUB subscribe), so the engine reads the board exactly
as the recorder does.

Replay re-stamps each frame with the current host time, keeping the
recording's spacing (divided by `speed`; the ESP clock in the header is
scaled the same way, so breathing reads `speed` x faster). Each loop gets
a new boot_id, so the engine resets its clock and warms up as after a
real reboot.
"""

import pathlib
import sys
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "firmware" / "tools"))
import csi_recorder  # noqa: E402

TS = csi_recorder.HDR_FIELDS.index("ts_us")
BOOT = csi_recorder.HDR_FIELDS.index("boot_id")


class _Thread:
    def __init__(self):
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self.error = None

    def start(self):
        self._thread.start()
        return self

    def stop(self):
        self._stop.set()
        self._thread.join(timeout=2.0)

    def _run(self):
        try:
            self.run()
        except Exception as err:                     # shown in get_status / the log, never kills the engine
            self.error = f"{type(err).__name__}: {err}"


class LiveSource(_Thread):
    def __init__(self, push, serial=None, baud=921600, esp=None):
        super().__init__()
        self.push = push
        self.args = (serial, baud, esp)
        self.name = f"usb {serial}" if serial else f"udp {esp or 'broadcast'}"

    def run(self):
        serial, baud, esp = self.args
        src = csi_recorder.SerialSource(serial, baud) if serial else csi_recorder.UdpSource(esp)
        last_sub = 0.0
        try:
            while not self._stop.is_set():
                now = time.monotonic()
                if now - last_sub >= 1.0:              # the board stops streaming without it
                    src.request()
                    last_sub = now
                packet = src.receive()
                if packet is not None:
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
        self.push, self.speed, self.loop = push, float(speed), loop
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
                return
