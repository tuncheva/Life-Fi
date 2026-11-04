import { describe, expect, it } from "vitest";
import type { Result } from "../src/lib/contracts.gen";
import { shareText, withBucketGaps, type VitalsBucket } from "../src/lib/vitals-history";
import { History } from "../src/server/history";
import { Store, type VitalsRow } from "../src/server/store";
import { MIN_READINGS, parseVitalsQuery, quantile, summarize } from "../src/server/vitals-history";

const NOW = 1_767_225_600_000;
const q = (s: string) => parseVitalsQuery(new URLSearchParams(s), NOW);

const r = (t: number, extra: Partial<VitalsRow> = {}): VitalsRow => ({
  t,
  presence: "present",
  motion: 0.02,
  breathing_bpm: 14,
  breathing_valid: 1,
  heart_bpm: 60,
  heart_valid: 1,
  count: 1,
  ...extra,
});

describe("parseVitalsQuery", () => {
  it("defaults to 24 h with 10 min buckets ending now", () => {
    expect(q("")).toEqual({ hours: 24, from: NOW - 24 * 3_600_000, to: NOW, bucketMs: 600_000 });
  });

  it("maps 1 and 6 h to 60 s and 5 min buckets", () => {
    expect(q("hours=1")).toMatchObject({ hours: 1, bucketMs: 60_000, from: NOW - 3_600_000 });
    expect(q("hours=6")).toMatchObject({ hours: 6, bucketMs: 300_000 });
  });

  it.each(["0", "2", "25", "2.5", "abc", ""])("rejects hours=%s", (h) => {
    expect(q(`hours=${h}`)).toEqual({ error: "hours must be 1, 6 or 24" });
  });

  it("rejects a future or non-numeric to, accepts a past one", () => {
    expect(q(`to=${NOW + 61_000}`)).toHaveProperty("error");
    expect(q("to=x")).toHaveProperty("error");
    expect(q("to=")).toHaveProperty("error");
    expect(q(`hours=6&to=${NOW - 1000}`)).toMatchObject({ to: NOW - 1000, from: NOW - 1000 - 6 * 3_600_000 });
  });
});

describe("quantile", () => {
  it("interpolates linearly", () => {
    expect(quantile([1, 2, 3], 0.5)).toBe(2);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(quantile([10, 20], 0.75)).toBe(17.5);
    expect(quantile([], 0.5)).toBeNull();
  });
});

