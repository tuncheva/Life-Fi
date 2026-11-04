// Downsampled history: one row per 5 s, never csi or wave (plan-v2 D9),
// kept in the event store (Firestore, track FB). The active profile decides whether breathing and heart are stored.
import type { Result } from "@/lib/contracts.gen";
import { type HistoryField, type HistoryRow, type Store, type VitalsRow } from "./store";

export { HISTORY_FIELDS, type HistoryField, type HistoryRow, type VitalsRow } from "./store";

export class History {
  constructor(
    private readonly store: Store,
    private readonly bucketMs = 5000,
  ) {}

  /** Keeps the latest result of every 5 s bucket. Heart follows the breathing gate (track H D2). */
  add(r: Result, storeVitals: boolean): void {
    const h = storeVitals ? (r.heart ?? null) : null;
    this.store.addHistory({
      t: Math.floor(r.ts / this.bucketMs) * this.bucketMs,
      presence: r.presence.state,
      motion: r.motion,
      breathing_bpm: storeVitals ? r.breathing.bpm : null,
      breathing_valid: storeVitals ? r.breathing.valid : null,
      posture: r.posture?.label ?? null,
      count: r.count?.value ?? null,
      heart_valid: h ? h.valid === true : null,
      heart_bpm: h?.valid === true && Number.isFinite(h.bpm) ? h.bpm : null,
    });
  }

  /** Rows for the vitals history (`from <= t < to`). */
  vitalsRows(from: number, to: number): Promise<VitalsRow[]> {
    return this.store.vitalsRows(from, to);
  }

  query(from: number, to: number, fields?: HistoryField[]): Promise<Partial<HistoryRow>[]> {
    return this.store.queryHistory(from, to, fields);
  }

  size(): Promise<number> {
    return this.store.historySize();
  }
}
