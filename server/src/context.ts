// Shared runtime objects, wired in main.ts and used by the API.
import type { FastifyBaseLogger } from "fastify";
import type { AlertManager } from "./alerts.js";
import type { Result } from "./contracts.gen.js";
import type { EngineClient } from "./engine-client.js";
import type { History } from "./history.js";
import type { ProfilesConfig } from "./profiles.js";
import type { SettingsStore } from "./settings.js";
import type { Watchdog } from "./watchdog.js";
import type { LiveHub } from "./ws.js";

export interface SourceState {
  mode: "live" | "replay";
  file: string | null;
  speed: number;
  loop: boolean;
  state: "running" | "stopped" | "error";
  /** Why the engine cannot read its source (e.g. "no USB serial port found"), else null. */
  error: string | null;
}

/** get_status `engine.source_info` (contracts/control.md). */
export interface EngineSourceInfo {
  name: string | null;
  state: "running" | "finished" | "error" | "none";
  file: string | null;
  speed: number;
  loop: boolean;
  error: string | null;
}

/** `data` of the engine's get_status ack (contracts/control.md). */
export interface EngineStatus {
  engine: Record<string, unknown> & {
    calibration?: { state: string; id: string | null; age_s: number | null };
    active_events?: { id: number; type: string; t: number; data?: Record<string, unknown> }[];
    source?: "live" | "replay";
    source_info?: EngineSourceInfo;
    recording?: { session: string | null; frames: number } | null;
    outputs?: { posture: boolean; count: boolean; activity: boolean };
  };
  device: (Record<string, unknown> & { last_status_us?: number }) | null;
}

/** The calibration the dashboard last started, so the UI can show its outcome (refused, finished). */
export interface CalibrationJob {
  kind: string;
  duration_s: number;
  started_at: number;
  state: "running" | "ok" | "failed";
  id: string | null;
  error: string | null;
  finished_at: number | null;
}

/** A segment that has been started but not ended (labels.jsonl segments are non-overlapping). */
export interface OpenSegment {
  t_start_us: number;
  label: string;
  count: number;
  subject: string | null;
  spot: string | null;
}

export interface RecordingState {
  session: string;
  started_us: number;
  open_segment: OpenSegment | null;
  labels: number;
}

export interface AppState {
  startedAt: number;
  latest: Result | null;
  lastResultAt: number | null;
  engineStatus: EngineStatus | null;
  source: SourceState;
  calibration: CalibrationJob | null;
  recording: RecordingState | null;
  /** Last presence change seen by this server process. */
  presence: { state: Result["presence"]["state"]; since: number; at_least: boolean } | null;
}

export interface AppContext {
  log: FastifyBaseLogger;
  /** One-time acknowledge tokens for phone notifications, by alert id (never the PIN). */
  ackTokens: Map<string, string>;
  engine: EngineClient;
  alerts: AlertManager;
  watchdog: Watchdog;
  history: History;
  settings: SettingsStore;
  profiles: ProfilesConfig;
  state: AppState;
  hub: LiveHub;
  version: string;
  dev: boolean;
}

/** The `Status` object of contracts/api.md. */
export function buildStatus(ctx: AppContext, includeResult: boolean): Record<string, unknown> {
  const s = ctx.settings.value;
  return {
    server: {
      version: ctx.version,
      uptime_s: Math.floor((Date.now() - ctx.state.startedAt) / 1000),
      profile: s.profile,
      time_zone: s.zone,
      room_name: s.room_name,
      contact_phone: s.contact_phone,
      sensor_offline: ctx.watchdog.isOffline ? ctx.watchdog.reason : null,
    },
    presence: ctx.state.presence,
    engine: {
      connected: ctx.engine.connected,
      last_result_ms: ctx.state.lastResultAt,
      status: ctx.state.engineStatus?.engine ?? null,
    },
    device: ctx.state.engineStatus?.device ?? null,
    source: ctx.state.source,
    calibration_job: ctx.state.calibration,
    recording: ctx.state.recording,
    ...(includeResult ? { result: ctx.state.latest } : {}),
    alerts_open: ctx.alerts.openCount(),
  };
}
