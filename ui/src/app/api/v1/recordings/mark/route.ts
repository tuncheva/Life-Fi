import { fail, readBody, write } from "@/server/http";
import { appendLabel, broadcastStatus, MARK_EVENTS, validEvent } from "@/server/recordings";

export const dynamic = "force-dynamic";

export const POST = write(async (ctx, req) => {
  const rec = ctx.state.recording;
  if (!rec) return fail(409, "conflict", "no recording in progress");
  const body = await readBody(req);
  if (typeof body.event !== "string" || !validEvent(body.event)) return fail(400, "bad_request", `event must be one of ${MARK_EVENTS.join(", ")} or hard_negative_<what>`);
  const line = { kind: "mark", session: rec.session, t_press_us: Date.now() * 1000, event: body.event, subject: typeof body.subject === "string" && body.subject ? body.subject : null };
  appendLabel(ctx, rec.session, line);
  broadcastStatus(ctx);
  return line;
});
