// The room as the dashboard draws it, and "where is someone" derived from one result
// (docs/overnight/plans/B-ui-ux.md B1.1). Occupancy first, distance second: one link
// gives no direction, so the distance is a radius around the sensor and only carries
// a number when the engine itself rates it better than a rough guess.
import type { Result } from "./contracts.gen";
import type { RoomStatus } from "./words";

/** Room size in metres; tx_m = transmitter distance from the sensor along the room's centre line. */
export type RoomGeometry = { length_m: number; width_m: number; tx_m: number | null };

export const DEFAULT_ROOM: RoomGeometry = { length_m: 4, width_m: 3, tx_m: null };

export const ROOM_KEY = "lifefi.room";
/** The old per-browser 2/3/5 m router toggle of the 3D view, migrated into tx_m once. */
const LEGACY_ROUTER_KEY = "lifefi.routerDistance";

const sane = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

/** The room saved in this browser, DEFAULT_ROOM on the server, when storage is blocked or the value is broken. */
export function readRoomGeometry(): RoomGeometry {
  if (typeof window === "undefined") return DEFAULT_ROOM;
  try {
    const raw = window.localStorage.getItem(ROOM_KEY);
    if (raw) {
      const g = JSON.parse(raw) as Partial<RoomGeometry>;
      return {
        length_m: sane(g.length_m, 1, 30) ?? DEFAULT_ROOM.length_m,
        width_m: sane(g.width_m, 1, 30) ?? DEFAULT_ROOM.width_m,
        tx_m: sane(g.tx_m, 0.2, 30),
      };
    }
    const legacy = sane(Number(window.localStorage.getItem(LEGACY_ROUTER_KEY)), 0.2, 30);
    if (legacy !== null) {
      const g = { ...DEFAULT_ROOM, tx_m: legacy };
      writeRoomGeometry(g);
      window.localStorage.removeItem(LEGACY_ROUTER_KEY);
      return g;
    }
  } catch {
    /* storage blocked: the default room */
  }
  return DEFAULT_ROOM;
}

/** Saves the room and tells every view in this tab (the `storage` event only reaches other tabs). */
export function writeRoomGeometry(g: RoomGeometry): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ROOM_KEY, JSON.stringify(g));
  } catch {
    /* storage blocked: nothing to keep */
  }
  window.dispatchEvent(new Event(ROOM_EVENT));
}

/** Fired in this tab by writeRoomGeometry. */
export const ROOM_EVENT = "lifefi:room";

// --- where is someone ---------------------------------------------------------------

// Track A's optional fields (contracts/results.schema.json). Read through a narrow local
// type so this compiles before and after contracts.gen.ts gains them.
export type OccupancyState = "empty" | "occupied" | "unsure";
export type Occupancy = { state: OccupancyState; p: number };
export type Quality = "none" | "low" | "medium";
export const QUALITY_REASONS = ["transmitter_not_fixed", "no_distance_fit", "no_empty_calibration", "low_packet_rate"] as const;
export type QualityReason = (typeof QUALITY_REASONS)[number];

type PositionExtra = { quality?: unknown; quality_reasons?: unknown; spot?: { reliable?: unknown; model_accuracy?: unknown } | null };

export type Distance = {
  /** metres from the sensor */
  d: number;
  sd: number;
  quality: Exclude<Quality, "none">;
  reasons: QualityReason[];
  held: boolean;
  /** ms since epoch when the distance started being held (the person stood still) */
  heldSince: number | null;
};

export type WhereState =
  | { kind: "blind"; reason: string }
  | { kind: "nobody" }
  | { kind: "unsure" }
  | { kind: "here"; people: number; distance: Distance | null; spot: { name: string; d: number | null } | null; reasons: QualityReason[] };

export function occupancyOf(result: Result | null): Occupancy | null {
  const o = (result as { occupancy?: unknown } | null)?.occupancy as Partial<Occupancy> | null | undefined;
  if (!o || (o.state !== "empty" && o.state !== "occupied" && o.state !== "unsure")) return null;
  return { state: o.state, p: typeof o.p === "number" ? o.p : 0 };
}

/** Distance quality; missing (an older engine, which is exactly the unreliable one) reads as "low". */
export function qualityOf(pos: NonNullable<Result["position"]>): Quality {
  const q = (pos as PositionExtra).quality;
  return q === "none" || q === "low" || q === "medium" ? q : "low";
}

