// /teach client side: the shapes of GET /api/v1/spots (contracts/api.md, Spots) and the pure
// helpers the page uses for its countdown and its honest model verdict.

export interface Step {
  id: number;
  kind: "lead" | "empty" | "walk" | "hold" | "end";
  name: string | null;
  d_m: number | null;
  t0_ms: number;
  t1_ms: number;
  say: string;
}

export interface RunState {
  session: string;
  state: "running" | "done" | "aborted";
  reason: string | null;
  server_now_ms: number;
  transmitter: "fixed" | "phone";
  rounds: 1 | 2;
  steps: Step[];
  index: number;
  started_ms: number;
  ends_ms: number;
  frames: number | null;
}

export interface ModelSummary {
  labels: string[];
  distances: Record<string, number | null>;
  loso_bal_acc: number | null;
  loso_by_session: number[] | null;
  holdout_accuracy: number | null;
  session: string | null;
  trained_at: number | null;
  chance: number;
  bar: number;
  reliable: boolean;
  sessions: string[];
}

export interface SessionInfo {
  id: string;
  started_ms: number | null;
  transmitter: "fixed" | "phone" | "unknown";
  protocol: string | null;
  labels: string[];
  distances: Record<string, number>;
  duration_s: number | null;
  frames: number | null;
  rate_hz: number | null;
  ok: boolean;
  problem: string | null;
}

export interface TrainingState {
  state: "running" | "done" | "failed";
  sessions: string[];
  started_ms: number;
  ended_ms: number | null;
  result: { metrics: { sessions: string[]; loso_by_session: number[] | null }; promoted: boolean; reason: string; engine_reloaded: boolean; candidate: ModelSummary | null; model: ModelSummary | null } | null;
  error: string | null;
}

export interface SpotsOverview {
  margin: number;
  model: ModelSummary | null;
  previous: ModelSummary | null;
  candidate: ModelSummary | null;
  sessions: SessionInfo[];
  readiness: { id: string; ok: boolean; label: string }[];
  teach: RunState | null;
  training: TrainingState | null;
  spot_names: string[];
  timing: { lead_s: number; empty_s: number; hold_s: number; walk_s: number; enter_s: number };
}

/** The step running at `serverNow` (the last one that has started). */
export function currentStep(steps: Step[], serverNow: number): Step | null {
  let cur: Step | null = null;
  for (const s of steps) if (s.t0_ms <= serverNow) cur = s;
  return cur;
}

/** Whole seconds left in `step` at `serverNow`, never negative. */
export function secondsLeft(step: Step, serverNow: number): number {
  return Math.max(0, Math.ceil((step.t1_ms - serverNow) / 1000));
}

/** Session length in seconds, as the server builds it (teach.ts buildSchedule). */
export function totalSeconds(t: SpotsOverview["timing"], spots: number, rounds: number): number {
  const holds = spots * rounds;
  return t.lead_s + 2 * t.empty_s + 2 * t.enter_s + holds * t.hold_s + (holds - 1) * t.walk_s;
}

/** Floored, never rounded up (docs/plan/ui-ux.md §2). */
export const pct = (v: number) => `${Math.floor(v * 100 + 1e-9)} %`;

export type Verdict = { tone: "ok" | "warn" | "danger" | "neutral"; title: string; text: string; transmitterLink: boolean };

/** What a cross-session score means, in plain words; always with chance next to it. */
export function verdict(m: Pick<ModelSummary, "loso_bal_acc" | "chance" | "bar">): Verdict {
  if (m.loso_bal_acc === null)
    return { tone: "neutral", title: "Not measured", text: "This model was trained on one session or by an older script, so nobody knows how it does on another visit. It is never shown as reliable.", transmitterLink: false };
  if (m.loso_bal_acc <= m.chance + 0.05)
    return { tone: "danger", title: "Not better than chance", text: "The model cannot tell these spots apart from another visit. Spots need a fixed transmitter.", transmitterLink: true };
  if (m.loso_bal_acc < m.bar)
    return { tone: "warn", title: "Better than chance but not reliable yet", text: "The dashboard will not show spot names. Record another session.", transmitterLink: false };
  return { tone: "ok", title: "Reliable", text: "The dashboard names the spot when it is confident.", transmitterLink: false };
}
