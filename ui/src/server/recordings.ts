// Recordings (plan-v2 §4.3, §10.1): the engine writes the .csirec, the server
// writes session.json at start and appends labels.jsonl. Segments are
// non-overlapping: starting one ends the open one.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { buildStatus, type AppContext } from "./context";

export const SEGMENT_LABELS = ["empty", "standing", "sitting", "lying", "walking", "normal_activity", "in_bed", "bed_empty", "breath_hold"];
export const MARK_EVENTS = ["sit_down", "stand_up", "lie_down", "get_up", "fall", "bed_exit", "breath_hold_start", "breath_hold_end"];
export const validLabel = (l: string) => SEGMENT_LABELS.includes(l) || /^paced_breathing_\d{1,3}$/.test(l);
export const validEvent = (e: string) => MARK_EVENTS.includes(e) || /^hard_negative_[\w-]+$/.test(e);

export const sessionsDir = () => join(config.dataDir, "sessions");
export const sessionDir = (s: string) => join(sessionsDir(), s);
export const labelsPath = (s: string) => join(sessionDir(s), "labels.jsonl");

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

export function broadcastStatus(ctx: AppContext): void {
  ctx.hub.broadcast({ type: "status", status: buildStatus(ctx, false) });
}
