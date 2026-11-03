import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../src/server/context";
import type { SpotsFile } from "../src/server/position-files";
import { runPython } from "../src/server/python";
import {
  buildSchedule,
  installCandidate,
  listSessions,
  parseMetrics,
  restoreModel,
  shouldPromote,
  spotsOverview,
  startTeach,
  startTraining,
  stopTeach,
  teachState,
  train,
  validateTeach,
  type TeachEnv,
  type TrainingState,
} from "../src/server/teach";

const root = mkdtempSync(join(tmpdir(), "lifefi-teach-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

/** A fresh data dir with a sessions folder; run() is a stub (vitest never runs Python). */
function mkEnv(run: TeachEnv["run"] = async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }), now = () => Date.now()): TeachEnv {
  const dataDir = join(root, `d${n++}`);
  mkdirSync(join(dataDir, "sessions"), { recursive: true });
  return { dataDir, sessionsDir: join(dataDir, "sessions"), root: join(__dirname, "..", ".."), now, run };
}

const LABELS = ["empty", "close", "middle", "far"];

function mkSession(env: TeachEnv, id: string, o: { tx?: string; spots?: boolean; csirec?: boolean; teach?: string; labels?: string[]; frames?: number } = {}) {
  const d = join(env.sessionsDir, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "session.json"), JSON.stringify({ session: id, started_us: 1_700_000_000_000_000, kind: "spots", ...(o.tx ? { transmitter: o.tx } : {}) }));
  if (o.csirec !== false) writeFileSync(join(d, `${id}.csirec`), "");
  if (o.spots !== false) {
    const spots = (o.labels ?? LABELS).map((name, i) => ({ name, d_m: name === "empty" ? 0 : i, t0_us: 1e15 + i * 50e6, t1_us: 1e15 + i * 50e6 + 45e6 }));
    writeFileSync(join(d, "spots.json"), JSON.stringify({ session: id, spots, ...(o.frames ? { frames: o.frames, t_start_us: 1e15, t_end_us: 1e15 + 200e6 } : {}) }));
  }
  if (o.teach) writeFileSync(join(d, "teach.json"), JSON.stringify({ state: "aborted", reason: o.teach }));
}

const model = (loso: number | null, labels = LABELS, extra: Record<string, unknown> = {}) => ({
  labels,
  distances: Object.fromEntries(labels.map((l) => [l, l === "empty" ? null : 1])),
  mu: [0],
  sd: [1],
  W: [[0]],
  b: [0],
  holdout_accuracy: 0.9,
  session: "a,b",
  trained_at: "2026-11-03T05:00:00",
  ...(loso === null ? {} : { loso_bal_acc: loso, loso_by_session: [loso, loso] }),
  ...extra,
});
const sf = (loso: number | null, k = 4) => ({ labels: LABELS.slice(0, k), loso_bal_acc: loso }) as SpotsFile;

type Sent = { type: string; args: Record<string, unknown> };
function mkCtx(o: { sent?: Sent[]; ack?: (type: string) => Record<string, unknown> } = {}) {
  const sent = o.sent ?? [];
  const ctx = {
    version: "0.1.0",
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    engine: {
      connected: true,
      send: vi.fn(async (type: string, args: Record<string, unknown> = {}) => {
        sent.push({ type, args });
        return { type: "ack", id: 1, ok: true, error: null, data: o.ack?.(type) ?? {} };
      }),
    },
    hub: { broadcast: vi.fn() },
    settings: { value: {} },
    watchdog: { isOffline: false },
    alerts: { openCount: () => 0 },
    state: {
      startedAt: 0,
      latest: { health: { rate_hz: 90 } },
      lastResultAt: Date.now(),
      engineStatus: null,
      source: { mode: "live", file: null, speed: 1, loop: false, state: "running", error: null },
      calibration: null,
      recording: null,
      presence: null,
    },
  };
  return { ctx: ctx as unknown as AppContext, raw: ctx, sent };
}

beforeEach(() => {
  const t = teachState();
  t.run = null;
  t.training = null;
});

