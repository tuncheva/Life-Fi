// Integration test against a real Firestore (track FB). Skipped unless FIRESTORE_IT=1; reads
// FIREBASE_* from ui/.env. Uses throwaway collections (lifefi_it_<random>_*) and deletes them after.
//   FIRESTORE_IT=1 npx vitest run test/firestore.it.test.ts
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Alert } from "../src/server/alerts";
import { createLogger } from "../src/server/log";
import { firebaseEnv, FirestoreStore } from "../src/server/store-firestore";
import type { HistoryRow } from "../src/server/store";

const RUN = process.env.FIRESTORE_IT === "1";
if (RUN && existsSync(".env")) process.loadEnvFile(".env");

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0); // a fixed minute boundary far from real data
const row = (t: number, extra: Partial<HistoryRow> = {}): HistoryRow => ({
  t,
  presence: "present",
  motion: 0.1,
  breathing_bpm: 14,
  breathing_valid: true,
  posture: "lying",
  count: 1,
  heart_bpm: 61.5,
  heart_valid: true,
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
  data: { nested: { list: [1, 2] }, missing: undefined },
});

describe.skipIf(!RUN)("FirestoreStore against a real project", () => {
  const prefix = `lifefi_it_${Math.random().toString(36).slice(2, 8)}_`;
  let s: FirestoreStore;

  beforeAll(() => {
    const fe = firebaseEnv();
    if (!fe) throw new Error("FIREBASE_* not set in ui/.env");
    s = new FirestoreStore({ ...fe, prefix }, createLogger("warn"));
  });

  afterAll(async () => {
    // everything this run wrote is older than "now + 1 day" with retention 0
    if (s) {
      await s.purge(0, Date.now() + 86_400_000);
      expect(await s.historySize()).toBe(0);
      await s.close();
    }
  }, 60_000);

  it("buffers history per minute and reads it back across minutes, including the unflushed one", async () => {
    for (let t = T0; t < T0 + 3 * 60_000; t += 5000) s.addHistory(row(t, { motion: (t - T0) / 1e6 }));
    s.addHistory(row(T0 + 5000, { motion: 0.9 })); // same bucket again: replaced, not duplicated
    // the third minute is still in the buffer: reads must include it
    const before = await s.queryHistory(T0, T0 + 3 * 60_000);
    expect(before).toHaveLength(36);
    await s.flush();
    expect(await s.historySize()).toBe(3);
    const rows = await s.queryHistory(T0 + 30_000, T0 + 90_000, ["presence", "heart"]);
    expect(rows.map((r) => r.t)).toEqual(Array.from({ length: 13 }, (_, i) => T0 + 30_000 + i * 5000));
    expect(rows[0]).toEqual({ t: T0 + 30_000, presence: "present", heart_bpm: 61.5, heart_valid: true });
    expect((await s.queryHistory(T0, T0 + 5000))[1]!.motion).toBe(0.9);
    const vitals = await s.vitalsRows(T0, T0 + 60_000);
    expect(vitals).toHaveLength(12); // `to` is exclusive
    expect(vitals[0]).toMatchObject({ breathing_valid: 1, heart_valid: 1 });
  }, 60_000);

  it("stores alerts with their latest state, newest first, and survives undefined fields", async () => {
    s.saveAlert(alert("a-9001", "pending", T0));
    s.saveAlert(alert("a-9001", "open", T0));
    s.saveAlert(alert("a-9001", "resolved", T0));
    s.saveAlert(alert("a-9002", "open", T0 + 1000));
    await s.flush();
    const loaded = await s.loadAlerts();
    expect(loaded.map((a) => [a.id, a.state])).toEqual([
      ["a-9002", "open"],
      ["a-9001", "resolved"],
    ]);
    expect(loaded[1]!.data).toEqual({ nested: { list: [1, 2] } });
  }, 60_000);

  it("stores events and filters by time and kind", async () => {
    s.addEvent({ t: T0 + 1000, kind: "presence", from: "empty", to: "present" });
    s.addEvent({ t: T0 + 2000, kind: "posture", from: null, to: "lying" });
    s.addEvent({ t: T0 + 3000, kind: "agent", data: { mode: "chat", tools: [{ name: "get_alerts", input: {}, ok: true }], ok: true } });
    await s.flush();
    expect((await s.queryEvents(T0, T0 + 10_000)).map((e) => e.kind)).toEqual(["presence", "posture", "agent"]);
    expect(await s.queryEvents(T0, T0 + 10_000, "agent")).toHaveLength(1);
    expect(await s.queryEvents(T0 + 1500, T0 + 2500)).toEqual([{ t: T0 + 2000, kind: "posture", from: null, to: "lying" }]);
  }, 60_000);

  it("sends writes on its own within seconds, and a new store loads recent data into its cache", async () => {
    const now = Date.now();
    s.addEvent({ t: now - 60_000, kind: "presence", from: "empty", to: "present" });
    s.saveAlert(alert("a-9100", "open", now - 30_000));
    for (let t = now - 120_000; t < now - 60_000; t += 5000) s.addHistory(row(Math.floor(t / 5000) * 5000));
    s.addHistory(row(Math.floor(now / 5000) * 5000)); // a later minute: the earlier one is written
    // no flush(): the store must send on its own (BulkWriter alone waits for 20 writes)
    await new Promise((r) => setTimeout(r, 3000));
    const fe = firebaseEnv()!;
    const fresh = new FirestoreStore({ ...fe, prefix }, createLogger("warn"));
    try {
      await fresh.ready;
      expect((await fresh.queryEvents(now - 3_600_000, now)).map((e) => e.to)).toEqual(["present"]);
      expect((await fresh.loadAlerts()).some((a) => a.id === "a-9100" && a.state === "open")).toBe(true);
      expect(await fresh.queryHistory(now - 3_600_000, now - 60_000)).toHaveLength(12);
    } finally {
      await fresh.close();
    }
  }, 60_000);

  it("purges by retention", async () => {
    const gone = await s.purge(1, T0 + 2 * 86_400_000);
    expect(gone).toBe(36);
    expect(await s.queryEvents(T0, T0 + 10_000)).toEqual([]);
    // the January alerts are gone; today's (previous test) is newer than the cutoff and stays
    expect((await s.loadAlerts()).map((a) => a.id)).toEqual(["a-9100"]);
  }, 60_000);
});
