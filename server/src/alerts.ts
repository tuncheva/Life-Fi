// Alert state machine (plan-v2 §7.2, contracts/api.md).
//
//   event active ─▶ pending (delay_s)
//   pending ─cleared before the timer─▶ dropped
//   pending ─timer expires (or delay_s = 0)─▶ open ─▶ "notify"
//   open ─ack─▶ acked ;  open/acked ─cleared─▶ resolved
//   open, not acked for escalate_after_s ─▶ "notify" again (escalation)
//
// The engine reports conditions; the profile decides which become alerts.
import { EventEmitter } from "node:events";
import type { Result } from "./contracts.gen.js";
import { insideHours, minutesOfDayIn, type AlertLevel, type ProfileName, type ProfilesConfig } from "./profiles.js";

export type AlertState = "pending" | "open" | "acked" | "resolved" | "dropped";
export const ALERT_STATES: AlertState[] = ["pending", "open", "acked", "resolved", "dropped"];

export interface Alert {
  id: string;
  /** Engine event id, or null for server-emitted events (sensor_offline, long_inactivity). */
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
  /** Who pressed acknowledge (a device or person name the browser sends), if known. */
  acked_by: string | null;
  /** Outcome of the last phone notification attempt. */
  notify: "sent" | "not_configured" | "failed" | null;
  notify_error: string | null;
  data: Record<string, unknown>;
}

export interface AlertManagerEvents {
  /** Every state transition. */
  alert: [Alert];
  /** Open and escalation: send a phone notification. */
  notify: [Alert, "open" | "escalation"];
}

type Timers = { delay?: NodeJS.Timeout; escalate?: NodeJS.Timeout };

/** Key that identifies a condition while it is active: engine event id or a server event name. */
export type ConditionKey = `e:${number}` | `s:${string}`;

export class AlertManager extends EventEmitter<AlertManagerEvents> {
  private readonly alerts = new Map<string, Alert>();
  private readonly byKey = new Map<ConditionKey, string>();
  private readonly timers = new Map<string, Timers>();
  private seq = 0;
  /** Set when the engine (re)connects: the next result settles which engine conditions survived. */
  private reconnected = false;

  constructor(
    private profiles: ProfilesConfig,
    private getProfile: () => ProfileName,
    private readonly now: () => number = () => Date.now(),
    private readonly maxKept = 500,
  ) {
    super();
  }

  setProfiles(p: ProfilesConfig): void {
    this.profiles = p;
  }

  /** Escalation delay in seconds; defaults to profiles.yml, the server overrides it from settings. */
  private escalateAfterS: () => number = () => this.profiles.notify.escalate_after_s;

  setEscalateAfter(fn: () => number): void {
    this.escalateAfterS = fn;
  }

  /**
   * Loads alerts persisted by a previous run. Anything that was still live is
   * marked resolved: after a restart the engine's `active` list re-raises
   * whatever is really still going on, as a new alert.
   */
  load(saved: Alert[], now = this.now()): number {
    let restored = 0;
    for (const a of saved) {
      if (this.alerts.has(a.id)) continue;
      const alert: Alert = { ...a };
      if (alert.state === "pending" || alert.state === "open" || alert.state === "acked") {
        alert.state = alert.state === "pending" ? "dropped" : "resolved";
        alert.resolved_at = now;
        alert.data = { ...alert.data, closed_by: "server restart" };
        this.emit("alert", { ...alert });
      }
      this.alerts.set(alert.id, alert);
      const n = Number(/^a-(\d+)$/.exec(alert.id)?.[1] ?? 0);
      if (n > this.seq) this.seq = n;
      restored++;
    }
    return restored;
  }

  list(states?: AlertState[]): Alert[] {
    const all = [...this.alerts.values()].sort((a, b) => b.created_at - a.created_at);
    return states ? all.filter((a) => states.includes(a.state)) : all;
  }

  get(id: string): Alert | undefined {
    return this.alerts.get(id);
  }

  openCount(): number {
    let n = 0;
    for (const a of this.alerts.values()) if (a.state === "open") n++;
    return n;
  }

  /**
   * The engine connected (again). It may have restarted, and then every
   * condition it had is gone: the first result after this closes engine
   * alerts missing from its `active` list as "engine restarted" (not an "all
   * clear"). Event ids are never reused by a new engine run (control.md), so
   * nothing else is needed. `boot_id` is the board's: a board reboot changes
   * it while the engine and its conditions carry on.
   */
  onEngineConnected(): void {
    this.reconnected = true;
  }

  /** Feeds one engine result: edge events plus reconciliation against `active` (N8). */
  onResult(r: Result): void {
    if (this.reconnected) {
      this.reconnected = false;
      const still = new Set(r.active.map((id) => `e:${id}`));
      for (const [key] of this.byKey) if (key.startsWith("e:") && !still.has(key)) this.clear(key, r.ts, "engine restarted");
    }

    for (const ev of r.events) {
      const key: ConditionKey = `e:${ev.id}`;
      if (ev.state === "active") this.raise(key, ev.type, ev.id, ev.t, ev.data);
      // a source switch ends the old signal's conditions without them being over: not an "all clear"
      else this.clear(key, ev.t, (ev.data as { reason?: unknown }).reason === "source changed" ? "source changed" : "cleared by the engine");
    }
    const active = new Set(r.active.map((id) => `e:${id}`));
    for (const [key] of this.byKey) {
      if (key.startsWith("e:") && !active.has(key)) this.clear(key, r.ts, "no longer reported by the engine");
    }
  }

