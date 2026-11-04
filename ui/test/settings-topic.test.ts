import { describe, expect, it } from "vitest";
import type { PublicSettings } from "../src/lib/api";
import { changedSettings, TOPIC_MIN, topicCheck } from "../src/lib/notify";

describe("topicCheck", () => {
  it("accepts an empty topic (alerts off) and a long one", () => {
    expect(topicCheck("", "")).toBe("ok");
    expect(topicCheck("  ", "old")).toBe("ok");
    expect(topicCheck("x".repeat(TOPIC_MIN), "")).toBe("ok");
  });

  it("refuses a new short topic", () => {
    expect(topicCheck("alerts", "")).toBe("refused");
    expect(topicCheck("alerts2", "alerts")).toBe("refused");
  });

  it("only warns for the short topic the install already uses (no lock-out)", () => {
    expect(topicCheck("room-1", "room-1")).toBe("short");
    expect(topicCheck(" room-1 ", "room-1")).toBe("short");
  });
});

describe("changedSettings", () => {
  const saved: PublicSettings = {
    pin_set: true,
    notify: { ntfy_url: "https://ntfy.sh", topic: "lifefi-abcdefghijklmnopqrstu", escalate_after_s: 60 },
    zone: "Europe/Sofia",
    dashboard_url: "http://192.168.1.10:8080",
    retention_days: 30,
    room_name: "Room 1",
    contact_phone: "",
  };

  it("sends nothing when nothing changed", () => {
    expect(changedSettings(saved, structuredClone(saved))).toEqual({});
  });

  it("sends only the changed fields, notify field by field (no lost update of the others)", () => {
    const next = structuredClone(saved);
    next.room_name = "Bedroom";
    next.notify.escalate_after_s = 120;
    expect(changedSettings(saved, next)).toEqual({ room_name: "Bedroom", notify: { escalate_after_s: 120 } });
  });
});
