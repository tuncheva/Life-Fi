// Checks engine results against contracts/results.schema.json before anything uses them.
// A result that breaks the contract is dropped and logged: it must never crash the server
// or reach the dashboard half-formed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020Mod from "ajv/dist/2020.js";
import { repoRoot } from "./config";

// CommonJS with `module.exports = X` and `exports.default = X` (as in test/simulator.test.ts).
const Ajv2020 = (Ajv2020Mod as unknown as { default?: typeof Ajv2020Mod }).default ?? Ajv2020Mod;

/** Returns null for a valid result, else the first problem ("/presence must have required property 'M'"). */
export type ResultValidator = (msg: unknown) => string | null;

export function resultValidator(schemaPath = join(repoRoot, "contracts", "results.schema.json")): ResultValidator {
  const ajv = new Ajv2020({ allErrors: false, strict: true });
  const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")) as object);
  return (msg) => {
    if (validate(msg)) return null;
    const e = validate.errors?.[0];
    return e ? `${e.instancePath || "/"} ${e.message ?? "is invalid"}` : "invalid";
  };
}
