import { describe, expect, it } from "vitest";
import type { CalibrationJob, Status } from "../src/lib/api";
import type { Result } from "../src/lib/contracts.gen";
import { calibrationErrorText, calibrationProgress, doneSteps, needsSetup, parseMetres, parseStep, sensorChecks, transmitterMoving, type HealthResponse, type SensorInput, type SetupResponse } from "../src/lib/setup";

function status(over: { engine?: boolean; mode?: "live" | "replay"; state?: "running" | "stopped" | "error"; error?: string | null } = {}): Status {
  return {
    server: { version: "1", uptime_s: 1, profile: "home", time_zone: "UTC", room_name: "Room 1", contact_phone: "", sensor_offline: null },
    presence: null,
    engine: { connected: over.engine ?? true, last_result_ms: null, status: null },
    device: null,
    source: { mode: over.mode ?? "live", file: null, speed: 1, loop: false, state: over.state ?? "running", error: over.error ?? null },
    calibration_job: null,
    recording: null,
    alerts_open: 0,
  };
}

const base: SensorInput = { connected: true, status: status(), stale: false, rateHz: 100, health: null, setup: null };
const states = (i: SensorInput) => Object.fromEntries(sensorChecks(i).checks.map((c) => [c.id, c.state]));

describe("parseStep", () => {
  it("accepts the known ids, case and space tolerant", () => {
    expect(parseStep("calibrate")).toBe("calibrate");
    expect(parseStep(" FIT ")).toBe("fit");
    expect(parseStep("sensor")).toBe("sensor");
  });
  it("rejects anything else", () => {
    expect(parseStep(null)).toBeNull();
    expect(parseStep("")).toBeNull();
    expect(parseStep("calibration")).toBeNull();
    expect(parseStep("../x")).toBeNull();
  });
});

describe("sensorChecks without the server routes", () => {
  it("all fine: every check ok", () => {
    const r = sensorChecks(base);
    expect(r.ok).toBe(true);
    expect(r.replay).toBe(false);
    expect(r.checks.every((c) => c.state === "ok")).toBe(true);
  });
  it("box unreachable: the rest waits instead of failing", () => {
    expect(states({ ...base, connected: false })).toEqual({ box: "fail", engine: "wait", board: "wait", readings: "wait", signal: "wait" });
    expect(states({ ...base, connected: false, status: null }).box).toBe("wait");
    expect(sensorChecks({ ...base, connected: false }).ok).toBe(false);
  });
  it("engine down: names the action", () => {
    const r = sensorChecks({ ...base, status: status({ engine: false }) });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === "engine")).toMatchObject({ state: "fail" });
    expect(r.checks.find((c) => c.id === "engine")?.detail).toMatch(/not running/);
  });
  it("board error: plug it into USB, with the engine's reason", () => {
    const c = sensorChecks({ ...base, status: status({ state: "error", error: "no USB serial port found" }) }).checks.find((c) => c.id === "board");
    expect(c?.state).toBe("fail");
    expect(c?.detail).toMatch(/USB.*no USB serial port found/);
  });
  it("stale readings fail, signal waits", () => {
    expect(states({ ...base, stale: true })).toMatchObject({ readings: "fail", signal: "wait" });
  });
  it("signal thresholds: 80 ok, 50 warn, below fails", () => {
    expect(states({ ...base, rateHz: 80 }).signal).toBe("ok");
    expect(states({ ...base, rateHz: 60 }).signal).toBe("warn");
    expect(sensorChecks({ ...base, rateHz: 60 }).ok).toBe(true);
    expect(states({ ...base, rateHz: 20 }).signal).toBe("fail");
    expect(states({ ...base, rateHz: null }).signal).toBe("wait");
  });
  it("replay: a warning, not a failure", () => {
    const r = sensorChecks({ ...base, status: status({ mode: "replay" }) });
    expect(r.replay).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.id === "board")?.state).toBe("warn");
  });
});

describe("sensorChecks with the server routes", () => {
  const health = (over: Partial<NonNullable<NonNullable<HealthResponse["checks"]>["board"]>>, engine = true): HealthResponse => ({
    ok: engine,
    checks: { engine: { ok: engine }, board: { ok: true, source: "live", result_age_s: 0.4, rate_hz: 95, error: null, ...over } },
  });
  it("health wins over the live stream", () => {
    // the stream says engine up, health says down
    expect(states({ ...base, health: health({}, false) }).engine).toBe("fail");
    // stream is stale, health says the board is fine
    expect(states({ ...base, stale: true, health: health({}) }).readings).toBe("ok");
    expect(states({ ...base, rateHz: 10, health: health({ rate_hz: 95 }) }).signal).toBe("ok");
  });
  it("health board error fails the board check", () => {
    const c = sensorChecks({ ...base, health: health({ ok: false, error: "no USB serial port found" }) }).checks.find((c) => c.id === "board");
    expect(c?.state).toBe("fail");
  });
  it("health in replay marks the session as a recording", () => {
    expect(sensorChecks({ ...base, health: health({ source: "replay" }) }).replay).toBe(true);
  });
  it("setup engine step is used when health is absent", () => {
    const setup: SetupResponse = { complete: false, steps: [{ id: "engine", done: false, optional: false, detail: "the engine is not running" }] };
    expect(states({ ...base, setup }).engine).toBe("fail");
  });
  it("a partial body does not throw", () => {
    expect(() => sensorChecks({ ...base, health: {}, setup: { steps: [{}] } })).not.toThrow();
  });
});

