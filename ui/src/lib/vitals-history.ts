// Long-term vital-sign trends ("how was the night?", track H): the reply of
// GET /api/v1/history/vitals and small pure helpers for the Insights "Last hours" section.
// No "use client": the server (server/vitals-history.ts) imports the types.

export interface VitalsBucket {
  /** Bucket start, ms since epoch (epoch-aligned to `bucket_s`). */
  t: number;
  /** Stored 5 s rows in the bucket. */
  n: number;
  /** Rows with someone present. */
  present_n: number;
  /** Present rows with motion below MOTION_ON. */
  still_n: number;
  /** Median motion over present rows; null when nobody was there. */
  motion_med: number | null;
  breath_n: number;
  /** Null with fewer than MIN_READINGS readings (a gap, never a number from one stray row). */
  breath_med: number | null;
  /** Present rows where the engine sent a heart estimate (valid or not). */
  heart_on_n: number;
  heart_n: number;
  heart_med: number | null;
}

export interface VitalsSummary {
  n: number;
  present_n: number;
  still_n: number;
  breath_n: number;
  breath_med: number | null;
  breath_q1: number | null;
  breath_q3: number | null;
  heart_on_n: number;
  heart_n: number;
  heart_med: number | null;
  heart_q1: number | null;
  heart_q3: number | null;
}

export interface VitalsHistoryReply {
  from: number;
  to: number;
  bucket_s: number;
  /** False when the active profile does not keep breathing or heart history. */
  stored: boolean;
  summary: VitalsSummary;
  buckets: VitalsBucket[];
}

/** The three ranges the UI offers (hours). */
export const HISTORY_HOURS = [1, 6, 24] as const;
export type HistoryHours = (typeof HISTORY_HOURS)[number];

/** "62 %" of the present time with a reading; null when nobody was there. */
export function shareText(readings: number, present: number): string | null {
  if (!(present > 0)) return null;
  return `${Math.round((100 * readings) / present)} %`;
}

/**
 * uPlot data `[xs, ys]` from buckets (oldest first): a null is inserted between buckets more
 * than one bucket apart, so the line breaks where there was no data.
 */
export function withBucketGaps(
  buckets: readonly VitalsBucket[],
  bucketMs: number,
  pick: (b: VitalsBucket) => number | null,
): [number[], (number | null)[]] {
  const xs: number[] = [];
  const ys: (number | null)[] = [];
  let prev: number | null = null;
  for (const b of buckets) {
    if (prev !== null && b.t - prev > bucketMs) {
      xs.push(prev + bucketMs);
      ys.push(null);
    }
    xs.push(b.t);
    ys.push(pick(b));
    prev = b.t;
  }
  return [xs, ys];
}

/** "10 min" / "1 h" for a bucket length in seconds. */
export function bucketText(bucketS: number): string {
  if (bucketS >= 3600 && bucketS % 3600 === 0) return `${bucketS / 3600} h`;
  if (bucketS >= 60) return `${Math.round(bucketS / 60)} min`;
  return `${bucketS} s`;
}
