// Runs a repo Python script (ml/train_spots.py for /teach). The same lookup as
// scripts/python.mjs (ESM outside ui/, so not imported): the repo's .venv first, else
// python / python3 on PATH. No shell; the whole process tree is killed on timeout.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./config";

/** Only the end of a long output is kept (the METRICS line and the error are last). */
const KEEP = 64 * 1024;

export function findPython(root = repoRoot): string {
  const venv = [join(root, ".venv", "Scripts", "python.exe"), join(root, ".venv", "bin", "python")].find((p) => existsSync(p));
  return venv ?? (process.platform === "win32" ? "python" : "python3");
}

export interface PyResult {
  /** Exit code, null when killed or it could not start. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

type SpawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcess;

export interface PyOptions {
  timeoutMs?: number;
  root?: string;
  python?: string;
  spawnFn?: SpawnFn;
  /** Kills the process tree (tests inject it). */
  killFn?: (child: ChildProcess) => void;
}

export function killTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  else child.kill("SIGKILL");
}

export function runPython(args: string[], opt: PyOptions = {}): Promise<PyResult> {
  const root = opt.root ?? repoRoot;
  const child = (opt.spawnFn ?? (spawn as unknown as SpawnFn))(opt.python ?? findPython(root), args, {
    cwd: root,
    windowsHide: true,
    shell: false,
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
  });
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let finished = false;
    child.stdout?.on("data", (d: Buffer | string) => (stdout = (stdout + d).slice(-KEEP)));
    child.stderr?.on("data", (d: Buffer | string) => (stderr = (stderr + d).slice(-KEEP)));
    const timer = setTimeout(() => {
      timedOut = true;
      (opt.killFn ?? killTree)(child);
    }, opt.timeoutMs ?? 180_000);
    const finish = (code: number | null, err?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done({ code: timedOut ? null : code, stdout, stderr: err ? `${stderr}${err.message}\n` : stderr, timedOut });
    };
    child.on("error", (err) => finish(null, err));
    child.on("close", (code: number | null) => finish(code));
  });
}
