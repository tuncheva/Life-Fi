// The Python that runs the engine: the repo's .venv first, else python / python3 on PATH.
// Shared by engine.mjs (npm run dev), start.mjs (npm run start) and test-all.mjs.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const candidates = [join(root, ".venv", "Scripts", "python.exe"), join(root, ".venv", "bin", "python")];

/** { python, venv }: venv is false when it falls back to the PATH python. */
export function findPython() {
  const venv = candidates.find((p) => existsSync(p));
  return { python: venv ?? (process.platform === "win32" ? "python" : "python3"), venv: !!venv };
}
