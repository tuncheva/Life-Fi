import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AlertManager, type Alert } from "../src/alerts.js";
import { insideHours, loadProfiles, minutesOfDayIn, type ProfileName, type ProfilesConfig } from "../src/profiles.js";
import type { Result } from "../src/contracts.gen.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const profiles: ProfilesConfig = loadProfiles(join(repo, "contracts", "profiles.yml"));

// 2026-01-15 12:00 UTC = 14:00 Europe/Sofia (UTC+2 in winter): outside 21:00-07:00.
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
const BOOT = 1234;

interface ResultOpts {
  ts?: number;
  boot_id?: number;
  events?: Result["events"];
  active?: number[];
}

function mkResult(o: ResultOpts = {}): Result {
  return {
    type: "result",
    v: 2,
    ts: o.ts ?? T0,
    t_rx_last_us: (o.ts ?? T0) * 1000,
    node: 1,
    boot_id: o.boot_id ?? BOOT,
    source: "live",
    config_hash: "x",
    pipeline_version: 2,
    health: { rate_hz: 88, loss_udp: 0, loss_air: 0, invalid_ratio: 0, rejected: { layout: 0, gain_invalid: 0 }, warmup: false },
    calibration: { state: "ok", id: "cal-0001", age_s: 10 },
    presence: { value: true, state: "present", S: 0.2, B: 0.7, M: 0.03 },
    motion: 0.03,
    posture: null,
    count: null,
    activity: null,
    breathing: { bpm: null, confidence: 0.1, valid: false, wave: [] },
    csi: [],
    events: o.events ?? [],
    active: o.active ?? [],
  };
}

function activeEv(id: number, type: string, t: number, data: Record<string, unknown> = {}): Result["events"][number] {
  return { id, type: type as Result["events"][number]["type"], state: "active", t, data };
}
function clearedEv(id: number, type: string, t: number): Result["events"][number] {
  return { id, type: type as Result["events"][number]["type"], state: "cleared", t, data: {} };
}

