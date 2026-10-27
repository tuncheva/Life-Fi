// Loads contracts/profiles.yml (plan-v2 §11) and computes its hash.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import YAML from "yaml";

export type AlertLevel = "high" | "medium" | "low";
export type ProfileName = "home" | "school" | "clinic";

export interface AlertRule {
  level: AlertLevel;
  delay_s: number;
  /** "21:00-07:00": the rule is active only inside this local-time window. */
  hours?: string;
}

export interface Profile {
  title: string;
  assumption: string;
  alerts: Record<string, AlertRule>;
  breathing: { show: boolean; store: boolean };
  pages: string[];
  inactivity?: { still_present_max_min: number; no_motion_by: string };
  occupancy?: { after_hours: { from: string; to: string; level: AlertLevel; source: string } };
}

export interface ProfilesConfig {
  profiles: Record<ProfileName, Profile>;
  notify: { ntfy_url: string; topic: string; escalate_after_s: number };
  zone: string;
  /** Short hash of the file contents; travels with every alert transition. */
  hash: string;
}

export const PROFILE_NAMES: ProfileName[] = ["home", "school", "clinic"];

export function isProfileName(v: unknown): v is ProfileName {
  return typeof v === "string" && (PROFILE_NAMES as string[]).includes(v);
}

export function loadProfiles(path: string): ProfilesConfig {
  const text = readFileSync(path, "utf8");
  const doc = YAML.parse(text) as Omit<ProfilesConfig, "hash">;
  for (const name of PROFILE_NAMES) {
    if (!doc.profiles?.[name]) throw new Error(`profiles.yml: missing profile '${name}'`);
  }
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 6);
  return { ...doc, hash };
}

/** True when local time `hhmm` (minutes since midnight) is inside "HH:MM-HH:MM", wrapping midnight. */
export function insideHours(window: string, minutesOfDay: number): boolean {
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window);
  if (!m) return true;
  const from = Number(m[1]) * 60 + Number(m[2]);
  const to = Number(m[3]) * 60 + Number(m[4]);
  return from <= to ? minutesOfDay >= from && minutesOfDay < to : minutesOfDay >= from || minutesOfDay < to;
}

export function minutesOfDayIn(zone: string, at: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(at));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const mi = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + mi;
}
