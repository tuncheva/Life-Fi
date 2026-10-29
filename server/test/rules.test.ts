import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AlertManager } from "../src/alerts.js";
import type { Result } from "../src/contracts.gen.js";
import { loadProfiles, type ProfileName } from "../src/profiles.js";
import { ServerRules } from "../src/rules.js";

const profiles = loadProfiles(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "contracts", "profiles.yml"));

/** ms since epoch for a local Europe/Sofia wall-clock time on 2026-03-10 (winter, UTC+2). */
const sofia = (hh: number, mm = 0) => Date.UTC(2026, 2, 10, hh - 2, mm);

const result = (ts: number, presence: Result["presence"]["state"], motion: number): Result =>
  ({ ts, presence: { state: presence, value: presence === "present", S: 0, B: 0, M: motion }, motion, health: { warmup: false } }) as unknown as Result;

function setup(profile: ProfileName, start: number) {
  let now = start;
  const alerts = new AlertManager(profiles, () => profile, () => now);
  const rules = new ServerRules(alerts, profiles, () => profile, () => now);
  return { alerts, rules, tick: (t: number) => (now = t) };
}

describe("ServerRules", () => {
  it("raises long_inactivity after still_present_max_min without motion, clears on movement", () => {
    const t0 = sofia(12, 0);
    const { alerts, rules, tick } = setup("home", t0);
    rules.onResult(result(t0, "present", 0.5));
    rules.onResult(result(t0 + 60_000, "present", 0.02));
    tick(t0 + 119 * 60_000);
    rules.evaluate();
    expect(alerts.isActive("s:long_inactivity")).toBe(false);
    tick(t0 + 121 * 60_000);
    rules.evaluate();
    expect(alerts.isActive("s:long_inactivity")).toBe(true);
    expect(alerts.list(["open"])[0]?.data.quiet_min).toBe(121);
    rules.onResult(result(t0 + 122 * 60_000, "present", 0.4));
    expect(alerts.isActive("s:long_inactivity")).toBe(false);
    expect(alerts.list(["resolved"])[0]?.data.closed_by).toBe("movement seen");
    alerts.stop();
  });

  it("raises long_inactivity when nobody moved by no_motion_by, not before", () => {
    const { alerts, rules } = setup("home", sofia(9, 30));
    rules.onResult(result(sofia(9, 30), "present", 0.01));
    expect(alerts.isActive("s:long_inactivity")).toBe(false);
    rules.onResult(result(sofia(10, 1), "present", 0.01));
    expect(alerts.isActive("s:long_inactivity")).toBe(true);
    expect(String(alerts.list(["open"])[0]?.data.reason)).toContain("10:00");
    alerts.stop();
  });

  it("does nothing in school and clears when the room empties", () => {
    const t0 = sofia(12, 0);
    const { alerts, rules, tick } = setup("school", t0);
    rules.onResult(result(t0, "present", 0.01));
    tick(t0 + 10 * 3600_000);
    rules.evaluate();
    expect(alerts.isActive("s:long_inactivity")).toBe(false);
    alerts.stop();
  });

  it("raises after_hours_occupancy in school inside 18:00-07:00 and clears outside or when empty", () => {
    const { alerts, rules } = setup("school", sofia(17, 59));
    rules.onResult(result(sofia(17, 59), "present", 0.3));
    expect(alerts.isActive("s:after_hours_occupancy")).toBe(false);
    rules.onResult(result(sofia(18, 1), "present", 0.3));
    expect(alerts.isActive("s:after_hours_occupancy")).toBe(true);
    expect(alerts.list(["open"])[0]?.level).toBe("medium");
    rules.onResult(result(sofia(18, 5), "empty", 0.0));
    expect(alerts.isActive("s:after_hours_occupancy")).toBe(false);
    expect(alerts.list(["resolved"])[0]?.data.closed_by).toBe("room is empty");
    rules.onResult(result(sofia(23, 0), "present", 0.3));
    expect(alerts.isActive("s:after_hours_occupancy")).toBe(true);
    rules.onResult(result(sofia(7, 1) + 86_400_000, "present", 0.3));
    expect(alerts.isActive("s:after_hours_occupancy")).toBe(false);
    alerts.stop();
  });

  it("never raises after_hours_occupancy at home, and ends time rules when the engine is lost", () => {
    const { alerts, rules } = setup("home", sofia(23, 0));
    rules.onResult(result(sofia(23, 0), "present", 0.3));
    expect(alerts.isActive("s:after_hours_occupancy")).toBe(false);
    const { alerts: a2, rules: r2 } = setup("school", sofia(23, 0));
    r2.onResult(result(sofia(23, 0), "present", 0.3));
    expect(a2.isActive("s:after_hours_occupancy")).toBe(true);
    r2.onEngineLost();
    expect(a2.isActive("s:after_hours_occupancy")).toBe(false);
    expect(a2.list(["resolved"])[0]?.data.closed_by).toBe("sensor stopped reporting");
    alerts.stop();
    a2.stop();
  });
});
