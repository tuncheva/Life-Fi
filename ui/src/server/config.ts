import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** The PIN until someone changes it in settings; /api/v1/setup flags it. */
export const DEFAULT_PIN = "1234";

const LOG_LEVELS = ["debug", "info", "warn", "error"];
const LOOPBACK = ["127.0.0.1", "::1", "localhost"];

export interface Config {
  engineHost: string;
  enginePort: number;
  /** Shared PIN for dashboard writes (plan-v2 §7.4). Dev default; change it in settings. */
  pin: string;
  dataDir: string;
  /** SQLite file for history and alerts; ":memory:" keeps nothing. */
  dbPath: string;
  profilesPath: string;
  /** Where the dashboard listens (LIFEFI_HOST, set by scripts/start.mjs; `next dev` binds every interface). */
  bindHost: string;
  version: string;
  /** Bad env values, one line each; each has been replaced by its default. runtime.start() refuses to run with any. */
  problems: string[];
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`life-fi: invalid configuration\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

export const isLoopback = (host: string) => LOOPBACK.includes(host);

/** Reads LIFEFI_* from `env`. Never throws: a bad value falls back to its default and is listed in `problems`. */
export function loadConfig(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): Config & { repoRoot: string } {
  const get = (name: string, fallback: string) => {
    const v = env[name];
    return v === undefined || v === "" ? fallback : v;
  };
  const problems: string[] = [];
  // `next dev` / `next start` run from ui/, one level under the repo root.
  const repoRoot = resolve(get("LIFEFI_REPO_ROOT", resolve(cwd, "..")));

  let enginePort = 6000;
  const rawPort = get("LIFEFI_ENGINE_PORT", "6000");
  if (/^\d+$/.test(rawPort) && Number(rawPort) >= 1 && Number(rawPort) <= 65535) enginePort = Number(rawPort);
  else problems.push(`LIFEFI_ENGINE_PORT must be an integer 1-65535 (got "${rawPort}")`);

  let pin = get("LIFEFI_PIN", DEFAULT_PIN);
  if (!/^\d{4,8}$/.test(pin)) {
    problems.push("LIFEFI_PIN must be 4 to 8 digits");
    pin = DEFAULT_PIN;
  }

  const level = env.LIFEFI_LOG;
  if (level !== undefined && level !== "" && !LOG_LEVELS.includes(level)) problems.push(`LIFEFI_LOG must be one of ${LOG_LEVELS.join(", ")} (got "${level}")`);

  const dataDir = resolve(repoRoot, get("LIFEFI_DATA_DIR", "data"));
  const profilesPath = resolve(repoRoot, get("LIFEFI_PROFILES", join("contracts", "profiles.yml")));
  if (!existsSync(profilesPath)) problems.push(`LIFEFI_PROFILES: file not found: ${profilesPath}`);

  return {
    repoRoot,
    engineHost: get("LIFEFI_ENGINE_HOST", "127.0.0.1"),
    enginePort,
    pin,
    dataDir,
    dbPath: get("LIFEFI_DB", join(dataDir, "lifefi.sqlite")),
    profilesPath,
    bindHost: get("LIFEFI_HOST", "0.0.0.0"),
    version: "0.1.0",
    problems,
  };
}

const loaded = loadConfig();
export const repoRoot = loaded.repoRoot;
export const config: Config = loaded;
