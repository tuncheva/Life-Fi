// Starts the real Python engine (engine/run.py) with the repo's .venv.
//
//   node scripts/engine.mjs                 # the board over USB, port found by itself
//   node scripts/engine.mjs --serial COM3   # any engine/run.py arguments are passed through
//
// Used by `npm run dev`.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [join(root, ".venv", "Scripts", "python.exe"), join(root, ".venv", "bin", "python")];
const python = candidates.find((p) => existsSync(p)) ?? (process.platform === "win32" ? "python" : "python3");
if (!candidates.includes(python)) console.warn(`engine: no .venv found, using "${python}" (pip install -r engine/requirements.txt)`);

const args = process.argv.slice(2);
const child = spawn(python, ["-u", join(root, "engine", "run.py"), ...args], { stdio: "inherit", cwd: root });
const stop = () => child.kill("SIGINT");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
