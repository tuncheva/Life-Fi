// Tool loops of both providers against mocked SDKs (track FB): the message shapes each API needs,
// tool errors as data, refusal, and the step cap. No network.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTool } from "../src/server/agent/provider";

const anthropicCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    beta = { messages: { create: anthropicCreate } };
  },
}));
const geminiGenerate = vi.fn();
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: geminiGenerate };
  },
}));

const { AnthropicProvider } = await import("../src/server/agent/anthropic");
const { GeminiProvider } = await import("../src/server/agent/gemini");

const tools: AgentTool[] = [
  { name: "get_alerts", description: "alerts", parameters: { type: "object", properties: {} }, run: async (i) => ({ alerts: [], hours: i.hours ?? 24 }) },
  { name: "broken", description: "fails", parameters: { type: "object", properties: {} }, run: async () => Promise.reject(new Error("store down")) },
];
const input = (maxSteps = 6) => ({ system: "sys", turns: [{ role: "user" as const, text: "any alerts?" }], tools, maxSteps, signal: new AbortController().signal });

beforeEach(() => {
  anthropicCreate.mockReset();
  geminiGenerate.mockReset();
});

describe("AnthropicProvider", () => {
  it("runs tools, sends results back in one user message, keeps thinking blocks, returns the text", async () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig" };
    anthropicCreate
      .mockResolvedValueOnce({
        model: "claude-opus-5-5",
        stop_reason: "tool_use",
        content: [thinking, { type: "tool_use", id: "tu1", name: "get_alerts", input: { hours: 6 } }, { type: "tool_use", id: "tu2", name: "broken", input: {} }],
      })
      .mockResolvedValueOnce({ model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "No alerts." }] });
    const out = await new AnthropicProvider("k", "claude-opus-5-5").run(input());
    expect(out).toEqual({
      text: "No alerts.",
      model: "claude-opus-5-5",
      toolCalls: [
        { name: "get_alerts", input: { hours: 6 }, ok: true },
        { name: "broken", input: {}, ok: false },
      ],
    });
    const first = anthropicCreate.mock.calls[0]![0];
    expect(first).toMatchObject({ model: "claude-opus-5-5", system: "sys", fallbacks: "default", betas: ["server-side-fallback-2026-07-01"], output_config: { effort: "low" } });
    expect(first.tools.map((t: { name: string }) => t.name)).toEqual(["get_alerts", "broken"]);
    const second = anthropicCreate.mock.calls[1]![0];
    // the mock keeps a reference: the final assistant turn was appended after this call
    expect(second.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(second.messages[1].content[0]).toBe(thinking);
    expect(second.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu1", content: '{"alerts":[],"hours":6}' },
        { type: "tool_result", tool_use_id: "tu2", content: '{"error":"store down"}', is_error: true },
      ],
    });
  });

  it("reports a refusal and the model that answered", async () => {
    anthropicCreate.mockResolvedValueOnce({ model: "claude-opus-5", stop_reason: "refusal", content: [] });
    expect(await new AnthropicProvider("k", "claude-opus-5-5").run(input())).toMatchObject({ text: "The assistant declined this request.", model: "claude-opus-5" });
  });

  it("stops after maxSteps", async () => {
    anthropicCreate.mockResolvedValue({ model: "m", stop_reason: "tool_use", content: [{ type: "tool_use", id: "x", name: "get_alerts", input: {} }] });
    const out = await new AnthropicProvider("k", "m").run(input(3));
    expect(anthropicCreate).toHaveBeenCalledTimes(3);
    expect(out.text).toMatch(/too many steps/);
  });

  it("passes API errors up (the agent turns them into 502)", async () => {
    anthropicCreate.mockRejectedValueOnce(new Error("429"));
    await expect(new AnthropicProvider("k", "m").run(input())).rejects.toThrow("429");
  });
});

describe("GeminiProvider", () => {
  it("runs function calls, answers with functionResponse parts carrying the id, returns the text", async () => {
    const modelTurn = { role: "model", parts: [{ functionCall: { id: "c1", name: "get_alerts", args: { hours: 2 } }, thoughtSignature: "s" }] };
    geminiGenerate
      .mockResolvedValueOnce({ functionCalls: [{ id: "c1", name: "get_alerts", args: { hours: 2 } }], candidates: [{ content: modelTurn }], text: undefined })
      .mockResolvedValueOnce({ functionCalls: undefined, text: " All quiet. " });
    const out = await new GeminiProvider("k", "gemini-3.5-flash-lite").run(input());
    expect(out).toEqual({ text: "All quiet.", model: "gemini-3.5-flash-lite", toolCalls: [{ name: "get_alerts", input: { hours: 2 }, ok: true }] });
    const first = geminiGenerate.mock.calls[0]![0];
    expect(first.config.systemInstruction).toBe("sys");
    expect(first.config.tools[0].functionDeclarations.map((f: { name: string }) => f.name)).toEqual(["get_alerts", "broken"]);
    const contents = geminiGenerate.mock.calls[1]![0].contents;
    expect(contents[0]).toEqual({ role: "user", parts: [{ text: "any alerts?" }] });
    expect(contents[1]).toBe(modelTurn); // sent back as returned (thought signatures kept)
    expect(contents[2]).toEqual({ role: "user", parts: [{ functionResponse: { id: "c1", name: "get_alerts", response: { result: { alerts: [], hours: 2 } } } }] });
  });

  it("returns tool errors as an error response", async () => {
    geminiGenerate
      .mockResolvedValueOnce({ functionCalls: [{ id: "c2", name: "broken", args: {} }], candidates: [{ content: { role: "model", parts: [] } }] })
      .mockResolvedValueOnce({ text: "Could not read it." });
    await new GeminiProvider("k", "m").run(input());
    expect(geminiGenerate.mock.calls[1]![0].contents[2].parts[0].functionResponse.response).toEqual({ error: { error: "store down" } });
  });

  it("maps assistant turns to the model role", async () => {
    geminiGenerate.mockResolvedValueOnce({ text: "ok" });
    await new GeminiProvider("k", "m").run({ ...input(), turns: [{ role: "user", text: "a" }, { role: "assistant", text: "b" }, { role: "user", text: "c" }] });
    expect(geminiGenerate.mock.calls[0]![0].contents.map((c: { role: string }) => c.role)).toEqual(["user", "model", "user"]);
  });
});
