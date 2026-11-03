// On-disk store (plan-v2 D9, decided for SQLite on 2026-10-27 since the
// server is TypeScript): downsampled history, alerts and their transitions.
// Uses Node's built-in node:sqlite, so nothing native has to be compiled.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Alert } from "./alerts";

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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS history (
  t INTEGER PRIMARY KEY,
  presence TEXT NOT NULL,
  motion REAL NOT NULL,
  breathing_bpm REAL,
  breathing_valid INTEGER,
  posture TEXT,
  count INTEGER
);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS alerts_created ON alerts (created_at);
CREATE TABLE IF NOT EXISTS alert_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id TEXT NOT NULL,
  state TEXT NOT NULL,
  t INTEGER NOT NULL,
  config_hash TEXT NOT NULL
);
`;

type DbRow = Record<string, string | number | null>;

export class Store {
  private readonly db: DatabaseSync;
  private readonly insertHistory: StatementSync;
  private readonly selectHistory: StatementSync;
  private readonly countHistory: StatementSync;
  private readonly purgeHistory: StatementSync;
  private readonly upsertAlert: StatementSync;
  private readonly insertLog: StatementSync;
  private readonly selectAlerts: StatementSync;
  private readonly purgeAlerts: StatementSync;
  private readonly purgeLog: StatementSync;

  /** `path` may be ":memory:" (tests). */
  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    this.db.exec(SCHEMA);
    this.insertHistory = this.db.prepare(
      "INSERT OR REPLACE INTO history (t, presence, motion, breathing_bpm, breathing_valid, posture, count) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.selectHistory = this.db.prepare("SELECT * FROM history WHERE t >= ? AND t <= ? ORDER BY t");
    this.countHistory = this.db.prepare("SELECT COUNT(*) AS n FROM history");
    this.purgeHistory = this.db.prepare("DELETE FROM history WHERE t < ?");
    this.upsertAlert = this.db.prepare("INSERT OR REPLACE INTO alerts (id, created_at, state, json) VALUES (?, ?, ?, ?)");
    this.insertLog = this.db.prepare("INSERT INTO alert_log (alert_id, state, t, config_hash) VALUES (?, ?, ?, ?)");
    this.selectAlerts = this.db.prepare("SELECT json FROM alerts ORDER BY created_at DESC LIMIT ?");
    this.purgeAlerts = this.db.prepare("DELETE FROM alerts WHERE created_at < ?");
    this.purgeLog = this.db.prepare("DELETE FROM alert_log WHERE t < ?");
  }

  // ---- history ----------------------------------------------------------------

  addHistory(r: HistoryRow): void {
    this.insertHistory.run(r.t, r.presence, r.motion, r.breathing_bpm, r.breathing_valid === null ? null : r.breathing_valid ? 1 : 0, r.posture, r.count);
  }

  queryHistory(from: number, to: number, fields?: HistoryField[]): Partial<HistoryRow>[] {
    const rows = this.selectHistory.all(from, to) as DbRow[];
    return rows.map((d) => {
      const row: HistoryRow = {
        t: d.t as number,
        presence: d.presence as HistoryRow["presence"],
        motion: d.motion as number,
        breathing_bpm: d.breathing_bpm as number | null,
        breathing_valid: d.breathing_valid === null ? null : d.breathing_valid === 1,
        posture: d.posture as string | null,
        count: d.count as number | null,
      };
      if (!fields) return row;
      const picked: Partial<HistoryRow> = { t: row.t };
      for (const f of fields) {
        if (f === "breathing") {
          picked.breathing_bpm = row.breathing_bpm;
          picked.breathing_valid = row.breathing_valid;
        } else picked[f] = row[f] as never;
      }
      return picked;
    });
  }

  historySize(): number {
    return (this.countHistory.get() as { n: number }).n;
  }

  /** Deletes rows older than `retentionDays`. Returns how many history rows went. */
  purge(retentionDays: number, now = Date.now()): number {
    const cutoff = now - retentionDays * 86_400_000;
    const r = this.purgeHistory.run(cutoff);
    this.purgeAlerts.run(cutoff);
    this.purgeLog.run(cutoff);
    return Number(r.changes);
  }

  // ---- alerts -------------------------------------------------------------------

  /** Persists the alert's current state and appends the transition to the log (plan-v2 §7.1). */
  saveAlert(a: Alert): void {
    const t = a.resolved_at ?? a.acked_at ?? a.opened_at ?? a.created_at;
    this.upsertAlert.run(a.id, a.created_at, a.state, JSON.stringify(a));
    this.insertLog.run(a.id, a.state, t, a.config_hash);
  }

  loadAlerts(limit = 500): Alert[] {
    return (this.selectAlerts.all(limit) as { json: string }[]).map((r) => JSON.parse(r.json) as Alert);
  }

  close(): void {
    this.db.close();
  }
}
