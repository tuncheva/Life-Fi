// REST client for contracts/api.md. Types here mirror that file by hand;
// the Result type is generated from the schema (contracts.gen.ts).
import type { Result } from "./contracts.gen";

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export type ProfileName = "home" | "school" | "clinic";
export type AlertLevel = "high" | "medium" | "low";
export type AlertState = "pending" | "open" | "acked" | "resolved" | "dropped";

export interface Alert {
  id: string;
  event_id: number | null;
  type: string;
  level: AlertLevel;
  state: AlertState;
  profile: ProfileName;
  config_hash: string;
  created_at: number;
  opened_at: number | null;
  acked_at: number | null;
  resolved_at: number | null;
  notified_at: number | null;
  escalated_at: number | null;
  data: Record<string, unknown>;
}

export interface SourceState {
  mode: "live" | "replay";
  file: string | null;
  speed: number;
  loop: boolean;
  state: "running" | "stopped";
}

export interface DeviceStatus {
  node: number;
  boot_id: number;
  fw_version: string;
  rssi_dbm: number;
  channel: number;
  uptime_s: number;
  rate_hz: number;
  loss_udp: number;
  loss_air: number;
  rejected: Record<string, number>;
  queue_drops: number;
  send_errors: number;
  wifi_disconnects: number;
  ping_rate_hz: number;
  ping_timeouts_last_s: number;
  last_status_us: number;
}

export interface EngineStatus {
  version: string;
  pipeline_version: number;
  config_hash: string;
  source: "live" | "replay";
  uptime_s: number;
  inference_ms: { p50: number; p95: number };
  models: { name: string; loaded: boolean; pipeline_version: number }[];
  calibration: { state: "none" | "running" | "ok" | "stale"; id: string | null; age_s: number | null };
  recording: unknown;
  mock?: { scenario: string; phase: string };
}

export interface CalibrationJob {
  kind: string;
  duration_s: number;
  started_at: number;
  state: "running" | "ok" | "failed";
  id: string | null;
  error: string | null;
  finished_at: number | null;
}

export interface Status {
  server: { version: string; uptime_s: number; profile: ProfileName; time_zone: string; sensor_offline: string | null };
  engine: { connected: boolean; last_result_ms: number | null; status: EngineStatus | null };
  device: DeviceStatus | null;
  source: SourceState;
  calibration_job: CalibrationJob | null;
  result?: Result | null;
  alerts_open: number;
}

export interface ProfileRule {
  level: AlertLevel;
  delay_s: number;
  hours?: string;
}

export interface Profile {
  title: string;
  assumption: string;
  alerts: Record<string, ProfileRule>;
  breathing: { show: boolean; store: boolean };
  pages: string[];
  inactivity?: { still_present_max_min: number; no_motion_by: string };
  occupancy?: { after_hours: { from: string; to: string; level: AlertLevel; source: string } };
}

export interface HistoryRow {
  t: number;
  presence?: "empty" | "present" | "uncertain";
  motion?: number;
  breathing_bpm?: number | null;
  breathing_valid?: boolean | null;
  posture?: string | null;
  count?: number | null;
}

export interface RecordingInfo {
  session: string;
  file: string | null;
  bytes: number;
  labels: boolean;
}

export interface ProfileView {
  active: ProfileName;
  profiles: Record<ProfileName, Profile>;
}

export interface PublicSettings {
  pin_set: boolean;
  notify: { ntfy_url: string; topic: string; escalate_after_s: number };
  zone: string;
  dashboard_url: string;
  retention_days: number;
}

export type WsMessage = Result | { type: "alert"; alert: Alert } | { type: "status"; status: Status };

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const PIN_KEY = "lifefi.pin";

export function getPin(): string {
  try {
    return localStorage.getItem(PIN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setPin(pin: string): void {
  try {
    localStorage.setItem(PIN_KEY, pin);
  } catch {
    /* private mode */
  }
}

/** Makes sure a PIN is stored for writes, asking once. Returns false if the user cancelled. */
export function ensurePin(): boolean {
  if (getPin()) return true;
  const pin = window.prompt("Enter the dashboard PIN");
  if (!pin) return false;
  setPin(pin);
  return true;
}

export async function api<T>(path: string, init: RequestInit & { pin?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.body) headers["content-type"] = "application/json";
  if (init.pin) headers["x-lifefi-pin"] = getPin();
  const res = await fetch(`${API_BASE}/api/v1${path}`, { ...init, headers });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) throw new ApiError(res.status, String(body.error ?? "error"), String(body.message ?? res.statusText));
  return body as T;
}

export const getStatus = () => api<Status>("/status");
export const getAlerts = (states = "open,acked") => api<{ alerts: Alert[] }>(`/alerts?state=${states}`);
export const ackAlert = (id: string) => api<Alert>(`/alerts/${id}/ack`, { method: "POST", body: "{}", pin: true });
export const getProfile = () => api<ProfileView>("/profile");
export const setProfile = (active: ProfileName) => api<ProfileView>("/profile", { method: "PUT", body: JSON.stringify({ active }), pin: true });
export const calibrate = (kind = "empty", duration_s = 120) => api<{ started: boolean }>("/calibrate", { method: "POST", body: JSON.stringify({ kind, duration_s }), pin: true });
export const getSettings = () => api<PublicSettings>("/settings");
export type SettingsPatch = Partial<Omit<PublicSettings, "pin_set" | "notify">> & { pin?: string; notify?: Partial<PublicSettings["notify"]> };
export const updateSettings = (patch: SettingsPatch) => api<PublicSettings>("/settings", { method: "PUT", body: JSON.stringify(patch), pin: true });
export const testNotification = () => api<{ sent: boolean }>("/settings/test-notification", { method: "POST", body: "{}", pin: true });
export const getHistory = (from: number, to: number, fields?: string) =>
  api<{ rows: HistoryRow[] }>(`/history?from=${from}&to=${to}${fields ? `&fields=${fields}` : ""}`);
export const getSource = () => api<SourceState>("/source");
export const setSource = (s: Omit<SourceState, "state">) => api<SourceState>("/source", { method: "PUT", body: JSON.stringify(s), pin: true });
export const getRecordings = () => api<{ recordings: RecordingInfo[]; recording: string | null }>("/recordings");
export const startRecording = (session: string, meta: Record<string, unknown>) =>
  api<{ session: string }>("/recordings/start", { method: "POST", body: JSON.stringify({ session, meta }), pin: true });
export const stopRecording = () => api<{ session: string; frames?: number }>("/recordings/stop", { method: "POST", body: "{}", pin: true });

// Dev-only (mock engine)
export interface ScenarioInfo {
  name: string;
  description: string;
  duration_s: number;
  loop: boolean;
}
export const devScenarios = async () => {
  const res = await fetch(`${API_BASE}/dev/scenarios`);
  if (!res.ok) throw new ApiError(res.status, "dev", "dev endpoints unavailable");
  return (await res.json()) as { scenarios: ScenarioInfo[]; current: string; phase: string };
};
export const devSetScenario = (name: string) =>
  fetch(`${API_BASE}/dev/scenario`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });

export function wsUrl(): string {
  const base = API_BASE || (typeof window !== "undefined" ? window.location.origin : "");
  return base.replace(/^http/, "ws") + "/ws/live";
}
