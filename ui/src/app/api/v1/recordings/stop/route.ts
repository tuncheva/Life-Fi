import { engineFail, fail, write } from "@/server/http";
import { broadcastStatus, endOpenSegment, readLabels } from "@/server/recordings";

export const dynamic = "force-dynamic";

export const POST = write(async (ctx) => {
  const rec = ctx.state.recording;
  if (!rec) return fail(409, "conflict", "no recording in progress");
  endOpenSegment(ctx, Date.now() * 1000);
  try {
    const ack = await ctx.engine.send("record_stop");
    ctx.state.recording = null;
    ctx.log.info({ session: rec.session, frames: ack.data.frames }, "recording stopped");
    broadcastStatus(ctx);
    return { session: rec.session, labels: readLabels(rec.session).length, ...ack.data };
  } catch (err) {
    return engineFail(err);
  }
});
