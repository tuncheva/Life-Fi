// Production start (docs/ops/README.md): the engine and the built dashboard, supervised.
//
//   npm run build                                   # once, and after every update
//   npm run start                                   # the board over USB
//   npm run start -- --replay firmware/recordings/second.csirec --loop
//
// Arguments are passed to engine/run.py. Env: LIFEFI_HOST (default 127.0.0.1, set 0.0.0.0
// for phones on the LAN), LIFEFI_PORT (3000), and every LIFEFI_* the backend reads.
// Checks the setup first, restarts a crashed engine or app with backoff (1 s .. 30 s),
// prefixes their output with [engine] / [app] and copies it to <data>/logs/lifefi-<date>.log
// (at most 50 MB a day; logs older than 14 days are deleted at start and at midnight).
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { findPython, root } from "./python.mjs";

const env = (name, fallback) => (process.env[name] ? process.env[name] : fallback);
const host = env("LIFEFI_HOST", "127.0.0.1");
const port = Number(env("LIFEFI_PORT", "3000"));
const enginePort = Number(env("LIFEFI_ENGINE_PORT", "6000"));
const dataDir = resolve(root, env("LIFEFI_DATA_DIR", "data"));
const logDir = join(dataDir, "logs");
const userArgs = process.argv.slice(2);
const has = (flag) => userArgs.some((a) => a === flag || a.startsWith(`${flag}=`));
// The engine must listen where the backend dials (LIFEFI_ENGINE_PORT) and keep calibration.json,
// position.json and spots_model.json (siblings of --calibration) in the app's data dir.
// Arguments the user passes win.
const engineArgs = [
  ...(has("--port") ? [] : ["--port", String(enginePort)]),
  ...(has("--calibration") ? [] : ["--calibration", join(dataDir, "calibration.json")]),
  ...userArgs,
];
const win = process.platform === "win32";

function die(what, fix, code = 1) {
  console.error(`start: ${what} — ${fix}`);
  process.exit(code);
}

// ---- preflight: nothing is spawned until all of this passes ---------------------------
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) die(`Node ${process.versions.node} is too old`, "install Node 22.13 or newer");
if (!existsSync(join(root, "ui", ".next", "BUILD_ID"))) die("the dashboard is not built", "run `npm run build` first");
const { python } = findPython();
const deps = spawnSync(python, ["-c", "import numpy, scipy, yaml, serial"], { cwd: root, encoding: "utf8", windowsHide: true });
if (deps.error) die(`cannot run Python ("${python}")`, "create .venv: python -m venv .venv, then pip install -r engine/requirements.txt");
if (deps.status !== 0) die(`Python packages missing (${python})`, "pip install -r engine/requirements.txt");
if (!Number.isInteger(port) || port < 1 || port > 65535) die(`LIFEFI_PORT must be a port number (got "${process.env.LIFEFI_PORT}")`, "unset it or set 1-65535");

/** Resolves true when host:port can be bound now. */
function portFree(p, h) {
  return new Promise((ok) => {
    const s = createServer();
    s.once("error", () => ok(false));
    s.listen({ port: p, host: h, exclusive: true }, () => s.close(() => ok(true)));
  });
}
if (!(await portFree(port, host))) die(`port ${port} on ${host} is in use`, "stop what uses it (Get-NetTCPConnection -LocalPort " + port + ") or set LIFEFI_PORT");
if (!Number.isInteger(enginePort) || enginePort < 1 || enginePort > 65535)
  die(`LIFEFI_ENGINE_PORT must be a port number (got "${process.env.LIFEFI_ENGINE_PORT}")`, "unset it or set 1-65535");
if (!(await portFree(enginePort, "127.0.0.1")))
  die(`engine port ${enginePort} is in use (an engine still running?)`, `stop it: Get-NetTCPConnection -LocalPort ${enginePort} | % OwningProcess`);
try {
  mkdirSync(logDir, { recursive: true });
  const probe = join(dataDir, `.write-test-${process.pid}`);
  writeFileSync(probe, "");
  unlinkSync(probe);
} catch (err) {
  die(`data dir ${dataDir} is not writable (${err.code ?? err.message})`, "fix its permissions or set LIFEFI_DATA_DIR");
}

// ---- log file ------------------------------------------------------------------------
const day = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const LOG_KEEP_MS = 14 * 86400_000;
const LOG_MAX_BYTES = 50 * 1024 * 1024; // per day; the rest of the day goes to the console only
/** Deletes lifefi-*.log older than 14 days in logDir (never anything else). Today's file is never that old. */
function prune() {
  let names = [];
  try {
    names = readdirSync(logDir);
  } catch {
    return;
  }
  for (const f of names) {
    if (!/^lifefi-.*\.log$/.test(f)) continue;
    const p = join(logDir, f);
    try {
      if (Date.now() - statSync(p).mtimeMs > LOG_KEEP_MS) unlinkSync(p);
    } catch {
      // gone already or locked: try again tomorrow
    }
  }
}
/** Size of today's log so far (0 when it does not exist yet). */
function sizeOf(d) {
  try {
    return statSync(join(logDir, `lifefi-${d}.log`)).size;
  } catch {
    return 0;
  }
}
prune();
let logBroken = false;
let logDay = day();
let logBytes = sizeOf(logDay);
let logCapped = false;
/** Prints one line and appends it to today's log (a new file after local midnight, when old logs are pruned too). */
function out(line, err = false) {
  (err ? console.error : console.log)(line);
  if (logBroken) return;
  const today = day();
  if (today !== logDay) {
    logDay = today;
    logBytes = sizeOf(today);
    logCapped = false;
    prune();
  }
  if (logCapped) return;
  let text = `${new Date().toTimeString().slice(0, 8)} ${line}\n`;
  if (logBytes + Buffer.byteLength(text) > LOG_MAX_BYTES) {
    logCapped = true;
    text = `${new Date().toTimeString().slice(0, 8)} [start] log cap (50 MB) reached: the rest of today goes to the console only\n`;
  }
  try {
    appendFileSync(join(logDir, `lifefi-${today}.log`), text);
    logBytes += Buffer.byteLength(text);
  } catch (e) {
    logBroken = true;
    console.error(`[start] cannot write the log file: ${e.message}`);
  }
}
const say = (msg) => out(`[start] ${msg}`);

