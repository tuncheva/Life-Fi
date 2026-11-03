import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AppContext } from "../src/server/context";
import { health, setup, type HealthEnv } from "../src/server/health";
import { read } from "../src/server/http";

const T0 = 1_700_000_000_000;
const dir = mkdtempSync(join(tmpdir(), "lifefi-health-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function mkCtx(o: { connected?: boolean; resultAgeMs?: number | null; offline?: boolean; mode?: "live" | "replay"; cal?: string | null; pin?: string; topic?: string; error?: string | null; sourceState?: string } = {}): AppContext {
  const age = o.resultAgeMs === undefined ? null : o.resultAgeMs;
  const latest =
    age === null
      ? null
      : { health: { rate_hz: 88 }, calibration: o.cal === null ? undefined : { state: o.cal ?? "ok", id: "cal-1", age_s: 12.4 } };
  return {
    version: "0.1.0",
    engine: { connected: o.connected ?? true },
    watchdog: { isOffline: o.offline ?? false },
    settings: { value: { pin: o.pin ?? "1234", notify: { topic: o.topic ?? "" } } },
    state: {
      startedAt: T0 - 812_400,
      latest,
      lastResultAt: age === null ? null : T0 - age,
      engineStatus: null,
      source: { mode: o.mode ?? "live", file: null, speed: 1, loop: false, state: o.sourceState ?? "running", error: o.error ?? null },
    },
  } as unknown as AppContext;
}

const env = (o: Partial<HealthEnv> = {}): HealthEnv => ({ now: T0, dbPath: ":memory:", dataDir: dir, bindHost: "127.0.0.1", ...o });

describe("health", () => {
  it("engine down: ok=false and the route answers 503 with the same body", async () => {
    const ctx = mkCtx({ connected: false });
    const h = health(ctx, env());
    expect(h.ok).toBe(false);
    expect(h.ready).toBe(false);
    expect(h.checks.engine.ok).toBe(false);
    const route = read((c) => {
      const b = health(c, env());
      return Response.json(b, { status: b.ok ? 200 : 503 });
    }, { runtime: () => ctx });
    const res = await route(new Request("http://x/api/v1/health"));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  it("engine up, no result yet: ok but not ready, every field present", () => {
    const h = health(mkCtx({ error: "no USB serial port found" }), env());
    expect(h.ok).toBe(true);
    expect(h.ready).toBe(false);
    expect(h.uptime_s).toBe(812);
    expect(h.checks.board).toEqual({ ok: false, source: "live", result_age_s: null, rate_hz: null, error: "no USB serial port found" });
    expect(h.checks.calibration).toEqual({ ok: false, state: null, id: null, age_s: null });
    expect(h.checks.storage.ok).toBe(true);
    expect(h.checks.storage.db_bytes).toBe(0);
  });

  it("fresh result and watchdog online: ready", () => {
    const h = health(mkCtx({ resultAgeMs: 1234 }), env());
    expect(h.ready).toBe(true);
    expect(h.checks.board.result_age_s).toBe(1.2);
    expect(h.checks.board.rate_hz).toBe(88);
    expect(h.checks.calibration).toEqual({ ok: true, state: "ok", id: "cal-1", age_s: 12 });
  });

  it("stale result (> 5 s) or watchdog offline: not ready", () => {
    expect(health(mkCtx({ resultAgeMs: 6000 }), env()).ready).toBe(false);
    expect(health(mkCtx({ resultAgeMs: 6000 }), env()).checks.board.rate_hz).toBe(88);
    expect(health(mkCtx({ resultAgeMs: 11_000 }), env()).checks.board.rate_hz).toBeNull();
    expect(health(mkCtx({ resultAgeMs: 100, offline: true }), env()).ready).toBe(false);
  });

  it("board unreadable: not ready, even though the engine keeps sending warm-up results", () => {
    const h = health(mkCtx({ resultAgeMs: 500, sourceState: "error", error: "no USB serial port found" }), env());
    expect(h.ready).toBe(false);
    expect(h.checks.board.ok).toBe(false);
    expect(setup(mkCtx({ resultAgeMs: 500, sourceState: "error", error: "no USB serial port found" }), env()).steps[1].detail).toBe("no USB serial port found");
  });

  it("an unwritable data dir fails storage and ok", () => {
    const h = health(mkCtx(), env({ dataDir: join(dir, "missing", "deeper") }));
    expect(h.checks.storage.ok).toBe(false);
    expect(h.ok).toBe(false);
  });
});

describe("setup", () => {
  const ids = ["engine", "board", "pin", "calibration", "notify", "lan"];

  it("lists the six steps in order; the default PIN keeps it incomplete", () => {
    const s = setup(mkCtx({ resultAgeMs: 100 }), env());
    expect(s.steps.map((x) => x.id)).toEqual(ids);
    expect(s.steps.find((x) => x.id === "pin")).toEqual({ id: "pin", done: false, optional: false, detail: "the PIN is still the default" });
    expect(s.complete).toBe(false);
  });

  it("complete when every non-optional step is done (optional ones may be open)", () => {
    const s = setup(mkCtx({ resultAgeMs: 100, pin: "8642" }), env());
    expect(s.complete).toBe(true);
    expect(s.steps.filter((x) => !x.done).map((x) => x.id)).toEqual(["notify", "lan"]);
    expect(s.steps.find((x) => x.id === "lan")?.detail).toContain("LIFEFI_HOST=0.0.0.0");
  });

  it("optional steps done with a topic and a LAN bind", () => {
    const s = setup(mkCtx({ resultAgeMs: 100, pin: "8642", topic: "room-1" }), env({ bindHost: "0.0.0.0" }));
    expect(s.steps.every((x) => x.done && x.detail === null)).toBe(true);
  });

  it("explains replay, stale calibration and a missing engine", () => {
    const replay = setup(mkCtx({ resultAgeMs: 100, mode: "replay", cal: "stale" }), env());
    expect(replay.steps[1]).toEqual({ id: "board", done: false, optional: false, detail: "replaying a recording, not the board" });
    expect(replay.steps[3].detail).toBe("calibration is stale: redo it with the room empty");
    const down = setup(mkCtx({ connected: false }), env());
    expect(down.steps[0].detail).toBe("the engine is not running");
    expect(down.steps[1].detail).toBe("no data from the board");
    expect(down.steps[3].detail).toBe("no empty-room calibration yet");
  });
});
