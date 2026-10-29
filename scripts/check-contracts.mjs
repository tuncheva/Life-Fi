// Validates every fixture in contracts/fixtures against contracts/results.schema.json.
// Run: npm run check:contracts
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(join(root, "contracts", "results.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

const dir = join(root, "contracts", "fixtures");
let failed = 0;
for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const data = JSON.parse(readFileSync(join(dir, name), "utf8"));
  const badRow = (data.csi ?? []).findIndex((row) => row.length !== 52);
  if (validate(data) && badRow < 0) {
    console.log(`ok    ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}`);
    if (badRow >= 0) console.log(`      /csi/${badRow} must have 52 values`);
    for (const e of validate.errors ?? []) console.log(`      ${e.instancePath || "/"} ${e.message}`);
  }
}
if (failed) {
  console.error(`${failed} fixture(s) failed`);
  process.exit(1);
}
