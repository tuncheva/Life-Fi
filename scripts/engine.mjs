// Starts the real Python engine (engine/run.py) with the repo's .venv.
//
//   node scripts/engine.mjs                 # the board over USB, port found by itself
//   node scripts/engine.mjs --serial COM3   # any engine/run.py arguments are passed through
//   node scripts/engine.mjs --demo          # replay the synthetic fall recording, looped
//
// --demo makes data/demo/fall.csirec with engine/tools/fakesensor.py when it
// is missing (data/ is not in git), replays it in a loop and starts the
// 2-minute empty-room calibration by itself, so the dashboard shows the whole
// story (empty room, someone walks in, falls, lies still) without the board.
// Used by `npm run dev:real` and `npm run dev:replay`.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [join(root, ".venv", "Scripts", "python.exe"), join(root, ".venv", "bin", "python")];
const python = candidates.find((p) => existsSync(p)) ?? (process.platform === "win32" ? "python" : "python3");
if (!candidates.includes(python)) console.warn(`engine: no .venv found, using "${python}" (pip install -r engine/requirements.txt)`);

let args = process.argv.slice(2);
if (args.includes("--demo")) {
  const demo = join(root, "data", "demo", "fall.csirec");
  if (!existsSync(demo)) {
    console.log(`engine: making the demo recording ${demo}`);
    const made = spawnSync(python, [join(root, "engine", "tools", "fakesensor.py"), "fall", demo], { stdio: "inherit" });
    if (made.status !== 0) process.exit(made.status ?? 1);
  }
  args = [...args.filter((a) => a !== "--demo"), "--replay", demo, "--loop", "--calibrate-at-start"];
}

const child = spawn(python, ["-u", join(root, "engine", "run.py"), ...args], { stdio: "inherit", cwd: root });
const stop = () => child.kill("SIGINT");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
