// Backward-compatibility guard: track M and the pages import these from ui.tsx.
import { describe, expect, it } from "vitest";
import * as ui from "../src/components/ui";

const EXPORTS = ["Card", "Pill", "TONE_CLASS", "btn", "inputCls", "Kbd", "Notice", "Icon", "TONE_ICON", "Skeleton", "PageSkeleton", "PageHeader", "Field", "EmptyState", "inputRowCls", "checkLabelCls"] as const;

describe("components/ui exports", () => {
  it("keeps every shared export", () => {
    for (const name of EXPORTS) expect(ui[name], name).toBeDefined();
  });

  it("inputs and segments are 44 px targets", () => {
    expect(ui.inputCls).toContain("min-h-11");
    expect(ui.inputRowCls).toContain("min-h-11");
    expect(ui.btn.segment(true)).toContain("min-h-11");
    expect(ui.checkLabelCls).toContain("min-h-11");
  });

  it("the row input has no top margin", () => {
    expect(ui.inputRowCls).not.toContain("mt-1");
  });
});
