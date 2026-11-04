import { describe, expect, it } from "vitest";
import { byDay, eventText, hoursText } from "../src/lib/events";

describe("eventText (track FB)", () => {
  it("words presence changes", () => {
    expect(eventText({ t: 0, kind: "presence", from: "empty", to: "present" }).title).toBe("Someone came in");
    expect(eventText({ t: 0, kind: "presence", from: "present", to: "empty" })).toMatchObject({ title: "The room became empty", icon: "empty" });
    expect(eventText({ t: 0, kind: "presence", from: "present", to: "uncertain" }).icon).toBe("question");
  });

  it("words posture and count with the old value", () => {
    expect(eventText({ t: 0, kind: "posture", from: "standing", to: "lying" })).toMatchObject({ title: "Now lying down", detail: "Was standing" });
    expect(eventText({ t: 0, kind: "count", from: 1, to: null })).toMatchObject({ title: "People in the room: unknown", detail: "Was 1" });
  });

  it("shows the question of an agent run, or its failure", () => {
    expect(eventText({ t: 0, kind: "agent", data: { mode: "chat", ok: true, question: "How was the night?" } })).toMatchObject({ title: "Assistant question", detail: "How was the night?" });
    expect(eventText({ t: 0, kind: "agent", data: { mode: "summary", ok: false, error: "timeout" } })).toMatchObject({ title: "Assistant summary failed", icon: "alert" });
  });
});

describe("byDay / hoursText", () => {
  it("groups consecutive items by label, keeping order", () => {
    const g = byDay([{ t: 3 }, { t: 2 }, { t: 1 }], (t) => (t > 1 ? "b" : "a"));
    expect(g.map((x) => [x.day, x.items.length])).toEqual([
      ["b", 2],
      ["a", 1],
    ]);
  });

  it("says days for a week", () => {
    expect(hoursText(6)).toBe("6 h");
    expect(hoursText(168)).toBe("7 days");
  });
});
