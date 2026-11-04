// The `/model` ("Insights") page's data side (docs/overnight/2026-11-04/plans/M-dashboard-model.md §3):
// one lean `TrendSample` per result, kept 15 min on the client (live.tsx buffers.trend) and on
// the server (server/recent.ts, GET /api/v1/recent) so a reload starts with the charts filled.
// Pure and without "use client": the server ring and the route import it too.
import type { Result } from "./contracts.gen";
import { BREATH_RANGE, HEART_RANGE, inRange } from "./vitals";

/** 15 min at one result per 0.5 s. */
export const TREND_CAPACITY = 1800;
export const TREND_SECONDS = 900;

export interface TrendSample {
  /** Result ts, ms. */
  t: number;
  presence: "empty" | "present" | "uncertain";
  /** occupancy.p, null when the engine sends none. */
  occP: number | null;
  /** Breaths/min, only when valid and in BREATH_RANGE; null = a gap. */
  breath: number | null;
  breathConf: number;
  /** Beats/min, same rule with HEART_RANGE; null when absent or invalid. */
  heart: number | null;
  /** The engine sends a `heart` object at all (it has a heart estimator). */
  heartOn: boolean;
  motion: number;
  /** position.d_m / d_sd, only while position.valid. */
  d: number | null;
  sd: number | null;
  /** position.quality === "low". */
  lowQuality: boolean;
  /** The taught spot's distance, only when the engine rates the spot model reliable. */
  spotD: number | null;
  /** Is a spot model loaded at all (position.spot present). */
  spotOn: boolean;
  rateHz: number;
  lossUdp: number;
  lossAir: number;
  rssi: number | null;
  warmup: boolean;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** One result → one sample. Never throws on an older engine's result (every optional field missing). */
export function trendSample(r: Result): TrendSample {
  const several = r.count?.value === 2; // one link cannot separate two chests
  const b = r.breathing;
  const h = (r as { heart?: Result["heart"] }).heart ?? null;
  const pos = r.position ?? null;
  const spot = pos?.spot ?? null;
  const occ = (r as { occupancy?: Result["occupancy"] }).occupancy ?? null;
  return {
    t: r.ts,
    presence: r.presence.state,
    occP: num(occ?.p),
    breath: !several && b?.valid && inRange(b.bpm, BREATH_RANGE) ? b.bpm : null,
    breathConf: num(b?.confidence) ?? 0,
    heart: !several && h?.valid && inRange(h.bpm, HEART_RANGE) ? h.bpm : null,
    heartOn: !!h && typeof h === "object",
    motion: num(r.motion) ?? 0,
    d: pos?.valid ? num(pos.d_m) : null,
    sd: pos?.valid ? num(pos.d_sd) : null,
    lowQuality: pos?.quality === "low",
    spotD: spot && spot.reliable === true ? num(spot.d_m) : null,
    spotOn: !!spot,
    rateHz: num(r.health?.rate_hz) ?? 0,
    lossUdp: num(r.health?.loss_udp) ?? 0,
    lossAir: num(r.health?.loss_air) ?? 0,
    rssi: num(r.link?.rssi_dbm),
    warmup: !!r.health?.warmup,
  };
}

export type Pick = (s: TrendSample) => number | null;

/**
 * uPlot columns for the last `windowS` seconds before the newest sample: x in seconds ago
 * (negative, newest = 0), one column per pick; nulls stay as gaps.
 */
export function trendSeries(samples: readonly TrendSample[], windowS: number, picks: readonly Pick[]): (number | null)[][] {
  const cut = windowed(samples, windowS);
  const now = cut.length ? cut[cut.length - 1]!.t : 0;
  return [cut.map((s) => (s.t - now) / 1000), ...picks.map((p) => cut.map(p))];
}

/** The samples of the last `windowS` seconds before the newest one. */
export function windowed(samples: readonly TrendSample[], windowS: number): readonly TrendSample[] {
  if (!samples.length) return samples;
  const from = samples[samples.length - 1]!.t - windowS * 1000;
  let i = samples.length;
  while (i > 0 && samples[i - 1]!.t >= from) i--;
  return i === 0 ? samples : samples.slice(i);
}

export interface TrendStats {
  /** Samples in the input. */
  n: number;
  /** Samples with a number. */
  read: number;
  /** read / n, 0 for no samples. */
  share: number;
  median: number | null;
  min: number | null;
  max: number | null;
}

/** Share of samples with a value, median and range of the values (nulls ignored). */
export function trendStats(samples: readonly TrendSample[], pick: Pick): TrendStats {
  const vals: number[] = [];
  for (const s of samples) {
    const v = pick(s);
    if (v !== null && Number.isFinite(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  const n = samples.length;
  if (!vals.length) return { n, read: 0, share: 0, median: null, min: null, max: null };
  const mid = vals.length >> 1;
  const median = vals.length % 2 ? vals[mid]! : (vals[mid - 1]! + vals[mid]!) / 2;
  return { n, read: vals.length, share: vals.length / n, median, min: vals[0]!, max: vals[vals.length - 1]! };
}

/** Longest step counted between two samples: a gap in the data is not time "spent" in a state. */
const MAX_STEP_MS = 2000;

/** Seconds during which `pred` held, each sample counting until the next one (at most 2 s). */
export function secondsWhere(samples: readonly TrendSample[], pred: (s: TrendSample) => boolean): number {
  let ms = 0;
  for (let i = 0; i < samples.length; i++) {
    if (!pred(samples[i]!)) continue;
    const next = samples[i + 1];
    ms += next ? Math.min(MAX_STEP_MS, Math.max(0, next.t - samples[i]!.t)) : 500;
  }
  return ms / 1000;
}

/** Seconds the samples cover (first to last, plus one tick). */
export function spanSeconds(samples: readonly TrendSample[]): number {
  if (!samples.length) return 0;
  return (samples[samples.length - 1]!.t - samples[0]!.t) / 1000 + 0.5;
}

/** "11 min", "40 s": a rounded duration for stat lines. */
export function minutesText(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  return `${Math.round(seconds / 60)} min`;
}

/**
 * The server's seed, then the live samples: seed samples older than the first live one, so a
 * reconnect never duplicates points, capped to the newest `cap`.
 */
export function mergeSeed(seed: readonly TrendSample[], live: readonly TrendSample[], cap = TREND_CAPACITY): TrendSample[] {
  const first = live[0]?.t ?? Infinity;
  const out = seed.filter((s) => s.t < first).concat(live);
  return out.length > cap ? out.slice(out.length - cap) : out;
}

/** What the client's ring offers; structural so this module does not import the client-only live.tsx. */
export interface TrendSource {
  version: number;
  trend: { toArray(): TrendSample[] };
}

let snap: { src: TrendSource | null; v: number; arr: TrendSample[] } = { src: null, v: -1, arr: [] };

/** The trend ring as an array, copied once per buffers.version however many charts ask. */
export function trendSnapshot(buffers: TrendSource): TrendSample[] {
  if (snap.src !== buffers || snap.v !== buffers.version) snap = { src: buffers, v: buffers.version, arr: buffers.trend.toArray() };
  return snap.arr;
}

/** The reply of GET /api/v1/recent. */
export interface RecentReply {
  boot_id: number | null;
  source: Result["source"] | null;
  now: number;
  samples: TrendSample[];
}

// ---- section and window state, remembered per browser ----

export const SECTION_PREFIX = "lifefi.section.";

/** Open state of a collapsible section; the default with no key, no storage or a throwing one. */
export function readSectionOpen(storage: Storage | null, id: string, byDefault: boolean): boolean {
  try {
    const v = storage?.getItem(SECTION_PREFIX + id);
    return v === "1" ? true : v === "0" ? false : byDefault;
  } catch {
    return byDefault;
  }
}

export function writeSectionOpen(storage: Storage | null, id: string, open: boolean): void {
  try {
    storage?.setItem(SECTION_PREFIX + id, open ? "1" : "0");
  } catch {
    /* private mode */
  }
}

/** The /model time windows, seconds. */
export const WINDOWS = [120, 300, 900] as const;
export type WindowS = (typeof WINDOWS)[number];
export const WINDOW_KEY = "lifefi.model.window";

export function readWindow(storage: Storage | null): WindowS {
  try {
    const v = Number(storage?.getItem(WINDOW_KEY));
    return (WINDOWS as readonly number[]).includes(v) ? (v as WindowS) : 900;
  } catch {
    return 900;
  }
}

export function writeWindow(storage: Storage | null, w: WindowS): void {
  try {
    storage?.setItem(WINDOW_KEY, String(w));
  } catch {
    /* private mode */
  }
}

export const windowText = (s: number) => (s >= 60 ? `${s / 60} min` : `${s} s`);

/** `localStorage`, or null where touching it throws (private mode, server). */
export function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
