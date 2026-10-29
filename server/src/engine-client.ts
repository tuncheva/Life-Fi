// TCP JSON-lines client for the engine (contracts/control.md).
// The engine listens on 127.0.0.1:6000; we connect and reconnect every 1 s.
import net from "node:net";
import { EventEmitter } from "node:events";
import type { Result } from "./contracts.gen.js";

export interface Ack {
  type: "ack";
  id: number;
  ok: boolean;
  error: string | null;
  data: Record<string, unknown>;
}

export class EngineError extends Error {
  constructor(message: string, readonly code: "engine_offline" | "timeout" | "refused") {
    super(message);
  }
}

interface Pending {
  resolve: (ack: Ack) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

type Logger = { info: (o: unknown, msg?: string) => void; warn: (o: unknown, msg?: string) => void; debug: (o: unknown, msg?: string) => void };

export interface EngineClientEvents {
  connected: [];
  disconnected: [];
  result: [Result];
  unknown: [Record<string, unknown>];
}

export class EngineClient extends EventEmitter<EngineClientEvents> {
  private sock: net.Socket | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  connected = false;
  connectedAt: number | null = null;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly log: Logger,
    private readonly reconnectMs = 1000,
  ) {
    super();
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.sock?.destroy();
    this.failPending(new EngineError("client stopped", "engine_offline"));
  }

  private connect(): void {
    if (this.stopped) return;
    const s = net.createConnection({ host: this.host, port: this.port });
    s.setEncoding("utf8");
    s.setNoDelay(true);
    s.on("connect", () => {
      this.sock = s;
      this.connected = true;
      this.connectedAt = Date.now();
      this.log.info({ host: this.host, port: this.port }, "engine connected");
      this.emit("connected");
    });
    s.on("data", (chunk: string) => this.onData(chunk));
    s.on("error", (err: NodeJS.ErrnoException) => {
      if (this.connected) this.log.warn({ err: err.message }, "engine socket error");
      else this.log.debug({ err: err.code }, "engine connect failed");
    });
    s.on("close", () => {
      const was = this.connected;
      this.connected = false;
      this.connectedAt = null;
      this.sock = null;
      this.buf = "";
      this.failPending(new EngineError("engine disconnected", "engine_offline"));
      if (was) {
        this.log.warn({}, "engine disconnected");
        this.emit("disconnected");
      }
      if (!this.stopped) this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectMs);
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.log.warn({ line: line.slice(0, 120) }, "engine sent a non-JSON line");
        continue;
      }
      this.dispatch(msg);
    }
    // A line longer than 1 MB means a broken peer; drop the buffer rather than grow forever.
    if (this.buf.length > 1_000_000) {
      this.log.warn({}, "engine line too long, dropping buffer");
      this.buf = "";
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    if (msg.type === "result") {
      this.emit("result", msg as unknown as Result);
    } else if (msg.type === "ack") {
      const ack = msg as unknown as Ack;
      const p = this.pending.get(ack.id);
      if (!p) {
        this.log.debug({ id: ack.id }, "ack for unknown command");
        return;
      }
      clearTimeout(p.timer);
      this.pending.delete(ack.id);
      p.resolve(ack);
    } else {
      this.emit("unknown", msg);
    }
  }

  /**
   * Sends a command and resolves with its ack. Rejects with EngineError when
   * the engine is offline, the ack does not arrive in `timeoutMs`, or the ack
   * has ok=false ("refused").
   */
  send(type: string, args: Record<string, unknown> = {}, timeoutMs = 3000): Promise<Ack> {
    if (!this.sock || !this.connected) {
      return Promise.reject(new EngineError("engine offline", "engine_offline"));
    }
    const id = this.nextId++;
    const line = JSON.stringify({ type, id, ...args }) + "\n";
    return new Promise<Ack>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EngineError(`engine did not answer '${type}' in ${timeoutMs} ms`, "timeout"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (ack) => (ack.ok ? resolve(ack) : reject(new EngineError(ack.error ?? `engine refused '${type}'`, "refused"))),
        reject,
        timer,
      });
      this.sock!.write(line, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new EngineError(`write failed: ${err.message}`, "engine_offline"));
        }
      });
    });
  }

  private failPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }
}
