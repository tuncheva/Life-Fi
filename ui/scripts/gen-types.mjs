// Generates src/lib/contracts.gen.ts from ../contracts/results.schema.json.
// Runs before `next dev` and `next build`. Commit the output: CI fails on a diff.
import { compile } from "json-schema-to-typescript";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, "..", "..", "contracts", "results.schema.json");
const outPaths = [join(here, "..", "src", "lib", "contracts.gen.ts")];

const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const ts = await compile(schema, "Result", {
  bannerComment:
    "/* eslint-disable */\n/**\n * GENERATED from contracts/results.schema.json by scripts/gen-types.mjs.\n * Do not edit. Change the schema and run `npm run gen:types`.\n */",
  additionalProperties: false,
  strictIndexSignatures: true,
  style: { singleQuote: false, semi: true },
});

for (const outPath of outPaths) {
  mkdirSync(dirname(outPath), { recursive: true });
  const previous = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
  if (previous !== ts) {
    writeFileSync(outPath, ts);
    console.log(`gen-types: wrote ${outPath}`);
  } else {
    console.log(`gen-types: up to date ${outPath}`);
  }
}
