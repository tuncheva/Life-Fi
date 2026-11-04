import { describe, expect, it } from "vitest";
import type { Result } from "../src/lib/contracts.gen";
import { BLIND_TEXT, MOTION_ON, OUT_OF_RANGE_TEXT, SEVERAL_TEXT, reasonText, vitalsView, vitalsWaiting } from "../src/lib/vitals";

type Over = { breathing?: Record<string, unknown>; heart?: Record<string, unknown> | null; presence?: string; motion?: number; count?: unknown };
const result = (o: Over = {}): Result => {
  const r: Record<string, unknown> = {
    ts: 1000,
    presence: { state: o.presence ?? "present", value: true, S: 0, B: 0, M: 0 },
    motion: o.motion ?? 0,
    count: o.count ?? null,
    breathing: { bpm: 14.4, valid: true, confidence: 0.9, wave: [], ...o.breathing },
  };
  if (o.heart !== undefined) r.heart = o.heart === null ? null : { bpm: 71.6, valid: true, confidence: 0.4, reason: null, ...o.heart };
  return r as unknown as Result;
};

describe("reasonText", () => {
  it("says every reason in words", () => {
    expect(reasonText("warming_up")).toMatch(/Starting up/);
    expect(reasonText("no_person")).toBe("Nobody to measure");
    expect(reasonText("motion")).toMatch(/Moved recently.*30 s/);
    expect(reasonText("motion", false)).toMatch(/Moved recently.*20 s/);
    expect(reasonText("noise")).toMatch(/weak/);
    expect(reasonText("unstable")).toMatch(/disagree/);
  });
});

describe("vitalsView", () => {
  it("shows a rounded breathing rate, steady from confidence 0.8", () => {
    const v = vitalsView(result(), false);
    expect(v.breath).toMatchObject({ value: "14", state: "reading", quality: "steady", unit: "breaths/min" });
    expect(vitalsView(result({ breathing: { confidence: 0.5 } }), false).breath.quality).toBe("rough");
  });

  it("heart is always a rough reading", () => {
    expect(vitalsView(result({ heart: {} }), false).heart).toMatchObject({ value: "72", state: "reading", quality: "rough", unit: "beats/min" });
  });

  it("hides values out of range", () => {
    const v = vitalsView(result({ breathing: { bpm: 70 }, heart: { bpm: 250 } }), false);
    expect(v.breath).toMatchObject({ value: null, state: "none", text: OUT_OF_RANGE_TEXT });
    expect(v.heart).toMatchObject({ value: null, text: OUT_OF_RANGE_TEXT });
  });

  it("hides non-finite numbers", () => {
    expect(vitalsView(result({ breathing: { bpm: Number.NaN } }), false).breath.value).toBeNull();
  });

  it("heart is null when absent or null, an object otherwise", () => {
    expect(vitalsView(result(), false).heart).toBeNull();
    expect(vitalsView(result({ heart: null }), false).heart).toBeNull();
    expect(vitalsView(result({ heart: { bpm: null, valid: false, reason: "warming_up" } }), false).heart?.text).toMatch(/Starting up/);
  });

  it("uses the engine's reason", () => {
    expect(vitalsView(result({ breathing: { bpm: null, valid: false, reason: "noise" } }), false).breath.text).toBe(reasonText("noise"));
    // "motion" = moved in the last 20 s (breathing) or 30 s (heart), not "moving now"
    expect(vitalsView(result({ breathing: { bpm: null, valid: false, reason: "motion" } }), false).breath.text).toMatch(/20 s/);
    expect(vitalsView(result({ heart: { bpm: null, valid: false, reason: "motion" } }), false).heart?.text).toMatch(/30 s/);
  });

  it("falls back when the reason is missing (older engine) or null", () => {
    expect(vitalsView(result({ presence: "empty", breathing: { bpm: null, valid: false } }), false).breath.text).toBe("Nobody to measure");
    expect(vitalsView(result({ motion: 0.4, breathing: { bpm: null, valid: false } }), false).breath.text).toMatch(/move/);
    expect(vitalsView(result({ breathing: { bpm: null, valid: false } }), false).breath.text).toBe("No reading yet");
    // the movement claim only above the engine's own gate (MOTION_ON), never for a still person
    expect(vitalsView(result({ motion: MOTION_ON + 0.05, breathing: { bpm: null, valid: false } }), false).breath.text).toMatch(/move/);
    expect(vitalsView(result({ motion: 0.05, breathing: { bpm: null, valid: false } }), false).breath.text).toBe("No reading yet");
    expect(vitalsView(result({ heart: { bpm: null, valid: false, reason: null } }), false).heart?.text).toBe("No reading yet");
  });

  it("is off while blind", () => {
    const v = vitalsView(result({ heart: {} }), true);
    expect(v.breath).toMatchObject({ state: "off", value: null, text: BLIND_TEXT });
    expect(v.heart).toMatchObject({ state: "off", value: null });
  });

  it("two people override a valid reading", () => {
    const v = vitalsView(result({ heart: {}, count: { value: 2, p: [0.2, 0.8], src: "model" } }), false);
    expect(v.breath).toMatchObject({ value: null, text: SEVERAL_TEXT });
    expect(v.heart).toMatchObject({ value: null, text: SEVERAL_TEXT });
  });

  it("waits before the first result", () => {
    expect(vitalsWaiting(false).breath.state).toBe("none");
    expect(vitalsWaiting(true).breath.state).toBe("off");
  });
});
