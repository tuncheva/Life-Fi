import { runAgent } from "@/server/agent/agent";
import { agentFail } from "@/server/agent/http";
import { readBody, write } from "@/server/http";

export const dynamic = "force-dynamic";

/** Plain-language summary of the last `hours` (default 24) for the caregiver. */
export const POST = write(async (ctx, req) => {
  const body = await readBody(req);
  return runAgent(ctx, "summary", { hours: typeof body.hours === "number" ? body.hours : undefined }).catch(agentFail);
});
