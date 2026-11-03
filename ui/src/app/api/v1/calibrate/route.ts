import type { CalibrationJob } from "@/server/context";
import { fail, readBody, write } from "@/server/http";
import { broadcastStatus } from "@/server/recordings";

export const dynamic = "force-dynamic";

export const POST = write(async (ctx, req) => {
  const body = await readBody(req);
  const kind = typeof body.kind === "string" ? body.kind : "empty";
  if (!["empty", "bed_empty", "bed_occupied"].includes(kind)) return fail(400, "bad_request", "kind must be empty, bed_empty or bed_occupied");
  const duration = typeof body.duration_s === "number" ? body.duration_s : 120;
  if (!ctx.engine.connected) return fail(503, "engine_offline", "engine is not connected");
  if (ctx.state.calibration?.state === "running") return fail(409, "conflict", "a calibration is already running");
  // The ack arrives when the calibration finishes (or at once if refused);
  // the result stream shows calibration.state meanwhile. The job object in
  // Status tells the dashboard the outcome.
  const job: CalibrationJob = { kind, duration_s: duration, started_at: Date.now(), state: "running", id: null, error: null, finished_at: null };
  ctx.state.calibration = job;
  broadcastStatus(ctx);
  ctx.engine
    .send("calibrate", { kind, duration_s: duration }, (duration + 5) * 1000)
    .then((ack) => {
      job.state = "ok";
      job.id = typeof ack.data.id === "string" ? ack.data.id : null;
      ctx.log.info({ id: job.id }, "calibration finished");
    })
    .catch((err: Error) => {
      job.state = "failed";
      job.error = err.message;
      ctx.log.warn({ err: err.message }, "calibration failed");
    })
    .finally(() => {
      job.finished_at = Date.now();
      broadcastStatus(ctx);
    });
  return { started: true, kind, duration_s: duration };
});
