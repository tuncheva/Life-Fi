import { describe, expect, it } from "vitest";
import type { Result } from "../src/lib/contracts.gen";
import { parseMinutes, RecentBuffer } from "../src/server/recent";

const r = (ts: number, boot = 1, source: Result["source"] = "replay"): Result =>
  ({ ts, boot_id: boot, source, presence: { state: "present", value: true, S: 0, B: 0, M: 0 }, motion: 0, count: null, breathing: { bpm: null, valid: false, confidence: 0, wave: [] }, health: { rate_hz: 90 } }) as unknown as Result;

describe("RecentBuffer", () => {
  it("wraps at capacity, oldest first", () => {
    const b = new RecentBuffer(3);
    for (let t = 1; t <= 5; t++) b.add(r(t));
    expect(b.length).toBe(3);
    expect(b.since(0).map((s) => s.t)).toEqual([3, 4, 5]);
  });

  it("since() filters by time", () => {
    const b = new RecentBuffer(10);
    for (let t = 1; t <= 5; t++) b.add(r(t * 1000));
    expect(b.since(3000).map((s) => s.t)).toEqual([3000, 4000, 5000]);
    expect(b.since(9000)).toEqual([]);
  });

  it("clears on a new boot or source", () => {
    const b = new RecentBuffer(10);
    b.add(r(1));
    b.add(r(2));
    b.add(r(3, 2));
    expect(b.since(0).map((s) => s.t)).toEqual([3]);
    expect(b.boot).toBe(2);
    b.add(r(4, 2, "live"));
    expect(b.since(0).map((s) => s.t)).toEqual([4]);
    expect(b.source).toBe("live");
  });
});

describe("parseMinutes", () => {
  it("accepts whole minutes 1..15, 15 when missing", () => {
    expect(parseMinutes(null)).toBe(15);
    expect(parseMinutes("5")).toBe(5);
    expect(parseMinutes("15")).toBe(15);
  });

  it("refuses everything else", () => {
    for (const q of ["0", "16", "2.5", "abc", "", "-1", " 5"]) expect(parseMinutes(q)).toBeNull();
  });
});
