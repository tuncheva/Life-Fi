import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AlertManager } from "../src/server/alerts";
import { loadProfiles } from "../src/server/profiles";

const profiles = loadProfiles(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "contracts", "profiles.yml"));

describe("AlertManager.syncActive", () => {
  it("raises alerts for active engine events it does not know, once", () => {
    const m = new AlertManager(profiles, () => "home", () => 5000);
    const raised = m.syncActive([
      { id: 7, type: "fall", t: 4000, data: { peak: 0.9 } },
      { id: 8, type: "bed_exit", t: 4000 }, // not alerted in home
    ]);
    expect(raised).toBe(1);
    const open = m.list(["open"]);
    expect(open.map((a) => [a.event_id, a.type, a.data])).toEqual([[7, "fall", { peak: 0.9 }]]);
    expect(m.syncActive([{ id: 7, type: "fall", t: 4000 }])).toBe(0);
    expect(m.list(["open"])).toHaveLength(1);
    m.stop();
  });

  it("does not duplicate an alert that the result edge already opened", () => {
    const m = new AlertManager(profiles, () => "home", () => 5000);
    m.onResult({ boot_id: 1, ts: 5000, events: [{ id: 3, type: "fall", state: "active", t: 5000, data: {} }], active: [3] } as never);
    expect(m.syncActive([{ id: 3, type: "fall", t: 5000 }])).toBe(0);
    expect(m.list(["open"])).toHaveLength(1);
    m.stop();
  });
});
