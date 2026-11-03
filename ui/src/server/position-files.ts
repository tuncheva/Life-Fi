// The engine's saved distance fit (position.json) and spot model (spots_model.json), for
// GET /api/v1/position. Read on each request: the engine rewrites them. Never the weights.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";

export interface PositionFit {
  A: number;
  n: number;
  d_m: number;
  /** ms since epoch */
  at: number | null;
}

export interface SpotsSummary {
  labels: string[];
  distances: Record<string, number | null>;
  /** leave-one-session-out balanced accuracy (train_spots.py), null when the model has none. Never the same-session holdout number. */
  loso_bal_acc: number | null;
  session: string | null;
  /** ms since epoch */
  trained_at: number | null;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Seconds since epoch (a number) or a local ISO time (a string, as spots.py writes it) → ms. */
function toMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v * 1000);
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

export function readPositionFiles(dir = config.dataDir): { fit: PositionFit | null; spots: SpotsSummary | null } {
  const f = readJson(join(dir, "position.json"));
  const A = num(f?.A);
  const n = num(f?.n);
  const fit = f && A !== null && n !== null ? { A, n, d_m: num(f.d_m) ?? 0, at: toMs(f.at) } : null;

  const s = readJson(join(dir, "spots_model.json"));
  let spots: SpotsSummary | null = null;
  if (s && Array.isArray(s.labels)) {
    const labels = s.labels.filter((x): x is string => typeof x === "string");
    const d = (s.distances && typeof s.distances === "object" ? s.distances : {}) as Record<string, unknown>;
    spots = {
      labels,
      distances: Object.fromEntries(labels.map((l) => [l, num(d[l])])),
      loso_bal_acc: num(s.loso_bal_acc),
      session: typeof s.session === "string" ? s.session : null,
      trained_at: toMs(s.trained_at),
    };
  }
  return { fit, spots };
}
