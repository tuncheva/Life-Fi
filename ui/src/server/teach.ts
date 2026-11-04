// "Teach spots" (/teach): records one labelled spots session with server-side timing, lists
// the sessions, trains the spot model on chosen ones (ml/train_spots.py) and installs it only
// when it is not worse than the current one. Files are the CLI's (ml/record_spots.py,
// ml/train_spots.py), so both agree:
//   <sessions>/spots-YYYYMMDD-HHMMSS/  .csirec (engine), session.json, spots.json (complete run
//                                      only), teach.json (why a run stopped early)
//   <data>/spots_model.json            the model the engine loads
//   <data>/spots_model.prev.json       the one it replaced (Restore previous)
//   <data>/spots_model.candidate.json  the last training output
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { config, repoRoot } from "./config";
import type { AppContext } from "./context";
import { fail, inRange, type Body } from "./http";
import { readSpotsFile, type SpotsFile } from "./position-files";
import { runPython, type PyResult } from "./python";
import { broadcastStatus, sessionsDir, startRecording, stopRecording } from "./recordings";

export const SESSION_ID = /^spots-\d{8}-\d{6}$/;
/** Fixed: ml/eval_position.py knows these four, and every session must share one label set. */
export const SPOT_NAMES = ["close", "middle", "far"] as const;
export type SpotName = (typeof SPOT_NAMES)[number];
export const LEAD_S = 20;
export const EMPTY_S = 60;
export const HOLD_S = 45;
export const WALK_S = 10;
/** Walking in from outside, or out of the room. */
export const ENTER_S = 15;
export const TRAIN_TIMEOUT_MS = 180_000;
/** Packets per second a spot window needs (lifefi/spots.py: 40 packets in 2 s). */
export const MIN_RATE_HZ = 20;

export interface TeachEnv {
  dataDir: string;
  sessionsDir: string;
  root: string;
  now: () => number;
  run: (args: string[], opt: { timeoutMs: number }) => Promise<PyResult>;
}

export const defaultEnv = (): TeachEnv => ({
  dataDir: config.dataDir,
  sessionsDir: sessionsDir(),
  root: repoRoot,
  now: () => Date.now(),
  run: (args, opt) => runPython(args, opt),
});

const modelPath = (env: TeachEnv) => join(env.dataDir, "spots_model.json");
const prevPath = (env: TeachEnv) => join(env.dataDir, "spots_model.prev.json");
const candidatePath = (env: TeachEnv) => join(env.dataDir, "spots_model.candidate.json");

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// ---- models -----------------------------------------------------------------------------

/** rules.yaml spots.reliable_margin (the engine's), default 0.15. */
export function readMargin(root = repoRoot): number {
  try {
    const r = YAML.parse(readFileSync(join(root, "engine", "config", "rules.yaml"), "utf8")) as { spots?: { reliable_margin?: unknown } };
    return num(r?.spots?.reliable_margin) ?? 0.15;
  } catch {
    return 0.15;
  }
}

export interface ModelSummary extends SpotsFile {
  /** 1/k: what guessing scores */
  chance: number;
  /** chance + margin: the cross-session score the engine needs to name spots */
  bar: number;
  reliable: boolean;
  sessions: string[];
}

export function summarize(f: SpotsFile | null, margin: number): ModelSummary | null {
  if (!f || !f.labels.length) return null;
  const chance = 1 / f.labels.length;
  return {
    ...f,
    chance,
    bar: chance + margin,
    // the same rule as lifefi/spots.py reliable(): only the cross-session score counts
    reliable: f.loso_bal_acc !== null && f.loso_bal_acc >= chance + margin,
    sessions: f.session ? f.session.split(",").filter(Boolean) : [],
  };
}

/**
 * Install the candidate? Compared by margin over chance, so models with different spot
 * sets compare fairly. Never a model without a cross-session score; ties install (the
 * newer data wins).
 */
