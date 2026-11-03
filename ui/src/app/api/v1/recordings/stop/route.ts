import { engineFail, fail, write } from "@/server/http";
import { readLabels, stopRecording } from "@/server/recordings";

export const dynamic = "force-dynamic";

export const POST = write(async (ctx) => {
  const rec = ctx.state.recording;
  if (!rec) return fail(409, "conflict", "no recording in progress");
  try {
    const data = await stopRecording(ctx);
    return { session: rec.session, labels: readLabels(rec.session).length, ...data };
  } catch (err) {
    return engineFail(err);
  }
});