describe("train_spots helpers", () => {
  it("parseMetrics takes the last METRICS line and rejects garbage", () => {
    expect(parseMetrics("x\nMETRICS {\"sessions\":[\"a\"],\"labels\":[\"x\"],\"loso_bal_acc\":null}\nMETRICS {\"sessions\":[\"b\"],\"labels\":[\"y\"]}\r\nsaved")?.sessions).toEqual(["b"]);
    expect(parseMetrics("METRICS {oops")).toBeNull();
    expect(parseMetrics("METRICS {\"a\":1}")).toBeNull();
    expect(parseMetrics("nothing")).toBeNull();
  });

  it("shouldPromote compares margin over chance and never installs without a cross-session score", () => {
    expect(shouldPromote(sf(null), null).promote).toBe(false);
    expect(shouldPromote(null, sf(0.5)).promote).toBe(false);
    expect(shouldPromote(sf(0.3), null).promote).toBe(true);
    expect(shouldPromote(sf(0.3), sf(null)).promote).toBe(true);
    expect(shouldPromote(sf(0.5), sf(0.4)).promote).toBe(true);
    expect(shouldPromote(sf(0.4), sf(0.4)).promote).toBe(true); // tie: the newer data wins
    const worse = shouldPromote(sf(0.31), sf(0.44));
    expect(worse.promote).toBe(false);
    expect(worse.reason).toContain("31 % vs 44 %");
    // 0.55 with 2 spots is 0.05 over chance; 0.40 with 4 spots is 0.15 over
    expect(shouldPromote(sf(0.55, 2), sf(0.4, 4)).promote).toBe(false);
    expect(shouldPromote(sf(0.4, 4), sf(0.55, 2)).promote).toBe(true);
  });

  it("listSessions: transmitter, stopped early, no .csirec, low rate, ignores other names", () => {
    const env = mkEnv();
    mkSession(env, "spots-20261103-010000", { tx: "fixed", frames: 18_000 });
    mkSession(env, "spots-20261103-020000");
    mkSession(env, "spots-20261103-030000", { spots: false, teach: "stopped by user" });
    mkSession(env, "spots-20261103-040000", { csirec: false });
    mkSession(env, "spots-20261103-050000", { tx: "phone", frames: 1000 });
    mkSession(env, "_invalid");
    mkSession(env, "spots-1");
    const s = listSessions(env.sessionsDir);
    expect(s.map((x) => x.id)).toEqual(["spots-20261103-010000", "spots-20261103-020000", "spots-20261103-030000", "spots-20261103-040000", "spots-20261103-050000"]);
    expect(s[0]).toMatchObject({ transmitter: "fixed", ok: true, rate_hz: 90, labels: ["close", "empty", "far", "middle"], started_ms: 1_700_000_000_000 });
    expect(s[1]).toMatchObject({ transmitter: "unknown", ok: true, rate_hz: null });
    expect(s[2]).toMatchObject({ ok: false, problem: "stopped early (no spots.json): stopped by user" });
    expect(s[3]).toMatchObject({ ok: false, problem: "no .csirec" });
    expect(s[4]).toMatchObject({ ok: false, transmitter: "phone", problem: "5 readings/s, too low" });
    expect(listSessions(join(env.dataDir, "missing"))).toEqual([]);
  });

  it("installCandidate keeps a backup; restore swaps them back", async () => {
    const env = mkEnv();
    writeFileSync(join(env.dataDir, "spots_model.json"), JSON.stringify(model(0.3)));
    writeFileSync(join(env.dataDir, "spots_model.candidate.json"), JSON.stringify(model(0.6)));
    await installCandidate(env);
    const read = (f: string) => JSON.parse(readFileSync(join(env.dataDir, f), "utf8")).loso_bal_acc;
    expect(read("spots_model.json")).toBe(0.6);
    expect(read("spots_model.prev.json")).toBe(0.3);
    expect(existsSync(join(env.dataDir, "spots_model.candidate.json"))).toBe(true);
    const { ctx, sent } = mkCtx({ ack: () => ({ spots: { labels: LABELS, loso_bal_acc: 0.3 } }) });
    const r = (await restoreModel(ctx, env)) as Record<string, { loso_bal_acc: number }>;
    expect(read("spots_model.json")).toBe(0.3);
    expect(read("spots_model.prev.json")).toBe(0.6);
    expect(r.model.loso_bal_acc).toBe(0.3);
    expect(r.engine_reloaded).toBe(true);
    expect(sent.map((s) => s.type)).toEqual(["reload_models"]);
  });

  it("restore without a backup is a 409", async () => {
    const res = (await restoreModel(mkCtx().ctx, mkEnv())) as Response;
    expect(res.status).toBe(409);
  });
});

