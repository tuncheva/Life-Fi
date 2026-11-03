import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resultValidator } from "../src/server/validate";

// The server's validator compiles contracts/results.schema.json itself (strict Ajv), so a
// field added to the schema is accepted with no server change. Every fixture must pass.
const fixtures = resolve(process.cwd(), "..", "contracts", "fixtures");

describe("resultValidator follows results.schema.json", () => {
  const validate = resultValidator();
  for (const name of readdirSync(fixtures).filter((f) => f.endsWith(".json")).sort()) {
    it(`accepts ${name}`, () => {
      expect(validate(JSON.parse(readFileSync(join(fixtures, name), "utf8")))).toBeNull();
    });
  }

  it("still drops a field the schema does not know", () => {
    const r = JSON.parse(readFileSync(join(fixtures, readdirSync(fixtures).filter((f) => f.endsWith(".json"))[0]), "utf8"));
    expect(validate({ ...r, not_in_the_schema: 1 })).not.toBeNull();
  });
});
