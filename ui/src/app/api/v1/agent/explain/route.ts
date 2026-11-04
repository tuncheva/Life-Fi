import { runAgent } from "@/server/agent/agent";
import { agentFail } from "@/server/agent/http";
import { fail, readBody, write } from "@/server/http";

export const dynamic = "force-dynamic";

/** "Explain this alert": what was detected and what to do now. */
export const POST = write(async (ctx, req) => {
  const body = await readBody(req);
  if (typeof body.alert_id !== "string" || !body.alert_id) return fail(400, "bad_request", "alert_id is required");
  return runAgent(ctx, "explain", { alertId: body.alert_id }).catch(agentFail);
});