describe("training", () => {
  const ids = ["spots-20261103-010000", "spots-20261103-020000"];
  const metricsLine = (loso: number | null) =>
    `saved\nMETRICS ${JSON.stringify({ sessions: ids, labels: LABELS, chance: 0.25, shrink: 0.1, how: "leave-one-session-out", split_bal_acc: 0.5, windows: {}, confusion: [], loso_bal_acc: loso, loso_by_session: loso === null ? null : [loso, loso] })}\n`;

  /** A train_spots.py stand-in: writes the candidate where --out says. */
  const fakeTrain = (loso: number | null, calls: string[][] = []): TeachEnv["run"] => async (args) => {
    calls.push(args);
    writeFileSync(args[args.indexOf("--out") + 1], JSON.stringify(model(loso)));
    return { code: 0, stdout: metricsLine(loso), stderr: "", timedOut: false };
  };

  async function waitDone() {
    for (let i = 0; i < 100 && teachState().training?.state === "running"; i++) await new Promise((r) => setTimeout(r, 5));
    return teachState().training!;
  }

  it("validates the session list", () => {
    const env = mkEnv();
    mkSession(env, ids[0], { tx: "fixed" });
    mkSession(env, ids[1], { tx: "fixed" });
    mkSession(env, "spots-20261103-030000", { spots: false });
    mkSession(env, "spots-20261103-040000", { labels: ["empty", "close", "far"] });
    const { ctx } = mkCtx();
    const status = (b: Record<string, unknown>) => startTraining(ctx, b, env).status;
    expect(status({ sessions: [ids[0]] })).toBe(400);
    expect(status({ sessions: [ids[0], "../../etc"] })).toBe(400);
    expect(status({ sessions: [ids[0], "spots-20261103-030000"] })).toBe(400);
    expect(status({ sessions: [ids[0], ids[0]] })).toBe(400);
    const differ = startTraining(ctx, { sessions: [ids[0], "spots-20261103-040000"] }, env);
    expect(differ.status).toBe(400);
  });

  it("a better model is installed, the engine reloads it, a second train is a 409 meanwhile", async () => {
    const env = mkEnv(fakeTrain(0.6));
    for (const id of ids) mkSession(env, id, { tx: "fixed" });
    writeFileSync(join(env.dataDir, "spots_model.json"), JSON.stringify(model(0.3)));
    const { ctx, sent } = mkCtx({ ack: () => ({ spots: { labels: LABELS, loso_bal_acc: 0.6 } }) });
    const res = startTraining(ctx, { sessions: ids }, env);
    expect(res.status).toBe(202);
    expect(startTraining(ctx, { sessions: ids }, env).status).toBe(409);
    const job = await waitDone();
    expect(job.state).toBe("done");
    expect(job.result).toMatchObject({ promoted: true, engine_reloaded: true });
    expect(job.result!.model).toMatchObject({ loso_bal_acc: 0.6, chance: 0.25, reliable: true });
    expect(JSON.parse(readFileSync(join(env.dataDir, "spots_model.prev.json"), "utf8")).loso_bal_acc).toBe(0.3);
    expect(sent.map((s) => s.type)).toEqual(["reload_models"]);
    const o = spotsOverview(ctx, env);
    expect(o.model?.loso_bal_acc).toBe(0.6);
    expect(o.previous?.loso_bal_acc).toBe(0.3);
    expect(o.margin).toBe(0.15);
  });

  it("a worse model is not installed; the args are built from session ids only", async () => {
    const calls: string[][] = [];
    const env = mkEnv(fakeTrain(0.2, calls));
    for (const id of ids) mkSession(env, id);
    writeFileSync(join(env.dataDir, "spots_model.json"), JSON.stringify(model(0.5)));
    startTraining(mkCtx().ctx, { sessions: ids }, env);
    const job = await waitDone();
    expect(job.result).toMatchObject({ promoted: false, engine_reloaded: false });
    expect(job.result!.reason).toContain("worse");
    expect(JSON.parse(readFileSync(join(env.dataDir, "spots_model.json"), "utf8")).loso_bal_acc).toBe(0.5);
    expect(existsSync(join(env.dataDir, "spots_model.prev.json"))).toBe(false);
    expect(calls[0]).toEqual(["ml/train_spots.py", "--out", join(env.dataDir, "spots_model.candidate.json"), "--json", ...ids.map((id) => join(env.sessionsDir, id))]);
  });

  it("a failing or timed-out script fails the job with its last stderr lines", async () => {
    const env = mkEnv(async () => ({ code: 2, stdout: "", stderr: "Traceback\nlabels differ between sessions: x", timedOut: false }));
    const job: TrainingState = { state: "running", sessions: ids, started_ms: 0, ended_ms: null, result: null, error: null };
    await train(mkCtx().ctx, job, env);
    expect(job).toMatchObject({ state: "failed", error: "Traceback\nlabels differ between sessions: x" });
    const env2 = mkEnv(async () => ({ code: null, stdout: "", stderr: "", timedOut: true }));
    await train(mkCtx().ctx, job, env2);
    expect(job.error).toContain("longer than 180 s");
  });
});

