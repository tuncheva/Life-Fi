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
