// Gemini API (@google/genai) with function calling and a manual loop (LLM_PROVIDER=gemini).
import { GoogleGenAI, type Content, type Part } from "@google/genai";
import { runTool, type LlmProvider, type RunInput, type RunOutput, type ToolCallLog } from "./provider";

export class GeminiProvider implements LlmProvider {
  readonly name = "gemini" as const;
  private readonly ai: GoogleGenAI;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async run({ system, turns, tools, maxSteps, signal }: RunInput): Promise<RunOutput> {
    const contents: Content[] = turns.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.text }] }));
    const functionDeclarations = tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters }));
    const toolCalls: ToolCallLog[] = [];
    for (let step = 0; step < maxSteps; step++) {
      const res = await this.ai.models.generateContent({
        model: this.model,
        contents,
        config: { systemInstruction: system, tools: [{ functionDeclarations }], abortSignal: signal },
      });
      const calls = res.functionCalls ?? [];
      if (!calls.length) return { text: (res.text ?? "").trim(), toolCalls, model: this.model };
      const said = res.candidates?.[0]?.content;
      if (said) contents.push(said);
      const parts: Part[] = [];
      for (const c of calls) {
        const name = c.name ?? "";
        const input = (c.args ?? {}) as Record<string, unknown>;
        const r = await runTool(tools, name, input);
        toolCalls.push({ name, input, ok: r.ok });
        parts.push({ functionResponse: { id: c.id, name, response: r.ok ? { result: JSON.parse(r.content) } : { error: JSON.parse(r.content) } } });
      }
      contents.push({ role: "user", parts });
    }
    return { text: "The assistant needed too many steps; try a narrower question.", toolCalls, model: this.model };
  }
}