describe("runPython", () => {
  class FakeChild extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    pid = 4242;
  }

  it("collects output and the exit code, no shell, hidden window, utf-8", async () => {
    let opts: Record<string, unknown> = {};
    const p = runPython(["ml/train_spots.py"], {
      python: "py",
      root: "/repo",
      spawnFn: (_cmd, _args, o) => {
        opts = o;
        const c = new FakeChild();
        setTimeout(() => {
          c.stdout.emit("data", Buffer.from("METRICS {}\n"));
          c.emit("close", 0);
        }, 1);
        return c as unknown as ChildProcess;
      },
    });
    expect(await p).toEqual({ code: 0, stdout: "METRICS {}\n", stderr: "", timedOut: false });
    expect(opts).toMatchObject({ cwd: "/repo", windowsHide: true, shell: false });
    expect((opts.env as Record<string, string>).PYTHONIOENCODING).toBe("utf-8");
  });

  it("kills a script that never ends", async () => {
    const killed: number[] = [];
    const r = await runPython(["x"], {
      python: "py",
      timeoutMs: 10,
      spawnFn: () => new FakeChild() as unknown as ChildProcess,
      killFn: (c) => {
        killed.push(c.pid!);
        (c as unknown as FakeChild).emit("close", null);
      },
    });
    expect(killed).toEqual([4242]);
    expect(r).toMatchObject({ code: null, timedOut: true });
  });
});