describe("calibrationProgress", () => {
  const job = (over: Partial<CalibrationJob>): CalibrationJob => ({ kind: "empty", duration_s: 60, started_at: 1_000_000, state: "running", id: null, error: null, finished_at: null, ...over });
  it("no job → idle", () => {
    expect(calibrationProgress(null, 0).phase).toBe("idle");
  });
  it("running: seconds left and fraction", () => {
    const p = calibrationProgress(job({}), 1_000_000 + 15_000);
    expect(p).toMatchObject({ phase: "running", remaining_s: 45 });
    expect(p.fraction).toBeCloseTo(0.25);
  });
  it("running past its time: 0 left, waiting for the engine", () => {
    expect(calibrationProgress(job({}), 1_000_000 + 90_000)).toMatchObject({ phase: "running", remaining_s: 0, fraction: 1 });
  });
  it("ok and failed outcomes", () => {
    expect(calibrationProgress(job({ state: "ok", finished_at: 1_060_000 }), 1_070_000).phase).toBe("ok");
    const f = calibrationProgress(job({ state: "failed", error: "timeout waiting for ack", finished_at: 1_060_000 }), 1_070_000);
    expect(f.phase).toBe("failed");
    expect(f.error).toMatch(/did not answer in time/);
  });
  it("an outcome older than the page is old news", () => {
    expect(calibrationProgress(job({ state: "failed", finished_at: 1_060_000 }), 2_000_000, 1_500_000).phase).toBe("idle");
    // a running job is always joined
    expect(calibrationProgress(job({}), 1_010_000, 1_500_000).phase).toBe("running");
  });
  it("error text never empty", () => {
    expect(calibrationErrorText(null)).toMatch(/Try again/);
    expect(calibrationErrorText("weird thing")).toMatch(/weird thing/);
  });
});

describe("needsSetup and doneSteps", () => {
  it("server complete wins", () => {
    expect(needsSetup({ setup: { complete: true }, localDone: false, calibration: "none" })).toBe(false);
    expect(needsSetup({ setup: { complete: false }, localDone: true, calibration: "ok" })).toBe(true);
  });
  it("without the route: local record and calibration", () => {
    expect(needsSetup({ setup: null, localDone: false, calibration: "ok" })).toBe(true);
    expect(needsSetup({ setup: null, localDone: true, calibration: "ok" })).toBe(false);
    expect(needsSetup({ setup: null, localDone: true, calibration: "stale" })).toBe(true);
    expect(needsSetup({ setup: null, localDone: true, calibration: null })).toBe(false);
  });
  it("calibration done from the server step, else the live state", () => {
    expect(doneSteps({ sensorOk: false, setup: null, calibration: "ok", roomSaved: false }).has("calibrate")).toBe(true);
    expect(doneSteps({ sensorOk: false, setup: { steps: [{ id: "calibration", done: false }] }, calibration: "ok", roomSaved: false }).has("calibrate")).toBe(false);
    expect([...doneSteps({ sensorOk: true, setup: null, calibration: "none", roomSaved: true })]).toEqual(["sensor", "transmitter"]);
  });
});

describe("parseMetres and transmitterMoving", () => {
  it("parses metres within limits, comma decimals too", () => {
    expect(parseMetres("2,5", { min: 0.3, max: 8 })).toBe(2.5);
    expect(parseMetres("", { min: 0.3, max: 8 })).toBeNull();
    expect(parseMetres("9", { min: 0.3, max: 8 })).toBe("bad");
    expect(parseMetres("abc", { min: 0.3, max: 8 })).toBe("bad");
  });
  it("reads track A's quality_reasons when present", () => {
    const r = (reasons: unknown) => ({ position: { quality_reasons: reasons } }) as unknown as Result;
    expect(transmitterMoving(r(["transmitter_not_fixed"]))).toBe(true);
    expect(transmitterMoving(r(["no_distance_fit"]))).toBe(false);
    expect(transmitterMoving(r(undefined))).toBe(false);
    expect(transmitterMoving(null)).toBe(false);
  });
});
