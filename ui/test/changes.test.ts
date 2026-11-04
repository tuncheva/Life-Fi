import { describe, expect, it } from "vitest";
import { ChangeTracker } from "../src/server/changes";

const r = (ts: number, presence: string, posture: string | null, count: number | null) =>
  ({ ts, presence: { state: presence }, posture: posture === null ? null : { label: posture }, count: count === null ? null : { value: count } }) as never;

describe("ChangeTracker (track FB)", () => {
  it("takes the first result as the baseline", () => {
    expect(new ChangeTracker().onResult(r(0, "present", "lying", 1))).toEqual([]);
  });

  it("records presence at once, with the old value", () => {
    const c = new ChangeTracker();
    c.onResult(r(0, "empty", null, 0));
    expect(c.onResult(r(100, "present", null, 0))).toEqual([{ t: 100, kind: "presence", from: "empty", to: "present" }]);
  });

  it("records posture only after it held, timed from when it began", () => {
    const c = new ChangeTracker(10_000);
    c.onResult(r(0, "present", "standing", 1));
    expect(c.onResult(r(1000, "present", "lying", 1))).toEqual([]);
    expect(c.onResult(r(10_999, "present", "lying", 1))).toEqual([]);
    expect(c.onResult(r(11_000, "present", "lying", 1))).toEqual([{ t: 1000, kind: "posture", from: "standing", to: "lying" }]);
    expect(c.onResult(r(30_000, "present", "lying", 1))).toEqual([]);
  });

  it("ignores flicker that goes back before the hold", () => {
    const c = new ChangeTracker(10_000);
    c.onResult(r(0, "present", "sitting", 1));
    const out = [];
    for (let t = 100; t < 60_000; t += 100) out.push(...c.onResult(r(t, "present", t % 1000 < 500 ? "standing" : "sitting", t % 3000 < 1500 ? 2 : 1)));
    expect(out).toEqual([]);
  });

  it("restarts the hold when the pending value changes", () => {
    const c = new ChangeTracker(10_000);
    c.onResult(r(0, "present", null, 1));
    c.onResult(r(1000, "present", null, 2));
    c.onResult(r(5000, "present", null, 3));
    expect(c.onResult(r(14_000, "present", null, 3))).toEqual([]);
    expect(c.onResult(r(15_000, "present", null, 3))).toEqual([{ t: 5000, kind: "count", from: 1, to: 3 }]);
  });
});
