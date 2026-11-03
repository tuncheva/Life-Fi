import { engineFail, fail, inRange, read, readBody, write } from "@/server/http";
import { broadcastStatus, replayPath } from "@/server/recordings";

export const dynamic = "force-dynamic";

export const GET = read((ctx) => ctx.state.source);

export const PUT = write(async (ctx, req) => {
  const body = await readBody(req);
  const mode = body.mode;
  if (mode !== "live" && mode !== "replay") return fail(400, "bad_request", "mode must be live or replay");
  let file: string | null = null;
  if (mode === "replay") {
    if (typeof body.file !== "string") return fail(400, "bad_request", "replay needs a file");
    file = replayPath(body.file);
    if (!file) return fail(400, "bad_request", "file must be a .csirec under firmware/recordings/ or the data sessions folder");
  }
  const speed = body.speed === undefined ? 1 : inRange(body.speed, 0.1, 20);
  if (speed === null) return fail(400, "bad_request", "speed must be 0.1 to 20");
  const loop = body.loop === true;
  try {
    // the engine plays the replay file itself (contracts/control.md set_source)
    await ctx.engine.send("set_source", mode === "replay" ? { mode, file, speed, loop } : { mode });
  } catch (err) {
    return engineFail(err);
  }
  ctx.state.source = { mode, file, speed, loop, state: "running", error: null };
  broadcastStatus(ctx);
  return ctx.state.source;
});
