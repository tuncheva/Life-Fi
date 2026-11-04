import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Alert } from "../src/server/alerts";
import { Store } from "../src/server/store";

const row = (t: number, extra: Partial<Parameters<Store["addHistory"]>[0]> = {}) => ({
  t,
  presence: "present" as const,
  motion: 0.1,
  breathing_bpm: 14,
  breathing_valid: true,
  posture: "lying",
  count: 1,
  ...extra,
});

const alert = (id: string, state: Alert["state"], created_at: number): Alert => ({
  id,
  event_id: 1,
  type: "fall",
  level: "high",
  state,
  profile: "home",
  config_hash: "abc123",
  created_at,
  opened_at: state === "pending" ? null : created_at,
  acked_at: null,
  acked_by: null,
  resolved_at: state === "resolved" ? created_at + 1000 : null,
  notified_at: null,
  notify: null,
  notify_error: null,
  escalated_at: null,
  data: {},
});

describe("Store (sqlite, in memory)", () => {
  it("keeps one row per bucket, replacing on the same t", () => {
    const s = new Store(":memory:");
    s.addHistory(row(5000, { motion: 0.1 }));
    s.addHistory(row(5000, { motion: 0.9 }));
    s.addHistory(row(10000));
    expect(s.historySize()).toBe(2);
    const rows = s.queryHistory(0, 20000);
    expect(rows.map((r) => r.t)).toEqual([5000, 10000]);
    expect(rows[0]!.motion).toBe(0.9);
    expect(rows[0]!.breathing_valid).toBe(true);
    s.close();
  });

  it("filters by time range and picks fields", () => {
    const s = new Store(":memory:");
    for (let t = 0; t < 60000; t += 5000) s.addHistory(row(t, { breathing_bpm: null, breathing_valid: null }));
    const rows = s.queryHistory(20000, 30000, ["presence", "breathing"]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ t: 20000, presence: "present", breathing_bpm: null, breathing_valid: null });
    expect("motion" in rows[0]!).toBe(false);
    s.close();
  });

  it("purges rows and alerts older than the retention", () => {
    const s = new Store(":memory:");
    const day = 86_400_000;
    const now = 100 * day;
    s.addHistory(row(now - 40 * day));
    s.addHistory(row(now - 5 * day));
    s.saveAlert(alert("a-0001", "resolved", now - 40 * day));
    s.saveAlert(alert("a-0002", "resolved", now - 5 * day));
    expect(s.purge(30, now)).toBe(1);
    expect(s.historySize()).toBe(1);
    expect(s.loadAlerts().map((a) => a.id)).toEqual(["a-0002"]);
    s.close();
  });

  it("stores the latest alert state and lists newest first", () => {
    const s = new Store(":memory:");
    s.saveAlert(alert("a-0001", "pending", 1000));
    s.saveAlert(alert("a-0001", "open", 1000));
    s.saveAlert(alert("a-0001", "resolved", 1000));
    s.saveAlert(alert("a-0002", "open", 2000));
    const loaded = s.loadAlerts();
    expect(loaded.map((a) => [a.id, a.state])).toEqual([
      ["a-0002", "open"],
      ["a-0001", "resolved"],
    ]);
    s.close();
  });

  it("round-trips through AlertManager.load, closing what was live", async () => {
    const { AlertManager } = await import("../src/server/alerts");
    const { loadProfiles } = await import("../src/server/profiles");
    const { fileURLToPath } = await import("node:url");
    const { join, dirname } = await import("node:path");
    const profiles = loadProfiles(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "contracts", "profiles.yml"));
    const s = new Store(":memory:");
    s.saveAlert(alert("a-0003", "open", 3000));
    s.saveAlert(alert("a-0001", "resolved", 1000));
    const m = new AlertManager(profiles, () => "home", () => 9999);
    const events: string[] = [];
    m.on("alert", (a) => events.push(`${a.id}:${a.state}`));
    expect(m.load(s.loadAlerts())).toBe(2);
    expect(m.get("a-0003")?.state).toBe("resolved");
    expect(m.get("a-0003")?.resolved_at).toBe(9999);
    expect(m.get("a-0001")?.state).toBe("resolved");
    expect(events).toEqual(["a-0003:resolved"]);
    // the sequence continues after the highest saved id
    m.raiseServer("sensor_offline");
    expect(m.list(["open"]).map((a) => a.id)).toEqual(["a-0004"]);
    m.stop();
    s.close();
  });
});

