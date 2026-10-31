import { engineFail, fail, readBody, write } from "@/server/http";

export const dynamic = "force-dynamic";

/** Fits the distance scale: someone has been moving `d_m` from the board for the last `seconds` (default 25). */
export const POST = write(async (ctx, req) => {
  const body = await readBody(req);
  const d_m = body.d_m;
  if (typeof d_m !== "number" || d_m < 0.3 || d_m > 8) return fail(400, "bad_request", "d_m must be a distance of 0.3 to 8 m");
  const seconds = typeof body.seconds === "number" ? body.seconds : 25;
  try {
    const ack = await ctx.engine.send("position_fit", { d_m, seconds });
    ctx.log.info({ ...ack.data, d_m }, "distance fitted");
    return ack.data;
  } catch (err) {
    return engineFail(err);
  }
});
