// Server-side rules (plan-v2 §6.10, §11): conditions the engine does not
// report because they need the clock or the profile.
//   long_inactivity (Home): present with no motion for `still_present_max_min`,
//     or no motion at all by `no_motion_by` local time.
//   after_hours_occupancy (School): present inside the after-hours window.
// Both are raised and cleared through the AlertManager like engine events.
import type { AlertManager } from "./alerts.js";
import type { Result } from "./contracts.gen.js";
import { insideHours, minutesOfDayIn, type ProfileName, type ProfilesConfig } from "./profiles.js";

/** Motion above this counts as "moved". Matches the mock's still/moving split; tune from recordings. */
export const MOTION_ON = 0.1;

export class ServerRules {
  private lastMotionAt: number | null = null;
  private presentSince: number | null = null;
  private presence: Result["presence"]["state"] | null = null;
  /** Local day (YYYY-MM-DD in the profile zone) in which motion was last seen. */
  private motionDay: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly alerts: AlertManager,
    private profiles: ProfilesConfig,
    private readonly getProfile: () => ProfileName,
    private readonly now: () => number = () => Date.now(),
  ) {}

  setProfiles(p: ProfilesConfig): void {
    this.profiles = p;
  }

  start(intervalMs = 10_000): void {
    this.timer = setInterval(() => this.evaluate(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  onResult(r: Result): void {
    const t = r.ts;
    if (r.presence.state !== this.presence) {
      this.presence = r.presence.state;
      this.presentSince = r.presence.state === "present" ? t : null;
    }
    if (r.motion >= MOTION_ON && !r.health.warmup) {
      this.lastMotionAt = t;
      this.motionDay = this.localDay(t);
    }
    this.evaluate(t);
  }

  /** Called when the engine goes away: the room cannot be judged, so time-based conditions end. */
  onEngineLost(): void {
    this.presence = null;
    this.presentSince = null;
    this.alerts.clearServer("long_inactivity", "sensor stopped reporting");
    this.alerts.clearServer("after_hours_occupancy", "sensor stopped reporting");
  }

  evaluate(t = this.now()): void {
    const profile = this.profiles.profiles[this.getProfile()];
    const present = this.presence === "present";

    // long_inactivity
    const inactivity = profile.inactivity;
    if (inactivity && present) {
      const quietSince = this.lastMotionAt ?? this.presentSince;
      const quietFor = quietSince === null ? 0 : t - quietSince;
      const tooLong = quietFor >= inactivity.still_present_max_min * 60_000;
      const byTime = (() => {
        const m = /^(\d{2}):(\d{2})$/.exec(inactivity.no_motion_by);
        if (!m) return false;
        const limit = Number(m[1]) * 60 + Number(m[2]);
        const minutes = minutesOfDayIn(this.profiles.zone, t);
        // past the limit, and no motion seen yet in the current local day
        return minutes >= limit && minutes < limit + 12 * 60 && this.motionDay !== this.localDay(t);
      })();
      if (tooLong || byTime) {
        if (!this.alerts.isActive("s:long_inactivity")) {
          this.alerts.raiseServer("long_inactivity", {
            reason: tooLong ? `no movement for ${Math.round(quietFor / 60_000)} min` : `no movement by ${inactivity.no_motion_by}`,
            quiet_min: Math.round(quietFor / 60_000),
          }, t);
        }
      } else if (this.alerts.isActive("s:long_inactivity")) {
        this.alerts.clearServer("long_inactivity", "movement seen", t);
      }
    } else if (this.alerts.isActive("s:long_inactivity")) {
      this.alerts.clearServer("long_inactivity", present ? "profile has no inactivity rule" : "nobody in the room", t);
    }

    // after_hours_occupancy
    const after = profile.occupancy?.after_hours;
    const inWindow = after ? insideHours(`${after.from}-${after.to}`, minutesOfDayIn(this.profiles.zone, t)) : false;
    if (after && present && inWindow) {
      if (!this.alerts.isActive("s:after_hours_occupancy")) {
        this.alerts.raiseServer("after_hours_occupancy", { window: `${after.from}-${after.to}`, source: after.source }, t);
      }
    } else if (this.alerts.isActive("s:after_hours_occupancy")) {
      this.alerts.clearServer("after_hours_occupancy", !after ? "profile has no after-hours rule" : !present ? "room is empty" : "outside the after-hours window", t);
    }
  }

  private localDay(t: number): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: this.profiles.zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
  }
}