describe("Store heart columns (track H)", () => {
  it("round-trips heart and picks it as a field", () => {
    const s = new Store(":memory:");
    s.addHistory(row(5000, { heart_bpm: 62.5, heart_valid: true }));
    s.addHistory(row(10000));
    const rows = s.queryHistory(0, 20000);
    expect(rows[0]).toMatchObject({ heart_bpm: 62.5, heart_valid: true });
    expect(rows[1]).toMatchObject({ heart_bpm: null, heart_valid: null });
    expect(s.queryHistory(0, 20000, ["heart"])[0]).toEqual({ t: 5000, heart_bpm: 62.5, heart_valid: true });
    expect(s.vitalsRows(5000, 10000)).toEqual([
      { t: 5000, presence: "present", motion: 0.1, breathing_bpm: 14, breathing_valid: 1, heart_bpm: 62.5, heart_valid: 1, count: 1 },
    ]);
    s.close();
  });

  it("purges rows with heart like any other", () => {
    const s = new Store(":memory:");
    const day = 86_400_000;
    s.addHistory(row(60 * day, { heart_bpm: 60, heart_valid: true }));
    expect(s.purge(30, 100 * day)).toBe(1);
    s.close();
  });
});

describe("Store migration of a pre-track-H file", () => {
  const OLD_DDL = `
CREATE TABLE history (t INTEGER PRIMARY KEY, presence TEXT NOT NULL, motion REAL NOT NULL, breathing_bpm REAL, breathing_valid INTEGER, posture TEXT, count INTEGER);
CREATE TABLE alerts (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, state TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX alerts_created ON alerts (created_at);
CREATE TABLE alert_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, alert_id TEXT NOT NULL, state TEXT NOT NULL, t INTEGER NOT NULL, config_hash TEXT NOT NULL);`;
  const OLD_INSERT = "INSERT OR REPLACE INTO history (t, presence, motion, breathing_bpm, breathing_valid, posture, count) VALUES (?, ?, ?, ?, ?, ?, ?)";

  /** A temp dir with an old-schema DB holding one row; removed after `fn`. */
  function withOldDb(fn: (file: string, handles: { close(): void }[]) => void) {
    const dir = mkdtempSync(join(tmpdir(), "lifefi-h-"));
    const file = join(dir, "old.sqlite");
    const handles: { close(): void }[] = [];
    try {
      const raw = new DatabaseSync(file);
      raw.exec(OLD_DDL);
      raw.prepare(OLD_INSERT).run(5000, "present", 0.05, 14, 1, "lying", 1);
      raw.close();
      fn(file, handles);
    } finally {
      for (const h of handles) {
        try {
          h.close();
        } catch {
          // already closed
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const columns = (file: string) => {
    const db = new DatabaseSync(file);
    const cols = (db.prepare("PRAGMA table_info(history)").all() as { name: string }[]).map((c) => c.name);
    const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    db.close();
    return { cols, v };
  };

  it("adds the heart columns once, keeps old rows, reopens as a no-op", () => {
    withOldDb((file, handles) => {
      const s = new Store(file);
      handles.push(s);
      expect(s.queryHistory(0, 10000)[0]).toMatchObject({ t: 5000, breathing_bpm: 14, heart_bpm: null, heart_valid: null });
      s.addHistory(row(10000, { heart_bpm: 58, heart_valid: true }));
      expect(s.queryHistory(10000, 10000)[0]).toMatchObject({ heart_bpm: 58, heart_valid: true });
      s.close();
      const again = new Store(file);
      handles.push(again);
      again.close();
      const { cols, v } = columns(file);
      expect(cols.filter((c) => c === "heart_bpm")).toHaveLength(1);
      expect(cols.filter((c) => c === "heart_valid")).toHaveLength(1);
      expect(v).toBe(1);
    });
  });

  it("an older build can still insert and read on a migrated file", () => {
    withOldDb((file, handles) => {
      new Store(file).close();
      const raw = new DatabaseSync(file);
      handles.push(raw);
      raw.prepare(OLD_INSERT).run(15000, "empty", 0, null, null, null, 0);
      const rows = raw.prepare("SELECT * FROM history ORDER BY t").all() as Record<string, unknown>[];
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ t: 15000, heart_bpm: null, heart_valid: null });
      raw.close();
    });
  });

  it("two stores opening the same old file both work", () => {
    withOldDb((file, handles) => {
      const a = new Store(file);
      handles.push(a);
      const b = new Store(file);
      handles.push(b);
      b.addHistory(row(20000, { heart_bpm: 70, heart_valid: true }));
      expect(a.queryHistory(20000, 20000)[0]).toMatchObject({ heart_bpm: 70 });
      a.close();
      b.close();
      expect(columns(file).cols.filter((c) => c === "heart_bpm")).toHaveLength(1);
    });
  });
});
