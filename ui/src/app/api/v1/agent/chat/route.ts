import { cleanTurns, runAgent } from "@/server/agent/agent";
import { agentFail } from "@/server/agent/http";
import { fail, readBody, write } from "@/server/http";

export const dynamic = "force-dynamic";

/** Q&A over the stored events: `messages` is the conversation so far, the last one from the user. */
export const POST = write(async (ctx, req) => {
  const body = await readBody(req);
  const turns = cleanTurns(body.messages);
  if (!turns) return fail(400, "bad_request", "messages must be [{role, text}] ending with a user message");
  return runAgent(ctx, "chat", { turns }).catch(agentFail);
});
