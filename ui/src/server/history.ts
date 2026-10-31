// Downsampled history: one row per 5 s, never csi or wave (plan-v2 D9),
// kept in the SQLite store. The active profile decides whether breathing is stored.
import type { Result } from "@/lib/contracts.gen";
import { type HistoryField, type HistoryRow, type Store } from "./store";

export { HISTORY_FIELDS, type HistoryField, type HistoryRow } from "./store";

export class History {
  constructor(
    private readonly store: Store,
    private readonly bucketMs = 5000,
  ) {}

  /** Keeps the latest result of every 5 s bucket. */
  add(r: Result, storeBreathing: boolean): void {
    this.store.addHistory({
      t: Math.floor(r.ts / this.bucketMs) * this.bucketMs,
      presence: r.presence.state,
      motion: r.motion,
      breathing_bpm: storeBreathing ? r.breathing.bpm : null,
      breathing_valid: storeBreathing ? r.breathing.valid : null,
      posture: r.posture?.label ?? null,
      count: r.count?.value ?? null,
    });
  }

  query(from: number, to: number, fields?: HistoryField[]): Partial<HistoryRow>[] {
    return this.store.queryHistory(from, to, fields);
  }

  size(): number {
    return this.store.historySize();
  }
}
