// First-run setup flow (/setup): pure logic and copy, tested in test/setup.test.ts.
// The server's GET /api/v1/setup and /api/v1/health (track C) are the truth when
// they answer; on an older server (404) or a network error the checks are
// derived from the live stream instead. Both responses are typed with every
// field optional, so a partial or changed body never throws here.
import type { CalibrationJob, Status } from "./api";
import type { Result } from "./contracts.gen";

export const STEPS = [
  { id: "sensor", title: "Sensor connected", optional: false },
  { id: "transmitter", title: "Room and Wi-Fi transmitter", optional: false },
  { id: "calibrate", title: "Empty-room calibration", optional: false },
  { id: "fit", title: "Distance tuning", optional: true },
  { id: "spots", title: "Spots in the room", optional: true },
  { id: "done", title: "Done", optional: false },
] as const;

export type StepId = (typeof STEPS)[number]["id"];

/** `?step=…` → a step id; anything else opens the first step that is not done. */
export function parseStep(q: string | null | undefined): StepId | null {
  const v = (q ?? "").trim().toLowerCase();
  return STEPS.some((s) => s.id === v) ? (v as StepId) : null;
}

// --- server responses (track C), every field optional ---------------------------

export interface HealthResponse {
  ok?: boolean;
  ready?: boolean;
  checks?: {
    engine?: { ok?: boolean };
    board?: { ok?: boolean; source?: "live" | "replay"; result_age_s?: number | null; rate_hz?: number | null; error?: string | null };
    calibration?: { ok?: boolean; state?: "none" | "running" | "ok" | "stale" | null; age_s?: number | null };
  };
}

export interface SetupResponse {
  complete?: boolean;
  steps?: { id?: string; done?: boolean; optional?: boolean; detail?: string | null }[];
}

/** A parsed body, or null when the route is missing (404), unreachable or not JSON. */
export async function fetchOptional<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`/api/v1${path}`, { cache: "no-store" });
    // health answers 503 with the same body when the engine is down: still a real answer
    if (!res.ok && res.status !== 503) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function serverStep(setup: SetupResponse | null, id: string) {
  return setup?.steps?.find((s) => s.id === id) ?? null;
}

// --- step 1: sensor checks -------------------------------------------------------

export type CheckState = "ok" | "warn" | "fail" | "wait";

export interface Check {
  id: "box" | "engine" | "board" | "readings" | "signal";
  label: string;
  state: CheckState;
  /** What is wrong or what to do, in words; null when fine. */
  detail: string | null;
}

export const RATE_OK_HZ = 80;
export const RATE_WARN_HZ = 50;

export interface SensorInput {
  /** The live stream to the box is open. */
  connected: boolean;
  status: Status | null;
  /** The last result is older than 3 s (or there is none). */
  stale: boolean;
  /** Packets per second from the newest result, null without one. */
  rateHz: number | null;
  health: HealthResponse | null;
  setup: SetupResponse | null;
}

/**
 * The step-1 check list. Each check depends on the one before it: when the box
 * is unreachable nothing below can be known, so it waits instead of failing.
 */
export function sensorChecks(i: SensorInput): { checks: Check[]; ok: boolean; replay: boolean } {
  const checks: Check[] = [];
  const box: CheckState = i.connected ? "ok" : i.status ? "fail" : "wait";
  checks.push({ id: "box", label: "Life-Fi box reachable", state: box, detail: box === "fail" ? "Can't reach the Life-Fi box. Check that it is switched on and on this network." : box === "wait" ? "Connecting…" : null });

  const engineOk = i.health?.checks?.engine?.ok ?? serverStep(i.setup, "engine")?.done ?? i.status?.engine.connected ?? null;
  const engine: CheckState = box !== "ok" ? "wait" : engineOk === null ? "wait" : engineOk ? "ok" : "fail";
  checks.push({ id: "engine", label: "Sensor software running", state: engine, detail: engine === "fail" ? "The sensor software is not running. Restart the Life-Fi box (npm run dev or npm start)." : null });

  const replay = (i.health?.checks?.board?.source ?? i.status?.source.mode) === "replay";
  const boardError = i.health?.checks?.board?.error ?? i.status?.source.error ?? null;
  const boardBroken = i.status?.source.state === "error" || (!!boardError && !replay);
  const board: CheckState = engine !== "ok" ? "wait" : boardBroken ? "fail" : "ok";
  checks.push({
    id: "board",
    label: replay ? "Reading a recording (not the board)" : "Sensor board readable",
    state: board === "ok" && replay ? "warn" : board,
    detail: board === "fail" ? `Plug the sensor board into USB${boardError ? ` (${boardError})` : ""}.` : null,
  });

  const fresh = i.health?.checks?.board?.ok ?? !i.stale;
  const readings: CheckState = board === "fail" || board === "wait" ? "wait" : fresh ? "ok" : "fail";
  checks.push({ id: "readings", label: "Readings arriving", state: readings, detail: readings === "fail" ? "No new readings for a few seconds. Check the USB cable and that the Wi-Fi transmitter is on." : null });

  const rate = i.health?.checks?.board?.rate_hz ?? i.rateHz;
  const signal: CheckState = readings !== "ok" || rate === null || rate === undefined ? "wait" : rate >= RATE_OK_HZ ? "ok" : rate >= RATE_WARN_HZ ? "warn" : "fail";
  checks.push({
    id: "signal",
    label: "Signal strong enough",
    state: signal,
    detail: signal === "warn" ? "Signal is a bit weak. Move the transmitter or the sensor so nothing big is between them." : signal === "fail" ? "Weak signal: too few readings per second. Bring the transmitter closer to the sensor." : null,
  });

  const ok = checks.every((c) => c.state === "ok" || c.state === "warn");
  return { checks, ok, replay };
}

