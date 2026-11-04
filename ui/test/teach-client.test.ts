import { describe, expect, it } from "vitest";
import { currentStep, pct, secondsLeft, totalSeconds, verdict, type Step } from "../src/lib/teach";

const step = (id: number, t0: number, t1: number): Step => ({ id, kind: "hold", name: "far", d_m: 3, t0_ms: t0, t1_ms: t1, say: "x" });

describe("teach client helpers", () => {
  it("current step and seconds left on the server clock", () => {
    const steps = [step(0, 0, 10_000), step(1, 10_000, 20_000)];
    expect(currentStep(steps, -1)).toBeNull();
    expect(currentStep(steps, 9_999)!.id).toBe(0);
    expect(currentStep(steps, 10_000)!.id).toBe(1);
    expect(secondsLeft(steps[1], 10_001)).toBe(10);
    expect(secondsLeft(steps[1], 25_000)).toBe(0);
  });

  it("total matches the server schedule", () => {
    const t = { lead_s: 20, empty_s: 60, hold_s: 45, walk_s: 10, enter_s: 15 };
    expect(totalSeconds(t, 3, 2)).toBe(490);
    expect(totalSeconds(t, 3, 1)).toBe(325);
  });

  it("verdict never flatters the model; pct floors", () => {
    const m = (loso: number | null) => ({ loso_bal_acc: loso, chance: 0.25, bar: 0.4 });
    expect(verdict(m(null)).title).toBe("Not measured");
    expect(verdict(m(0.19))).toMatchObject({ tone: "danger", transmitterLink: true });
    expect(verdict(m(0.3)).tone).toBe("danger");
    expect(verdict(m(0.35)).tone).toBe("warn");
    expect(verdict(m(0.4)).tone).toBe("ok");
    expect(pct(0.399)).toBe("39 %");
    expect(pct(0.58)).toBe("58 %");
  });
});
