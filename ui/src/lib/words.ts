// Plain-language status for people who are not engineers (docs/plan/ui-ux.md §2).
// Every screen derives what it says from here, so the room card, the header,
// presentation mode and the alert banner never disagree, and no raw enum
// (empty / present / uncertain, warmup, stale, S/B/M) reaches a consumer view.
import type { Result } from "./contracts.gen";
import type { Alert, ProfileName, Status } from "./api";

/** The room's name comes from the server settings; "Room 1" until the status has arrived. */
export function roomName(status: Status | null | undefined): string {
  return status?.server.room_name?.trim() || "Room 1";
}

export type Tone = "present" | "empty" | "uncertain" | "offline" | "connecting";

export interface RoomStatus {
  tone: Tone;
  headline: string;
  detail: string | null;
  /** What to do about it, when there is something to do. */
  action: { label: string; href: string } | null;
  /** True when the room cannot be seen at all; consumers must not read anything else as current. */
  blind: boolean;
}

export interface PresenceSince {
  state: Result["presence"]["state"];
  /** ms since epoch; null while unknown */
  since: number | null;
  /** true when history did not reach back to the change, so "since" is a lower bound */
  atLeast: boolean;
}

export const PROFILE_TEXT: Record<ProfileName, { title: string; who: string; assumption: string }> = {
  home: { title: "Home", who: "One older person living alone", assumption: "Assumes one person lives here. Breathing and fall detection need them to be alone in the room." },
  clinic: { title: "Clinic", who: "One patient room", assumption: "Assumes a single patient in the room. Visitors make breathing and bed readings unreliable." },
  school: { title: "School", who: "Classroom or shared room", assumption: "Several people are normal here. Breathing is neither shown nor stored." },
};

export const DISCLAIMER = "Assistive notification, not a medical device. Does not replace a nurse call or emergency services.";

