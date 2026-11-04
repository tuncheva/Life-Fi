import { describe, expect, it } from "vitest";
import { readSectionOpen, writeSectionOpen } from "../src/lib/model";

const store = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m } as unknown as Storage & { m: Map<string, string> };
};
const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } } as unknown as Storage;

describe("readSectionOpen", () => {
  it("uses the default without a key or storage", () => {
    expect(readSectionOpen(store(), "x", true)).toBe(true);
    expect(readSectionOpen(store(), "x", false)).toBe(false);
    expect(readSectionOpen(null, "x", true)).toBe(true);
  });

  it("reads 1 and 0", () => {
    expect(readSectionOpen(store({ "lifefi.section.x": "1" }), "x", false)).toBe(true);
    expect(readSectionOpen(store({ "lifefi.section.x": "0" }), "x", true)).toBe(false);
  });

  it("falls back on a throwing storage", () => {
    expect(readSectionOpen(throwing, "x", true)).toBe(true);
  });
});

describe("writeSectionOpen", () => {
  it("writes lifefi.section.<id>", () => {
    const st = store();
    writeSectionOpen(st, "breathing", true);
    expect(st.m.get("lifefi.section.breathing")).toBe("1");
    writeSectionOpen(st, "breathing", false);
    expect(st.m.get("lifefi.section.breathing")).toBe("0");
  });

  it("swallows a throwing setItem", () => {
    expect(() => writeSectionOpen(throwing, "x", true)).not.toThrow();
    expect(() => writeSectionOpen(null, "x", true)).not.toThrow();
  });
});
