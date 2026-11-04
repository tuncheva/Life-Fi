import { llmEnv } from "@/server/agent/provider";
import { firebaseEnv } from "@/server/store-firestore";
import { read } from "@/server/http";

export const dynamic = "force-dynamic";

/** Whether the assistant and the event store are configured, and with what (never a key). */
export const GET = read((ctx) => {
  const e = llmEnv();
  const fe = ctx.store.kind === "firestore" ? firebaseEnv() : null;
  return {
    configured: !!e.apiKey,
    provider: e.provider,
    model: e.model,
    store: ctx.store.kind,
    firebase: fe ? { project: fe.projectId, prefix: fe.prefix, emulator: fe.emulator } : null,
  };
});
