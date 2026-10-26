"""Log the firmware console to the terminal and a file, with host timestamps.

    python firmware/tools/serial_log.py COM5                       # until Ctrl+C
    python firmware/tools/serial_log.py COM5 --seconds 90 --reset
    python firmware/tools/serial_log.py COM5 --send "learn 2" --send-after 5

Uses pyserial (bundled with PlatformIO: ~/.platformio/penv/Scripts/python.exe).
"""

import argparse
import datetime as dt
import pathlib
import re
import sys
import time

import serial

ANSI = re.compile(r"\x1b\[[0-9;]*m")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("port", help="serial port, e.g. COM5 or /dev/ttyUSB0")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--seconds", type=float, default=0, help="stop after this long (0 = until Ctrl+C)")
    ap.add_argument("--reset", action="store_true", help="reset the board on open (EN via RTS)")
    ap.add_argument("--send", action="append", default=[], help="command to type into the console")
    ap.add_argument("--send-after", type=float, default=3, help="seconds before sending --send commands")
    ap.add_argument("--out", type=pathlib.Path, default=None, help="log file (default logs/<time>.log)")
    args = ap.parse_args()

    out = args.out or pathlib.Path("logs") / dt.datetime.now().strftime("lifefi-%Y%m%d-%H%M%S.log")
    out.parent.mkdir(parents=True, exist_ok=True)

    ser = serial.Serial()
    ser.port = args.port
    ser.baudrate = args.baud
    ser.timeout = 0.2
    ser.dtr = False  # keep GPIO0 high so the board boots the app, not the bootloader
    ser.rts = False
    ser.open()
    if args.reset:
        ser.rts = True
        time.sleep(0.1)
        ser.rts = False

    start = time.monotonic()
    pending = list(args.send)
    buf = b""
    with out.open("a", encoding="utf-8") as log:
        print(f"logging {args.port} @ {args.baud} to {out}", file=sys.stderr)
        try:
            while not args.seconds or time.monotonic() - start < args.seconds:
                if pending and time.monotonic() - start >= args.send_after:
                    cmd = pending.pop(0)
                    ser.write(cmd.encode() + b"\n")
                    print(f">>> {cmd}", file=sys.stderr)
                buf += ser.read(4096)
                while b"\n" in buf:
                    raw, buf = buf.split(b"\n", 1)
                    line = raw.decode("utf-8", "replace").rstrip("\r")
                    stamp = dt.datetime.now().isoformat(timespec="milliseconds")
                    print(line, flush=True)
                    log.write(f"{stamp} {ANSI.sub('', line)}\n")
                    log.flush()
        except KeyboardInterrupt:
            pass
    ser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
