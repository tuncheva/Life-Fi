import { fail, readBody, write } from "@/server/http";
import { broadcastStatus, endOpenSegment, SEGMENT_LABELS, validLabel } from "@/server/recordings";

export const dynamic = "force-dynamic";

export const POST = write(async (ctx, req) => {
  const rec = ctx.state.recording;
  if (!rec) return fail(409, "conflict", "no recording in progress");
  const body = await readBody(req);
  const t_us = Date.now() * 1000;
  if (body.action === "end") {
    const ended = endOpenSegment(ctx, t_us);
    broadcastStatus(ctx);
    return { ended, open_segment: null };
  }
  if (body.action !== "start") return fail(400, "bad_request", "action must be start or end");
  if (typeof body.label !== "string" || !validLabel(body.label)) return fail(400, "bad_request", `label must be one of ${SEGMENT_LABELS.join(", ")} or paced_breathing_<bpm>`);
  const ended = endOpenSegment(ctx, t_us);
  rec.open_segment = {
    t_start_us: t_us,
    label: body.label,
    count: typeof body.count === "number" ? body.count : 1,
    subject: typeof body.subject === "string" && body.subject ? body.subject : null,
    spot: typeof body.spot === "string" && body.spot ? body.spot : null,
  };
  broadcastStatus(ctx);
  return { ended, open_segment: rec.open_segment };
});
