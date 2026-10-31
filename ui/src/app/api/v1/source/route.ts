import { engineFail, fail, read, readBody, write } from "@/server/http";
import { broadcastStatus } from "@/server/recordings";

export const dynamic = "force-dynamic";

export const GET = read((ctx) => ctx.state.source);

export const PUT = write(async (ctx, req) => {
  const body = await readBody(req);
  const mode = body.mode;
  if (mode !== "live" && mode !== "replay") return fail(400, "bad_request", "mode must be live or replay");
  if (mode === "replay" && typeof body.file !== "string") return fail(400, "bad_request", "replay needs a file");
  const speed = typeof body.speed === "number" ? body.speed : 1;
  const loop = body.loop === true;
  try {
    // the engine plays the replay file itself (contracts/control.md set_source)
    await ctx.engine.send("set_source", mode === "replay" ? { mode, file: body.file, speed, loop } : { mode });
  } catch (err) {
    return engineFail(err);
  }
  ctx.state.source = { mode, file: mode === "replay" ? (body.file as string) : null, speed, loop, state: "running", error: null };
  broadcastStatus(ctx);
  return ctx.state.source;
});
