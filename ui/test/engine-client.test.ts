import { afterEach, beforeEach, describe, expect, it } from "vitest";
import net from "node:net";
import { once } from "node:events";
import { EngineClient, EngineError, type Ack } from "../src/server/engine-client";
import { resultValidator } from "../src/server/validate";

const log = { info: () => {}, warn: () => {}, debug: () => {} };

const RESULT_LINE = JSON.stringify({
  type: "result",
  v: 2,
  ts: 1_700_000_000_000,
  t_rx_last_us: 1_700_000_000_000_000,
  node: 1,
  boot_id: 42,
  source: "live",
  config_hash: "x",
  pipeline_version: 2,
  health: { rate_hz: 88, loss_udp: 0, loss_air: 0, invalid_ratio: 0, rejected: { layout: 0, gain_invalid: 0 }, warmup: false },
  calibration: { state: "ok", id: "cal-0001", age_s: 10 },
  presence: { value: true, state: "present", S: 0.2, B: 0.7, M: 0.03 },
  motion: 0.03,
  posture: null,
  count: null,
  activity: null,
  breathing: { bpm: null, confidence: 0.1, valid: false, wave: [] },
  csi: [],
  events: [],
  active: [],
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for `fn` to be true, polling, so tests do not depend on exact timer ordering. */
async function waitFor(fn: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await sleep(5);
  }
}

type Command = { type: string; id: number } & Record<string, unknown>;

/** A fake engine: accepts connections, parses command lines, lets the test decide how to answer. */
class FakeEngine {
  readonly server = net.createServer((s) => this.accept(s));
  readonly sockets: net.Socket[] = [];
  readonly commands: Command[] = [];
  onCommand: ((cmd: Command, sock: net.Socket) => void) | null = null;
  port = 0;

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as net.AddressInfo).port;
  }

  private accept(s: net.Socket): void {
    this.sockets.push(s);
    s.setEncoding("utf8");
    let buf = "";
    s.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const cmd = JSON.parse(line) as Command;
        this.commands.push(cmd);
        this.onCommand?.(cmd, s);
      }
    });
    s.on("error", () => {});
  }

  ack(sock: net.Socket, id: number, ok: boolean, error: string | null = null, data: Record<string, unknown> = {}): void {
    sock.write(JSON.stringify({ type: "ack", id, ok, error, data }) + "\n");
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

describe("EngineClient", () => {
  let engine: FakeEngine;
  let client: EngineClient;

  beforeEach(async () => {
    engine = new FakeEngine();
    await engine.listen();
    client = new EngineClient("127.0.0.1", engine.port, log, 20);
  });

  afterEach(async () => {
    client.stop();
    await engine.close();
  });

  async function connect(): Promise<void> {
    const connected = once(client, "connected");
    client.start();
    await connected;
  }

  it("connects and emits 'connected'", async () => {
    expect(client.connected).toBe(false);
    await connect();
    expect(client.connected).toBe(true);
    expect(client.connectedAt).not.toBeNull();
    await waitFor(() => engine.sockets.length === 1);
  });

  it("parses a result line and emits 'result'", async () => {
    await connect();
    await waitFor(() => engine.sockets.length === 1);
    const result = once(client, "result");
    engine.sockets[0]!.write(RESULT_LINE + "\n");
    const [r] = await result;
    expect(r.type).toBe("result");
    expect(r.boot_id).toBe(42);
    expect(r.health.rate_hz).toBe(88);
  });

  it("emits 'unknown' for other message types and skips non-JSON lines", async () => {
    await connect();
    await waitFor(() => engine.sockets.length === 1);
    const unknown = once(client, "unknown");
    engine.sockets[0]!.write("this is not json\n\n" + JSON.stringify({ type: "hello", x: 1 }) + "\n");
    const [msg] = await unknown;
    expect(msg).toEqual({ type: "hello", x: 1 });
  });

  it("drops a result that breaks the schema, and lines that are not JSON objects", async () => {
    client.stop();
    client = new EngineClient("127.0.0.1", engine.port, log, 20, resultValidator());
    await connect();
    await waitFor(() => engine.sockets.length === 1);
    const got: unknown[] = [];
    client.on("result", (r) => got.push(r));
    const bad = { ...JSON.parse(RESULT_LINE), presence: { value: true } };
    engine.sockets[0]!.write(["null", "[1,2]", "42", JSON.stringify(bad), RESULT_LINE].join("\n") + "\n");
    await waitFor(() => got.length === 1);
    await sleep(30);
    expect(got).toHaveLength(1);
    expect(client.invalidResults).toBe(1);
  });

  it("the schema validator accepts every contract fixture", () => {
    const validate = resultValidator();
    expect(validate(JSON.parse(RESULT_LINE))).toBeNull();
    expect(validate({ ...JSON.parse(RESULT_LINE), activity: { label: "dancing", p: 1, probs: {}, src: "model" } })).toMatch(/activity/);
  });

  it("send() resolves with the ack when the engine answers ok:true", async () => {
    await connect();
    engine.onCommand = (cmd, sock) => engine.ack(sock, cmd.id, true, null, { config_hash: "abc" });
    const ack: Ack = await client.send("reload_rules");
    expect(ack).toEqual({ type: "ack", id: 1, ok: true, error: null, data: { config_hash: "abc" } });
    expect(engine.commands).toEqual([{ type: "reload_rules", id: 1 }]);
  });

  it("send() passes the arguments and uses increasing ids", async () => {
    await connect();
    engine.onCommand = (cmd, sock) => engine.ack(sock, cmd.id, true);
    await client.send("set_source", { mode: "replay" });
    await client.send("calibrate", { kind: "empty", duration_s: 5 });
    expect(engine.commands).toEqual([
      { type: "set_source", id: 1, mode: "replay" },
      { type: "calibrate", id: 2, kind: "empty", duration_s: 5 },
    ]);
  });

  it("send() rejects with code 'refused' when the engine answers ok:false", async () => {
    await connect();
    engine.onCommand = (cmd, sock) => engine.ack(sock, cmd.id, false, "motion seen during calibration");
    const err = await client.send("calibrate", { kind: "empty" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe("refused");
    expect((err as EngineError).message).toBe("motion seen during calibration");
  });

  it("send() rejects with code 'timeout' when no ack arrives", async () => {
    await connect();
    engine.onCommand = () => {}; // never answers
    const err = await client.send("get_status", {}, 50).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe("timeout");
    await waitFor(() => engine.commands.length === 1);
    // a late ack is ignored
    engine.ack(engine.sockets[0]!, 1, true);
    await sleep(20);
    expect(client.connected).toBe(true);
  });

  it("send() rejects with code 'engine_offline' when not connected", async () => {
    const err = await client.send("get_status").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe("engine_offline");
    expect(engine.commands).toEqual([]);
  });

  it("matches acks to their own command when several are in flight", async () => {
    await connect();
    engine.onCommand = (cmd, sock) => {
      // answer in reverse order
      if (cmd.id === 2) {
        engine.ack(sock, 2, true, null, { n: 2 });
        engine.ack(sock, 1, true, null, { n: 1 });
      }
    };
    const [a1, a2] = await Promise.all([client.send("get_status"), client.send("get_status")]);
    expect(a1.data).toEqual({ n: 1 });
    expect(a2.data).toEqual({ n: 2 });
  });

  it("reassembles a line split across two chunks", async () => {
    await connect();
    await waitFor(() => engine.sockets.length === 1);
    const results: unknown[] = [];
    client.on("result", (r) => results.push(r));
    const sock = engine.sockets[0]!;
    const cut = Math.floor(RESULT_LINE.length / 2);
    sock.write(RESULT_LINE.slice(0, cut));
    await sleep(30);
    expect(results).toHaveLength(0);
    sock.write(RESULT_LINE.slice(cut) + "\n");
    await waitFor(() => results.length === 1);
    expect(results[0]).toEqual(JSON.parse(RESULT_LINE));
  });

  it("handles several lines in one chunk", async () => {
    await connect();
    await waitFor(() => engine.sockets.length === 1);
    const results: unknown[] = [];
    client.on("result", (r) => results.push(r));
    engine.sockets[0]!.write(RESULT_LINE + "\n" + RESULT_LINE + "\n");
    await waitFor(() => results.length === 2);
  });

  it("reconnects after the engine closes the socket", async () => {
    await connect();
    await waitFor(() => engine.sockets.length === 1);

    const disconnected = once(client, "disconnected");
    const reconnected = once(client, "connected");
    engine.sockets[0]!.destroy();
    await disconnected;
    expect(client.connected).toBe(false);
    expect(client.connectedAt).toBeNull();

    await reconnected;
    expect(client.connected).toBe(true);
    await waitFor(() => engine.sockets.length === 2);

    // the new connection works
    engine.onCommand = (cmd, sock) => engine.ack(sock, cmd.id, true);
    const ack = await client.send("get_status");
    expect(ack.ok).toBe(true);
  });

  it("fails in-flight commands with 'engine_offline' when the socket drops", async () => {
    await connect();
    await waitFor(() => engine.sockets.length === 1);
    engine.onCommand = (_cmd, sock) => sock.destroy();
    const err = await client.send("get_status").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe("engine_offline");
  });

  it("keeps retrying while the engine is down and connects once it is up", async () => {
    await engine.close();
    const port = engine.port;
    let connects = 0;
    client.on("connected", () => connects++);
    client.start();
    await sleep(80);
    expect(connects).toBe(0);
    expect(client.connected).toBe(false);

    engine = new FakeEngine();
    await new Promise<void>((resolve) => engine.server.listen(port, "127.0.0.1", resolve));
    engine.port = port;
    await waitFor(() => connects === 1);
    expect(client.connected).toBe(true);
  });

  it("stop() closes the socket and does not reconnect", async () => {
    await connect();
    await waitFor(() => engine.sockets.length === 1);
    client.stop();
    await waitFor(() => !client.connected);
    await sleep(100);
    expect(engine.sockets).toHaveLength(1);
    const err = await client.send("get_status").catch((e: unknown) => e);
    expect((err as EngineError).code).toBe("engine_offline");
  });
});
