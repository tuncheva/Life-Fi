import { describe, expect, it } from "vitest";
import type { Result } from "../src/lib/contracts.gen";
import { mergeSeed, readWindow, secondsWhere, trendSample, trendSeries, trendSnapshot, trendStats, type TrendSample } from "../src/lib/model";

const full = {
  ts: 5000,
  boot_id: 1,
  source: "replay",
  presence: { state: "present", value: true, S: 0, B: 0, M: 0 },
  motion: 0.1,
  count: { value: 1, p: [0.9, 0.1], src: "model" },
  breathing: { bpm: 15, valid: true, confidence: 0.9, wave: [], reason: null },
  heart: { bpm: 70, valid: true, confidence: 0.3, reason: null },
  occupancy: { state: "occupied", p: 0.92 },
  position: { valid: true, d_m: 2.1, d_sd: 0.4, R_db: 3, noise_db: -10, held: false, zone: "middle", people: 1, quality: "low", spot: { name: "bed", p: 0.8, d_m: 2.5, reliable: true } },
  health: { rate_hz: 95, loss_udp: 0.01, loss_air: 0.02, warmup: false },
  link: { rssi_dbm: -55, board: null },
} as unknown as Result;

const bare = { ts: 1, presence: { state: "empty", value: false, S: 0, B: 0, M: 0 }, motion: 0, count: null, breathing: { bpm: null, valid: false, confidence: 0, wave: [] }, health: { rate_hz: 0 } } as unknown as Result;

const s = (t: number, over: Partial<TrendSample> = {}): TrendSample => ({ ...trendSample(bare), t, ...over });

describe("trendSample", () => {
  it("takes every field from a full result", () => {
    expect(trendSample(full)).toEqual({
      t: 5000,
      presence: "present",
      occP: 0.92,
      breath: 15,
      breathConf: 0.9,
      heart: 70,
      heartOn: true,
      motion: 0.1,
      d: 2.1,
      sd: 0.4,
      lowQuality: true,
      spotD: 2.5,
      spotOn: true,
      rateHz: 95,
      lossUdp: 0.01,
      lossAir: 0.02,
      rssi: -55,
      warmup: false,
    });
  });

  it("does not throw on an older engine's result", () => {
    expect(trendSample(bare)).toMatchObject({ occP: null, breath: null, heart: null, heartOn: false, d: null, spotD: null, spotOn: false, rssi: null, lossUdp: 0 });
  });

  it("drops both rates when two people are counted", () => {
    const two = { ...full, count: { value: 2, p: [0.1, 0.9], src: "model" } } as Result;
    expect(trendSample(two)).toMatchObject({ breath: null, heart: null, heartOn: true });
  });

  it("drops out-of-range rates and unreliable spots", () => {
    const r = { ...full, breathing: { ...full.breathing, bpm: 80 }, position: { ...full.position!, spot: { name: "bed", p: 0.5, d_m: 2, reliable: false } } } as Result;
    expect(trendSample(r)).toMatchObject({ breath: null, spotD: null, spotOn: true });
  });
});

describe("trendSeries", () => {
  it("cuts to the window before the newest sample, x in seconds ago, nulls kept", () => {
    const rows = [s(0, { breath: 10 }), s(60_000, { breath: null }), s(100_000, { breath: 12 }), s(120_000, { breath: 14 })];
    const [x, y] = trendSeries(rows, 60, [(r) => r.breath]);
    expect(x).toEqual([-60, -20, 0]);
    expect(y).toEqual([null, 12, 14]);
  });

  it("gives empty columns for no samples", () => {
    expect(trendSeries([], 60, [(r) => r.breath, (r) => r.heart])).toEqual([[], [], []]);
  });
});

describe("trendStats", () => {
  it("share, median and range ignore nulls", () => {
    const rows = [s(0, { breath: 10 }), s(1, { breath: null }), s(2, { breath: 14 }), s(3, { breath: 12 })];
    expect(trendStats(rows, (r) => r.breath)).toEqual({ n: 4, read: 3, share: 0.75, median: 12, min: 10, max: 14 });
  });

  it("all null → no numbers", () => {
    expect(trendStats([s(0), s(1)], (r) => r.heart)).toEqual({ n: 2, read: 0, share: 0, median: null, min: null, max: null });
    expect(trendStats([], (r) => r.heart).share).toBe(0);
  });

  it("even count → mean of the middle two", () => {
    expect(trendStats([s(0, { breath: 10 }), s(1, { breath: 20 })], (r) => r.breath).median).toBe(15);
  });
});

describe("secondsWhere", () => {
  it("counts each sample until the next, gaps capped", () => {
    const rows = [s(0, { presence: "present" }), s(500, { presence: "present" }), s(1000), s(60_000, { presence: "present" })];
    expect(secondsWhere(rows, (r) => r.presence === "present")).toBe(1.5);
  });
});

describe("mergeSeed", () => {
  it("keeps seed before the first live sample and drops the overlap", () => {
    const seed = [s(1), s(2), s(3)];
    const live = [s(3), s(4)];
    expect(mergeSeed(seed, live).map((r) => r.t)).toEqual([1, 2, 3, 4]);
  });

  it("caps to the newest", () => {
    const seed = Array.from({ length: 10 }, (_, i) => s(i));
    expect(mergeSeed(seed, [s(10)], 4).map((r) => r.t)).toEqual([7, 8, 9, 10]);
  });

  it("handles an empty seed or empty live", () => {
    expect(mergeSeed([], [s(1)]).map((r) => r.t)).toEqual([1]);
    expect(mergeSeed([s(1)], []).map((r) => r.t)).toEqual([1]);
  });
});

describe("trendSnapshot", () => {
  it("copies once per version", () => {
    let copies = 0;
    const src = { version: 1, trend: { toArray: () => (copies++, [s(1)]) } };
    const a = trendSnapshot(src);
    expect(trendSnapshot(src)).toBe(a);
    src.version = 2;
    trendSnapshot(src);
    expect(copies).toBe(2);
  });
});

describe("readWindow", () => {
  it("defaults to 15 min", () => {
    expect(readWindow(null)).toBe(900);
    expect(readWindow({ getItem: () => "300" } as unknown as Storage)).toBe(300);
    expect(readWindow({ getItem: () => "7" } as unknown as Storage)).toBe(900);
    expect(readWindow({ getItem: () => { throw new Error("private"); } } as unknown as Storage)).toBe(900);
  });
});
