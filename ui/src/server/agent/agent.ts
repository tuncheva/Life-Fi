// The caregiver agent: day summary, "explain this alert", and Q&A chat over the stored events.
// One run in flight at a time; every run is stored as an `agent` event.
import type { AppContext } from "../context";
import { createProvider, llmEnv, type LlmProvider, type Turn } from "./provider";
import { agentTools, alertView } from "./tools";

export type AgentMode = "summary" | "explain" | "chat";

export interface AgentReply {
  text: string;
  provider: string;
  model: string;
  tool_calls: number;
}

export class AgentError extends Error {
  constructor(
    readonly code: "not_configured" | "busy" | "not_found" | "failed",
    message: string,
  ) {
    super(message);
  }
}

const SYSTEM = `You are the assistant inside Life-Fi, a Wi-Fi sensing system that watches over one person in a room without cameras. You talk to a caregiver or family member.
- Use the tools to look up data; never invent numbers, times or events. If data is missing, say so.
- Answer in plain language, short: 2-4 sentences unless the user asks for detail. All times in the data are already local to the room; quote them as clock times ("at 14:02").
- Readings are estimates from Wi-Fi signals, not medical measurements. Never diagnose or give medical advice; for anything worrying, suggest checking on the person or contacting a professional.
- Do not mention tool names or JSON.`;

const MAX_STEPS = 6;
const TIMEOUT_MS = 30_000;
const MAX_TURNS = 10;
const MAX_TEXT = 2000;

// on globalThis like the runtime: Next may bundle each route separately, and all must share
// one busy flag (one run at a time) and one client
const SHARED = Symbol.for("lifefi.agent");
const shared = ((globalThis as { [SHARED]?: { busy: boolean; cached: { key: string; provider: LlmProvider | null } | null } })[SHARED] ??= { busy: false, cached: null });

async function provider(): Promise<LlmProvider | null> {
  const e = llmEnv();
  const key = `${e.provider}|${e.model}|${e.apiKey ?? ""}`;
  if (shared.cached?.key !== key) shared.cached = { key, provider: await createProvider(e) };
  return shared.cached.provider;
}

/** Validates chat turns from the client: alternating-agnostic, last one from the user, capped. */
export function cleanTurns(raw: unknown): Turn[] | null {
  if (!Array.isArray(raw)) return null;
  const turns = raw
    .filter((t): t is { role: string; text: string } => !!t && typeof t === "object" && typeof (t as Turn).text === "string" && ((t as Turn).role === "user" || (t as Turn).role === "assistant"))
    .map((t) => ({ role: t.role as Turn["role"], text: t.text.trim().slice(0, MAX_TEXT) }))
    .filter((t) => t.text)
    .slice(-MAX_TURNS);
  while (turns.length && turns[0]!.role !== "user") turns.shift();
  return turns.length && turns[turns.length - 1]!.role === "user" ? turns : null;
}

export async function runAgent(ctx: AppContext, mode: AgentMode, opts: { hours?: number; alertId?: string; turns?: Turn[] }): Promise<AgentReply> {
  const p = await provider();
  if (!p) throw new AgentError("not_configured", `no API key for LLM_PROVIDER=${llmEnv().provider} (set it in ui/.env)`);
  let turns: Turn[];
  if (mode === "summary") {
    const hours = Math.min(Math.max(Number(opts.hours ?? 24) || 24, 1), 168);
    turns = [{ role: "user", text: `Summarize the last ${hours} hours for the caregiver: presence, rest and activity, breathing and heart readings, and any alerts and how they were handled.` }];
  } else if (mode === "explain") {
    const a = opts.alertId ? ctx.alerts.get(opts.alertId) : undefined;
    if (!a) throw new AgentError("not_found", `no alert '${opts.alertId ?? ""}'`);
    turns = [{ role: "user", text: `Explain this alert to the caregiver: what was detected, what the readings around that time looked like, and what to do now.\n${JSON.stringify(alertView(a, ctx.settings.value.zone))}` }];
  } else {
    if (!opts.turns?.length) throw new AgentError("failed", "no question");
    turns = opts.turns;
  }
  if (shared.busy) throw new AgentError("busy", "the assistant is still answering another request");
  shared.busy = true;
  const started = Date.now();
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const out = await p.run({ system: SYSTEM, turns, tools: agentTools(ctx), maxSteps: MAX_STEPS, signal });
    const reply: AgentReply = { text: out.text || "No answer.", provider: p.name, model: out.model, tool_calls: out.toolCalls.length };
    ctx.store.addEvent({
      t: started,
      kind: "agent",
      data: { mode, provider: p.name, model: out.model, question: turns[turns.length - 1]!.text, answer: reply.text, tools: out.toolCalls, ms: Date.now() - started, ok: true },
    });
    return reply;
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    ctx.log.warn({ mode, provider: p.name, error: message }, "agent run failed");
    ctx.store.addEvent({ t: started, kind: "agent", data: { mode, provider: p.name, model: p.model, ms: Date.now() - started, ok: false, error: message } });
    throw new AgentError("failed", signal.aborted ? "the assistant took too long" : "the assistant could not answer right now");
  } finally {
    shared.busy = false;
  }
}