// --- step 2: room and transmitter -----------------------------------------------

export const ROOM_LIMITS = { min: 1, max: 20 } as const;
export const TX_LIMITS = { min: 0.3, max: 15 } as const;

/** A typed number within limits, or null with nothing typed; NaN-safe. */
export function parseMetres(v: string, limits: { min: number; max: number }): number | null | "bad" {
  const t = v.trim().replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < limits.min || n > limits.max) return "bad";
  return Math.round(n * 10) / 10;
}

/** True when the engine says the transmitter is not fixed (track A's quality_reasons). */
export function transmitterMoving(result: Result | null): boolean {
  const reasons = (result?.position as { quality_reasons?: unknown } | null | undefined)?.quality_reasons;
  return Array.isArray(reasons) && reasons.includes("transmitter_not_fixed");
}

// --- step 3: calibration --------------------------------------------------------

export type CalibrationPhase = "idle" | "running" | "ok" | "failed";

export interface CalibrationProgress {
  phase: CalibrationPhase;
  /** Whole seconds left while running (0 once the time is up but the engine has not answered). */
  remaining_s: number;
  /** 0..1 while running. */
  fraction: number;
  error: string | null;
}

/** The calibration job from Status, read at `now` (ms). A job that finished earlier than `since` is old news. */
export function calibrationProgress(job: CalibrationJob | null | undefined, now: number, since = 0): CalibrationProgress {
  if (!job || (job.state !== "running" && (job.finished_at ?? job.started_at) < since)) return { phase: "idle", remaining_s: 0, fraction: 0, error: null };
  if (job.state === "running") {
    const total = Math.max(1, job.duration_s * 1000);
    const elapsed = Math.max(0, now - job.started_at);
    return { phase: "running", remaining_s: Math.max(0, Math.ceil((total - elapsed) / 1000)), fraction: Math.min(1, elapsed / total), error: null };
  }
  if (job.state === "ok") return { phase: "ok", remaining_s: 0, fraction: 1, error: null };
  return { phase: "failed", remaining_s: 0, fraction: 0, error: calibrationErrorText(job.error) };
}

/** The engine's refusal in words a non-engineer can act on. */
export function calibrationErrorText(e: string | null | undefined): string {
  const m = (e ?? "").toLowerCase();
  if (!m) return "The calibration did not finish. Try again with the room empty.";
  if (m.includes("timeout") || m.includes("timed out")) return "The sensor software did not answer in time. Check the sensor and try again.";
  if (m.includes("motion") || m.includes("moving") || m.includes("present")) return "Someone moved in the room during the calibration. Make sure the room is empty and try again.";
  if (m.includes("disconnect") || m.includes("not connected") || m.includes("offline")) return "The sensor software stopped during the calibration. Check step 1, then try again.";
  if (m.includes("frames") || m.includes("packets") || m.includes("data")) return "Too few readings arrived during the calibration. Check the signal in step 1, then try again.";
  return `The calibration did not finish: ${e}. Try again with the room empty.`;
}

export const CALIBRATION_SECONDS = [60, 120] as const;

// --- step 4: distance fit ---------------------------------------------------------

export const FIT_LIMITS = { min: 0.3, max: 8 } as const;
export const FIT_SECONDS = 25;

// --- whole flow -------------------------------------------------------------------

const LOCAL_KEY = "lifefi.setup";

export function readLocalSetup(): { done_at: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "null") as { done_at?: unknown } | null;
    return v && typeof v.done_at === "number" ? { done_at: v.done_at } : null;
  } catch {
    return null;
  }
}

export function writeLocalSetup(): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify({ done_at: Date.now() }));
  } catch {
    /* private mode: the pill shows again next time */
  }
  window.dispatchEvent(new Event("lifefi-setup"));
}

/**
 * Whether the header shows "Finish setup": the server's `complete` when the
 * route exists, else this browser never finished /setup or the calibration is
 * missing or stale.
 */
export function needsSetup(i: { setup: SetupResponse | null; localDone: boolean; calibration: Result["calibration"]["state"] | null }): boolean {
  if (typeof i.setup?.complete === "boolean") return !i.setup.complete;
  if (!i.localDone) return true;
  return i.calibration === "none" || i.calibration === "stale";
}

/** Step ids that are done, for the stepper ticks. Server truth when present. */
export function doneSteps(i: { sensorOk: boolean; setup: SetupResponse | null; calibration: Result["calibration"]["state"] | null; roomSaved: boolean }): Set<StepId> {
  const done = new Set<StepId>();
  if (i.sensorOk) done.add("sensor");
  if (i.roomSaved) done.add("transmitter");
  const cal = serverStep(i.setup, "calibration");
  if (cal ? cal.done : i.calibration === "ok") done.add("calibrate");
  return done;
}

/** Plain-language text for the server's optional steps (keyed on id, never on detail). */
export const SERVER_EXTRA: Record<string, { label: string; href: string | null; todo: string }> = {
  pin: { label: "Dashboard PIN changed", href: "/settings/", todo: "The PIN is still the factory one (1234). Change it in Settings." },
  notify: { label: "Phone alerts set up", href: "/settings/", todo: "No phone alerts yet. Set an ntfy topic in Settings." },
  lan: { label: "Reachable from phones", href: null, todo: "Only this computer can open the dashboard. Start the box with LIFEFI_HOST=0.0.0.0 to reach it from phones." },
};
