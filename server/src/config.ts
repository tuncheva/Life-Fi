import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// src/ in dev (tsx) and dist/ after build are both one level under server/.
export const serverRoot = resolve(here, "..");
export const repoRoot = resolve(serverRoot, "..");

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export const config = {
  port: Number(env("LIFEFI_PORT", "8080")),
  host: env("LIFEFI_HOST", "0.0.0.0"),
  engineHost: env("LIFEFI_ENGINE_HOST", "127.0.0.1"),
  enginePort: Number(env("LIFEFI_ENGINE_PORT", "6000")),
  /** Shared PIN for dashboard writes (plan-v2 §7.4). Dev default; change it in settings. */
  pin: env("LIFEFI_PIN", "1234"),
  dataDir: resolve(env("LIFEFI_DATA_DIR", join(repoRoot, "data"))),
  profilesPath: resolve(env("LIFEFI_PROFILES", join(repoRoot, "contracts", "profiles.yml"))),
  uiDir: resolve(env("LIFEFI_UI_DIR", join(repoRoot, "ui", "out"))),
  /** Allow CORS from the Next.js dev server. */
  devCors: env("NODE_ENV", "development") !== "production",
  version: "0.1.0",
} as const;