describe("summarize", () => {
  const B = 60_000;

  it("returns only non-empty, aligned buckets", () => {
    const rows = [r(5_000), r(10_000), r(125_000)];
    const { buckets } = summarize(rows, B);
    expect(buckets.map((b) => b.t)).toEqual([0, 120_000]);
    expect(buckets[0]!.n).toBe(2);
  });

  it("counts only valid, in-range, single-person, present rows as readings", () => {
    const rows = [
      r(0, { breathing_valid: 0, heart_valid: 0, heart_bpm: null }),
      r(5_000, { breathing_bpm: 70, heart_bpm: 30 }),
      r(10_000, { breathing_bpm: 2, heart_bpm: 210 }),
      r(15_000, { count: 2 }),
      r(20_000, { presence: "empty" }),
      r(25_000, { presence: "uncertain" }),
    ];
    const { buckets, summary } = summarize(rows, B);
    expect(buckets[0]).toMatchObject({ n: 6, present_n: 4, breath_n: 0, heart_n: 0, breath_med: null, heart_med: null, heart_on_n: 4 });
    expect(summary.present_n).toBe(4);
  });

  it(`needs ${MIN_READINGS} readings for a median`, () => {
    const two = summarize([r(0, { breathing_bpm: 12 }), r(5_000, { breathing_bpm: 16 })], B).buckets[0]!;
    expect(two.breath_n).toBe(2);
    expect(two.breath_med).toBeNull();
    const three = summarize([r(0, { breathing_bpm: 12 }), r(5_000, { breathing_bpm: 16 }), r(10_000, { breathing_bpm: 13 })], B).buckets[0]!;
    expect(three.breath_med).toBe(13);
    const four = summarize([12, 16, 13, 18].map((v, i) => r(i * 5_000, { breathing_bpm: v })), B).buckets[0]!;
    expect(four.breath_med).toBe(14.5);
  });

  it("heart_on_n is 0 when no row had a heart estimate", () => {
    const { buckets, summary } = summarize([r(0, { heart_valid: null, heart_bpm: null }), r(5_000, { heart_valid: null, heart_bpm: null })], B);
    expect(buckets[0]!.heart_on_n).toBe(0);
    expect(summary.heart_on_n).toBe(0);
    expect(summary.heart_med).toBeNull();
  });

  it("still uses MOTION_ON: 0.09 is still, 0.1 is not", () => {
    const { buckets, summary } = summarize([r(0, { motion: 0.09 }), r(5_000, { motion: 0.1 }), r(10_000, { motion: 0.5, presence: "empty" })], B);
    expect(buckets[0]!.still_n).toBe(1);
    expect(buckets[0]!.motion_med).toBe(0.1);
    expect(summary.still_n).toBe(1);
  });

  it("summary share is over present rows and its median over all readings", () => {
    // bucket 0: 3 readings 10,10,10; bucket 1: 5 readings 20 → bucket medians 10, 20
    const rows = [
      ...[0, 5, 10].map((s) => r(s * 1000, { breathing_bpm: 10 })),
      r(15_000, { breathing_valid: 0 }),
      ...[60, 65, 70, 75, 80].map((s) => r(s * 1000, { breathing_bpm: 20 })),
    ];
    const { summary } = summarize(rows, B);
    expect(summary.present_n).toBe(9);
    expect(summary.breath_n).toBe(8);
    // a median of bucket medians would be 15; over all readings it is 20
    expect(summary.breath_med).toBe(20);
    expect(summary.breath_q1).toBe(10);
    expect(shareText(summary.breath_n, summary.present_n)).toBe("89 %");
  });

  it("zero rows give no buckets and null medians", () => {
    const { buckets, summary } = summarize([], B);
    expect(buckets).toEqual([]);
    expect(summary).toMatchObject({ n: 0, present_n: 0, breath_med: null, heart_med: null, breath_q1: null });
  });
});

describe("History.add (heart)", () => {
  const result = (heart: unknown): Result =>
    ({
      ts: 7_000,
      presence: { state: "present" },
      motion: 0.03,
      breathing: { bpm: 14, valid: true, confidence: 0.9 },
      count: { value: 1 },
      ...(heart === undefined ? {} : { heart }),
    }) as unknown as Result;

  const stored = (heart: unknown, storeVitals = true) => {
    const s = new Store(":memory:");
    new History(s).add(result(heart), storeVitals);
    const row = s.queryHistory(0, 10_000)[0]!;
    s.close();
    return row;
  };

  it("stores nothing vital when the profile says no", () => {
    expect(stored({ bpm: 60, valid: true, confidence: 0.5 }, false)).toMatchObject({ breathing_bpm: null, breathing_valid: null, heart_bpm: null, heart_valid: null });
  });

  it("no heart in the result → heart null", () => {
    expect(stored(undefined)).toMatchObject({ breathing_bpm: 14, heart_bpm: null, heart_valid: null });
    expect(stored(null)).toMatchObject({ heart_bpm: null, heart_valid: null });
  });

  it("an invalid heart keeps the flag but not the number", () => {
    expect(stored({ bpm: 70, valid: false, confidence: 0.1 })).toMatchObject({ heart_bpm: null, heart_valid: false });
  });

  it("a valid heart is stored", () => {
    expect(stored({ bpm: 61.5, valid: true, confidence: 0.6 })).toMatchObject({ t: 5_000, heart_bpm: 61.5, heart_valid: true });
  });
});

describe("withBucketGaps / shareText", () => {
  const b = (t: number, v: number | null): VitalsBucket => ({
    t, n: 1, present_n: 1, still_n: 1, motion_med: 0, breath_n: 3, breath_med: v, heart_on_n: 0, heart_n: 0, heart_med: null,
  });

  it("inserts a null between non-adjacent buckets only", () => {
    expect(withBucketGaps([b(0, 12), b(60_000, 13), b(240_000, 14)], 60_000, (x) => x.breath_med)).toEqual([
      [0, 60_000, 120_000, 240_000],
      [12, 13, null, 14],
    ]);
  });

  it("shareText needs someone present", () => {
    expect(shareText(0, 0)).toBeNull();
    expect(shareText(1, 3)).toBe("33 %");
  });
});