describe("teach run", () => {
  const opt = { distances: { close: 0.5, middle: 1.5, far: 3 }, rounds: 2 as const };

  it("buildSchedule: lead, empty, both rounds with a walk between every hold, empty, end; contiguous", () => {
    const s = buildSchedule(opt, 1000);
    expect(s.map((x) => (x.kind === "hold" ? x.name : x.kind)).filter((k) => k !== "walk")).toEqual(["lead", "empty", "close", "middle", "far", "far", "middle", "close", "empty", "end"]);
    s.forEach((x, i) => i && expect(x.t0_ms).toBe(s[i - 1].t1_ms));
    expect(s.at(-1)!.t1_ms - 1000).toBe(490_000);
    for (let i = 1; i < s.length; i++) if (s[i].kind === "hold") expect(s[i - 1].kind).toBe("walk");
    expect(s.every((x) => x.say.length > 0)).toBe(true);
    expect(buildSchedule({ ...opt, rounds: 1 }, 0).at(-1)!.t1_ms).toBe(325_000);
  });

  it("validateTeach", () => {
    expect(validateTeach({ distances: opt.distances, rounds: 2, transmitter: "fixed" })).toMatchObject({ rounds: 2 });
    expect(validateTeach({ distances: { ...opt.distances, far: 11 }, rounds: 2, transmitter: "fixed" })).toContain("far");
    expect(validateTeach({ distances: opt.distances, rounds: 3, transmitter: "fixed" })).toContain("rounds");
    expect(validateTeach({ distances: opt.distances, rounds: 1 })).toContain("transmitter");
  });

  describe("with fake timers", () => {
    const T0 = new Date(2026, 10, 3, 7, 0, 0).getTime();
    let env: TeachEnv;
    beforeEach(() => {
      vi.useFakeTimers({ now: T0 });
      env = mkEnv(undefined, () => Date.now());
    });
    afterEach(() => vi.useRealTimers());
    const body = { distances: opt.distances, rounds: 1, transmitter: "fixed" };

    /** Advances time in 500 ms ticks, the board sending results all along (unless `board` is false). */
    async function advance(ctx: ReturnType<typeof mkCtx>["raw"], ms: number, board = true) {
      for (let t = 0; t < ms; t += 500) {
        if (board) ctx.state.lastResultAt = Date.now();
        await vi.advanceTimersByTimeAsync(500);
      }
    }

    it("a full run writes spots.json with the empty and hold steps at the schedule times", async () => {
      const { ctx, raw, sent } = mkCtx({ ack: (t) => (t === "record_stop" ? { frames: 27_000, t_start_us: T0 * 1000, t_end_us: (T0 + 325_000) * 1000 } : {}) });
      const st = (await startTeach(ctx, body, env)) as Exclude<Awaited<ReturnType<typeof startTeach>>, Response>;
      expect(st.session).toBe("spots-20261103-070000");
      expect(sent[0]).toMatchObject({ type: "record_start", args: { session: st.session, meta: { kind: "spots", transmitter: "fixed", protocol: "teach-v1", rounds: 1 } } });
      expect((sent[0].args.meta as Record<string, unknown>).session).toBeUndefined();
      expect(raw.state.recording).toMatchObject({ session: st.session });
      // second start while running: 409
      expect(((await startTeach(ctx, body, env)) as Response).status).toBe(409);
      await advance(raw, 100_000);
      expect(teachState().run!.index).toBeGreaterThan(2);
      await advance(raw, 227_000);
      const run = teachState().run!;
      expect(run.state).toBe("done");
      expect(sent.at(-1)!.type).toBe("record_stop");
      expect(raw.state.recording).toBeNull();
      const spec = JSON.parse(readFileSync(join(env.sessionsDir, st.session, "spots.json"), "utf8"));
      const labelled = st.steps.filter((s) => s.kind === "empty" || s.kind === "hold");
      expect(spec.spots).toEqual(labelled.map((s) => ({ name: s.name, d_m: s.kind === "empty" ? 0 : s.d_m, t0_us: s.t0_ms * 1000, t1_us: s.t1_ms * 1000 })));
      expect(spec.spots.map((s: { name: string }) => s.name)).toEqual(["empty", "close", "middle", "far", "empty"]);
      expect(spec).toMatchObject({ session: st.session, frames: 27_000, protocol: "teach-v1", transmitter: "fixed" });
      const session = JSON.parse(readFileSync(join(env.sessionsDir, st.session, "session.json"), "utf8"));
      expect(session).toMatchObject({ session: st.session, transmitter: "fixed", kind: "spots" });
      writeFileSync(join(env.sessionsDir, st.session, `${st.session}.csirec`), ""); // the engine writes it
      expect(listSessions(env.sessionsDir)[0]).toMatchObject({ ok: true, transmitter: "fixed", rate_hz: 83.1 });
    });

    it("stop: record_stop, teach.json, no spots.json", async () => {
      const { ctx, raw, sent } = mkCtx();
      const st = (await startTeach(ctx, body, env)) as { session: string };
      await advance(raw, 30_000);
      const r = (await stopTeach()) as { state: string; reason: string };
      expect(r).toMatchObject({ state: "aborted", reason: "stopped by user" });
      expect(sent.at(-1)!.type).toBe("record_stop");
      const d = join(env.sessionsDir, st.session);
      expect(existsSync(join(d, "spots.json"))).toBe(false);
      expect(JSON.parse(readFileSync(join(d, "teach.json"), "utf8"))).toMatchObject({ state: "aborted", reason: "stopped by user" });
      expect(((await stopTeach()) as Response).status).toBe(409);
    });

    it("the board goes quiet for 10 s: aborted", async () => {
      const { ctx, raw } = mkCtx();
      await startTeach(ctx, body, env);
      await advance(raw, 20_000);
      await advance(raw, 11_000, false);
      expect(teachState().run).toMatchObject({ state: "aborted", reason: "no readings from the board for 10 s" });
    });

    it("the recording is stopped from elsewhere: aborted, no record_stop sent by the run", async () => {
      const { ctx, raw, sent } = mkCtx();
      await startTeach(ctx, body, env);
      raw.state.recording = null;
      await advance(raw, 1000);
      expect(teachState().run).toMatchObject({ state: "aborted", reason: "the recording was stopped outside this page" });
      expect(sent.map((s) => s.type)).toEqual(["record_start"]);
    });

    it("refuses to start when not ready, and training refuses while a run is active", async () => {
      const { ctx, raw } = mkCtx();
      raw.state.source.mode = "replay";
      expect(((await startTeach(ctx, body, env)) as Response).status).toBe(409);
      raw.state.source.mode = "live";
      raw.engine.connected = false;
      expect(((await startTeach(ctx, body, env)) as Response).status).toBe(409);
      raw.engine.connected = true;
      expect(((await startTeach(ctx, { ...body, rounds: 5 }, env)) as Response).status).toBe(400);
      await startTeach(ctx, body, env);
      expect(startTraining(ctx, { sessions: ["a", "b"] }, env).status).toBe(409);
    });
  });
});
