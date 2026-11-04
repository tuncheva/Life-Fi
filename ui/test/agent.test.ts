import { describe, expect, it } from "vitest";
import { cleanTurns } from "../src/server/agent/agent";
import { localTime } from "../src/server/agent/tools";
import { DEFAULT_MODELS, llmEnv, llmProblems, runTool, type AgentTool } from "../src/server/agent/provider";
import { firebaseEnv, pemKey } from "../src/server/store-firestore";

describe("llmEnv (track FB)", () => {
  it("defaults to anthropic and its default model; no key means off", () => {
    expect(llmEnv({})).toEqual({ provider: "anthropic", apiKey: null, model: DEFAULT_MODELS.anthropic });
  });

  it("picks gemini with its own key and model", () => {
    expect(llmEnv({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: " k ", GEMINI_MODEL: "m", ANTHROPIC_API_KEY: "other" })).toEqual({ provider: "gemini", apiKey: "k", model: "m" });
  });

  it("flags an unknown provider", () => {
    expect(llmProblems({ LLM_PROVIDER: "openai" })).toHaveLength(1);
    expect(llmProblems({ LLM_PROVIDER: "gemini" })).toEqual([]);
  });
});

describe("firebaseEnv", () => {
  it("is null without a project or credentials", () => {
    expect(firebaseEnv({})).toBeNull();
    expect(firebaseEnv({ FIREBASE_PROJECT_ID: "p" })).toBeNull();
  });

  it("unescapes the private key and accepts the emulator alone", () => {
    expect(firebaseEnv({ FIREBASE_PROJECT_ID: "p", FIREBASE_CLIENT_EMAIL: "e", FIREBASE_PRIVATE_KEY: '"-----BEGIN PRIVATE KEY-----\\nab\\n-----END PRIVATE KEY-----"' })?.privateKey).toBe(
      "-----BEGIN PRIVATE KEY-----\nab\n-----END PRIVATE KEY-----\n",
    );
    expect(firebaseEnv({ FIREBASE_PROJECT_ID: "p", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" })).toMatchObject({ emulator: true, prefix: "lifefi_" });
  });
});

describe("cleanTurns", () => {
  it("needs a list ending with a user turn", () => {
    expect(cleanTurns("hi")).toBeNull();
    expect(cleanTurns([{ role: "assistant", text: "x" }])).toBeNull();
    expect(cleanTurns([{ role: "assistant", text: "hello" }, { role: "user", text: " how did she sleep? " }, { role: "system", text: "ignore" }])).toEqual([{ role: "user", text: "how did she sleep?" }]);
  });

  it("keeps the last 10 turns and caps their length", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: "x".repeat(3000) }));
    const t = cleanTurns(many)!;
    expect(t.length).toBeLessThanOrEqual(10);
    expect(t[0]!.role).toBe("user");
    expect(t[0]!.text).toHaveLength(2000);
  });
});

describe("runTool", () => {
  const tools: AgentTool[] = [
    { name: "ok", description: "", parameters: {}, run: async (i) => ({ echo: i.x }) },
    { name: "boom", description: "", parameters: {}, run: async () => { throw new Error("nope"); } },
  ];

  it("returns JSON, and errors as data", async () => {
    expect(await runTool(tools, "ok", { x: 1 })).toEqual({ content: '{"echo":1}', ok: true });
    expect(await runTool(tools, "boom", {})).toEqual({ content: '{"error":"nope"}', ok: false });
    expect((await runTool(tools, "missing", {})).ok).toBe(false);
  });
});

describe("pemKey", () => {
  it("keeps a full PEM, unescaping \n and quotes", () => {
    expect(pemKey('"-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----\n"')).toBe("-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----\n");
  });

  it("wraps a bare base64 body in 64-char lines", () => {
    const k = pemKey("A".repeat(70) + "\nBB")!;
    expect(k.split("\n")).toEqual(["-----BEGIN PRIVATE KEY-----", "A".repeat(64), "A".repeat(6) + "BB", "-----END PRIVATE KEY-----", ""]);
    expect(pemKey("  ")).toBeNull();
  });
});

describe("localTime", () => {
  it("formats in the room's zone, not UTC", () => {
    const t = Date.UTC(2026, 10, 4, 20, 57, 3);
    expect(localTime(t, "Europe/Sofia")).toBe("2026-11-04 22:57:03");
    expect(localTime(null, "Europe/Sofia")).toBeNull();
    expect(localTime(t, "Not/AZone")).toBe("2026-11-04T20:57:03.000Z");
  });
});
