import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readPositionFiles } from "../src/server/position-files";

const dir = mkdtempSync(join(tmpdir(), "lifefi-pos-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("readPositionFiles", () => {
  it("nulls when the files are missing or broken", () => {
    expect(readPositionFiles(dir)).toEqual({ fit: null, spots: null });
    writeFileSync(join(dir, "position.json"), "{oops");
    expect(readPositionFiles(dir).fit).toBeNull();
  });

  it("reads the fit and the spot summary, in ms, without the weights", () => {
    writeFileSync(join(dir, "position.json"), JSON.stringify({ A: 16.13, n: 2.0, d_m: 2.0, at: 1793463150.1023128 }));
    writeFileSync(
      join(dir, "spots_model.json"),
      JSON.stringify({
        labels: ["close", "far", "empty"],
        distances: { close: 0.4, far: 2.2, empty: null },
        mu: [1],
        sd: [1],
        W: [[1]],
        b: [0],
        shrink: 0.1,
        holdout_accuracy: 0.93,
        loso_bal_acc: 0.21,
        session: "spots-1,spots-2",
        trained_at: "2026-10-31T19:50:48",
      }),
    );
    const r = readPositionFiles(dir);
    expect(r.fit).toEqual({ A: 16.13, n: 2, d_m: 2, at: 1793463150102 });
    expect(r.spots).toEqual({
      labels: ["close", "far", "empty"],
      distances: { close: 0.4, far: 2.2, empty: null },
      loso_bal_acc: 0.21,
      session: "spots-1,spots-2",
      trained_at: new Date(2026, 9, 31, 19, 50, 48).getTime(),
    });
    expect(JSON.stringify(r)).not.toContain("shrink");
    expect(JSON.stringify(r)).not.toContain("holdout");
  });
});
