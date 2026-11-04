// Breathing, heart and movement over the last hours (track H), aggregated from the 5 s history
// rows for GET /api/v1/history/vitals. Pure: tested without the runtime. The honesty rules live
// here, in one place: a reading needs someone present, a valid flag, a number in the sane range
// and not two people; a median needs MIN_READINGS readings, otherwise it is a gap.
import { BREATH_RANGE, HEART_RANGE, inRange, MOTION_ON } from "@/lib/vitals";
import { HISTORY_HOURS, type HistoryHours, type VitalsBucket, type VitalsSummary } from "@/lib/vitals-history";
import type { VitalsRow } from "./store";

export const HOURS = HISTORY_HOURS;
/** Fewer valid readings than this in a bucket (or the range) give no number: 3 rows = 15 s. */
export const MIN_READINGS = 3;
/** One history row stands for 5 s. */
export const ROW_MS = 5000;
const HOUR_MS = 3_600_000;
/** How far `to` may lie ahead of the server clock (clock skew). */
const FUTURE_SLACK_MS = 60_000;

/** 1 h → 60 s buckets (≤ 61), 6 h → 5 min (≤ 73), 24 h → 10 min (≤ 145). */
export function bucketMsFor(hours: HistoryHours): number {
  return hours === 1 ? 60_000 : hours === 6 ? 300_000 : 600_000;
}

export type VitalsQuery = { hours: HistoryHours; from: number; to: number; bucketMs: number };

export function parseVitalsQuery(q: URLSearchParams, now: number): VitalsQuery | { error: string } {
  const h = q.get("hours");
  const hours = h === null ? 24 : Number(h);
  if ((h !== null && h.trim() === "") || !(HOURS as readonly number[]).includes(hours)) return { error: "hours must be 1, 6 or 24" };
  const t = q.get("to");
  const to = t === null ? now : Number(t);
  if ((t !== null && t.trim() === "") || !Number.isFinite(to) || to > now + FUTURE_SLACK_MS) {
    return { error: "to must be ms since epoch, not in the future" };
  }
  const hh = hours as HistoryHours;
  return { hours: hh, from: to - hh * HOUR_MS, to, bucketMs: bucketMsFor(hh) };
}

/** Linear-interpolated quantile of an ascending array; null when empty. */
export function quantile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

const r1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
const r2 = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);
const asc = (a: number, b: number) => a - b;

/** Median rounded to 0.1, or null with fewer than MIN_READINGS values. */
function med(values: number[]): number | null {
  if (values.length < MIN_READINGS) return null;
  return r1(quantile(values.sort(asc), 0.5));
}

const present = (r: VitalsRow) => r.presence === "present";
const breathOf = (r: VitalsRow) =>
  present(r) && r.breathing_valid === 1 && r.count !== 2 && inRange(r.breathing_bpm, BREATH_RANGE) ? r.breathing_bpm : null;
const heartOf = (r: VitalsRow) =>
  present(r) && r.heart_valid === 1 && r.count !== 2 && inRange(r.heart_bpm, HEART_RANGE) ? r.heart_bpm : null;

type Acc = { t: number; n: number; present_n: number; still_n: number; motion: number[]; breath: number[]; heart_on_n: number; heart: number[] };

/**
 * Groups rows (oldest first, already limited to the range) into epoch-aligned buckets; only
 * non-empty buckets. The summary's median and quartiles come from all readings in the range.
 */
export function summarize(rows: readonly VitalsRow[], bucketMs: number): { summary: VitalsSummary; buckets: VitalsBucket[] } {
  const accs: Acc[] = [];
  const allBreath: number[] = [];
  const allHeart: number[] = [];
  let presentN = 0;
  let stillN = 0;
  let heartOnN = 0;
  for (const r of rows) {
    const t = Math.floor(r.t / bucketMs) * bucketMs;
    let a = accs[accs.length - 1];
    if (!a || a.t !== t) {
      a = { t, n: 0, present_n: 0, still_n: 0, motion: [], breath: [], heart_on_n: 0, heart: [] };
      accs.push(a);
    }
    a.n++;
    if (!present(r)) continue;
    a.present_n++;
    presentN++;
    if (Number.isFinite(r.motion)) a.motion.push(r.motion);
    if (r.motion < MOTION_ON) {
      a.still_n++;
      stillN++;
    }
    if (r.heart_valid !== null) {
      a.heart_on_n++;
      heartOnN++;
    }
    const b = breathOf(r);
    if (b !== null) {
      a.breath.push(b);
      allBreath.push(b);
    }
    const h = heartOf(r);
    if (h !== null) {
      a.heart.push(h);
      allHeart.push(h);
    }
  }
  const buckets: VitalsBucket[] = accs.map((a) => ({
    t: a.t,
    n: a.n,
    present_n: a.present_n,
    still_n: a.still_n,
    motion_med: a.motion.length ? r2(quantile(a.motion.sort(asc), 0.5)) : null,
    breath_n: a.breath.length,
    breath_med: med(a.breath),
    heart_on_n: a.heart_on_n,
    heart_n: a.heart.length,
    heart_med: med(a.heart),
  }));
  allBreath.sort(asc);
  allHeart.sort(asc);
  const q = (s: number[], p: number) => (s.length < MIN_READINGS ? null : r1(quantile(s, p)));
  const summary: VitalsSummary = {
    n: rows.length,
    present_n: presentN,
    still_n: stillN,
    breath_n: allBreath.length,
    breath_med: q(allBreath, 0.5),
    breath_q1: q(allBreath, 0.25),
    breath_q3: q(allBreath, 0.75),
    heart_on_n: heartOnN,
    heart_n: allHeart.length,
    heart_med: q(allHeart, 0.5),
    heart_q1: q(allHeart, 0.25),
    heart_q3: q(allHeart, 0.75),
  };
  return { summary, buckets };
}