// ---- children --------------------------------------------------------------------------
const BACKOFF_S = [1, 2, 4, 8, 16, 30];
// exit codes that mean "Ctrl+C reached the child": 130 (SIGINT), STATUS_CONTROL_C_EXIT. A clean
// exit 0 is not one of them: run.py and next also return 0 when they stop on their own, and that
// is restarted. On a real Ctrl+C our own SIGINT handler sets `stopping` (and clears a pending
// restart), so a child that exits 0 a moment earlier is not brought back.
const STOPPED = new Set([130, 3221225786, -1073741510]);
let stopping = false;
let exitCode = 0;

const nextBin = createRequire(join(root, "ui", "package.json")).resolve("next/dist/bin/next");
const children = {
  engine: { cmd: python, args: ["-u", join(root, "engine", "run.py"), ...engineArgs], cwd: root, env: process.env },
  app: { cmd: process.execPath, args: [nextBin, "start", "-p", String(port), "-H", host], cwd: join(root, "ui"), env: { ...process.env, LIFEFI_HOST: host, LIFEFI_DATA_DIR: dataDir } },
};
const running = { engine: null, app: null };
const timers = { engine: null, app: null };
const failures = { engine: 0, app: 0 };

function launch(name) {
  timers[name] = null;
  if (stopping) return;
  const c = children[name];
  // no windowsHide: it would detach the child from this console, and Ctrl+C must reach it
  const child = spawn(c.cmd, c.args, { cwd: c.cwd, env: c.env, stdio: ["ignore", "pipe", "pipe"] });
  const startedAt = Date.now();
  running[name] = child;
  createInterface({ input: child.stdout }).on("line", (l) => out(`[${name}] ${l}`));
  createInterface({ input: child.stderr }).on("line", (l) => out(`[${name}] ${l}`, true));
  child.on("error", (err) => say(`${name} could not start: ${err.message}`));
  child.on("exit", (code, signal) => {
    running[name] = null;
    const how = code !== null ? `code ${code}` : `signal ${signal}`;
    if (stopping) return finish();
    if (name === "engine" && code === 2) {
      say("engine refused its arguments or config (exit 2); not restarting");
      exitCode = 2;
      return shutdown("engine exit 2");
    }
    if ((code !== null && STOPPED.has(code)) || signal === "SIGINT" || signal === "SIGTERM") {
      say(`${name} stopped (${how}); shutting down`);
      // a console Ctrl+C reached the sibling too; a signal from elsewhere did not, so stop it now
      return shutdown(`${name} stopped`, code !== null && STOPPED.has(code));
    }
    if (Date.now() - startedAt > 60_000) failures[name] = 0;
    const delay = BACKOFF_S[Math.min(failures[name], BACKOFF_S.length - 1)];
    failures[name]++;
    say(`${name} exited (${how}), restarting in ${delay} s`);
    timers[name] = setTimeout(() => launch(name), delay * 1000);
  });
}

function forceKill(child) {
  if (win) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGKILL");
}

let forceTimer = null;
function shutdown(why, consoleCtrl = false) {
  if (stopping) return;
  stopping = true;
  say(`stopping (${why})`);
  for (const t of Object.values(timers)) if (t) clearTimeout(t);
  const alive = Object.values(running).filter(Boolean);
  for (const child of alive) {
    // On Windows a console Ctrl+C has already reached the children; anything else cannot be
    // delivered gently there, so it is a hard stop of the whole tree.
    if (!win) child.kill("SIGINT");
    else if (!consoleCtrl) forceKill(child);
  }
  forceTimer = setTimeout(() => {
    for (const child of Object.values(running)) if (child) forceKill(child);
  }, 10_000);
  forceTimer.unref();
  finish();
}

function finish() {
  if (!stopping || Object.values(running).some(Boolean)) return;
  if (forceTimer) clearTimeout(forceTimer);
  say("stopped");
  process.exit(exitCode);
}

process.on("SIGINT", () => shutdown("Ctrl+C", true));
process.on("SIGTERM", () => shutdown("SIGTERM"));
if (win) process.on("SIGBREAK", () => shutdown("Ctrl+Break", true));

say(`dashboard on http://${host === "0.0.0.0" ? "localhost" : host}:${port}${host === "0.0.0.0" ? " (and the LAN)" : " (this PC only; LIFEFI_HOST=0.0.0.0 opens it to the LAN)"}, logs in ${logDir}`);
launch("engine");
launch("app");
