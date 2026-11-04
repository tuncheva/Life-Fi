import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAIN_NAV, SETUP_NAV, isActive } from "../src/lib/nav";
import { parseWholeNumber } from "../src/lib/words";

describe("isActive", () => {
  it("matches a route and the pages below it, never a longer name", () => {
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/", "/alerts")).toBe(false);
    expect(isActive("/alerts", "/alerts/")).toBe(true);
    expect(isActive("/alerts", "/alerts/x")).toBe(true);
    expect(isActive("/setup", "/settings")).toBe(false);
    expect(isActive("/setup", "/setupx")).toBe(false);
    expect(isActive("/model", "/model")).toBe(true);
  });
});

describe("navigation model", () => {
  it("main nav is Room, Insights, Assistant, Events, Alerts", () => {
    expect(MAIN_NAV.map((h) => h.href)).toEqual(["/", "/model", "/assistant", "/events", "/alerts"]);
    expect(MAIN_NAV.find((h) => h.href === "/model")?.label).toBe("Insights");
  });

  it("the Setup menu has neither /model nor /present", () => {
    const hrefs = SETUP_NAV.map((h) => h.href);
    expect(hrefs).not.toContain("/model");
    expect(hrefs).not.toContain("/present");
  });

  it("no href ends with a slash (each would cost a redirect)", () => {
    for (const { href } of [...MAIN_NAV, ...SETUP_NAV]) if (href !== "/") expect(href.endsWith("/")).toBe(false);
  });

  it("every href has a page", () => {
    for (const { href } of [...MAIN_NAV, ...SETUP_NAV]) {
      if (href === "/") continue;
      expect(existsSync(fileURLToPath(new URL(`../src/app${href}/page.tsx`, import.meta.url))), href).toBe(true);
    }
  });
});

describe("parseWholeNumber", () => {
  it("rejects empty, non-numbers and out-of-range values instead of returning 0", () => {
    expect(parseWholeNumber("", 0)).toBeNull();
    expect(parseWholeNumber("abc", 0)).toBeNull();
    expect(parseWholeNumber("-1", 0)).toBeNull();
    expect(parseWholeNumber("3.5", 0)).toBeNull();
    expect(parseWholeNumber("0", 0)).toBe(0);
    expect(parseWholeNumber("0", 1)).toBeNull();
    expect(parseWholeNumber(" 30 ", 0)).toBe(30);
    expect(parseWholeNumber("4000", 1, 3650)).toBeNull();
  });
});
