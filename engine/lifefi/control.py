"""The engine on TCP 127.0.0.1:6000, JSON lines (contracts/control.md).

The engine listens; the server connects (and reconnects every 1 s). A
result goes out every tick whether or not a command is pending; every
command gets exactly one ack (calibrate's when it finishes). Only one
client: a second one replaces the first. Frames arrive from a source
thread (lifefi.sources) through a queue and are fed to the engine on the
event loop, so the engine itself is single-threaded.
"""

import asyncio
import json
import queue
import time

from . import sources


class Server:
    def __init__(self, engine, host="127.0.0.1", port=6000, live_args=None, log=print):
        self.engine, self.host, self.port, self.log = engine, host, port, log
        self.live_args = live_args or {}
        self.frames = queue.Queue(maxsize=20000)
        self.writer = None
        self.source = None
        self.dropped = 0
        engine.source_hook = self.set_source
        self.bound_port = None

    # ---- sources -----------------------------------------------------------
    def push(self, packet, host_us, src):
        try:
            self.frames.put_nowait((packet, host_us, src))
        except queue.Full:
            self.dropped += 1

    def set_source(self, mode, file=None, speed=1.0, loop=False):
        """Stops the current source and starts the one asked for; raises ValueError if it cannot."""
        new = None
        if mode == "replay":
            if not file:
                raise ValueError("replay needs a file")
            new = sources.ReplaySource(self.push, file, speed, loop)
        elif self.live_args.get("serial") or self.live_args.get("esp"):
            new = sources.LiveSource(self.push, **self.live_args)
        if self.source is not None:
            self.source.stop()
        self.source = new.start() if new is not None else None
        self.log(f"source: {new.name if new else 'none'}")

    # ---- protocol ----------------------------------------------------------
    def send(self, obj):
        w = self.writer
        if w is not None and not w.is_closing():
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
                    self.engine.handle(cmd, self.send, time.time())
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
            while True:
                try:
                    packet, host_us, src = self.frames.get_nowait()
                except queue.Empty:
                    break
                self.engine.feed(packet, host_us, src)
            self.send(self.engine.tick(time.time()))
            due += tick
            await asyncio.sleep(max(0.0, due - time.time()))

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
