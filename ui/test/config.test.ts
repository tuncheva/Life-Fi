import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/server/config";

// vitest runs from ui/, like `next dev`, so the repo root is one level up
const root = resolve(process.cwd(), "..");

describe("loadConfig", () => {
  it("has no problems with the defaults", () => {
    const c = loadConfig({});
    expect(c.problems).toEqual([]);
    expect(c.enginePort).toBe(6000);
    expect(c.pin).toBe("1234");
    expect(c.bindHost).toBe("0.0.0.0");
    expect(c.dataDir).toBe(join(root, "data"));
    expect(c.dbPath).toBe(join(root, "data", "lifefi.sqlite"));
  });

  it("puts the db in the resolved data dir", () => {
    const c = loadConfig({ LIFEFI_DATA_DIR: "somewhere" });
    expect(c.dataDir).toBe(join(root, "somewhere"));
    expect(c.dbPath).toBe(join(root, "somewhere", "lifefi.sqlite"));
  });

  it("lists every bad value by name, falls back to the default and never throws", () => {
    const c = loadConfig({ LIFEFI_ENGINE_PORT: "abc", LIFEFI_PROFILES: "nope/profiles.yml", LIFEFI_PIN: "12", LIFEFI_LOG: "loud" });
    expect(c.enginePort).toBe(6000);
    expect(c.pin).toBe("1234");
    expect(c.problems).toHaveLength(4);
    expect(c.problems[0]).toContain('LIFEFI_ENGINE_PORT must be an integer 1-65535 (got "abc")');
    expect(c.problems.some((p) => p.startsWith("LIFEFI_PROFILES: file not found"))).toBe(true);
    expect(c.problems.some((p) => p.startsWith("LIFEFI_PIN"))).toBe(true);
    expect(c.problems.some((p) => p.startsWith("LIFEFI_LOG"))).toBe(true);
  });

  it("rejects out-of-range ports", () => {
    expect(loadConfig({ LIFEFI_ENGINE_PORT: "70000" }).problems).toHaveLength(1);
    expect(loadConfig({ LIFEFI_ENGINE_PORT: "0" }).problems).toHaveLength(1);
  });

  it("ConfigError lists the problems", () => {
    const e = new ConfigError(["A is bad", "B is bad"]);
    expect(e.message).toBe("life-fi: invalid configuration\n  - A is bad\n  - B is bad");
  });
});
