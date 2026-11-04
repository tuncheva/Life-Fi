import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProfilesConfig } from "../src/server/profiles";
import { ConfigError } from "../src/server/config";
import type { AppContext } from "../src/server/context";
import { EngineError } from "../src/server/engine-client";
import { PinLimiter, read, readBody, write } from "../src/server/http";
import { replayPath } from "../src/server/recordings";
import { parseRoom, SettingsStore } from "../src/server/settings";

const errors: unknown[] = [];
const ctx = {
  log: { error: (o: unknown) => errors.push(o), warn() {}, info() {}, debug() {} },
  settings: { checkPin: (p: string | undefined) => p === "2468", trustToken: () => "T0KEN", checkTrust: (c: string | undefined) => c === "T0KEN" },
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

  it("a body over 64 KB without Content-Length (chunked) is 413 too", async () => {
    const h = write(async (_c, req) => readBody(req), { runtime, limiter: new PinLimiter() });
    const big = new TextEncoder().encode(`{"x":"${"a".repeat(70_000)}"}`);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < big.length; i += 8192) c.enqueue(big.subarray(i, i + 8192));
        c.close();
      },
    });
    const req = new Request("http://x/api/v1/thing", { method: "POST", body, headers: { "x-lifefi-pin": "2468" }, duplex: "half" } as RequestInit);
    expect(req.headers.get("content-length")).toBeNull();
    expect((await h(req)).status).toBe(413);
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

  it("lets a trusted browser with the right PIN through a lockout, nobody else", async () => {
    const limiter = new PinLimiter(() => 0);
    const h = write(() => ({ ok: true }), { runtime, limiter });
    // the first accepted PIN hands out the trust cookie
    const first = await h(post("{}"));
    expect(first.headers.get("set-cookie")).toMatch(/^lifefi_trust=T0KEN; Path=\/api\/v1; .*HttpOnly; SameSite=Strict/);
    expect((await h(post("{}", "2468", { cookie: "a=1; lifefi_trust=T0KEN" }))).headers.get("set-cookie")).toBeNull();
    for (let i = 0; i < 5; i++) await h(post("{}", "0000"));
    // locked: the right PIN without the cookie, a wrong PIN with it, and a forged cookie all get 429
    expect((await h(post("{}"))).status).toBe(429);
    expect((await h(post("{}", "0000", { cookie: "lifefi_trust=T0KEN" }))).status).toBe(429);
    expect((await h(post("{}", "2468", { cookie: "lifefi_trust=guess" }))).status).toBe(429);
    // the caregiver's browser still acknowledges right away
    expect((await h(post("{}", "2468", { cookie: "lifefi_trust=T0KEN" }))).status).toBe(200);
    // and that did not lift the lockout for everyone else
    expect((await h(post("{}"))).status).toBe(429);
  });

  it("forgets earlier lockouts after an hour without wrong PINs", async () => {
    let now = 0;
    const limiter = new PinLimiter(() => now);
    const h = write(() => ({ ok: true }), { runtime, limiter });
    for (let i = 0; i < 5; i++) await h(post("{}", "0000"));
    now += 60_000;
    for (let i = 0; i < 5; i++) await h(post("{}", "0000"));
    expect((await h(post("{}"))).headers.get("Retry-After")).toBe("120");
    now += 120_000 + 3600_001;
    for (let i = 0; i < 5; i++) await h(post("{}", "0000"));
    expect((await h(post("{}"))).headers.get("Retry-After")).toBe("60");
  });

  it("the trust token is per install and changes with the PIN", () => {
    const dir = mkdtempSync(join(tmpdir(), "lifefi-trust-"));
    try {
      const defaults = { pin: "1234", profiles: { notify: { ntfy_url: "", topic: "", escalate_after_s: 60 }, zone: "UTC" } as unknown as ProfilesConfig };
      const a = new SettingsStore(dir, defaults);
      const t = a.trustToken();
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(new SettingsStore(dir, defaults).trustToken()).toBe(t); // the key survives a restart
      expect(a.checkTrust(t)).toBe(true);
      expect(a.checkTrust("x")).toBe(false);
      a.update({ pin: "9753" });
      expect(a.checkTrust(t)).toBe(false);
      const other = mkdtempSync(join(tmpdir(), "lifefi-trust-"));
      try {
        expect(new SettingsStore(other, defaults).trustToken()).not.toBe(t);
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
