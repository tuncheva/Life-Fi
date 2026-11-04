// Anthropic Messages API with a manual tool loop. Default model claude-opus-5-5 at low effort
// (short caregiver answers); server-side refusal fallback on, so a declined request is re-run.
import Anthropic from "@anthropic-ai/sdk";
import { runTool, type LlmProvider, type RunInput, type RunOutput, type ToolCallLog } from "./provider";

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic" as const;
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 1 });
  }

  async run({ system, turns, tools, maxSteps, signal }: RunInput): Promise<RunOutput> {
    const messages: Anthropic.Beta.BetaMessageParam[] = turns.map((t) => ({ role: t.role, content: t.text }));
    const defs: Anthropic.Beta.BetaTool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Beta.BetaTool["input_schema"],
    }));
    const toolCalls: ToolCallLog[] = [];
    let model = this.model;
    for (let step = 0; step < maxSteps; step++) {
      const res = await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: 4000,
          system,
          messages,
          tools: defs,
          output_config: { effort: "low" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal },
      );
      model = res.model;
      if (res.stop_reason === "refusal") return { text: "The assistant declined this request.", toolCalls, model };
      // the full content (thinking blocks included) goes back unchanged
      messages.push({ role: "assistant", content: res.content });
      const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (res.stop_reason !== "tool_use" || !uses.length) {
        const text = res.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        return { text, toolCalls, model };
      }
      // every result of one turn in a single user message
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const u of uses) {
        const input = (u.input ?? {}) as Record<string, unknown>;
        const r = await runTool(tools, u.name, input);
        toolCalls.push({ name: u.name, input, ok: r.ok });
        results.push({ type: "tool_result", tool_use_id: u.id, content: r.content, ...(r.ok ? {} : { is_error: true }) });
      }
      messages.push({ role: "user", content: results });
    }
    return { text: "The assistant needed too many steps; try a narrower question.", toolCalls, model };
  }
}
