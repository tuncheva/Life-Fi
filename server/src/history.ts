// Downsampled history: one row per 5 s, never csi or wave (plan-v2 D9).
// In-memory ring buffer for now; the on-disk store (SQLite vs H2) is still an
// open team decision. The query API will not change when it lands.
import type { Result } from "./contracts.gen.js";

export interface HistoryRow {
  t: number;
  presence: "empty" | "present" | "uncertain";
  motion: number;
  breathing_bpm: number | null;
  breathing_valid: boolean | null;
  posture: string | null;
  count: number | null;
}

export const HISTORY_FIELDS = ["presence", "motion", "breathing", "posture", "count"] as const;
export type HistoryField = (typeof HISTORY_FIELDS)[number];

export class History {
  private rows: HistoryRow[] = [];
  private bucketOf(t: number): number {
    return Math.floor(t / this.bucketMs) * this.bucketMs;
  }

  constructor(
    private readonly bucketMs = 5000,
    private readonly maxRows = 24 * 3600 * 1000 / 5000 * 2, // 48 h
  ) {}

  /** Keeps the latest result of every 5 s bucket. `storeBreathing` follows the active profile. */
  add(r: Result, storeBreathing: boolean): void {
    const t = this.bucketOf(r.ts);
    const row: HistoryRow = {
      t,
      presence: r.presence.state,
      motion: r.motion,
      breathing_bpm: storeBreathing ? r.breathing.bpm : null,
      breathing_valid: storeBreathing ? r.breathing.valid : null,
      posture: r.posture?.label ?? null,
      count: r.count?.value ?? null,
    };
    const last = this.rows[this.rows.length - 1];
    if (last && last.t === t) this.rows[this.rows.length - 1] = row;
    else {
      this.rows.push(row);
      if (this.rows.length > this.maxRows) this.rows.splice(0, this.rows.length - this.maxRows);
    }
  }

  query(from: number, to: number, fields?: HistoryField[]): Partial<HistoryRow>[] {
    const out: Partial<HistoryRow>[] = [];
    for (const row of this.rows) {
      if (row.t < from || row.t > to) continue;
      if (!fields) {
        out.push(row);
        continue;
      }
      const picked: Partial<HistoryRow> = { t: row.t };
      for (const f of fields) {
        if (f === "breathing") {
          picked.breathing_bpm = row.breathing_bpm;
          picked.breathing_valid = row.breathing_valid;
        } else picked[f] = row[f] as never;
      }
      out.push(picked);
    }
    return out;
  }

  size(): number {
    return this.rows.length;
  }
}
