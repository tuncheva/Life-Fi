"""The engine's TCP protocol (contracts/control.md), end to end over a socket.

    python engine/tests/test_control.py

Starts lifefi.control.Server on a free port with a replayed synthetic
recording, connects like the server does, and checks the result stream,
the acks and the source switch.
"""

import asyncio
import json
import pathlib
import socket
import sys
import tempfile
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "engine"))
sys.path.insert(0, str(ROOT / "engine" / "tools"))
import fakesensor  # noqa: E402
from lifefi.control import Server  # noqa: E402
from lifefi.engine import Engine  # noqa: E402

try:
    import jsonschema
    SCHEMA = jsonschema.Draft202012Validator(json.loads((ROOT / "contracts" / "results.schema.json").read_text()))
except ImportError:
    SCHEMA = None

failures = 0


def check(cond, what):
    global failures
    print(("  ok   " if cond else "  FAIL ") + what)
    failures += 0 if cond else 1


class Client:
    def __init__(self, port):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=5)
        self.buf = b""

    def send(self, obj):
        self.sock.sendall((json.dumps(obj) + "\n").encode())

    def lines(self, seconds):
        out, end = [], time.time() + seconds
        self.sock.settimeout(0.2)
        while time.time() < end:
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout:
                continue
            if not chunk:
                break
            self.buf += chunk
            while b"\n" in self.buf:
                line, self.buf = self.buf.split(b"\n", 1)
                out.append(json.loads(line))
        return out

    def ack(self, cid, seconds=3.0):
        end = time.time() + seconds
        while time.time() < end:
            for m in self.lines(0.3):
                if m.get("type") == "ack" and m.get("id") == cid:
                    return m
        return None


tmp = pathlib.Path(tempfile.mkdtemp())
rec = tmp / "sitting.csirec"
ts_us, csi, _ = fakesensor.scenario("sitting")
fakesensor.write(rec, ts_us[:2000], csi[:2000])            # ~22 s is enough here

eng = Engine(mode="replay")
logs = []
srv = Server(eng, port=0, log=logs.append, live_args={"serial": "NO_SUCH_PORT", "baud": 921600})
srv.set_source("replay", str(rec))
ready = threading.Event()
threading.Thread(target=lambda: asyncio.run(srv.serve(ready)), daemon=True).start()
check(ready.wait(5), "engine listening")

print("== result stream")
c = Client(srv.bound_port)
msgs = c.lines(2.6)
results = [m for m in msgs if m.get("type") == "result"]
check(4 <= len(results) <= 7, f"a result every 0.5 s ({len(results)} in 2.6 s)")
check(SCHEMA is None or all(not list(SCHEMA.iter_errors(r)) for r in results), "every result matches the schema")
check(results and results[-1]["source"] == "replay" and results[-1]["health"]["rate_hz"] > 50,
      f"replayed frames arrive ({results and results[-1]['health']['rate_hz']} Hz)")

print("== commands")
c.send({"type": "get_status", "id": 1})
a = c.ack(1)
check(a is not None and a["ok"] and a["data"]["engine"]["version"] and a["data"]["device"] is not None,
      f"get_status acked with engine and device ({a and list(a['data'])})")
c.send({"type": "no_such_command", "id": 2})
a = c.ack(2)
check(a is not None and not a["ok"] and "unknown" in a["error"], f"unknown command refused ({a and a['error']})")
c.send({"type": "calibrate", "id": 3, "kind": "empty", "duration_s": 5})
a = c.ack(3)
check(a is not None and not a["ok"], f"a 5 s calibration is refused at once ({a and a['error']})")
c.send({"type": "reload_rules", "id": 4})
a = c.ack(4)
check(a is not None and a["ok"] and a["data"]["config_hash"] == eng.config_hash, "reload_rules returns the config hash")
c.send({"type": "set_source", "id": 5, "mode": "replay"})
a = c.ack(5)
check(a is not None and not a["ok"] and "file" in a["error"], f"replay without a file refused ({a and a['error']})")
c.send({"type": "calibrate", "id": 7, "kind": "empty", "duration_s": None})
a = c.ack(7)
check(a is not None and not a["ok"], f"a bad argument type is refused ({a and a['error']})")
c.send({"type": "get_status", "id": 8})
check(c.ack(8) is not None, "and the connection still works")
c.send({"type": "reload_models", "id": 12})
a = c.ack(12, seconds=10)
check(a is not None and a["ok"] and "models" in a["data"], "reload_models acked")
c.send({"type": "set_source", "id": 6, "mode": "live"})
a = c.ack(6)
check(a is not None and a["ok"], "switch to live (a port that does not exist)")
time.sleep(2.5)
r = [m for m in c.lines(1.2) if m.get("type") == "result"]
check(r and r[-1]["source"] == "live" and r[-1]["health"]["rate_hz"] == 0.0, "live, and the rate falls to 0")
c.send({"type": "get_status", "id": 9})
a = c.ack(9)
info = a and a["data"]["engine"]["source_info"]
check(info and info["state"] == "error" and "NO_SUCH_PORT" in (info["error"] or ""),
      f"the port error reaches get_status ({info})")
rec_path = tmp / "rec" / "s01.csirec"
c.send({"type": "record_start", "id": 10, "session": "s01", "path": str(rec_path), "meta": {}})
a = c.ack(10)
c.send({"type": "record_stop", "id": 11})
b = c.ack(11)
check(a and a["ok"] and b and b["ok"] and rec_path.exists() and b["data"]["frames"] == 0,
      f"record_start / record_stop write a .csirec ({b and b['data']})")

print("== a tick that raises does not stop the results")
real_tick, calls = eng.tick, []


def bad_tick(now):
    calls.append(now)
    if len(calls) == 1:
        raise RuntimeError("boom")
    return real_tick(now)


eng.tick = bad_tick
r = [m for m in c.lines(1.6) if m.get("type") == "result"]
eng.tick = real_tick
check(len(calls) >= 2 and len(r) >= 2 and any("boom" in x for x in logs), f"results go on ({len(r)} in 1.6 s)")

print("== a second client replaces the first")
c2 = Client(srv.bound_port)
check(any(m.get("type") == "result" for m in c2.lines(1.2)), "the new client gets results")
c.lines(0.3)                                                  # whatever was already in flight
check(not [m for m in c.lines(1.2) if m.get("type") == "result"], "the old one gets nothing more")

print("== no board configured")
eng2 = Engine(mode="replay")
srv2 = Server(eng2, port=0, log=lambda *_: None)
acks = []
eng2.handle({"type": "set_source", "id": 1, "mode": "live"}, acks.append, time.time())
check(acks and not acks[0]["ok"] and "no board" in acks[0]["error"], f"live refused ({acks and acks[0]['error']})")

print("== finding the board's port")
from lifefi import sources  # noqa: E402
from serial.tools import list_ports  # noqa: E402


class Port:
    def __init__(self, device, vid):
        self.device, self.vid = device, vid


real_comports = list_ports.comports
for ports, want in (([], "no USB serial port"), ([Port("COM7", 0x10C4)], "COM7"),
                    ([Port("COM7", 0x10C4), Port("COM9", 0x303A)], "several"),
                    ([Port("COM1", None)], "no USB serial port")):
    list_ports.comports = lambda ports=ports: ports
    try:
        got = sources.find_board_port()
    except ValueError as err:
        got = str(err)
    check(want in got, f"{[p.device for p in ports]} -> {got}")
list_ports.comports = real_comports

srv.stop()
print(f"\ntest_control {'PASSED' if not failures else 'FAILED'}: {failures} failure(s)")
sys.exit(1 if failures else 0)
