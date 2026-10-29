import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Mod from "ajv/dist/2020.js";
import addFormatsMod from "ajv-formats";
import { Simulator } from "../src/mock-engine/simulator.js";
import { SCENARIOS, listScenarios } from "../src/mock-engine/scenarios.js";
import type { Result } from "../src/contracts.gen.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const schema = JSON.parse(readFileSync(join(repo, "contracts", "results.schema.json"), "utf8")) as object;
// Both packages are CommonJS with `module.exports = X` and `exports.default = X`, so `.default`
// is the class/function whether the ESM interop hands back the namespace or the export itself.
const Ajv2020 = Ajv2020Mod.default;
const addFormats = addFormatsMod.default;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
const STEP_MS = 500;

function durationMs(name: string): number {
  return SCENARIOS[name]!.phases.reduce((a, p) => a + p.for_s, 0) * 1000;
}

/** Steps the simulator through `ms` and returns every result (nulls kept). */
function run(sim: Simulator, from: number, ms: number): { t: number; r: Result | null }[] {
  const out: { t: number; r: Result | null }[] = [];
  for (let t = from; t <= from + ms; t += STEP_MS) out.push({ t, r: sim.step(t) });
  return out;
}

function describeErrors(): string {
  return (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
}

describe("Simulator", () => {
  for (const name of Object.keys(SCENARIOS)) {
    it(`scenario '${name}' produces schema-valid, consistent results`, () => {
      const sim = new Simulator(name, T0);
      expect(sim.scenarioName).toBe(name);
      const rows = run(sim, T0, durationMs(name) + 10_000);
      expect(rows.length).toBeGreaterThan(20);

      const open = new Set<number>();
      let lastBoot: number | null = null;
      let seen = 0;
      for (const { t, r } of rows) {
        if (r === null) continue;
        seen++;
        expect(validate(r), `t+${(t - T0) / 1000}s: ${describeErrors()}`).toBe(true);
        expect(r.ts).toBe(t);
        for (const row of r.csi) expect(row).toHaveLength(52);
        expect(r.csi.length).toBeGreaterThan(0);

        if (lastBoot !== null && r.boot_id !== lastBoot) {
          // the engine rebooted: its events are gone and ids start over
          open.clear();
        }
        lastBoot = r.boot_id;

        for (const ev of r.events) {
          if (ev.state === "active") {
            expect(open.has(ev.id), `event ${ev.id} raised twice`).toBe(false);
            expect(r.health.warmup, `event ${ev.type} raised during warm-up`).toBe(false);
            open.add(ev.id);
          } else {
            expect(open.has(ev.id), `event ${ev.id} cleared but never raised`).toBe(true);
            open.delete(ev.id);
          }
          expect(ev.t).toBe(t);
        }
        expect([...r.active].sort((a, b) => a - b)).toEqual([...open].sort((a, b) => a - b));
      }
      expect(seen).toBeGreaterThan(0);
    });
  }

  it("listScenarios reports every scenario with its duration", () => {
    const list = listScenarios();
    expect(list.map((s) => s.name).sort()).toEqual(Object.keys(SCENARIOS).sort());
    const fall = list.find((s) => s.name === "fall")!;
    expect(fall.duration_s).toBeCloseTo(79.5);
    expect(fall.loop).toBe(false);
  });

  it("'fall' raises fall, then fainted_suspected, and clears both", () => {
    const sim = new Simulator("fall", T0);
    const edges: { t: number; type: string; state: string; id: number }[] = [];
    for (const { t, r } of run(sim, T0, durationMs("fall") + 10_000)) {
      for (const ev of r?.events ?? []) edges.push({ t: t - T0, type: ev.type, state: ev.state, id: ev.id });
    }
    expect(edges.map((e) => `${e.type}:${e.state}`)).toEqual([
      "fall:active",
      "fainted_suspected:active",
      "fall:cleared",
      "fainted_suspected:cleared",
    ]);
    const [fallOn, faintOn, fallOff, faintOff] = edges as [typeof edges[0], typeof edges[0], typeof edges[0], typeof edges[0]];
    expect(fallOn.id).toBe(1);
    expect(faintOn.id).toBe(2);
    expect(fallOn.t).toBe(9500); // after walking(8) + 1.5 s fall
    expect(faintOn.t).toBe(29500); // 20 s later
    expect(fallOff.t).toBe(69500); // 40 s later, when the person gets up
    expect(faintOff.t).toBe(69500);
    expect(fallOff.id).toBe(1);
    expect(faintOff.id).toBe(2);

    // the fall carries a peak value
    const first = run(new Simulator("fall", T0), T0, 10_000).map((x) => x.r).find((r) => r?.events.length)!;
    expect(first.events[0]!.data).toEqual({ peak: expect.any(Number) });
    expect(first.active).toEqual([1]);
  });

  it("'breath_hold' raises and clears no_breathing", () => {
    const sim = new Simulator("breath_hold", T0);
    const edges: { t: number; type: string; state: string; data: unknown }[] = [];
    for (const { t, r } of run(sim, T0, durationMs("breath_hold") + 10_000)) {
      for (const ev of r?.events ?? []) edges.push({ t: t - T0, type: ev.type, state: ev.state, data: ev.data });
    }
    expect(edges).toEqual([
      { t: 24_000, type: "no_breathing", state: "active", data: { since_s: 12 } },
      { t: 42_000, type: "no_breathing", state: "cleared", data: {} },
    ]);
  });

  it("'sensor_offline' is silent for 25 s and then reboots with warm-up and a new boot_id", () => {
    const sim = new Simulator("sensor_offline", T0);
    const rows = run(sim, T0, durationMs("sensor_offline") + 10_000);
    const bootBefore = rows[0]!.r!.boot_id;

    const silent = rows.filter((x) => x.t >= T0 + 5000 && x.t < T0 + 30_000);
    expect(silent.length).toBe(50);
    expect(silent.every((x) => x.r === null)).toBe(true);
    expect(rows.filter((x) => x.t < T0 + 5000).every((x) => x.r !== null)).toBe(true);

    const afterReboot = rows.filter((x) => x.t >= T0 + 30_000);
    expect(afterReboot.every((x) => x.r !== null)).toBe(true);
    const first = afterReboot[0]!.r!;
    expect(first.boot_id).not.toBe(bootBefore);
    expect(first.health.warmup).toBe(true);
    expect(first.presence.state).toBe("uncertain");
    expect(first.posture).toBeNull();
    expect(first.health.rate_hz).toBe(40);
    expect(first.events).toEqual([]);
    expect(first.active).toEqual([]);
    // every result after the reboot shares the new boot_id
    expect(afterReboot.every((x) => x.r!.boot_id === first.boot_id)).toBe(true);
    // warm-up lasts the 4 s phase and then the lying phase is healthy
    const warm = afterReboot.filter((x) => x.r!.health.warmup);
    expect(warm.length).toBe(8);
    const healthy = afterReboot.find((x) => !x.r!.health.warmup)!.r!;
    expect(healthy.presence.state).toBe("present");
    expect(healthy.posture?.label).toBe("lying");
    expect(healthy.breathing.valid).toBe(true);
    expect(healthy.breathing.bpm).toBeGreaterThan(10);
  });

  it("'warmup' reports warm-up for 10 s and never raises events during it", () => {
    const sim = new Simulator("warmup", T0);
    const rows = run(sim, T0, 20_000);
    const warm = rows.filter((x) => x.t < T0 + 10_000);
    expect(warm.every((x) => x.r!.health.warmup && x.r!.events.length === 0)).toBe(true);
    expect(rows.find((x) => x.t === T0 + 10_000)!.r!.health.warmup).toBe(false);
  });

  it("'low_rate' reports the overridden CSI rate", () => {
    const sim = new Simulator("low_rate", T0);
    const rows = run(sim, T0, 20_000);
    expect(rows.find((x) => x.t === T0 + 4000)!.r!.health.rate_hz).toBeGreaterThan(50);
    expect(rows.find((x) => x.t === T0 + 6000)!.r!.health.rate_hz).toBe(30);
  });

  it("'uncertain' keeps presence_uncertain active and 'empty' has no posture or count", () => {
    const u = new Simulator("uncertain", T0).step(T0 + 5000)!;
    expect(u.presence.state).toBe("uncertain");
    expect(u.events).toEqual([expect.objectContaining({ type: "presence_uncertain", state: "active", id: 1 })]);
    expect(u.active).toEqual([1]);

    const e = new Simulator("empty", T0).step(T0 + 5000)!;
    expect(e.presence).toMatchObject({ value: false, state: "empty" });
    expect(e.posture).toBeNull();
    expect(e.count).toBeNull();
    expect(e.breathing.valid).toBe(false);
    expect(e.breathing.bpm).toBeNull();
  });

  it("a non-looping scenario continues with its `then` scenario", () => {
    const sim = new Simulator("fall", T0);
    run(sim, T0, durationMs("fall") + 1000);
    expect(sim.scenarioName).toBe("normal");
    expect(sim.phaseLabel).toBe("lying still");
  });

  it("a looping scenario starts over", () => {
    const sim = new Simulator("two_people", T0);
    run(sim, T0, durationMs("two_people") + 1000);
    expect(sim.scenarioName).toBe("two_people");
    expect(sim.phaseLabel).toBe("two people, moving");
  });

  it("setScenario switches scenarios and rejects unknown names", () => {
    const sim = new Simulator("normal", T0);
    expect(sim.setScenario("nope", T0)).toBe(false);
    expect(sim.scenarioName).toBe("normal");
    expect(sim.setScenario("empty", T0 + 1000)).toBe(true);
    expect(sim.scenarioName).toBe("empty");
    expect(sim.phaseLabel).toBe("empty");
    expect(sim.step(T0 + 5000)!.presence.state).toBe("empty");
  });

  it("the constructor rejects an unknown scenario", () => {
    expect(() => new Simulator("nope", T0)).toThrow(/unknown scenario/);
  });

  it("statusData reports the mock scenario, device status and a null device while silent", () => {
    const sim = new Simulator("sensor_offline", T0);
    sim.step(T0);
    const s1 = sim.statusData(T0) as { engine: Record<string, unknown>; device: Record<string, unknown> | null };
    expect(s1.engine.mock).toEqual({ scenario: "sensor_offline", phase: "lying still" });
    expect(s1.device).toMatchObject({ node: 1, last_status_us: T0 * 1000 });
    sim.step(T0 + 10_000);
    const s2 = sim.statusData(T0 + 10_000) as { device: unknown };
    expect(s2.device).toBeNull();
  });
});
