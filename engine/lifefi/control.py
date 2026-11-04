"""The engine on TCP 127.0.0.1:6000, JSON lines (contracts/control.md).

The engine listens; the server connects (and reconnects every 1 s). A
result goes out every tick whether or not a command is pending; every
command gets exactly one ack (calibrate's when it finishes). Only one
client: a second one replaces the first. Frames arrive from a source
thread (lifefi.sources) through a queue and are fed to the engine on the
event loop, so the engine itself is single-threaded. An exception in
one tick is logged and the next tick runs anyway: the result stream must
never stop because of one bad frame.
"""

import asyncio
import json
import queue
import time
import traceback

from . import sources

MAX_BUFFER = 1 << 20         # a client that stops reading is dropped past this many unsent bytes


class Server:
    def __init__(self, engine, host="127.0.0.1", port=6000, live_args=None, log=print):
        self.engine, self.host, self.port, self.log = engine, host, port, log
        self.live_args = live_args or {}
        self.frames = queue.Queue(maxsize=20000)
        self.writer = None
        self.source = None
        self.dropped = 0
        engine.source_hook = self.set_source
        engine.source_info_hook = self.source_info
        engine.board_hook = self.board
        self.bound_port = None
        self.last_error_log = -1e9

    # ---- sources -----------------------------------------------------------
    def push(self, packet, host_us, src):
        try:
            self.frames.put_nowait((packet, host_us, src))
        except queue.Full:
            self.dropped += 1

    def set_source(self, mode, file=None, speed=1.0, loop=False):
        """Stops the current source and starts the one asked for; raises ValueError if it cannot."""
        if mode == "replay":
            if not file:
                raise ValueError("replay needs a file")
            new = sources.ReplaySource(self.push, file, speed, loop)
        elif self.live_args:
            new = sources.LiveSource(self.push, **self.live_args)
        else:
            raise ValueError("no board configured: start the engine with --serial or --esp")
        if self.source is not None:
            self.source.stop()
        self.source = new.start()
        self.log(f"source: {new.name}")

    def board(self):
        """The live board's own presence/people estimate (USB log), or None."""
        return getattr(self.source, "board", None)

    def source_info(self):
        if self.source is None:
            return {"name": None, "state": "none", "file": None, "speed": 1.0, "loop": False, "error": None}
        return self.source.info()

    # ---- protocol ----------------------------------------------------------
    def send(self, obj):
        w = self.writer
        if w is None or w.is_closing():
            return
        if w.transport.get_write_buffer_size() > MAX_BUFFER:
            self.log("server is not reading: dropping it")
            w.close()
            return
        w.write((json.dumps(obj, separators=(",", ":")) + "\n").encode())

    async def _client(self, reader, writer):
        if self.writer is not None:
            self.log("second client: closing the old one")
            self.writer.close()
        self.writer = writer
        self.log(f"server connected from {writer.get_extra_info('peername')}")
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    cmd = json.loads(line)
                except json.JSONDecodeError:
                    self.log(f"bad command line: {line[:120]!r}")
                    continue
                if isinstance(cmd, dict):
                    try:
                        self.engine.handle(cmd, self.send, time.time())
                    except Exception:                 # Engine.handle acks its own errors; this is a last resort
                        self._log_error("command")
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            if self.writer is writer:
                self.writer = None
                self.log("server disconnected")
            writer.close()

    async def _ticker(self):
        tick = self.engine.rules["tick_s"]
        due = time.time()
        while True:
            try:
                while True:
                    try:
                        packet, host_us, src = self.frames.get_nowait()
                    except queue.Empty:
                        break
                    self.engine.feed(packet, host_us, src)
                self.send(self.engine.tick(time.time()))
            except Exception:
                self._log_error("tick")
            due += tick
            if due < time.time() - 5 * tick:          # fell far behind (a slow tick): don't burst to catch up
                due = time.time()
            await asyncio.sleep(max(0.0, due - time.time()))

    def _log_error(self, where):
        """The traceback, at most once a minute so a repeating error does not flood the log."""
        now = time.time()
        if now - self.last_error_log >= 60.0:
            self.last_error_log = now
            self.log(f"error in {where} (kept running):\n{traceback.format_exc()}")

    async def serve(self, ready=None):
        server = await asyncio.start_server(self._client, self.host, self.port)
        self.bound_port = server.sockets[0].getsockname()[1]
        self.log(f"engine listening on {self.host}:{self.bound_port}")
        if ready is not None:
            ready.set()
        async with server:
            await asyncio.gather(server.serve_forever(), self._ticker())

    def stop(self):
        if self.source is not None:
            self.source.stop()
        self.engine.close()
