import { engineFail, fail, readBody, write } from "@/server/http";
import { startRecording } from "@/server/recordings";

export const dynamic = "force-dynamic";

export const POST = write(async (ctx, req) => {
  const body = await readBody(req);
  if (typeof body.session !== "string" || !/^[\w-]+$/.test(body.session)) return fail(400, "bad_request", "session must be a short id (letters, digits, - _)");
  if (ctx.state.recording) return fail(409, "conflict", `session '${ctx.state.recording.session}' is already recording`);
  if (ctx.state.source.mode !== "live") return fail(409, "conflict", "recording is live only");
  const meta = (body.meta && typeof body.meta === "object" ? body.meta : {}) as Record<string, unknown>;
  try {
    return await startRecording(ctx, body.session, meta);
  } catch (err) {
    return engineFail(err);
  }
});
