// Read-only tools for the caregiver agent. They return derived, identifier-free values only:
// never the room name, the contact phone, acked_by, raw CSI or breathing waves (gemini-api-options.md §1).
import type { AppContext } from "../context";
import { EVENT_KINDS, type EventKind } from "../store";
import { summarize } from "../vitals-history";
import type { Alert } from "../alerts";
import type { AgentTool } from "./provider";

const HOUR = 3600_000;
const MAX_HOURS = 24 * 7;

const hoursArg = (input: Record<string, unknown>, fallback: number) => {
  const h = Number(input.hours ?? fallback);
  return Number.isFinite(h) && h > 0 ? Math.min(h, MAX_HOURS) : fallback;
};

/** Local wall-clock time in the dashboard's zone ("2026-11-04 22:57:03"), so the model never reads UTC as local. */
export function localTime(t: number | null, zone: string): string | null {
  if (t === null) return null;
  try {
    return new Date(t).toLocaleString("sv-SE", { timeZone: zone });
  } catch {
    return new Date(t).toISOString();
  }
}

/** What the model may see of an alert. */
export const alertView = (a: Alert, zone: string) => {
  const iso = (t: number | null) => localTime(t, zone);
  return {
    id: a.id,
    type: a.type,
    level: a.level,
    state: a.state,
    created: iso(a.created_at),
    opened: iso(a.opened_at),
    acknowledged: iso(a.acked_at),
    resolved: iso(a.resolved_at),
    escalated: iso(a.escalated_at),
    details: a.data,
  };
};

const hoursSchema = (what: string) => ({
  type: "object",
  properties: { hours: { type: "number", description: `How many hours back to look for ${what} (1-168, default 24).` } },
  additionalProperties: false,
});

export function agentTools(ctx: AppContext, now = () => Date.now()): AgentTool[] {
  const zone = ctx.settings.value.zone;
  const iso = (t: number | null) => localTime(t, zone);
  return [
    {
      name: "get_current_status",
      description: "The current reading: presence, motion level, posture, people count, breathing and heart estimates, whether the sensor is online, and how many alerts are open.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        const r = ctx.state.latest;
        return {
          now: iso(now()),
          time_zone: zone,
          // the watchdog only fires after a timeout, so a missing engine counts as offline at once
          sensor_software_running: ctx.engine.connected,
          sensor_offline: ctx.watchdog.isOffline || !ctx.engine.connected || ctx.state.latest === null,
          sensor_offline_reason: ctx.watchdog.isOffline ? ctx.watchdog.reason : null,
          // readings need >= 50 Wi-Fi frames/s; fewer means breathing, heart and posture are unreliable
          frames_per_s: r?.health.rate_hz ?? null,
          frames_per_s_needed: 50,
          fixed_transmitter_seen: ctx.state.engineStatus?.device ? ctx.state.engineStatus.device.transmitter === "fixed" : null,
          last_reading: iso(ctx.state.lastResultAt),
          presence: r?.presence.state ?? null,
          presence_since: iso(ctx.state.presence?.since ?? null),
          // true: the dashboard restarted while this state held, so it began at that time or earlier
          presence_since_is_lower_bound: ctx.state.presence?.at_least ?? null,
          motion: r?.motion ?? null,
          posture: r?.posture?.label ?? null,
          people: r?.count?.value ?? null,
          breathing_bpm: r?.breathing.valid ? r.breathing.bpm : null,
          heart_bpm: r?.heart?.valid ? r.heart.bpm : null,
          alerts_open: ctx.alerts.openCount(),
        };
      },
    },
    {
      name: "get_alerts",
      description: "Alerts (falls, breathing pauses, long inactivity, sensor offline, ...) created in the last N hours, newest first, with their state and timestamps.",
      parameters: hoursSchema("alerts"),
      run: async (input) => {
        const from = now() - hoursArg(input, 24) * HOUR;
        return { alerts: ctx.alerts.list().filter((a) => a.created_at >= from).slice(0, 50).map((a) => alertView(a, zone)) };
      },
    },
    {
      name: "get_events",
      description: "State changes in the last N hours: presence (empty/present/uncertain), posture, and people count, oldest first.",
      parameters: {
        type: "object",
        properties: {
          hours: { type: "number", description: "How many hours back (1-168, default 24)." },
          kind: { type: "string", enum: EVENT_KINDS.filter((k) => k !== "agent"), description: "Only this kind of change." },
        },
        additionalProperties: false,
      },
      run: async (input) => {
        const to = now();
        const kind = typeof input.kind === "string" && (EVENT_KINDS as readonly string[]).includes(input.kind) && input.kind !== "agent" ? (input.kind as EventKind) : undefined;
        const events = (await ctx.store.queryEvents(to - hoursArg(input, 24) * HOUR, to, kind)).filter((e) => e.kind !== "agent");
        // the newest 200 keep the answer small
        return { events: events.slice(-200).map((e) => ({ t: iso(e.t), kind: e.kind, from: e.from ?? null, to: e.to ?? null })), total: events.length };
      },
    },
    {
      name: "get_vitals_summary",
      description: "Breathing rate, heart rate and movement over the last N hours: medians, ranges and how much of the time a reading was available.",
      parameters: hoursSchema("vitals"),
      run: async (input) => {
        const to = now();
        const hours = hoursArg(input, 24);
        const { summary } = summarize(await ctx.history.vitalsRows(to - hours * HOUR, to), hours <= 1 ? 60_000 : hours <= 6 ? 300_000 : 900_000);
        return { hours, summary };
      },
    },
  ];
}
