// REST + WebSocket routes (contracts/api.md).
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ALERT_STATES, type AlertState } from "./alerts.js";
import { config } from "./config.js";
import { buildStatus, type AppContext, type CalibrationJob } from "./context.js";
import { EngineError } from "./engine-client.js";
import { HISTORY_FIELDS, type HistoryField } from "./history.js";
import { isProfileName } from "./profiles.js";

type Body = Record<string, unknown>;

function fail(reply: FastifyReply, code: number, error: string, message: string) {
  return reply.code(code).send({ error, message });
}

function engineFail(reply: FastifyReply, err: unknown) {
  if (err instanceof EngineError) {
    const code = err.code === "engine_offline" ? 503 : err.code === "timeout" ? 504 : 409;
    return fail(reply, code, err.code === "refused" ? "conflict" : "engine_offline", err.message);
  }
  throw err;
}

export function registerApi(app: FastifyInstance, ctx: AppContext): void {
  const requirePin = async (req: FastifyRequest, reply: FastifyReply) => {
    const pin = req.headers["x-lifefi-pin"];
    if (!ctx.settings.checkPin(Array.isArray(pin) ? pin[0] : pin)) {
      return fail(reply, 401, "pin", "wrong or missing X-Lifefi-Pin header");
    }
  };
  const write = { preHandler: requirePin };

  app.get("/api/v1/status", async () => buildStatus(ctx, true));

  app.get("/api/v1/history", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const to = q.to ? Number(q.to) : Date.now();
    const from = q.from ? Number(q.from) : to - 24 * 3600 * 1000;
    if (!Number.isFinite(from) || !Number.isFinite(to)) return fail(reply, 400, "bad_request", "from/to must be ms since epoch");
    let fields: HistoryField[] | undefined;
    if (q.fields) {
      const list = q.fields.split(",").map((s) => s.trim());
      const bad = list.find((f) => !(HISTORY_FIELDS as readonly string[]).includes(f));
      if (bad) return fail(reply, 400, "bad_request", `unknown field '${bad}'`);
      fields = list as HistoryField[];
    }
    return { rows: ctx.history.query(from, to, fields) };
  });

  app.get("/api/v1/alerts", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const states = (q.state ?? "open,acked").split(",").map((s) => s.trim());
    const bad = states.find((s) => !(ALERT_STATES as string[]).includes(s));
    if (bad) return fail(reply, 400, "bad_request", `unknown state '${bad}'`);
    return { alerts: ctx.alerts.list(states as AlertState[]) };
  });

  app.post("/api/v1/alerts/:id/ack", write, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = ctx.alerts.ack(id);
    if (r === null) return fail(reply, 404, "not_found", `no alert '${id}'`);
    if (r === false) return fail(reply, 409, "conflict", "alert is not open");
    return r;
  });

  const profileView = () => ({ active: ctx.settings.value.profile, profiles: ctx.profiles.profiles });
  app.get("/api/v1/profile", async () => profileView());
  app.put("/api/v1/profile", write, async (req, reply) => {
    const body = (req.body ?? {}) as Body;
    if (!isProfileName(body.active)) return fail(reply, 400, "bad_request", "active must be home, school or clinic");
    if (body.active !== ctx.settings.value.profile) {
      ctx.settings.update({ profile: body.active });
      ctx.log.info({ profile: body.active }, "profile changed");
      ctx.hub.broadcast({ type: "status", status: buildStatus(ctx, false) });
    }
    return profileView();
  });

  app.post("/api/v1/calibrate", write, async (req, reply) => {
    const body = (req.body ?? {}) as Body;
    const kind = typeof body.kind === "string" ? body.kind : "empty";
    if (!["empty", "bed_empty", "bed_occupied"].includes(kind)) return fail(reply, 400, "bad_request", "kind must be empty, bed_empty or bed_occupied");
    const duration = typeof body.duration_s === "number" ? body.duration_s : 120;
    if (!ctx.engine.connected) return fail(reply, 503, "engine_offline", "engine is not connected");
    if (ctx.state.calibration?.state === "running") return fail(reply, 409, "conflict", "a calibration is already running");
    // The ack arrives when the calibration finishes (or at once if refused);
    // the result stream shows calibration.state meanwhile. The job object in
    // Status tells the dashboard the outcome.
    const job: CalibrationJob = { kind, duration_s: duration, started_at: Date.now(), state: "running", id: null, error: null, finished_at: null };
    ctx.state.calibration = job;
    const broadcast = () => ctx.hub.broadcast({ type: "status", status: buildStatus(ctx, false) });
    broadcast();
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
        broadcast();
      });
    return { started: true, kind, duration_s: duration };
  });

  app.get("/api/v1/source", async () => ctx.state.source);
  app.put("/api/v1/source", write, async (req, reply) => {
    const body = (req.body ?? {}) as Body;
    const mode = body.mode;
    if (mode !== "live" && mode !== "replay") return fail(reply, 400, "bad_request", "mode must be live or replay");
    if (mode === "replay" && typeof body.file !== "string") return fail(reply, 400, "bad_request", "replay needs a file");
    try {
      await ctx.engine.send("set_source", { mode });
    } catch (err) {
      return engineFail(reply, err);
    }
    ctx.state.source = {
      mode,
      file: mode === "replay" ? (body.file as string) : null,
      speed: typeof body.speed === "number" ? body.speed : 1,
      loop: body.loop === true,
      state: "running",
    };
    // TODO(phase 5): start/stop engine/tools/replay here (plan-v2 §7.1 Replay).
    ctx.hub.broadcast({ type: "status", status: buildStatus(ctx, false) });
    return ctx.state.source;
  });

  // Recordings: start/stop go to the engine; segments and marks are appended to labels.jsonl (plan-v2 §4.3).
  let session: string | null = null;
  const labelsPath = (s: string) => join(config.dataDir, "sessions", s, "labels.jsonl");
  const appendLabel = (s: string, line: Record<string, unknown>) => {
    mkdirSync(join(config.dataDir, "sessions", s), { recursive: true });
    appendFileSync(labelsPath(s), JSON.stringify(line) + "\n");
  };

  /** Recorded sessions under data/sessions/<id>/<id>.csirec, for the replay picker. */
  app.get("/api/v1/recordings", async () => {
    const dir = join(config.dataDir, "sessions");
    if (!existsSync(dir)) return { recordings: [], recording: session };
    const recordings = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const file = join(dir, d.name, `${d.name}.csirec`);
        const has = existsSync(file);
        return { session: d.name, file: has ? file : null, bytes: has ? statSync(file).size : 0, labels: existsSync(labelsPath(d.name)) };
      })
      .sort((a, b) => a.session.localeCompare(b.session));
    return { recordings, recording: session };
  });

  app.post("/api/v1/recordings/start", write, async (req, reply) => {
    const body = (req.body ?? {}) as Body;
    if (typeof body.session !== "string" || !/^[\w-]+$/.test(body.session)) return fail(reply, 400, "bad_request", "session must be a short id");
    if (session) return fail(reply, 409, "conflict", `session '${session}' is already recording`);
    const path = join(config.dataDir, "sessions", body.session, `${body.session}.csirec`);
    try {
      await ctx.engine.send("record_start", { session: body.session, path, meta: body.meta ?? {} });
    } catch (err) {
      return engineFail(reply, err);
    }
    session = body.session;
    return { session };
  });

  app.post("/api/v1/recordings/stop", write, async (_req, reply) => {
    if (!session) return fail(reply, 409, "conflict", "no recording in progress");
    try {
      const ack = await ctx.engine.send("record_stop");
      const s = session;
      session = null;
      return { session: s, ...ack.data };
    } catch (err) {
      return engineFail(reply, err);
    }
  });

  app.post("/api/v1/recordings/segment", write, async (req, reply) => {
    if (!session) return fail(reply, 409, "conflict", "no recording in progress");
    const body = (req.body ?? {}) as Body;
    if (body.action !== "start" && body.action !== "end") return fail(reply, 400, "bad_request", "action must be start or end");
    appendLabel(session, { kind: "segment", session, t_us: Date.now() * 1000, ...body });
    return {};
  });

  app.post("/api/v1/recordings/mark", write, async (req, reply) => {
    if (!session) return fail(reply, 409, "conflict", "no recording in progress");
    const body = (req.body ?? {}) as Body;
    if (typeof body.event !== "string") return fail(reply, 400, "bad_request", "event is required");
    appendLabel(session, { kind: "mark", session, t_press_us: Date.now() * 1000, event: body.event, subject: body.subject ?? null });
    return {};
  });

  app.get("/api/v1/settings", async () => ctx.settings.public());
  app.put("/api/v1/settings", write, async (req) => {
    const body = (req.body ?? {}) as Body;
    const patch: Record<string, unknown> = {};
    if (typeof body.pin === "string") patch.pin = body.pin;
    if (typeof body.zone === "string") patch.zone = body.zone;
    if (typeof body.dashboard_url === "string") patch.dashboard_url = body.dashboard_url;
    if (typeof body.retention_days === "number") patch.retention_days = body.retention_days;
    if (body.notify && typeof body.notify === "object") patch.notify = body.notify;
    ctx.settings.update(patch);
    return ctx.settings.public();
  });

  app.get("/ws/live", { websocket: true }, (socket) => {
    const hello: unknown[] = [{ type: "status", status: buildStatus(ctx, false) }];
    if (ctx.state.latest) hello.push(ctx.state.latest);
    ctx.hub.add(socket, hello);
  });

  // Dev-only: drive the mock engine's scenarios (not part of the contract).
  if (ctx.dev) {
    app.get("/dev/scenarios", async (_req, reply) => {
      try {
        return (await ctx.engine.send("mock_list_scenarios")).data;
      } catch (err) {
        return engineFail(reply, err);
      }
    });
    app.post("/dev/scenario", async (req, reply) => {
      const body = (req.body ?? {}) as Body;
      if (typeof body.name !== "string") return fail(reply, 400, "bad_request", "name is required");
      try {
        return (await ctx.engine.send("mock_scenario", { name: body.name })).data;
      } catch (err) {
        return engineFail(reply, err);
      }
    });
  }
}
