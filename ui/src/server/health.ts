// GET /api/v1/health and /api/v1/setup (contracts/api.md): can the server do its job, are
// people being sensed right now, and what is left of the first-run setup.
import { existsSync, statfsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, DEFAULT_PIN, isLoopback } from "./config";
import type { AppContext } from "./context";

const CAL_STATES = ["none", "running", "ok", "stale"] as const;
type CalState = (typeof CAL_STATES)[number];
const LOW_DISK = 500 * 1024 * 1024;

export interface HealthEnv {
  now: number;
  dbPath: string;
  dataDir: string;
  bindHost: string;
}

export interface Health {
  ok: boolean;
  ready: boolean;
  version: string;
  uptime_s: number;
  checks: {
    engine: { ok: boolean };
    board: { ok: boolean; source: "live" | "replay"; result_age_s: number | null; rate_hz: number | null; error: string | null };
    calibration: { ok: boolean; state: CalState | null; id: string | null; age_s: number | null };
    storage: { ok: boolean; db_bytes: number; free_bytes: number | null };
  };
}

export interface SetupStep {
  id: "engine" | "board" | "pin" | "calibration" | "notify" | "lan";
  done: boolean;
  optional: boolean;
  detail: string | null;
}

export const defaultEnv = (): HealthEnv => ({ now: Date.now(), dbPath: config.dbPath, dataDir: config.dataDir, bindHost: config.bindHost });

const size = (p: string) => (existsSync(p) ? statSync(p).size : 0);

let writable: { at: number; ok: boolean; dir: string } | null = null;
/** Writes and deletes a probe file; the answer is kept 60 s. */
function dataDirWritable(dir: string, now: number): boolean {
  if (writable && writable.dir === dir && now - writable.at < 60_000) return writable.ok;
  let ok = true;
  try {
    const probe = join(dir, `.health-${process.pid}`);
    writeFileSync(probe, "");
    unlinkSync(probe);
  } catch {
    ok = false;
  }
  writable = { at: now, ok, dir };
  return ok;
}

function calibrationOf(ctx: AppContext): Health["checks"]["calibration"] {
  const from = ctx.state.latest?.calibration ?? ctx.state.engineStatus?.engine?.calibration;
  if (!from || !(CAL_STATES as readonly string[]).includes(from.state)) return { ok: false, state: null, id: null, age_s: null };
  const state = from.state as CalState;
  return { ok: state === "ok", state, id: from.id ?? null, age_s: typeof from.age_s === "number" ? Math.round(from.age_s) : null };
}

export function health(ctx: AppContext, env: HealthEnv = defaultEnv()): Health {
  const { state } = ctx;
  const engineOk = ctx.engine.connected;
  const ageMs = state.lastResultAt === null ? null : Math.max(0, env.now - state.lastResultAt);
  const boardOk = engineOk && ageMs !== null && ageMs < 5000 && !ctx.watchdog.isOffline;
  const memory = env.dbPath === ":memory:";
  let free: number | null = null;
  try {
    const s = statfsSync(env.dataDir);
    free = s.bavail * s.bsize;
  } catch {
    free = null;
  }
  const storageOk = dataDirWritable(env.dataDir, env.now) && (free === null || free > LOW_DISK);
  const ok = engineOk && storageOk;
  return {
    ok,
    ready: ok && boardOk,
    version: ctx.version,
    uptime_s: Math.floor((env.now - state.startedAt) / 1000),
    checks: {
      engine: { ok: engineOk },
      board: {
        ok: boardOk,
        source: state.source.mode,
        result_age_s: ageMs === null ? null : Math.round(ageMs / 100) / 10,
        rate_hz: ageMs !== null && ageMs < 10_000 && state.latest ? state.latest.health.rate_hz : null,
        error: state.source.error,
      },
      calibration: calibrationOf(ctx),
      storage: { ok: storageOk, db_bytes: memory ? 0 : size(env.dbPath) + size(`${env.dbPath}-wal`), free_bytes: free },
    },
  };
}

/** The six first-run steps, always in this order; the UI keys on `id`, never on `detail`. */
export function setup(ctx: AppContext, env: HealthEnv = defaultEnv()): { complete: boolean; steps: SetupStep[] } {
  const h = health(ctx, env);
  const s = ctx.settings.value;
  const cal = h.checks.calibration.state;
  const live = h.checks.board.source === "live";
  const steps: SetupStep[] = [
    { id: "engine", done: h.checks.engine.ok, optional: false, detail: h.checks.engine.ok ? null : "the engine is not running" },
    {
      id: "board",
      done: h.checks.board.ok && live,
      optional: false,
      detail: h.checks.board.ok && live ? null : !live ? "replaying a recording, not the board" : (h.checks.board.error ?? "no data from the board"),
    },
    { id: "pin", done: s.pin !== DEFAULT_PIN, optional: false, detail: s.pin !== DEFAULT_PIN ? null : "the PIN is still the default" },
    {
      id: "calibration",
      done: cal === "ok",
      optional: false,
      detail: cal === "ok" ? null : cal === "stale" ? "calibration is stale: redo it with the room empty" : cal === "running" ? "calibration running" : "no empty-room calibration yet",
    },
    { id: "notify", done: s.notify.topic.trim() !== "", optional: true, detail: s.notify.topic.trim() !== "" ? null : "no ntfy topic set" },
    {
      id: "lan",
      done: !isLoopback(env.bindHost),
      optional: true,
      detail: isLoopback(env.bindHost) ? "only this PC can open the dashboard (set LIFEFI_HOST=0.0.0.0)" : null,
    },
  ];
  return { complete: steps.every((x) => x.optional || x.done), steps };
}
