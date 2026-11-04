import { describe, expect, it } from "vitest";
import type { Alert } from "../src/server/alerts";
import { MemoryStore, type HistoryRow } from "../src/server/store";

const row = (t: number, extra: Partial<HistoryRow> = {}) => ({
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

describe("MemoryStore (the store contract)", () => {
  it("keeps one row per bucket, replacing on the same t", async () => {
    const s = new MemoryStore();
    s.addHistory(row(5000, { motion: 0.1 }));
    s.addHistory(row(5000, { motion: 0.9 }));
    s.addHistory(row(10000));
    expect((await s.historySize())).toBe(2);
    const rows = await s.queryHistory(0, 20000);
    expect(rows.map((r) => r.t)).toEqual([5000, 10000]);
    expect(rows[0]!.motion).toBe(0.9);
    expect(rows[0]!.breathing_valid).toBe(true);
    await s.close();
  });

  it("filters by time range and picks fields", async () => {
    const s = new MemoryStore();
    for (let t = 0; t < 60000; t += 5000) s.addHistory(row(t, { breathing_bpm: null, breathing_valid: null }));
    const rows = await s.queryHistory(20000, 30000, ["presence", "breathing"]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ t: 20000, presence: "present", breathing_bpm: null, breathing_valid: null });
    expect("motion" in rows[0]!).toBe(false);
    await s.close();
  });

  it("purges rows and alerts older than the retention", async () => {
    const s = new MemoryStore();
    const day = 86_400_000;
    const now = 100 * day;
    s.addHistory(row(now - 40 * day));
    s.addHistory(row(now - 5 * day));
    s.saveAlert(alert("a-0001", "resolved", now - 40 * day));
    s.saveAlert(alert("a-0002", "resolved", now - 5 * day));
    expect((await s.purge(30, now))).toBe(1);
    expect((await s.historySize())).toBe(1);
    expect((await s.loadAlerts()).map((a) => a.id)).toEqual(["a-0002"]);
    await s.close();
  });

  it("stores the latest alert state and lists newest first", async () => {
    const s = new MemoryStore();
    s.saveAlert(alert("a-0001", "pending", 1000));
    s.saveAlert(alert("a-0001", "open", 1000));
    s.saveAlert(alert("a-0001", "resolved", 1000));
    s.saveAlert(alert("a-0002", "open", 2000));
    const loaded = (await s.loadAlerts());
    expect(loaded.map((a) => [a.id, a.state])).toEqual([
      ["a-0002", "open"],
      ["a-0001", "resolved"],
    ]);
    await s.close();
  });

  it("round-trips through AlertManager.load, closing what was live", async () => {
    const { AlertManager } = await import("../src/server/alerts");
    const { loadProfiles } = await import("../src/server/profiles");
    const { fileURLToPath } = await import("node:url");
    const { join, dirname } = await import("node:path");
    const profiles = loadProfiles(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "contracts", "profiles.yml"));
    const s = new MemoryStore();
    s.saveAlert(alert("a-0003", "open", 3000));
    s.saveAlert(alert("a-0001", "resolved", 1000));
    const m = new AlertManager(profiles, () => "home", () => 9999);
    const events: string[] = [];
    m.on("alert", (a) => events.push(`${a.id}:${a.state}`));
    expect(m.load(await s.loadAlerts())).toBe(2);
    expect(m.get("a-0003")?.state).toBe("resolved");
    expect(m.get("a-0003")?.resolved_at).toBe(9999);
    expect(m.get("a-0001")?.state).toBe("resolved");
    expect(events).toEqual(["a-0003:resolved"]);
    // the sequence continues after the highest saved id
    m.raiseServer("sensor_offline");
    expect(m.list(["open"]).map((a) => a.id)).toEqual(["a-0004"]);
    m.stop();
    await s.close();
  });
});

describe("Store heart columns (track H)", () => {
  it("round-trips heart and picks it as a field", async () => {
    const s = new MemoryStore();
    s.addHistory(row(5000, { heart_bpm: 62.5, heart_valid: true }));
    s.addHistory(row(10000));
    const rows = await s.queryHistory(0, 20000);
    expect(rows[0]).toMatchObject({ heart_bpm: 62.5, heart_valid: true });
    expect(rows[1]).toMatchObject({ heart_bpm: null, heart_valid: null });
    expect((await s.queryHistory(0, 20000, ["heart"]))[0]).toEqual({ t: 5000, heart_bpm: 62.5, heart_valid: true });
    expect(await s.vitalsRows(5000, 10000)).toEqual([
      { t: 5000, presence: "present", motion: 0.1, breathing_bpm: 14, breathing_valid: 1, heart_bpm: 62.5, heart_valid: 1, count: 1 },
    ]);
    await s.close();
  });

  it("purges rows with heart like any other", async () => {
    const s = new MemoryStore();
    const day = 86_400_000;
    s.addHistory(row(60 * day, { heart_bpm: 60, heart_valid: true }));
    expect((await s.purge(30, 100 * day))).toBe(1);
    await s.close();
  });
});

describe("MemoryStore events and alert log (track FB)", () => {
  it("keeps events by time and kind", async () => {
    const s = new MemoryStore();
    s.addEvent({ t: 3000, kind: "posture", from: "standing", to: "lying" });
    s.addEvent({ t: 1000, kind: "presence", from: "empty", to: "present" });
    s.addEvent({ t: 9000, kind: "agent", data: { mode: "summary" } });
    expect((await s.queryEvents(0, 5000)).map((e) => e.kind)).toEqual(["presence", "posture"]);
    expect(await s.queryEvents(0, 10000, "agent")).toHaveLength(1);
    expect(await s.purge(0, 5000 + 0)).toBe(0);
    expect((await s.queryEvents(0, 10000)).map((e) => e.t)).toEqual([9000]);
  });

  it("logs every alert transition", () => {
    const s = new MemoryStore();
    s.saveAlert(alert("a-0001", "pending", 1000));
    s.saveAlert(alert("a-0001", "resolved", 1000));
    expect(s.alertLog.map((l) => [l.alert_id, l.state, l.t])).toEqual([
      ["a-0001", "pending", 1000],
      ["a-0001", "resolved", 2000],
    ]);
  });
});