describe("AlertManager", () => {
  let now: number;
  let profile: ProfileName;
  let mgr: AlertManager;
  let transitions: Alert[];
  let notifies: [Alert, "open" | "escalation"][];

  /** Advances the injected clock and the fake timers together. */
  const advance = (ms: number) => {
    now += ms;
    vi.advanceTimersByTime(ms);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    now = T0;
    profile = "home";
    transitions = [];
    notifies = [];
    mgr = new AlertManager(profiles, () => profile, () => now);
    mgr.on("alert", (a) => transitions.push(a));
    mgr.on("notify", (a, kind) => notifies.push([a, kind]));
  });

  afterEach(() => {
    mgr.stop();
    vi.useRealTimers();
  });

  it("fall with delay 0 opens immediately and notifies 'open'", () => {
    mgr.onResult(mkResult({ events: [activeEv(1, "fall", T0, { peak: 0.9 })], active: [1] }));
    const alerts = mgr.list();
    expect(alerts).toHaveLength(1);
    const a = alerts[0]!;
    expect(a).toMatchObject({
      id: "a-0001",
      event_id: 1,
      type: "fall",
      level: "high",
      state: "open",
      profile: "home",
      config_hash: profiles.hash,
      created_at: T0,
      opened_at: T0,
      notified_at: T0,
      acked_at: null,
      resolved_at: null,
      escalated_at: null,
      data: { peak: 0.9 },
    });
    expect(transitions.map((t) => t.state)).toEqual(["pending", "open"]);
    expect(notifies).toHaveLength(1);
    expect(notifies[0]![1]).toBe("open");
    expect(notifies[0]![0].id).toBe("a-0001");
    expect(mgr.openCount()).toBe(1);
    expect(mgr.isActive("e:1")).toBe(true);
  });

  it("no_breathing in home is pending for 5 s and then opens", () => {
    mgr.onResult(mkResult({ events: [activeEv(7, "no_breathing", T0, { since_s: 12 })], active: [7] }));
    const a = mgr.get("a-0001")!;
    expect(a.state).toBe("pending");
    expect(a.level).toBe("high");
    expect(notifies).toHaveLength(0);

    advance(4999);
    expect(a.state).toBe("pending");
    expect(notifies).toHaveLength(0);

    advance(1);
    expect(a.state).toBe("open");
    expect(a.opened_at).toBe(T0 + 5000);
    expect(a.notified_at).toBe(T0 + 5000);
    expect(notifies).toHaveLength(1);
    expect(notifies[0]![1]).toBe("open");
    expect(transitions.map((t) => t.state)).toEqual(["pending", "open"]);
  });

  it("pending alert cleared before the timer is dropped without notifying", () => {
    mgr.onResult(mkResult({ events: [activeEv(7, "no_breathing", T0)], active: [7] }));
    advance(2000);
    mgr.onResult(mkResult({ ts: now, events: [clearedEv(7, "no_breathing", now)], active: [] }));
    const a = mgr.get("a-0001")!;
    expect(a.state).toBe("dropped");
    expect(a.resolved_at).toBe(T0 + 2000);
    expect(a.opened_at).toBeNull();

    advance(10_000); // the delay timer must not fire any more
    expect(a.state).toBe("dropped");
    expect(notifies).toHaveLength(0);
    expect(transitions.map((t) => t.state)).toEqual(["pending", "dropped"]);
    expect(mgr.isActive("e:7")).toBe(false);
  });

  it("ack: open → acked; non-open returns false; unknown id returns null", () => {
    mgr.onResult(mkResult({ events: [activeEv(1, "fall", T0), activeEv(2, "no_breathing", T0)], active: [1, 2] }));
    advance(1000);

    const acked = mgr.ack("a-0001");
    expect(acked).toMatchObject({ id: "a-0001", state: "acked", acked_at: T0 + 1000 });
    expect(mgr.get("a-0001")!.state).toBe("acked");
    expect(mgr.openCount()).toBe(0);

    // acking again: no longer open
    expect(mgr.ack("a-0001")).toBe(false);
    // a-0002 is still pending (delay 5 s)
    expect(mgr.get("a-0002")!.state).toBe("pending");
    expect(mgr.ack("a-0002")).toBe(false);
    expect(mgr.ack("a-9999")).toBeNull();

    // once acked, no escalation ever fires for a-0001 (a-0002 opens after 5 s and does escalate)
    advance(10 * 60_000);
    expect(notifies.filter(([a, k]) => k === "escalation" && a.id === "a-0001")).toHaveLength(0);
    expect(notifies.filter(([a, k]) => k === "escalation" && a.id === "a-0002").length).toBeGreaterThan(0);
    expect(mgr.get("a-0001")!.escalated_at).toBeNull();
  });

  it("cleared while open → resolved", () => {
    mgr.onResult(mkResult({ events: [activeEv(1, "fall", T0)], active: [1] }));
    advance(3000);
    mgr.onResult(mkResult({ ts: now, events: [clearedEv(1, "fall", now)], active: [] }));
    const a = mgr.get("a-0001")!;
    expect(a.state).toBe("resolved");
    expect(a.resolved_at).toBe(T0 + 3000);
    expect(transitions.map((t) => t.state)).toEqual(["pending", "open", "resolved"]);
    expect(mgr.openCount()).toBe(0);
  });

  it("cleared while acked → resolved", () => {
    mgr.onResult(mkResult({ events: [activeEv(1, "fall", T0)], active: [1] }));
    advance(1000);
    expect(mgr.ack("a-0001")).not.toBe(false);
    advance(1000);
    mgr.onResult(mkResult({ ts: now, events: [clearedEv(1, "fall", now)], active: [] }));
    const a = mgr.get("a-0001")!;
    expect(a.state).toBe("resolved");
    expect(a.resolved_at).toBe(T0 + 2000);
    expect(transitions.map((t) => t.state)).toEqual(["pending", "open", "acked", "resolved"]);
  });

  it("reconcile: an id missing from `active` resolves the alert even without a cleared edge", () => {
    mgr.onResult(mkResult({ events: [activeEv(1, "fall", T0), activeEv(2, "fainted_suspected", T0)], active: [1, 2] }));
    expect(mgr.openCount()).toBe(2);
    advance(500);
    // the engine dropped event 1 from `active` but never sent a "cleared" edge
    mgr.onResult(mkResult({ ts: now, active: [2] }));
    expect(mgr.get("a-0001")!.state).toBe("resolved");
    expect(mgr.get("a-0001")!.resolved_at).toBe(T0 + 500);
    expect(mgr.get("a-0002")!.state).toBe("open");
    expect(mgr.isActive("e:1")).toBe(false);
    expect(mgr.isActive("e:2")).toBe(true);
  });

  it("an engine reconnect closes what the engine no longer has as 'engine restarted', keeps server alerts", () => {
    mgr.onResult(mkResult({ events: [activeEv(1, "fall", T0), activeEv(2, "no_breathing", T0)], active: [1, 2] }));
    mgr.raiseServer("sensor_offline", { reason: "x" });
    expect(mgr.get("a-0001")!.state).toBe("open"); // fall
    expect(mgr.get("a-0002")!.state).toBe("pending"); // no_breathing (delay 5)
    expect(mgr.get("a-0003")!.state).toBe("open"); // sensor_offline

    advance(1000);
    // the engine restarted: it has none of the old conditions, and a new event with a new id
    mgr.onEngineConnected();
    mgr.onResult(mkResult({ ts: now, events: [activeEv(9001, "fall", now)], active: [9001] }));

    expect(mgr.get("a-0001")!).toMatchObject({ state: "resolved", resolved_at: T0 + 1000, data: { closed_by: "engine restarted" } });
    expect(mgr.get("a-0002")!.state).toBe("dropped");
    expect(mgr.get("a-0003")!.state).toBe("open");
    expect(mgr.isActive("s:sensor_offline")).toBe(true);
    expect(mgr.get("a-0004")!).toMatchObject({ type: "fall", event_id: 9001, state: "open", created_at: T0 + 1000 });
  });

  it("an engine reconnect keeps the conditions the engine still reports", () => {
    mgr.onResult(mkResult({ events: [activeEv(1, "fall", T0)], active: [1] }));
    advance(1000);
    mgr.onEngineConnected();
    mgr.onResult(mkResult({ ts: now, active: [1] }));
    expect(mgr.get("a-0001")!.state).toBe("open");
    expect(mgr.list()).toHaveLength(1);
  });

  it("a board reboot (new boot_id) keeps every alert open", () => {
    mgr.onResult(mkResult({ events: [activeEv(1, "fall", T0)], active: [1] }));
    advance(1000);
    mgr.onResult(mkResult({ ts: now, boot_id: BOOT + 1, active: [1] }));
    expect(mgr.get("a-0001")!.state).toBe("open");
    expect(mgr.list()).toHaveLength(1);
    expect(notifies).toHaveLength(1); // the phone is not told twice
  });

  it("the delay counts from when the condition began", () => {
    advance(4000);
    // recovered after a reconnect: no_breathing (delay 5 s) began 4 s ago, so 1 s is left
    mgr.syncActive([{ id: 5, type: "no_breathing", t: T0 }]);
    expect(mgr.get("a-0001")!.state).toBe("pending");
    advance(999);
    expect(mgr.get("a-0001")!.state).toBe("pending");
    advance(1);
    expect(mgr.get("a-0001")!.state).toBe("open");
    // one that began more than 5 s ago opens at once
    mgr.syncActive([{ id: 6, type: "no_breathing", t: T0 - 10_000 }]);
    expect(mgr.get("a-0002")!.state).toBe("open");
  });

  it("escalates an open, unacked alert after escalate_after_s and re-notifies", () => {
    expect(profiles.notify.escalate_after_s).toBe(120);
    mgr.onResult(mkResult({ events: [activeEv(1, "fall", T0)], active: [1] }));
    const a = mgr.get("a-0001")!;
    expect(notifies).toHaveLength(1);

    advance(119_999);
    expect(a.escalated_at).toBeNull();
    expect(notifies).toHaveLength(1);

    advance(1);
    expect(a.state).toBe("open");
    expect(a.escalated_at).toBe(T0 + 120_000);
    expect(a.notified_at).toBe(T0 + 120_000);
    expect(notifies).toHaveLength(2);
    expect(notifies[1]![1]).toBe("escalation");
    expect(notifies[1]![0].id).toBe("a-0001");

    // it keeps escalating while still open
    advance(120_000);
    expect(a.escalated_at).toBe(T0 + 240_000);
    expect(notifies).toHaveLength(3);
    expect(notifies[2]![1]).toBe("escalation");

    // resolving stops it
    mgr.onResult(mkResult({ ts: now, active: [] }));
    expect(a.state).toBe("resolved");
    advance(600_000);
    expect(notifies).toHaveLength(3);
  });

  it("a type the active profile does not alert on creates nothing", () => {
    profile = "school";
    mgr.onResult(mkResult({ events: [activeEv(1, "no_breathing", T0), activeEv(2, "bed_exit", T0)], active: [1, 2] }));
    expect(mgr.list()).toHaveLength(0);
    expect(transitions).toHaveLength(0);
    expect(notifies).toHaveLength(0);
    expect(mgr.isActive("e:1")).toBe(false);

    // but a fall is still alerted in school
    mgr.onResult(mkResult({ events: [activeEv(3, "fall", T0)], active: [1, 2, 3] }));
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.get("a-0001")).toMatchObject({ type: "fall", profile: "school", state: "open" });
  });

  describe("hours window (bed_exit in clinic, 21:00-07:00, Europe/Sofia)", () => {
    it("insideHours handles a window that wraps midnight", () => {
      const w = "21:00-07:00";
      expect(insideHours(w, 21 * 60)).toBe(true);
      expect(insideHours(w, 23 * 60 + 59)).toBe(true);
      expect(insideHours(w, 0)).toBe(true);
      expect(insideHours(w, 6 * 60 + 59)).toBe(true);
      expect(insideHours(w, 7 * 60)).toBe(false);
      expect(insideHours(w, 12 * 60)).toBe(false);
      expect(insideHours(w, 20 * 60 + 59)).toBe(false);
    });

    it("insideHours handles a same-day window and an unparsable window", () => {
      expect(insideHours("09:00-17:00", 9 * 60)).toBe(true);
      expect(insideHours("09:00-17:00", 16 * 60 + 59)).toBe(true);
      expect(insideHours("09:00-17:00", 17 * 60)).toBe(false);
      expect(insideHours("09:00-17:00", 8 * 60 + 59)).toBe(false);
      expect(insideHours("always", 0)).toBe(true);
    });

    it("minutesOfDayIn converts to Sofia local time", () => {
      // 20:00 UTC on 2026-01-15 is 22:00 in Sofia (UTC+2)
      expect(minutesOfDayIn("Europe/Sofia", Date.UTC(2026, 0, 15, 20, 0, 0))).toBe(22 * 60);
      // 10:00 UTC is 12:00 in Sofia
      expect(minutesOfDayIn("Europe/Sofia", Date.UTC(2026, 0, 15, 10, 0, 0))).toBe(12 * 60);
      // in summer Sofia is UTC+3: 20:00 UTC is 23:00
      expect(minutesOfDayIn("Europe/Sofia", Date.UTC(2026, 6, 15, 20, 0, 0))).toBe(23 * 60);
    });

    it("the manager alerts on bed_exit at 22:00 Sofia", () => {
      profile = "clinic";
      const t = Date.UTC(2026, 0, 15, 20, 0, 0); // 22:00 Europe/Sofia
      now = t;
      mgr.onResult(mkResult({ ts: t, events: [activeEv(5, "bed_exit", t)], active: [5] }));
      expect(mgr.list()).toHaveLength(1);
      expect(mgr.get("a-0001")).toMatchObject({ type: "bed_exit", profile: "clinic", level: "high", state: "open", created_at: t });
      expect(notifies).toHaveLength(1);
    });

    it("the manager ignores bed_exit at 12:00 Sofia", () => {
      profile = "clinic";
      const t = Date.UTC(2026, 0, 15, 10, 0, 0); // 12:00 Europe/Sofia
      now = t;
      mgr.onResult(mkResult({ ts: t, events: [activeEv(5, "bed_exit", t)], active: [5] }));
      expect(mgr.list()).toHaveLength(0);
      expect(notifies).toHaveLength(0);
      expect(mgr.isActive("e:5")).toBe(false);
    });

    it("the manager alerts on bed_exit just before 07:00 and not at 07:00 Sofia", () => {
      profile = "clinic";
      const before = Date.UTC(2026, 0, 15, 4, 59, 0); // 06:59 Europe/Sofia
      now = before;
      mgr.onResult(mkResult({ ts: before, events: [activeEv(5, "bed_exit", before)], active: [5] }));
      expect(mgr.list()).toHaveLength(1);

      const at = Date.UTC(2026, 0, 16, 5, 0, 0); // 07:00 Europe/Sofia, next day
      now = at;
      mgr.onResult(mkResult({ ts: at, events: [activeEv(6, "bed_exit", at)], active: [6] }));
      expect(mgr.list()).toHaveLength(1); // nothing new; the first one was resolved by reconcile
      expect(mgr.get("a-0001")!.state).toBe("resolved");
    });
  });

  it("list() filters by state and sorts newest first", () => {
    mgr.onResult(mkResult({ ts: T0, events: [activeEv(1, "fall", T0)], active: [1] }));
    advance(1000);
    mgr.onResult(mkResult({ ts: now, events: [activeEv(2, "no_breathing", now)], active: [1, 2] }));
    expect(mgr.list().map((a) => a.id)).toEqual(["a-0002", "a-0001"]);
    expect(mgr.list(["open"]).map((a) => a.id)).toEqual(["a-0001"]);
    expect(mgr.list(["pending"]).map((a) => a.id)).toEqual(["a-0002"]);
    expect(mgr.list(["resolved", "dropped"])).toEqual([]);
  });
});
