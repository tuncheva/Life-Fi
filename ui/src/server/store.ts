// Event store (track FB, 2026-11-04: Firestore replaces SQLite): downsampled history, alerts,
// their transitions, state-change events and agent runs. Writes are synchronous for the caller
// (queued, never block the 10 Hz result loop); reads are async. MemoryStore is the same contract
// with nothing persisted, used in tests and when Firebase is not configured.
import type { Alert } from "./alerts";

export interface HistoryRow {
  t: number;
  presence: "empty" | "present" | "uncertain";
  motion: number;
  breathing_bpm: number | null;
  breathing_valid: boolean | null;
  posture: string | null;
  count: number | null;
  /** Null unless the heart estimate was valid (track H). Optional so older callers still compile. */
  heart_bpm?: number | null;
  /** Null when the result had no heart or the profile does not store vitals. */
  heart_valid?: boolean | null;
}

/** The columns the vitals history needs (server/vitals-history.ts); valid flags raw 1/0/null. */
export interface VitalsRow {
  t: number;
  presence: string;
  motion: number;
  breathing_bpm: number | null;
  breathing_valid: number | null;
  heart_bpm: number | null;
  heart_valid: number | null;
  count: number | null;
}

export const HISTORY_FIELDS = ["presence", "motion", "breathing", "posture", "count", "heart"] as const;
export type HistoryField = (typeof HISTORY_FIELDS)[number];

export const EVENT_KINDS = ["presence", "posture", "count", "agent"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** A state change seen by the server, or one agent run. Never carries the room name or phone. */
export interface StoreEvent {
  t: number;
  kind: EventKind;
  from?: string | number | null;
  to?: string | number | null;
  data?: Record<string, unknown>;
}

export interface AlertLogRow {
  alert_id: string;
  state: string;
  t: number;
  config_hash: string;
}

export interface Store {
  readonly kind: "firestore" | "memory";
  addHistory(r: HistoryRow): void;
  queryHistory(from: number, to: number, fields?: HistoryField[]): Promise<Partial<HistoryRow>[]>;
  /** The vitals columns for `from <= t < to`, oldest first. */
  vitalsRows(from: number, to: number): Promise<VitalsRow[]>;
  historySize(): Promise<number>;
  /** Deletes everything older than `retentionDays`. Returns how many history rows went. */
  purge(retentionDays: number, now?: number): Promise<number>;
  /** Persists the alert's current state and appends the transition to the log (plan-v2 §7.1). */
  saveAlert(a: Alert): void;
  /** Newest first. */
  loadAlerts(limit?: number): Promise<Alert[]>;
  addEvent(e: StoreEvent): void;
  /** `from <= t <= to`, oldest first. */
  queryEvents(from: number, to: number, kind?: EventKind): Promise<StoreEvent[]>;
  /** Flushes pending writes. */
  close(): Promise<void>;
}

/** The time an alert transition happened. */
export const transitionTime = (a: Alert) => a.resolved_at ?? a.acked_at ?? a.opened_at ?? a.created_at;

export function pickFields(row: HistoryRow, fields?: HistoryField[]): Partial<HistoryRow> {
  const full: HistoryRow = { ...row, heart_bpm: row.heart_bpm ?? null, heart_valid: row.heart_valid ?? null };
  if (!fields) return full;
  const picked: Partial<HistoryRow> = { t: full.t };
  for (const f of fields) {
    if (f === "breathing") {
      picked.breathing_bpm = full.breathing_bpm;
      picked.breathing_valid = full.breathing_valid;
    } else if (f === "heart") {
      picked.heart_bpm = full.heart_bpm;
      picked.heart_valid = full.heart_valid;
    } else picked[f] = full[f] as never;
  }
  return picked;
}

const flag = (b: boolean | null | undefined) => (b === null || b === undefined ? null : b ? 1 : 0);

export const toVitalsRow = (r: HistoryRow): VitalsRow => ({
  t: r.t,
  presence: r.presence,
  motion: r.motion,
  breathing_bpm: r.breathing_bpm,
  breathing_valid: flag(r.breathing_valid),
  heart_bpm: r.heart_bpm ?? null,
  heart_valid: flag(r.heart_valid),
  count: r.count,
});

/** Nothing persisted: tests, LIFEFI_DB=:memory:, or no Firebase credentials. */
export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  private readonly history = new Map<number, HistoryRow>();
  private readonly alerts = new Map<string, Alert>();
  readonly alertLog: AlertLogRow[] = [];
  private events: StoreEvent[] = [];

  addHistory(r: HistoryRow): void {
    this.history.set(r.t, { ...r });
  }

  private sorted(from: number, to: number, toExclusive = false): HistoryRow[] {
    return [...this.history.values()].filter((r) => r.t >= from && (toExclusive ? r.t < to : r.t <= to)).sort((a, b) => a.t - b.t);
  }

  async queryHistory(from: number, to: number, fields?: HistoryField[]): Promise<Partial<HistoryRow>[]> {
    return this.sorted(from, to).map((r) => pickFields(r, fields));
  }

  async vitalsRows(from: number, to: number): Promise<VitalsRow[]> {
    return this.sorted(from, to, true).map(toVitalsRow);
  }

  async historySize(): Promise<number> {
    return this.history.size;
  }

  async purge(retentionDays: number, now = Date.now()): Promise<number> {
    const cutoff = now - retentionDays * 86_400_000;
    let gone = 0;
    for (const t of [...this.history.keys()]) {
      if (t < cutoff) {
        this.history.delete(t);
        gone++;
      }
    }
    for (const [id, a] of [...this.alerts]) if (a.created_at < cutoff) this.alerts.delete(id);
    this.alertLog.splice(0, this.alertLog.length, ...this.alertLog.filter((l) => l.t >= cutoff));
    this.events = this.events.filter((e) => e.t >= cutoff);
    return gone;
  }

  saveAlert(a: Alert): void {
    this.alerts.set(a.id, structuredClone(a));
    this.alertLog.push({ alert_id: a.id, state: a.state, t: transitionTime(a), config_hash: a.config_hash });
  }

  async loadAlerts(limit = 500): Promise<Alert[]> {
    return [...this.alerts.values()].sort((a, b) => b.created_at - a.created_at).slice(0, limit).map((a) => structuredClone(a));
  }

  addEvent(e: StoreEvent): void {
    this.events.push(structuredClone(e));
  }

  async queryEvents(from: number, to: number, kind?: EventKind): Promise<StoreEvent[]> {
    return this.events.filter((e) => e.t >= from && e.t <= to && (!kind || e.kind === kind)).sort((a, b) => a.t - b.t);
  }

  async close(): Promise<void> {}
}