export function clock(ts: number, seconds = false): string {
  return new Date(ts).toLocaleTimeString([], seconds ? { hour: "2-digit", minute: "2-digit", second: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
}

/** "today 14:02", "yesterday 23:10", "3 Nov 09:15" */
export function dayClock(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(d, n)) return `today ${clock(ts)}`;
  const y = new Date(n);
  y.setDate(n.getDate() - 1);
  if (sameDay(d, y)) return `yesterday ${clock(ts)}`;
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${clock(ts)}`;
}

/** "45 s", "12 min", "3 h 05 min", "2 days" */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, "0")} min`;
  return `${Math.floor(h / 24)} days`;
}

/** "1:07" for a ticking counter */
export function stopwatch(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function sinceText(p: PresenceSince | null, now: number): string | null {
  if (!p || p.since === null) return null;
  const at = clock(p.since);
  const lasted = duration(now - p.since);
  return p.atLeast ? `for at least ${lasted}` : `since ${at} · ${lasted}`;
}

export function calibrationText(cal: Result["calibration"] | null | undefined): { text: string; tone: "ok" | "warn" | "danger"; needsAction: boolean } {
  if (!cal) return { text: "Calibration unknown", tone: "warn", needsAction: false };
  switch (cal.state) {
    case "ok":
      return { text: cal.age_s === null ? "Calibrated" : `Calibrated ${duration(cal.age_s * 1000)} ago`, tone: "ok", needsAction: false };
    case "running":
      return { text: "Calibrating · keep the room empty", tone: "warn", needsAction: false };
    case "stale":
      return { text: "Needs an empty-room calibration", tone: "warn", needsAction: true };
    default:
      return { text: "Not calibrated yet", tone: "warn", needsAction: true };
  }
}

const WATCHDOG_TEXT: Record<string, string> = {
  "engine disconnected": "The sensor software stopped.",
  "no result for 10 s": "The sensor has stopped reporting.",
  "CSI rate below 50 Hz for 60 s": "The sensor signal is too weak to be reliable.",
  "no device status for 10 s": "The sensor board stopped reporting.",
};

/**
 * The single sentence for "what is going on in the room", by priority:
 * server unreachable > engine down > sensor silent > starting up > presence.
 */
export function roomStatus(input: {
  connected: boolean;
  status: Status | null;
  result: Result | null;
  stale: boolean;
  presenceSince: PresenceSince | null;
  profile: ProfileName;
  now: number;
}): RoomStatus {
  const { connected, status, result, stale, presenceSince, profile, now } = input;
  const none = { action: null, blind: true } as const;

  if (!connected) {
    return result
      ? { tone: "offline", headline: "Can't reach the Life-Fi box", detail: `Last update at ${clock(result.ts)}. Trying again… Check the box is on and this device is on the same network.`, ...none }
      : { tone: "connecting", headline: "Connecting to Life-Fi…", detail: "If this does not change in a few seconds, check that the Life-Fi box is switched on and this device is on the same network.", ...none };
  }
  if (status && !status.engine.connected) {
    return { tone: "offline", headline: "We cannot see the room right now", detail: "The sensor software is not running. Restart the Life-Fi box.", ...none };
  }
  if (status?.server.sensor_offline || stale) {
    const age = result ? now - result.ts : null;
    const why =
      status?.source.state === "error" && status.source.error
        ? `The sensor board can't be read (${status.source.error}).`
        : status?.server.sensor_offline
          ? (WATCHDOG_TEXT[status.server.sensor_offline] ?? "The sensor is not reporting.")
          : "The sensor is not reporting.";
    const forHow = age !== null ? ` Last reading ${duration(age)} ago.` : "";
    return { tone: "offline", headline: "We cannot see the room right now", detail: `${why}${forHow} Check the sensor is plugged in.`, ...none };
  }
  if (!result) {
    return { tone: "connecting", headline: "Waiting for the first reading…", detail: null, ...none };
  }
  if (result.health.warmup) {
    return { tone: "uncertain", headline: "Starting up, checking the room", detail: "Takes a few seconds after a restart. Nothing can be detected until it is done.", action: null, blind: true };
  }

  const since = sinceText(presenceSince?.state === result.presence.state ? presenceSince : null, now);
  const p = result.presence.state;
  if (p === "present") {
    const headline = profile === "school" ? "Room in use" : profile === "clinic" ? "Patient is in the room" : "Someone is home";
    return { tone: "present", headline, detail: since, action: null, blind: false };
  }
  if (p === "empty") {
    const headline = profile === "school" ? "Room is empty" : "Nobody in the room";
    return { tone: "empty", headline, detail: since, action: null, blind: false };
  }
  const cal = calibrationText(result.calibration);
  if (cal.needsAction) {
    return {
      tone: "uncertain",
      headline: "Not sure if anyone is there",
      detail: "The empty-room calibration is missing or old. Recalibrate while nobody is in the room.",
      action: { label: "Calibrate", href: "/calibrate/" },
      blind: false,
    };
  }
  return { tone: "uncertain", headline: "Not sure if anyone is there", detail: "Someone may be sitting very still or far from the sensor.", action: null, blind: false };
}

export function activityText(motion: number): string {
  if (motion < 0.06) return "Very still";
  if (motion < 0.2) return "Small movements";
  if (motion < 0.6) return "Moving around";
  return "Moving a lot";
}

export const POSTURE_TEXT: Record<string, string> = { lying: "Lying down", sitting: "Sitting", standing: "Standing", unknown: "Not known yet" };

/** Posture is "last change we saw": a missed transition leaves it wrong until the next one. */
export function postureText(posture: Result["posture"]): { text: string; since: string | null } {
  if (!posture || posture.label === "unknown") return { text: "Not known yet", since: null };
  return { text: POSTURE_TEXT[posture.label] ?? posture.label, since: `since ${clock(posture.since)}` };
}

export function breathingText(result: Result): { value: string | null; text: string } {
  const b = result.breathing;
  if (result.presence.state === "empty") return { value: null, text: "Nobody to measure" };
  if (b.valid && b.bpm !== null) return { value: b.bpm.toFixed(0), text: b.confidence >= 0.8 ? "breaths a minute · steady reading" : "breaths a minute · rough reading" };
  if (result.count?.value === 2) return { value: null, text: "Can't be read with several people in the room" };
  if (result.motion >= 0.2) return { value: null, text: "Can't be read while they move" };
  return { value: null, text: "No steady reading right now" };
}

/** The movement model's classes (results.schema.json activityLabel), in words. */
export const ACTIVITY_LABELS = ["none", "walking", "sit_down", "lie_down", "rise", "fall"] as const;
export const ACTIVITY_TEXT: Record<(typeof ACTIVITY_LABELS)[number], string> = {
  none: "No movement event",
  walking: "Walking",
  sit_down: "Sitting down",
  lie_down: "Lying down",
  rise: "Getting up",
  fall: "Falling",
};

/** Alert copy: hedged where the detector can be wrong, with what to do, per profile. */
export const ALERT_TITLE: Record<string, string> = {
  fall: "Possible fall",
  fainted_suspected: "No movement after a possible fall",
  no_breathing: "Breathing not detected",
  presence_uncertain: "Can't tell if someone is there",
  recalibrate_needed: "Calibration needed",
  bed_exit: "Left the bed",
  sensor_offline: "Sensor offline",
  long_inactivity: "No movement for a long time",
  after_hours_occupancy: "Room in use after hours",
};

export function alertTitle(type: string): string {
  return ALERT_TITLE[type] ?? type.replace(/_/g, " ");
}

/** What "resolved" means for each type, in words: the recovery, not the problem. */
const CLEARED: Record<string, string> = {
  fall: "the possible fall is over",
  fainted_suspected: "moving again after the fall",
  no_breathing: "breathing detected again",
  presence_uncertain: "presence is clear again",
  recalibrate_needed: "calibration is fine again",
  bed_exit: "back in bed",
  sensor_offline: "the sensor is back",
  long_inactivity: "moving again",
  after_hours_occupancy: "the room is empty again",
};

export function clearedText(type: string): string {
  return CLEARED[type] ?? `${alertTitle(type).toLowerCase()} is over`;
}

export function alertAction(type: string, profile: ProfileName): string {
  const urgent = type === "fall" || type === "fainted_suspected" || type === "no_breathing";
  if (urgent) {
    if (profile === "clinic") return "Go to the patient now.";
    if (profile === "school") return "Go to the room now.";
    return "Call or check on them now. If they don't respond, call 112.";
  }
  switch (type) {
    case "bed_exit":
      return "Check the patient is safe.";
    case "sensor_offline":
      return "We cannot see the room. Check the sensor has power and Wi-Fi.";
    case "long_inactivity":
      return "Call them, or ask someone nearby to look in.";
    case "after_hours_occupancy":
      return "Check who is in the room.";
    case "presence_uncertain":
    case "recalibrate_needed":
      return "Recalibrate while the room is empty.";
    default:
      return "Check on the room.";
  }
}

export function levelText(level: Alert["level"]): string {
  return level === "high" ? "Urgent" : level === "medium" ? "Needs attention" : "For information";
}
