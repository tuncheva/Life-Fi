import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/server/config";
import type { AppContext } from "../src/server/context";
import { EngineError } from "../src/server/engine-client";
import { PinLimiter, read, readBody, write } from "../src/server/http";
import { replayPath } from "../src/server/recordings";
import { parseRoom } from "../src/server/settings";

const errors: unknown[] = [];
const ctx = {
  log: { error: (o: unknown) => errors.push(o), warn() {}, info() {}, debug() {} },
  settings: { checkPin: (p: string | undefined) => p === "2468" },
} as unknown as AppContext;
const runtime = () => ctx;
const post = (body: string | null, pin = "2468", headers: Record<string, string> = {}) =>
  new Request("http://x/api/v1/thing", { method: "POST", body, headers: { "x-lifefi-pin": pin, ...headers } });

describe("read/write error handling", () => {
  it("a handler that throws gives 500 internal JSON, never the stack", async () => {
    const h = read(() => {
      throw new Error("boom at secret/place.ts");
    }, { runtime });
    const res = await h(new Request("http://x/api/v1/status"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toEqual({ error: "internal", message: "unexpected server error" });
    expect(JSON.stringify(errors)).toContain("boom");
  });

  it("a config error gives 500 config with the list", async () => {
    const h = read(() => 1, { runtime: () => { throw new ConfigError(["LIFEFI_ENGINE_PORT must be an integer 1-65535 (got \"abc\")"]); } });
    const res = await h(new Request("http://x/api/v1/health"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("config");
    expect(body.message).toContain("LIFEFI_ENGINE_PORT");
  });

  it("an EngineError thrown out of a handler is the engine error JSON", async () => {
    const h = read(() => {
      throw new EngineError("engine is not connected", "engine_offline");
    }, { runtime });
    const res = await h(new Request("http://x/"));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("engine_offline");
  });

  it("malformed JSON is 400; an empty body is {}", async () => {
    const h = write(async (_c, req) => readBody(req), { runtime, limiter: new PinLimiter() });
    const bad = await h(post("{not json"));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toBe("body is not valid JSON");
    const empty = await h(post(null));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({});
  });

  it("a write body over 64 KB is 413", async () => {
    const h = write(() => ({ ok: true }), { runtime, limiter: new PinLimiter() });
    const res = await h(post("{}", "2468", { "content-length": String(70_000) }));
    expect(res.status).toBe(413);
  });
});

describe("wrong-PIN limiter", () => {
  it("locks after 5 wrong PINs for 60 s, then doubles the next lockout", async () => {
    let now = 1_700_000_000_000;
    const limiter = new PinLimiter(() => now);
    const h = write(() => ({ ok: true }), { runtime, limiter });
    for (let i = 0; i < 5; i++) expect((await h(post("{}", "0000"))).status).toBe(401);
    const locked = await h(post("{}", "2468"));
    expect(locked.status).toBe(429);
    expect(locked.headers.get("Retry-After")).toBe("60");
    expect(((await locked.json()) as { error: string }).error).toBe("rate_limited");
    now += 60_000;
    expect((await h(post("{}", "2468"))).status).toBe(200);
    // the right PIN reset the doubling: a new lockout is 60 s again
    for (let i = 0; i < 5; i++) await h(post("{}", "0000"));
    expect((await h(post("{}", "2468"))).headers.get("Retry-After")).toBe("60");
    now += 60_000;
    // a second lockout in a row (no right PIN between) lasts 120 s
    for (let i = 0; i < 5; i++) await h(post("{}", "0000"));
    const second = await h(post("{}", "2468"));
    expect(second.headers.get("Retry-After")).toBe("120");
    now += 61_000;
    expect((await h(post("{}", "2468"))).status).toBe(429);
    now += 60_000;
    expect((await h(post("{}", "2468"))).status).toBe(200);
  });

  it("wrong PINs spread over more than 60 s do not lock", async () => {
    let now = 0;
    const limiter = new PinLimiter(() => now);
    const h = write(() => ({ ok: true }), { runtime, limiter });
    for (let i = 0; i < 10; i++) {
      expect((await h(post("{}", "0000"))).status).toBe(401);
      now += 15_000;
    }
  });
});

describe("replay paths", () => {
  const root = resolve("/repo");
  const data = join(root, "data");
  it("allows .csirec under firmware/recordings and data/sessions only", () => {
    expect(replayPath("firmware/recordings/second.csirec", root, data)).toBe(join(root, "firmware", "recordings", "second.csirec"));
    expect(replayPath(join(data, "sessions", "s03", "s03.csirec"), root, data)).toBe(join(data, "sessions", "s03", "s03.csirec"));
    expect(replayPath("../../Windows/win.ini", root, data)).toBeNull();
    expect(replayPath("firmware/recordings/../../../etc/x.csirec", root, data)).toBeNull();
    expect(replayPath("firmware/recordings/notes.txt", root, data)).toBeNull();
    expect(replayPath("engine/run.csirec", root, data)).toBeNull();
  });
});

describe("room geometry", () => {
  it("accepts a room with the sensor and transmitter inside it", () => {
    expect(parseRoom({ width_m: 4, depth_m: 3.5, sensor: { x_m: 0.2, y_m: 0 }, transmitter: { x_m: 3.8, y_m: 3.5 } })).toEqual({
      width_m: 4,
      depth_m: 3.5,
      sensor: { x_m: 0.2, y_m: 0 },
      transmitter: { x_m: 3.8, y_m: 3.5 },
    });
    expect(parseRoom({ width_m: 4, depth_m: 3, sensor: { x_m: 1, y_m: 1 } })).toMatchObject({ transmitter: null });
  });

  it("rejects bad sizes and points outside the room", () => {
    expect(typeof parseRoom({ width_m: 0.5, depth_m: 3, sensor: { x_m: 0, y_m: 0 } })).toBe("string");
    expect(typeof parseRoom({ width_m: 4, depth_m: 3, sensor: { x_m: 5, y_m: 0 } })).toBe("string");
    expect(typeof parseRoom({ width_m: 4, depth_m: 3, sensor: { x_m: 1, y_m: 1 }, transmitter: { x_m: 1, y_m: -1 } })).toBe("string");
    expect(typeof parseRoom("big")).toBe("string");
  });
});