  /**
   * Engine events that are active right now, from `get_status`. Results only
   * carry ids in `active`, so after a server restart or reconnect this is how
   * an ongoing condition gets its alert back (N8).
   */
  syncActive(events: { id: number; type: string; t: number; data?: Record<string, unknown> }[]): number {
    let raised = 0;
    for (const ev of events) {
      const key: ConditionKey = `e:${ev.id}`;
      if (this.byKey.has(key)) continue;
      const before = this.alerts.size;
      this.raise(key, ev.type, ev.id, ev.t, ev.data ?? {});
      if (this.alerts.size > before) raised++;
    }
    return raised;
  }

  /** Server-emitted condition (sensor_offline, long_inactivity). */
  raiseServer(type: string, data: Record<string, unknown> = {}, t = this.now()): void {
    this.raise(`s:${type}`, type, null, t, data);
  }

  clearServer(type: string, reason = "condition ended", t = this.now()): void {
    this.clear(`s:${type}`, t, reason);
  }

  /** Records what happened to the phone notification for this alert. */
  setNotifyOutcome(id: string, outcome: NonNullable<Alert["notify"]>, error: string | null = null): void {
    const alert = this.alerts.get(id);
    if (!alert) return;
    alert.notify = outcome;
    alert.notify_error = error;
    this.emit("alert", { ...alert });
  }

  isActive(key: ConditionKey): boolean {
    return this.byKey.has(key);
  }

  private raise(key: ConditionKey, type: string, eventId: number | null, t: number, data: Record<string, unknown>): void {
    if (this.byKey.has(key)) return; // already tracked
    const profile = this.getProfile();
    const rule = this.profiles.profiles[profile].alerts[type];
    if (!rule) return; // this profile does not alert on this condition
    if (rule.hours && !insideHours(rule.hours, minutesOfDayIn(this.profiles.zone, t))) return;

    const id = `a-${String(++this.seq).padStart(4, "0")}`;
    const alert: Alert = {
      id,
      event_id: eventId,
      type,
      level: rule.level,
      state: "pending",
      profile,
      config_hash: this.profiles.hash,
      created_at: t,
      opened_at: null,
      acked_at: null,
      resolved_at: null,
      notified_at: null,
      escalated_at: null,
      acked_by: null,
      notify: null,
      notify_error: null,
      data,
    };
    this.alerts.set(id, alert);
    this.byKey.set(key, id);
    this.prune();
    this.emit("alert", { ...alert });

    // The delay counts from when the condition began (`t`): an event recovered
    // from get_status after a reconnect does not wait the whole delay again.
    const left = rule.delay_s * 1000 - Math.max(0, this.now() - t);
    if (left <= 0) {
      this.open(alert);
    } else {
      const delay = setTimeout(() => this.open(alert), left);
      this.timers.set(id, { delay });
    }
  }

  private open(alert: Alert): void {
    if (alert.state !== "pending") return;
    const t = this.now();
    alert.state = "open";
    alert.opened_at = t;
    alert.notified_at = t;
    const timers = this.timers.get(alert.id) ?? {};
    delete timers.delay;
    const esc = this.escalateAfterS();
    if (esc > 0) timers.escalate = setTimeout(() => this.escalate(alert), esc * 1000);
    this.timers.set(alert.id, timers);
    this.emit("alert", { ...alert });
    this.emit("notify", { ...alert }, "open");
  }

  private escalate(alert: Alert): void {
    if (alert.state !== "open") return;
    const t = this.now();
    alert.escalated_at = t;
    alert.notified_at = t;
    const esc = this.escalateAfterS();
    const timers = this.timers.get(alert.id) ?? {};
    if (esc > 0) timers.escalate = setTimeout(() => this.escalate(alert), esc * 1000);
    this.timers.set(alert.id, timers);
    this.emit("alert", { ...alert });
    this.emit("notify", { ...alert }, "escalation");
  }

  private clear(key: ConditionKey, t: number, reason: string): void {
    const id = this.byKey.get(key);
    if (!id) return;
    this.byKey.delete(key);
    const alert = this.alerts.get(id);
    if (!alert) return;
    this.stopTimers(id);
    alert.data = { ...alert.data, closed_by: reason };
    if (alert.state === "pending") {
      alert.state = "dropped";
      alert.resolved_at = t;
    } else if (alert.state === "open" || alert.state === "acked") {
      alert.state = "resolved";
      alert.resolved_at = t;
    } else {
      return;
    }
    this.emit("alert", { ...alert });
  }

  /** Returns the alert, or null if it does not exist; `false` if it is not open. */
  ack(id: string, by: string | null = null): Alert | null | false {
    const alert = this.alerts.get(id);
    if (!alert) return null;
    if (alert.state !== "open") return false;
    alert.state = "acked";
    alert.acked_at = this.now();
    alert.acked_by = by;
    const timers = this.timers.get(id);
    if (timers?.escalate) clearTimeout(timers.escalate);
    this.emit("alert", { ...alert });
    return { ...alert };
  }

  private stopTimers(id: string): void {
    const timers = this.timers.get(id);
    if (timers?.delay) clearTimeout(timers.delay);
    if (timers?.escalate) clearTimeout(timers.escalate);
    this.timers.delete(id);
  }

  /** Keeps memory bounded: drops the oldest finished alerts beyond `maxKept`. */
  private prune(): void {
    if (this.alerts.size <= this.maxKept) return;
    const finished = [...this.alerts.values()]
      .filter((a) => a.state === "resolved" || a.state === "dropped")
      .sort((a, b) => a.created_at - b.created_at);
    for (const a of finished.slice(0, this.alerts.size - this.maxKept)) this.alerts.delete(a.id);
  }

  stop(): void {
    for (const id of this.timers.keys()) this.stopTimers(id);
  }
}