export function reasonsOf(pos: NonNullable<Result["position"]> | null | undefined): QualityReason[] {
  const r = (pos as PositionExtra | null | undefined)?.quality_reasons;
  if (!Array.isArray(r)) return [];
  return r.filter((x): x is QualityReason => (QUALITY_REASONS as readonly unknown[]).includes(x));
}

/** True only when the engine says the spot model is good enough for this room. */
export function spotReliable(pos: NonNullable<Result["position"]> | null | undefined): boolean {
  return (pos as PositionExtra | null | undefined)?.spot?.reliable === true;
}

/** The spot model's measured accuracy (0..1), null when the engine does not say. */
export function spotAccuracy(pos: NonNullable<Result["position"]> | null | undefined): number | null {
  const a = (pos as PositionExtra | null | undefined)?.spot?.model_accuracy;
  return typeof a === "number" && Number.isFinite(a) ? a : null;
}

/**
 * Where is someone, never more certain than the engine (plan B1.1): the presence state
 * decides the headline (alerts and the timeline depend on it); occupancy can only make
 * the where-block less sure, never contradict it.
 */
export function positionView(input: { status: RoomStatus; result: Result | null; heldSince: number | null }): WhereState {
  const { status, result, heldSince } = input;
  if (status.blind || !result) return { kind: "blind", reason: status.headline };
  const occ = occupancyOf(result);
  const presence = result.presence.state;
  if (presence === "empty") return occ?.state === "occupied" ? { kind: "unsure" } : { kind: "nobody" };
  if (presence === "uncertain") return { kind: "unsure" };
  if (occ?.state === "empty") return { kind: "unsure" };

  const pos = result.position ?? null;
  const reasons = reasonsOf(pos);
  const people = Math.max(1, pos?.people ?? 1);
  if (occ?.state === "unsure") return { kind: "here", people, distance: null, spot: null, reasons };

  let distance: Distance | null = null;
  if (pos && pos.valid && pos.d_m !== null) {
    const quality = qualityOf(pos);
    if (quality !== "none") distance = { d: pos.d_m, sd: pos.d_sd ?? 0, quality, reasons, held: pos.held, heldSince: pos.held ? heldSince : null };
  }
  const spot = pos?.spot && spotReliable(pos) && pos.spot.name !== "empty" ? { name: pos.spot.name, d: pos.spot.d_m } : null;
  return { kind: "here", people, distance, spot, reasons };
}

/** Half-width of a rough band at the least, so a low-quality guess never reads as a line. */
export const ROUGH_SD = 0.5;

/**
 * What the room drawing may show, by the same rule as whereText: a "medium" distance gets a
 * ring with the zone rings, their labels and the scale bar to read it against. A low-quality
 * distance gets only a wide band marked "rough guess" (no metres, no scale), so the owner
 * still sees roughly where the engine thinks they are without reading off "about 2.2 m".
 */
export type RoomDrawing = { ring: { d: number; sd: number; held: boolean; rough: boolean } | null; scale: boolean };

export function roomDrawing(w: WhereState): RoomDrawing {
  const dist = w.kind === "here" ? w.distance : null;
  if (!dist) return { ring: null, scale: false };
  if (dist.quality !== "medium") return { ring: { d: dist.d, sd: Math.max(dist.sd, ROUGH_SD), held: dist.held, rough: true }, scale: false };
  return { ring: { d: dist.d, sd: dist.sd, held: dist.held, rough: false }, scale: true };
}

/** Where to fix each reason in the setup flow (/setup?step=…). */
export const REASON_STEP: Record<QualityReason, string> = {
  transmitter_not_fixed: "transmitter",
  no_distance_fit: "fit",
  no_empty_calibration: "calibrate",
  low_packet_rate: "sensor",
};

/** d ± sd rounded to half metres, for the "roughly 2 to 3 m" sentence. */
export function distanceRange(d: number, sd: number): { lo: number; hi: number } {
  const half = (v: number) => Math.round(v * 2) / 2;
  let lo = half(Math.max(0, d - sd));
  let hi = half(d + sd);
  if (hi <= lo) {
    lo = half(d);
    hi = lo + 0.5;
  }
  return { lo, hi };
}
