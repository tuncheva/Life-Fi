// Phone notification settings, pure (the settings page and the PUT /settings route use it).
// The ntfy topic is the only secret in front of the alert feed: anyone who guesses it can
// read the alerts. A new topic must be long enough to be unguessable; a shorter topic that an
// install already uses keeps working (refusing it would turn phone alerts off), with a warning.
import type { PublicSettings, SettingsPatch } from "./api";

export const TOPIC_MIN = 20;

/** "ok", "short" (an existing short topic: warn), or "refused" (a new short topic: block). Empty = off. */
export function topicCheck(next: string, current: string): "ok" | "short" | "refused" {
  const t = next.trim();
  if (!t || t.length >= TOPIC_MIN) return "ok";
  return t === current.trim() ? "short" : "refused";
}

/**
 * The fields of `next` that differ from `saved` (notify field by field), so the settings Save
 * never resends values this page did not change: the form is loaded once, and a field the
 * setup wizard or another device changed meanwhile must not be put back to an old copy.
 */
export function changedSettings(saved: PublicSettings, next: PublicSettings): SettingsPatch {
  const out: Record<string, unknown> = {};
  for (const k of ["zone", "dashboard_url", "retention_days", "room_name", "contact_phone"] as const) if (next[k] !== saved[k]) out[k] = next[k];
  const notify: Record<string, unknown> = {};
  for (const k of ["topic", "ntfy_url", "escalate_after_s"] as const) if (next.notify[k] !== saved.notify[k]) notify[k] = next.notify[k];
  if (Object.keys(notify).length) out.notify = notify;
  return out as SettingsPatch;
}
