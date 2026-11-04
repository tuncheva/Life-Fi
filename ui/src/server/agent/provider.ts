// LLM provider choice for the caregiver agent (track FB). Anthropic by default, Gemini as the
// option; keys and models only from env (ui/.env, see ui/.env.example).

export const PROVIDERS = ["anthropic", "gemini"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

/** A read-only tool the model may call. `parameters` is a JSON Schema object. */
export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(input: Record<string, unknown>): Promise<unknown>;
}

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

export interface ToolCallLog {
  name: string;
  input: Record<string, unknown>;
  ok: boolean;
}

export interface RunInput {
  system: string;
  turns: Turn[];
  tools: AgentTool[];
  maxSteps: number;
  signal: AbortSignal;
}

export interface RunOutput {
  text: string;
  toolCalls: ToolCallLog[];
  /** The model that actually answered (a fallback may differ from the configured one). */
  model: string;
}

/** Each provider runs its own tool loop, so its native history (thinking blocks, ids) is sent back exactly as received. */
export interface LlmProvider {
  readonly name: ProviderName;
  readonly model: string;
  run(input: RunInput): Promise<RunOutput>;
}

export interface LlmEnv {
  provider: ProviderName;
  apiKey: string | null;
  model: string;
}

export const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-opus-5-5",
  gemini: "gemini-3.5-flash-lite",
};

/** Problems in the LLM_* env, for config.problems. An empty key is not a problem (the agent is just off). */
export function llmProblems(env: Record<string, string | undefined>): string[] {
  const p = env.LLM_PROVIDER;
  return p && !(PROVIDERS as readonly string[]).includes(p) ? [`LLM_PROVIDER must be one of ${PROVIDERS.join(", ")} (got "${p}")`] : [];
}

export function llmEnv(env: Record<string, string | undefined> = process.env): LlmEnv {
  const provider = ((PROVIDERS as readonly string[]).includes(env.LLM_PROVIDER ?? "") ? env.LLM_PROVIDER : "anthropic") as ProviderName;
  const key = provider === "anthropic" ? env.ANTHROPIC_API_KEY : env.GEMINI_API_KEY;
  const model = (provider === "anthropic" ? env.ANTHROPIC_MODEL : env.GEMINI_MODEL)?.trim() || DEFAULT_MODELS[provider];
  return { provider, apiKey: key?.trim() || null, model };
}

/** Null when the chosen provider has no key. Imported lazily so a missing SDK never breaks the server. */
export async function createProvider(e: LlmEnv = llmEnv()): Promise<LlmProvider | null> {
  if (!e.apiKey) return null;
  if (e.provider === "gemini") {
    const { GeminiProvider } = await import("./gemini");
    return new GeminiProvider(e.apiKey, e.model);
  }
  const { AnthropicProvider } = await import("./anthropic");
  return new AnthropicProvider(e.apiKey, e.model);
}

/** Runs a tool, returning the JSON the model sees and whether it worked. */
export async function runTool(tools: AgentTool[], name: string, input: Record<string, unknown>): Promise<{ content: string; ok: boolean }> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { content: JSON.stringify({ error: `unknown tool '${name}'` }), ok: false };
  try {
    return { content: JSON.stringify(await tool.run(input ?? {})), ok: true };
  } catch (err) {
    return { content: JSON.stringify({ error: (err as Error)?.message ?? String(err) }), ok: false };
  }
}
