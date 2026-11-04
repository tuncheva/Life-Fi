// Every test in the repo, one command (also what CI runs):
//
//   node scripts/test-all.mjs                   # contracts, engine + ml scripts, ui (vitest)
//   node scripts/test-all.mjs --only engine     # one part: contracts | engine | ui
//   node scripts/test-all.mjs --full            # adds ui lint, build and typecheck
//
// Engine tests are plain scripts (no pytest): every engine/tests/test_*.py and
// ml/tests/test_*.py runs as its own process; one that prints "SKIPPED" (a dataset that
// is not here) counts as a skip; each has 10 min (test_engine.py alone takes minutes). Runs everything even after a failure; exit 1 if any failed.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { findPython, root } from "./python.mjs";

const argv = process.argv.slice(2);
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
const full = argv.includes("--full");
if (only && !["contracts", "engine", "ui"].includes(only)) {
  console.error("test-all: --only must be contracts, engine or ui");
  process.exit(2);
}
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const results = [];

/** Runs one command; resolves { status: PASS|FAIL|SKIP, s }. Output is shown live unless `quiet`. */
function run(name, cmd, args, { quiet = false, timeoutS = 0 } = {}) {
  return new Promise((done) => {
    const t0 = Date.now();
    // npm.cmd needs a shell on Windows (Node refuses to spawn .cmd files without one)
    const child = spawn(cmd, args, { cwd: root, shell: cmd === npm && process.platform === "win32", stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit" });
    let output = "";
    if (quiet) {
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));
    }
    let timedOut = false;
    const timer = timeoutS ? setTimeout(() => ((timedOut = true), child.kill()), timeoutS * 1000) : null;
    const finish = (code, err) => {
      if (timer) clearTimeout(timer);
      const s = (Date.now() - t0) / 1000;
      const status = code === 0 ? (/SKIPPED/.test(output) ? "SKIP" : "PASS") : "FAIL";
      if (quiet && status === "FAIL") process.stdout.write(output + (timedOut ? `\n(timed out after ${timeoutS} s)\n` : "") + (err ? `\n${err.message}\n` : ""));
      results.push({ name, status, s });
      console.log(`${status} ${name} (${s.toFixed(1)} s)`);
      done();
    };
    child.on("error", (err) => finish(1, err));
    child.on("exit", (code) => finish(code ?? 1));
  });
}

if (!only || only === "contracts") await run("contracts", process.execPath, [join(root, "scripts", "check-contracts.mjs")]);

if (!only || only === "engine") {
  const { python } = findPython();
  for (const dir of ["engine/tests", "ml/tests"]) {
    if (!existsSync(join(root, dir))) continue;
    const files = readdirSync(join(root, dir)).filter((f) => /^test_.*\.py$/.test(f)).sort();
    for (const f of files) await run(`${dir}/${f}`, python, ["-u", join(root, dir, f)], { quiet: true, timeoutS: 600 });
  }
}

if (!only || only === "ui") {
  await run("ui vitest", npm, ["run", "test", "-w", "ui"]);
  if (full) {
    await run("ui lint", npm, ["run", "lint", "-w", "ui"]);
    await run("ui build", npm, ["run", "build", "-w", "ui"]); // before typecheck: it writes .next/types
    await run("ui typecheck", npm, ["run", "typecheck", "-w", "ui"]);
  }
}

const count = (st) => results.filter((r) => r.status === st).length;
console.log(`\n${"-".repeat(60)}`);
for (const r of results) console.log(`${r.status.padEnd(5)} ${r.name.padEnd(44)} ${r.s.toFixed(1).padStart(6)} s`);
console.log(`${"-".repeat(60)}\n${count("PASS")} passed, ${count("SKIP")} skipped, ${count("FAIL")} failed`);
process.exit(count("FAIL") ? 1 : 0);
