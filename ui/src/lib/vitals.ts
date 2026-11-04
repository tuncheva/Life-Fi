// Breathing and (experimental) heart rate in words and numbers, for the vitals card on `/`
// and `/model` (docs/overnight/2026-11-04/plans/M-dashboard-model.md §4). Pure: no React,
// no "use client", so tests and the server can import it. A rate is shown only when the
// engine says `valid` and the number is a finite value in a sane range; otherwise the
// reason in plain words. Never a held or guessed number.
import type { Result } from "./contracts.gen";

/** UI-only sanity ranges (orchestrator D5): outside them the number is not shown. */
export const BREATH_RANGE: readonly [number, number] = [4, 60];
export const HEART_RANGE: readonly [number, number] = [35, 200];

export type VitalReason = "warming_up" | "no_person" | "motion" | "noise" | "unstable";

export interface VitalView {
  /** Rounded integer, only when the reading is trusted. */
  value: string | null;
  unit: "breaths/min" | "beats/min";
  /** reading: a number is shown; none: no number, a reason; off: the room can't be seen. */
  state: "reading" | "none" | "off";
  /** breath: confidence >= 0.8 steady; heart: always rough (one link, experimental). */
  quality: "steady" | "rough" | null;
  /** Reason or quality line, plain words. */
  text: string;
}

export interface Vitals {
  breath: VitalView;
  /** null when the engine sends no `heart` (absent or null): it does not estimate one. */
  heart: VitalView | null;
}

const REASON_TEXT: Record<VitalReason, string> = {
  warming_up: "Starting up: needs about 30 s of signal",
  no_person: "Nobody to measure",
  motion: "Can't be read while they move: needs about 30 s of stillness",
  noise: "Signal too weak to pick out a rate",
  unstable: "Readings disagree: waiting for a steady one",
};

export function reasonText(reason: VitalReason): string {
  return REASON_TEXT[reason] ?? "No steady reading right now";
}

export const BLIND_TEXT = "Not available while the room can't be seen";
export const SEVERAL_TEXT = "Can't be read with several people in the room";
export const OUT_OF_RANGE_TEXT = "Reading out of range: not shown";

/** True when `bpm` is a finite number inside `range`. */
export function inRange(bpm: unknown, range: readonly [number, number]): bpm is number {
  return typeof bpm === "number" && Number.isFinite(bpm) && bpm >= range[0] && bpm <= range[1];
}

function isReason(r: unknown): r is VitalReason {
  return typeof r === "string" && r in REASON_TEXT;
}

type Raw = { bpm: number | null; valid: boolean; confidence: number; reason?: string | null };

function one(result: Result, raw: Raw, unit: VitalView["unit"], range: readonly [number, number], heart: boolean, blind: boolean): VitalView {
  const none = (text: string): VitalView => ({ value: null, unit, state: "none", quality: null, text });
  if (blind) return { value: null, unit, state: "off", quality: null, text: BLIND_TEXT };
  if (result.count?.value === 2) return none(SEVERAL_TEXT);
  if (raw.valid && inRange(raw.bpm, range)) {
    const steady = !heart && raw.confidence >= 0.8;
    const what = heart ? "beats a minute · rough reading" : steady ? "breaths a minute · steady reading" : "breaths a minute · rough reading";
    return { value: Math.round(raw.bpm).toFixed(0), unit, state: "reading", quality: steady ? "steady" : "rough", text: what };
  }
  if (raw.valid && raw.bpm !== null) return none(OUT_OF_RANGE_TEXT);
  if (isReason(raw.reason)) return none(reasonText(raw.reason));
  // An older engine (no reason): derive one from what the result does say.
  if (result.presence.state === "empty") return none(REASON_TEXT.no_person);
  if (result.motion >= 0.2) return none(REASON_TEXT.motion);
  return none("No steady reading right now");
}

/** Both vitals for one result; `blind` from useRoomStatus(). */
export function vitalsView(result: Result, blind: boolean): Vitals {
  const breath = one(result, result.breathing, "breaths/min", BREATH_RANGE, false, blind);
  const h = (result as { heart?: Result["heart"] }).heart;
  const heart = h && typeof h === "object" ? one(result, h, "beats/min", HEART_RANGE, true, blind) : null;
  return { breath, heart };
}

/** The view before any result arrived (or while blind with no result). */
export function vitalsWaiting(blind: boolean): Vitals {
  return {
    breath: { value: null, unit: "breaths/min", state: blind ? "off" : "none", quality: null, text: blind ? BLIND_TEXT : "Waiting for a reading" },
    heart: null,
  };
}

/** Sparkline y ranges, fixed so the line does not jump with every new point. */
export const BREATH_SPARK: readonly [number, number] = [0, 40];
export const HEART_SPARK: readonly [number, number] = [40, 140];
/** Calm reference band for breathing at rest (adults), drawn neutral, never as an alarm. */
export const BREATH_TYPICAL: readonly [number, number] = [12, 20];