export function shouldPromote(cand: SpotsFile | null, cur: SpotsFile | null): { promote: boolean; reason: string } {
  const pct = (v: number) => `${Math.floor(v * 100)} %`;
  if (!cand || cand.loso_bal_acc === null) return { promote: false, reason: "not installed: the new model has no cross-session score (it needs 2 or more sessions)" };
  if (!cur || cur.loso_bal_acc === null) return { promote: true, reason: "installed: the current model had no cross-session score" };
  const over = (f: SpotsFile) => f.loso_bal_acc! - 1 / f.labels.length;
  if (over(cand) >= over(cur)) return { promote: true, reason: `installed: ${pct(cand.loso_bal_acc)} across sessions (current ${pct(cur.loso_bal_acc)})` };
  return { promote: false, reason: `not installed: worse than the current model (${pct(cand.loso_bal_acc)} vs ${pct(cur.loso_bal_acc)} across sessions, compared over chance)` };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Writes `bytes` to `<dst>.tmp`, then renames it over `dst` (the engine never reads half a file). Windows may refuse once while a reader has it open. */
async function replaceFile(dst: string, bytes: Buffer): Promise<void> {
  const tmp = `${dst}.tmp`;
  writeFileSync(tmp, bytes);
  try {
    renameSync(tmp, dst);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EBUSY") throw err;
    await sleep(200);
    renameSync(tmp, dst);
  }
}

/** current → .prev.json, candidate → spots_model.json. */
export async function installCandidate(env: TeachEnv): Promise<void> {
  const cand = readFileSync(candidatePath(env));
  if (existsSync(modelPath(env))) await replaceFile(prevPath(env), readFileSync(modelPath(env)));
  await replaceFile(modelPath(env), cand);
}

/** Swaps spots_model.json and .prev.json. */
export async function restorePrevious(env: TeachEnv): Promise<void> {
  const prev = readFileSync(prevPath(env));
  const cur = existsSync(modelPath(env)) ? readFileSync(modelPath(env)) : null;
  await replaceFile(modelPath(env), prev);
  if (cur) await replaceFile(prevPath(env), cur);
}

// ---- sessions ---------------------------------------------------------------------------

export interface SessionInfo {
  id: string;
  started_ms: number | null;
  /** "unknown": recorded before /teach (ml/record_spots.py) */
  transmitter: "fixed" | "phone" | "unknown";
  protocol: string | null;
  /** spot names in this session (empty included), sorted */
  labels: string[];
  distances: Record<string, number>;
  /** labelled span, first spot start to last spot end */
  duration_s: number | null;
  frames: number | null;
  rate_hz: number | null;
  ok: boolean;
  problem: string | null;
}

export function listSessions(dir: string): SessionInfo[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: SessionInfo[] = [];
  for (const id of names.filter((n) => SESSION_ID.test(n)).sort()) {
    const d = join(dir, id);
    try {
      if (!statSync(d).isDirectory()) continue;
    } catch {
      continue;
    }
    const meta = readJson(join(d, "session.json")) ?? {};
    const spec = readJson(join(d, "spots.json"));
    const spots = Array.isArray(spec?.spots) ? (spec.spots as Record<string, unknown>[]) : [];
    const t0 = Math.min(...spots.map((s) => num(s.t0_us) ?? Infinity));
    const t1 = Math.max(...spots.map((s) => num(s.t1_us) ?? -Infinity));
    const frames = num(spec?.frames);
    const span = (num(spec?.t_end_us) ?? 0) - (num(spec?.t_start_us) ?? 0);
    const rate = frames !== null && span > 0 ? frames / (span / 1e6) : null;
    const tx = meta.transmitter;
    let problem: string | null = null;
    if (!spec) {
      const teach = readJson(join(d, "teach.json"));
      problem = `stopped early (no spots.json)${typeof teach?.reason === "string" ? `: ${teach.reason}` : ""}`;
    } else if (!readdirSync(d).some((f) => f.endsWith(".csirec"))) problem = "no .csirec";
    else if (!spots.length) problem = "spots.json lists no spots";
    else if (rate !== null && rate < MIN_RATE_HZ) problem = `${Math.round(rate)} readings/s, too low`;
    const distances: Record<string, number> = {};
    for (const s of spots) if (typeof s.name === "string" && s.name !== "empty" && num(s.d_m) !== null) distances[s.name] = num(s.d_m)!;
    out.push({
      id,
      started_ms: num(meta.started_us) !== null ? Math.round(num(meta.started_us)! / 1000) : null,
      transmitter: tx === "fixed" || tx === "phone" ? tx : "unknown",
      protocol: typeof meta.protocol === "string" ? meta.protocol : null,
      labels: [...new Set(spots.map((s) => s.name).filter((n): n is string => typeof n === "string"))].sort(),
      distances,
      duration_s: Number.isFinite(t0) && Number.isFinite(t1) ? Math.round((t1 - t0) / 1e6) : null,
      frames,
      rate_hz: rate === null ? null : Math.round(rate * 10) / 10,
      ok: problem === null,
      problem,
    });
  }
  return out;
}

// ---- training ---------------------------------------------------------------------------

/** The METRICS line of ml/train_spots.py --json. */
export interface Metrics {
  sessions: string[];
  labels: string[];
  chance: number;
  shrink: number;
  how: string;
  split_bal_acc: number;
  windows: Record<string, Record<string, number>>;
  confusion: number[][];
  loso_bal_acc: number | null;
  loso_by_session: number[] | null;
}

/** The last `METRICS {json}` line, or null. */
export function parseMetrics(stdout: string): Metrics | null {
  const line = stdout.split(/\r?\n/).filter((l) => l.startsWith("METRICS ")).pop();
  if (!line) return null;
  try {
    const m = JSON.parse(line.slice("METRICS ".length)) as Metrics;
    return m && Array.isArray(m.labels) && Array.isArray(m.sessions) ? m : null;
  } catch {
    return null;
  }
}

export interface TrainResult {
  metrics: Metrics;
  promoted: boolean;
  reason: string;
  /** the engine answered reload_models with the installed model */
  engine_reloaded: boolean;
  candidate: ModelSummary | null;
  model: ModelSummary | null;
}

export interface TrainingState {
  state: "running" | "done" | "failed";
  sessions: string[];
  started_ms: number;
  ended_ms: number | null;
  result: TrainResult | null;
  error: string | null;
}

// ---- the run ----------------------------------------------------------------------------

export interface Step {
  id: number;
  kind: "lead" | "empty" | "walk" | "hold" | "end";
  name: string | null;
  d_m: number | null;
  t0_ms: number;
  t1_ms: number;
  say: string;
}

export interface TeachOptions {
  distances: Record<SpotName, number>;
  rounds: 1 | 2;
  transmitter: "fixed" | "phone";
}

const metres = (d: number) => `${d} ${d === 1 ? "metre" : "metres"}`;

/**
 * The whole session: lead, empty, the spots (round 2 in reverse, so a spot is not tied to the
 * time it was recorded), empty again, end. Always a walk between two holds: a re-entered spot
 * is a new visit. Only empty and hold steps are labelled.
 */
export function buildSchedule(opt: Pick<TeachOptions, "distances" | "rounds">, startMs: number): Step[] {
  const steps: Step[] = [];
  let t = startMs;
  const add = (kind: Step["kind"], s: number, say: string, name: string | null = null, d_m: number | null = null) => {
    steps.push({ id: steps.length, kind, name, d_m, t0_ms: t, t1_ms: t + s * 1000, say });
    t += s * 1000;
  };
  add("lead", LEAD_S, `Leave the room and close the door. Empty room recording starts in ${LEAD_S} seconds.`);
  add("empty", EMPTY_S, `Recording the empty room. Stay outside for ${EMPTY_S} seconds.`, "empty", 0);
  const order = opt.rounds === 2 ? [...SPOT_NAMES, ...[...SPOT_NAMES].reverse()] : [...SPOT_NAMES];
  order.forEach((name, i) => {
    const d = opt.distances[name];
    if (i === 0) add("walk", ENTER_S, `Come in and stand at ${name}, ${metres(d)} from the sensor.`, name, d);
    else if (order[i - 1] === name) add("walk", WALK_S, `Step away, then come back to ${name}, ${metres(d)}.`, name, d);
    else add("walk", WALK_S, `Stop. Go to ${name}, ${metres(d)}.`, name, d);
    add("hold", HOLD_S, `Recording ${name}. Stay there, move normally, ${HOLD_S} seconds.`, name, d);
  });
  add("walk", ENTER_S, "Leave the room and close the door.");
  add("empty", EMPTY_S, `Recording the empty room again. Stay outside for ${EMPTY_S} seconds.`, "empty", 0);
  add("end", 0, "All done. You can come back.");
  return steps;
}

/** The POST /spots/teach body, or an error message. */
export function validateTeach(b: Body): TeachOptions | string {
  const d = (b.distances && typeof b.distances === "object" ? b.distances : {}) as Record<string, unknown>;
  const distances = {} as Record<SpotName, number>;
  for (const n of SPOT_NAMES) {
    const v = inRange(d[n], 0.2, 10);
    if (v === null) return `distances.${n} must be 0.2 to 10 m`;
    distances[n] = Math.round(v * 100) / 100;
  }
  if (b.rounds !== 1 && b.rounds !== 2) return "rounds must be 1 or 2";
  if (b.transmitter !== "fixed" && b.transmitter !== "phone") return "transmitter must be fixed or phone";
  return { distances, rounds: b.rounds, transmitter: b.transmitter };
}

export interface RunState {
  session: string;
  state: "running" | "done" | "aborted";
  reason: string | null;
  server_now_ms: number;
  transmitter: "fixed" | "phone";
  rounds: 1 | 2;
  steps: Step[];
  index: number;
  started_ms: number;
  ends_ms: number;
  frames: number | null;
}

/** Abort when no result for this long, or the rate stays under BOARD_MIN_HZ this long. */
const BOARD_GONE_MS = 10_000;
const BOARD_MIN_HZ = 10;
const ENGINE_GONE_MS = 5000;

export class TeachRun {
  state: RunState["state"] = "running";
  reason: string | null = null;
  index = 0;
  frames: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private engineLostAt: number | null = null;
  private lowSince: number | null = null;

  constructor(
    private readonly ctx: AppContext,
    readonly session: string,
    readonly opt: TeachOptions,
    readonly steps: Step[],
    private readonly dir: string,
    private readonly env: TeachEnv,
  ) {}

  get started_ms() {
    return this.steps[0].t0_ms;
  }

  get ends_ms() {
    return this.steps[this.steps.length - 1].t1_ms;
  }

  view(): RunState {
    return {
      session: this.session,
      state: this.state,
      reason: this.reason,
      server_now_ms: this.env.now(),
      transmitter: this.opt.transmitter,
      rounds: this.opt.rounds,
      steps: this.steps,
      index: this.index,
      started_ms: this.started_ms,
      ends_ms: this.ends_ms,
      frames: this.frames,
    };
  }

  begin(intervalMs = 500): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  /** Advances the step, finishes at the end, aborts when the session can no longer be trusted. */
  async tick(): Promise<void> {
    if (this.busy || this.state !== "running") return;
    this.busy = true;
    try {
      const now = this.env.now();
      const st = this.ctx.state;
      if (st.recording?.session !== this.session) return await this.abort("the recording was stopped outside this page", false);
      if (st.source.mode !== "live") return await this.abort("the source is no longer live");
      if (!this.ctx.engine.connected) {
        this.engineLostAt ??= now;
        if (now - this.engineLostAt > ENGINE_GONE_MS) return await this.abort("the engine disconnected");
      } else this.engineLostAt = null;
      const since = Math.max(st.lastResultAt ?? 0, this.started_ms);
      if (now - since > BOARD_GONE_MS) return await this.abort("no readings from the board for 10 s");
      const rate = st.latest?.health.rate_hz;
      if (typeof rate === "number" && rate < BOARD_MIN_HZ) {
        this.lowSince ??= now;
        if (now - this.lowSince > BOARD_GONE_MS) return await this.abort(`signal too weak (${Math.round(rate)} readings/s) for 10 s`);
      } else this.lowSince = null;
      if (now >= this.ends_ms) return await this.finish();
      while (this.index < this.steps.length - 1 && this.steps[this.index + 1].t0_ms <= now) this.index++;
    } finally {
      this.busy = false;
    }
  }

  private clear(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Stops the recording, writes teach.json and never spots.json. */
  async abort(reason: string, ours = true): Promise<void> {
    if (this.state !== "running") return;
    this.clear();
    this.state = "aborted";
    this.reason = reason;
    if (ours && this.ctx.state.recording?.session === this.session) {
      try {
        await stopRecording(this.ctx);
      } catch (err) {
        // the engine is gone: it has nothing open any more either
        this.ctx.log.warn({ session: this.session, err: (err as Error).message }, "teach: record_stop failed");
        this.ctx.state.recording = null;
        broadcastStatus(this.ctx);
      }
    }
    writeFileSync(join(this.dir, "teach.json"), JSON.stringify({ session: this.session, state: "aborted", reason, at_ms: this.env.now() }, null, 2) + "\n");
    this.ctx.log.info({ session: this.session, reason }, "teach run aborted");
  }

  private async finish(): Promise<void> {
    let data: Record<string, unknown>;
    try {
      data = await stopRecording(this.ctx);
    } catch (err) {
      return this.abort(`could not stop the recording: ${(err as Error).message}`, false);
    }
    this.clear();
    this.frames = num(data.frames);
    this.index = this.steps.length - 1;
    // record_spots.py's shape (host-clock µs), plus keys the scripts ignore
    const spots = this.steps
      .filter((s) => s.kind === "empty" || s.kind === "hold")
      .map((s) => ({ name: s.name, d_m: s.kind === "empty" ? 0.0 : s.d_m, t0_us: s.t0_ms * 1000, t1_us: s.t1_ms * 1000 }));
    writeFileSync(
      join(this.dir, "spots.json"),
      JSON.stringify(
        { session: this.session, spots, frames: this.frames, t_start_us: num(data.t_start_us), t_end_us: num(data.t_end_us), protocol: "teach-v1", transmitter: this.opt.transmitter },
        null,
        2,
      ) + "\n",
    );
    this.state = "done";
    this.ctx.log.info({ session: this.session, frames: this.frames }, "teach run done");
  }
}

// ---- the singleton (a dev hot reload keeps the run, like the runtime) --------------------

const KEY = Symbol.for("lifefi.teach");
type Teach = { run: TeachRun | null; training: TrainingState | null };
export function teachState(): Teach {
  const g = globalThis as { [KEY]?: Teach };
  return (g[KEY] ??= { run: null, training: null });
}

const running = (t: Teach) => t.run?.state === "running";
const training = (t: Teach) => t.training?.state === "running";

/** Local time id, as ml/record_spots.py makes it. */
export function sessionId(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `spots-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface Check {
  id: string;
  ok: boolean;
  label: string;
}

/** What must hold before a run starts; the page shows them, POST /spots/teach refuses on the first failing one. */
export function readiness(ctx: AppContext, t: Teach, now: number): Check[] {
  const st = ctx.state;
  const fresh = st.lastResultAt !== null && now - st.lastResultAt < 5000;
  const rate = fresh ? st.latest?.health.rate_hz : undefined;
  return [
    { id: "engine", ok: ctx.engine.connected, label: ctx.engine.connected ? "Engine connected" : "Engine not connected" },
    { id: "source", ok: st.source.mode === "live", label: st.source.mode === "live" ? "Source is the live board" : "Source is a replay: switch to live" },
    {
      id: "board",
      ok: typeof rate === "number" && rate >= MIN_RATE_HZ,
      label: typeof rate === "number" ? `${Math.round(rate)} readings/s${rate >= MIN_RATE_HZ ? "" : ` (needs ${MIN_RATE_HZ})`}` : "No readings from the board",
    },
    { id: "recording", ok: !st.recording, label: st.recording ? `Recording '${st.recording.session}' is running` : "No other recording" },
    { id: "busy", ok: !running(t) && !training(t), label: running(t) ? "A teach run is active" : training(t) ? "Training is running" : "Not training" },
    { id: "calibration", ok: st.calibration?.state !== "running", label: st.calibration?.state === "running" ? "A calibration is running" : "No calibration running" },
  ];
}

// ---- route handlers (thin routes in app/api/v1/spots/**) ----------------------------------

export function spotsOverview(ctx: AppContext, env = defaultEnv()) {
  const t = teachState();
  const margin = readMargin(env.root);
  return {
    margin,
    model: summarize(readSpotsFile(modelPath(env)), margin),
    previous: summarize(readSpotsFile(prevPath(env)), margin),
    candidate: summarize(readSpotsFile(candidatePath(env)), margin),
    sessions: listSessions(env.sessionsDir),
    readiness: readiness(ctx, t, env.now()),
    teach: t.run?.view() ?? null,
    training: t.training,
    spot_names: SPOT_NAMES,
    timing: { lead_s: LEAD_S, empty_s: EMPTY_S, hold_s: HOLD_S, walk_s: WALK_S, enter_s: ENTER_S },
  };
}

export async function startTeach(ctx: AppContext, body: Body, env = defaultEnv()): Promise<Response | RunState> {
  const opt = validateTeach(body);
  if (typeof opt === "string") return fail(400, "bad_request", opt);
  const t = teachState();
  const bad = readiness(ctx, t, env.now()).find((c) => !c.ok);
  if (bad) return fail(409, "conflict", bad.label);
  const session = sessionId(env.now());
  const dir = join(env.sessionsDir, session);
  if (existsSync(dir)) return fail(409, "conflict", `session ${session} already exists; try again in a second`);
  const meta = {
    kind: "spots",
    transmitter: opt.transmitter,
    protocol: "teach-v1",
    spots: SPOT_NAMES.map((name) => ({ name, d_m: opt.distances[name] })),
    hold_s: HOLD_S,
    empty_s: EMPTY_S,
    gap_s: WALK_S,
    rounds: opt.rounds,
  };
  await startRecording(ctx, session, meta, dir); // an engine error is answered by write()
  // after the ack: the schedule's clock is the one the engine stamps host_us with
  const run = new TeachRun(ctx, session, opt, buildSchedule(opt, env.now()), dir, env);
  t.run = run;
  run.begin();
  return run.view();
}

export async function stopTeach(): Promise<Response | RunState> {
  const run = teachState().run;
  if (!run || run.state !== "running") return fail(409, "conflict", "no teach run is active");
  await run.abort("stopped by user");
  return run.view();
}

export function startTraining(ctx: AppContext, body: Body, env = defaultEnv()): Response {
  const t = teachState();
  if (running(t)) return fail(409, "conflict", "a teach run is active");
  if (training(t)) return fail(409, "conflict", "training is already running");
  const ids = Array.isArray(body.sessions) ? body.sessions : null;
  if (!ids || ids.length < 2 || !ids.every((s) => typeof s === "string")) return fail(400, "bad_request", "sessions must list 2 or more session ids");
  const byId = new Map(listSessions(env.sessionsDir).map((s) => [s.id, s]));
  const chosen = (ids as string[]).map((id) => byId.get(id));
  const unknown = (ids as string[]).filter((id, i) => !SESSION_ID.test(id) || !chosen[i]?.ok);
  if (unknown.length) return fail(400, "bad_request", `not a usable session: ${unknown.join(", ")}`);
  if (new Set(ids).size !== ids.length) return fail(400, "bad_request", "a session is listed twice");
  const sets = chosen.map((s) => s!.labels.join(","));
  if (sets.some((x) => x !== sets[0])) return fail(400, "bad_request", `labels differ between sessions: ${chosen.map((s) => `${s!.id} ${s!.labels.join(",")}`).join("; ")}`);

  const job: TrainingState = { state: "running", sessions: ids as string[], started_ms: env.now(), ended_ms: null, result: null, error: null };
  t.training = job;
  void train(ctx, job, env);
  return Response.json({ training: job }, { status: 202 });
}

const tail = (s: string, n: number) => s.trim().split(/\r?\n/).slice(-n).join("\n");

/** Runs train_spots.py, installs the candidate when shouldPromote says so, reloads the engine. Never throws: the job carries the outcome. */
export async function train(ctx: AppContext, job: TrainingState, env: TeachEnv): Promise<void> {
  const end = (patch: Partial<TrainingState>) => Object.assign(job, { ended_ms: env.now(), ...patch });
  try {
    const out = candidatePath(env);
    const r = await env.run(["ml/train_spots.py", "--out", out, "--json", ...job.sessions.map((id) => join(env.sessionsDir, id))], { timeoutMs: TRAIN_TIMEOUT_MS });
    if (r.timedOut) return void end({ state: "failed", error: `training took longer than ${TRAIN_TIMEOUT_MS / 1000} s and was stopped` });
    const metrics = parseMetrics(r.stdout);
    if (r.code !== 0 || !metrics) return void end({ state: "failed", error: tail(r.stderr || r.stdout, 20) || `train_spots.py exited with ${r.code}` });
    const margin = readMargin(env.root);
    const cand = readSpotsFile(out);
    const decision = shouldPromote(cand, readSpotsFile(modelPath(env)));
    let engine_reloaded = false;
    if (decision.promote) {
      await installCandidate(env);
      engine_reloaded = await reloadEngine(ctx, cand);
    }
    ctx.log.info({ sessions: job.sessions, loso_bal_acc: metrics.loso_bal_acc, promoted: decision.promote }, "spot model trained");
    end({
      state: "done",
      result: { metrics, promoted: decision.promote, reason: decision.reason, engine_reloaded, candidate: summarize(cand, margin), model: summarize(readSpotsFile(modelPath(env)), margin) },
    });
  } catch (err) {
    ctx.log.error({ err: (err as Error).message }, "spot training failed");
    end({ state: "failed", error: (err as Error).message });
  }
}

/** reload_models; true when the engine answers with the model just installed. */
async function reloadEngine(ctx: AppContext, f: SpotsFile | null): Promise<boolean> {
  if (!ctx.engine.connected) return false;
  try {
    const ack = await ctx.engine.send("reload_models", {}, 10_000);
    const s = ack.data.spots as { labels?: unknown; loso_bal_acc?: unknown } | null | undefined;
    return !!f && !!s && JSON.stringify(s.labels) === JSON.stringify(f.labels) && (num(s.loso_bal_acc) ?? null) === f.loso_bal_acc;
  } catch (err) {
    ctx.log.warn({ err: (err as Error).message }, "reload_models failed");
    return false;
  }
}

export async function restoreModel(ctx: AppContext, env = defaultEnv()): Promise<Response | Record<string, unknown>> {
  if (training(teachState())) return fail(409, "conflict", "training is running");
  if (!existsSync(prevPath(env))) return fail(409, "conflict", "there is no previous model to restore");
  await restorePrevious(env);
  const margin = readMargin(env.root);
  const model = summarize(readSpotsFile(modelPath(env)), margin);
  const engine_reloaded = await reloadEngine(ctx, readSpotsFile(modelPath(env)));
  ctx.log.info({ labels: model?.labels }, "previous spot model restored");
  return { model, previous: summarize(readSpotsFile(prevPath(env)), margin), engine_reloaded };
}
