import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { engineFail, fail, readBody, write } from "@/server/http";
import { broadcastStatus, readLabels, sessionDir } from "@/server/recordings";

export const dynamic = "force-dynamic";

export const POST = write(async (ctx, req) => {
  const body = await readBody(req);
  if (typeof body.session !== "string" || !/^[\w-]+$/.test(body.session)) return fail(400, "bad_request", "session must be a short id (letters, digits, - _)");
  if (ctx.state.recording) return fail(409, "conflict", `session '${ctx.state.recording.session}' is already recording`);
  if (ctx.state.source.mode !== "live") return fail(409, "conflict", "recording is live only");
  const meta = (body.meta && typeof body.meta === "object" ? body.meta : {}) as Record<string, unknown>;
  const path = join(sessionDir(body.session), `${body.session}.csirec`);
  try {
    await ctx.engine.send("record_start", { session: body.session, path, meta });
  } catch (err) {
    return engineFail(err);
  }
  const started_us = Date.now() * 1000;
  mkdirSync(sessionDir(body.session), { recursive: true });
  const sessionJson = {
    session: body.session,
    started_us,
    firmware: (ctx.state.engineStatus?.device as Record<string, unknown> | null)?.fw_version ?? null,
    engine: ctx.state.engineStatus?.engine.version ?? null,
    config_hash: ctx.state.latest?.config_hash ?? null,
    pipeline_version: ctx.state.latest?.pipeline_version ?? null,
    ...meta,
  };
  writeFileSync(join(sessionDir(body.session), "session.json"), JSON.stringify(sessionJson, null, 2) + "\n");
  ctx.state.recording = { session: body.session, started_us, open_segment: null, labels: readLabels(body.session).length };
  ctx.log.info({ session: body.session }, "recording started");
  broadcastStatus(ctx);
  return { session: body.session, started_us };
});
