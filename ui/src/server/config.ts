import { join, resolve } from "node:path";

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

// `next dev` / `next start` run from ui/, one level under the repo root.
export const repoRoot = resolve(env("LIFEFI_REPO_ROOT", resolve(process.cwd(), "..")));

export const config = {
  engineHost: env("LIFEFI_ENGINE_HOST", "127.0.0.1"),
  enginePort: Number(env("LIFEFI_ENGINE_PORT", "6000")),
  /** Shared PIN for dashboard writes (plan-v2 §7.4). Dev default; change it in settings. */
  pin: env("LIFEFI_PIN", "1234"),
  dataDir: resolve(env("LIFEFI_DATA_DIR", join(repoRoot, "data"))),
  /** SQLite file for history and alerts; ":memory:" keeps nothing. */
  dbPath: env("LIFEFI_DB", join(env("LIFEFI_DATA_DIR", join(repoRoot, "data")), "lifefi.sqlite")),
  profilesPath: resolve(env("LIFEFI_PROFILES", join(repoRoot, "contracts", "profiles.yml"))),
  version: "0.1.0",
} as const;
