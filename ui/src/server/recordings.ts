// Recordings (plan-v2 §4.3, §10.1): the engine writes the .csirec, the server
// writes session.json at start and appends labels.jsonl. Segments are
// non-overlapping: starting one ends the open one.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { config, repoRoot } from "./config";
import { buildStatus, type AppContext } from "./context";

export const SEGMENT_LABELS = ["empty", "standing", "sitting", "lying", "walking", "normal_activity", "in_bed", "bed_empty", "breath_hold"];
export const MARK_EVENTS = ["sit_down", "stand_up", "lie_down", "get_up", "fall", "bed_exit", "breath_hold_start", "breath_hold_end"];
export const validLabel = (l: string) => SEGMENT_LABELS.includes(l) || /^paced_breathing_\d{1,3}$/.test(l);
export const validEvent = (e: string) => MARK_EVENTS.includes(e) || /^hard_negative_[\w-]+$/.test(e);

export const sessionsDir = () => join(config.dataDir, "sessions");
export const sessionDir = (s: string) => join(sessionsDir(), s);
export const labelsPath = (s: string) => join(sessionDir(s), "labels.jsonl");

/**
 * The absolute path of a replay file the dashboard may ask for, else null: a .csirec under
 * firmware/recordings/ or the sessions folder (the engine opens any path it is given).
 * Relative paths are from the repo root, as the engine sees them.
 */
export function replayPath(file: string, root = repoRoot, dataDir = config.dataDir): string | null {
  const p = resolve(root, file);
  if (!p.toLowerCase().endsWith(".csirec")) return null;
  const inside = (dir: string) => {
    const r = relative(dir, p);
    return r !== "" && !r.startsWith("..") && !isAbsolute(r);
  };
  return [resolve(root, "firmware", "recordings"), resolve(dataDir, "sessions")].some(inside) ? p : null;
}

export function appendLabel(ctx: AppContext, s: string, line: Record<string, unknown>): void {
  mkdirSync(sessionDir(s), { recursive: true });
  appendFileSync(labelsPath(s), JSON.stringify(line) + "\n");
  if (ctx.state.recording?.session === s) ctx.state.recording.labels++;
}

export function readLabels(s: string): Record<string, unknown>[] {
  if (!existsSync(labelsPath(s))) return [];
  return readFileSync(labelsPath(s), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Ends the open segment (if any) at `t_us` and writes it. */
export function endOpenSegment(ctx: AppContext, t_us: number): Record<string, unknown> | null {
  const rec = ctx.state.recording;
  if (!rec?.open_segment) return null;
  const seg = rec.open_segment;
  rec.open_segment = null;
  const line = { kind: "segment", session: rec.session, t_start_us: seg.t_start_us, t_end_us: t_us, label: seg.label, count: seg.count, subject: seg.subject, spot: seg.spot };
  appendLabel(ctx, rec.session, line);
  return line;
}

/**
 * Starts a recording (the caller has checked that none runs and the source is live): the engine
 * opens `<dir>/<session>.csirec`, then session.json = header + `meta` (meta keys at the top level).
 * Throws the engine's error.
 */
export async function startRecording(ctx: AppContext, session: string, meta: Record<string, unknown>, dir = sessionDir(session)): Promise<{ session: string; started_us: number }> {
  await ctx.engine.send("record_start", { session, path: join(dir, `${session}.csirec`), meta });
  const started_us = Date.now() * 1000;
  mkdirSync(dir, { recursive: true });
  const sessionJson = {
    session,
    started_us,
    firmware: (ctx.state.engineStatus?.device as Record<string, unknown> | null)?.fw_version ?? null,
    engine: ctx.state.engineStatus?.engine.version ?? null,
    config_hash: ctx.state.latest?.config_hash ?? null,
    pipeline_version: ctx.state.latest?.pipeline_version ?? null,
    ...meta,
  };
  writeFileSync(join(dir, "session.json"), JSON.stringify(sessionJson, null, 2) + "\n");
  ctx.state.recording = { session, started_us, open_segment: null, labels: readLabels(session).length };
  ctx.log.info({ session }, "recording started");
  broadcastStatus(ctx);
  return { session, started_us };
}

/** Stops the open recording (the caller has checked there is one): the stop ack's data. Throws the engine's error. */
export async function stopRecording(ctx: AppContext): Promise<Record<string, unknown>> {
  const rec = ctx.state.recording!;
  endOpenSegment(ctx, Date.now() * 1000);
  const ack = await ctx.engine.send("record_stop");
  ctx.state.recording = null;
  ctx.log.info({ session: rec.session, frames: ack.data.frames }, "recording stopped");
  broadcastStatus(ctx);
  return ack.data;
}

export function broadcastStatus(ctx: AppContext): void {
  ctx.hub.broadcast({ type: "status", status: buildStatus(ctx, false) });
}
