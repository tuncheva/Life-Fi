// REST + WebSocket routes (contracts/api.md).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ALERT_STATES, type AlertState } from "./alerts.js";
import { config } from "./config.js";
import { buildStatus, type AppContext, type CalibrationJob } from "./context.js";
import { EngineError } from "./engine-client.js";
import { HISTORY_FIELDS, type HistoryField } from "./history.js";
import { notifyTest } from "./notify.js";
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

  // Acknowledge: with the PIN (dashboard) or with the one-time token from the phone notification.
  const pinOrAckToken = async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const token = (req.query as Record<string, string | undefined>).token;
    if (token && ctx.ackTokens.get(id) === token) return;
    return requirePin(req, reply);
  };
  app.post("/api/v1/alerts/:id/ack", { preHandler: pinOrAckToken }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Body;
    const token = (req.query as Record<string, string | undefined>).token;
    const viaPhone = !!token && ctx.ackTokens.get(id) === token;
    const by = typeof body.by === "string" && body.by.trim() ? body.by.trim().slice(0, 40) : viaPhone ? "phone notification" : null;
    const r = ctx.alerts.ack(id, by);
    if (viaPhone && r) ctx.ackTokens.delete(id);
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
    const speed = typeof body.speed === "number" ? body.speed : 1;
    const loop = body.loop === true;
    try {
      // the engine plays the replay file itself (contracts/control.md set_source)
      await ctx.engine.send("set_source", mode === "replay" ? { mode, file: body.file, speed, loop } : { mode });
    } catch (err) {
      return engineFail(reply, err);
    }
    ctx.state.source = { mode, file: mode === "replay" ? (body.file as string) : null, speed, loop, state: "running", error: null };
    ctx.hub.broadcast({ type: "status", status: buildStatus(ctx, false) });
    return ctx.state.source;
  });

  // Recordings (plan-v2 §4.3, §10.1): the engine writes the .csirec, the
  // server writes session.json at start and appends labels.jsonl. Segments
  // are non-overlapping: starting one ends the open one.
  const sessionDir = (s: string) => join(config.dataDir, "sessions", s);
  const labelsPath = (s: string) => join(sessionDir(s), "labels.jsonl");
  const appendLabel = (s: string, line: Record<string, unknown>) => {
    mkdirSync(sessionDir(s), { recursive: true });
    appendFileSync(labelsPath(s), JSON.stringify(line) + "\n");
    if (ctx.state.recording?.session === s) ctx.state.recording.labels++;
  };
  const readLabels = (s: string): Record<string, unknown>[] => {
    if (!existsSync(labelsPath(s))) return [];
    return readFileSync(labelsPath(s), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  };
  const broadcastStatus = () => ctx.hub.broadcast({ type: "status", status: buildStatus(ctx, false) });
  const SEGMENT_LABELS = ["empty", "standing", "sitting", "lying", "walking", "normal_activity", "in_bed", "bed_empty", "breath_hold"];
  const MARK_EVENTS = ["sit_down", "stand_up", "lie_down", "get_up", "fall", "bed_exit", "breath_hold_start", "breath_hold_end"];
  const validLabel = (l: string) => SEGMENT_LABELS.includes(l) || /^paced_breathing_\d{1,3}$/.test(l);
  const validEvent = (e: string) => MARK_EVENTS.includes(e) || /^hard_negative_[\w-]+$/.test(e);

  /** Ends the open segment (if any) at `t_us` and writes it. */
  const endOpenSegment = (t_us: number): Record<string, unknown> | null => {
    const rec = ctx.state.recording;
    if (!rec?.open_segment) return null;
    const seg = rec.open_segment;
    rec.open_segment = null;
    const line = { kind: "segment", session: rec.session, t_start_us: seg.t_start_us, t_end_us: t_us, label: seg.label, count: seg.count, subject: seg.subject, spot: seg.spot };
    appendLabel(rec.session, line);
    return line;
  };

  /** Recorded sessions under data/sessions/<id>/, for the replay picker and the labelling page. */
  app.get("/api/v1/recordings", async () => {
    const dir = join(config.dataDir, "sessions");
    const recordings = !existsSync(dir)
      ? []
      : readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => {
            const file = join(dir, d.name, `${d.name}.csirec`);
            const has = existsSync(file);
            return { session: d.name, file: has ? file : null, bytes: has ? statSync(file).size : 0, labels: existsSync(labelsPath(d.name)) ? readLabels(d.name).length : 0 };
          })
          .sort((a, b) => a.session.localeCompare(b.session));
    return { recordings, recording: ctx.state.recording, vocabulary: { segments: SEGMENT_LABELS, marks: MARK_EVENTS } };
  });

  app.get("/api/v1/recordings/labels", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const s = q.session ?? ctx.state.recording?.session;
    if (!s || !/^[\w-]+$/.test(s)) return fail(reply, 400, "bad_request", "session is required");
    return { session: s, labels: readLabels(s), open_segment: ctx.state.recording?.session === s ? ctx.state.recording.open_segment : null };
  });

  app.post("/api/v1/recordings/start", write, async (req, reply) => {
    const body = (req.body ?? {}) as Body;
    if (typeof body.session !== "string" || !/^[\w-]+$/.test(body.session)) return fail(reply, 400, "bad_request", "session must be a short id (letters, digits, - _)");
    if (ctx.state.recording) return fail(reply, 409, "conflict", `session '${ctx.state.recording.session}' is already recording`);
    if (ctx.state.source.mode !== "live") return fail(reply, 409, "conflict", "recording is live only");
    const meta = (body.meta && typeof body.meta === "object" ? body.meta : {}) as Record<string, unknown>;
    const path = join(sessionDir(body.session), `${body.session}.csirec`);
    try {
      await ctx.engine.send("record_start", { session: body.session, path, meta });
    } catch (err) {
      return engineFail(reply, err);
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
    broadcastStatus();
    return { session: body.session, started_us };
  });

  app.post("/api/v1/recordings/stop", write, async (_req, reply) => {
    const rec = ctx.state.recording;
    if (!rec) return fail(reply, 409, "conflict", "no recording in progress");
    endOpenSegment(Date.now() * 1000);
    try {
      const ack = await ctx.engine.send("record_stop");
      ctx.state.recording = null;
      ctx.log.info({ session: rec.session, frames: ack.data.frames }, "recording stopped");
      broadcastStatus();
      return { session: rec.session, labels: readLabels(rec.session).length, ...ack.data };
    } catch (err) {
      return engineFail(reply, err);
    }
  });

  app.post("/api/v1/recordings/segment", write, async (req, reply) => {
    const rec = ctx.state.recording;
    if (!rec) return fail(reply, 409, "conflict", "no recording in progress");
    const body = (req.body ?? {}) as Body;
    const t_us = Date.now() * 1000;
    if (body.action === "end") {
      const ended = endOpenSegment(t_us);
      broadcastStatus();
      return { ended, open_segment: null };
    }
    if (body.action !== "start") return fail(reply, 400, "bad_request", "action must be start or end");
    if (typeof body.label !== "string" || !validLabel(body.label)) return fail(reply, 400, "bad_request", `label must be one of ${SEGMENT_LABELS.join(", ")} or paced_breathing_<bpm>`);
    const ended = endOpenSegment(t_us);
    rec.open_segment = {
      t_start_us: t_us,
      label: body.label,
      count: typeof body.count === "number" ? body.count : 1,
      subject: typeof body.subject === "string" && body.subject ? body.subject : null,
      spot: typeof body.spot === "string" && body.spot ? body.spot : null,
    };
    broadcastStatus();
    return { ended, open_segment: rec.open_segment };
  });

  app.post("/api/v1/recordings/mark", write, async (req, reply) => {
    const rec = ctx.state.recording;
    if (!rec) return fail(reply, 409, "conflict", "no recording in progress");
    const body = (req.body ?? {}) as Body;
    if (typeof body.event !== "string" || !validEvent(body.event)) return fail(reply, 400, "bad_request", `event must be one of ${MARK_EVENTS.join(", ")} or hard_negative_<what>`);
    const line = { kind: "mark", session: rec.session, t_press_us: Date.now() * 1000, event: body.event, subject: typeof body.subject === "string" && body.subject ? body.subject : null };
    appendLabel(rec.session, line);
    broadcastStatus();
    return line;
  });

  app.get("/api/v1/settings", async () => ctx.settings.public());
  app.put("/api/v1/settings", write, async (req, reply) => {
    const body = (req.body ?? {}) as Body;
    const patch: Record<string, unknown> = {};
    if (typeof body.pin === "string") {
      if (!/^\d{4,8}$/.test(body.pin)) return fail(reply, 400, "bad_request", "pin must be 4 to 8 digits");
      patch.pin = body.pin;
    }
    if (typeof body.zone === "string") {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: body.zone });
      } catch {
        return fail(reply, 400, "bad_request", `unknown time zone '${body.zone}'`);
      }
      patch.zone = body.zone;
      ctx.profiles.zone = body.zone;
    }
    if (typeof body.dashboard_url === "string") patch.dashboard_url = body.dashboard_url.trim();
    if (typeof body.room_name === "string" && body.room_name.trim()) patch.room_name = body.room_name.trim().slice(0, 40);
    if (typeof body.contact_phone === "string") patch.contact_phone = body.contact_phone.replace(/[^+\d\s()-]/g, "").trim().slice(0, 30);
    if (typeof body.retention_days === "number" && body.retention_days >= 1) patch.retention_days = Math.round(body.retention_days);
    if (body.notify && typeof body.notify === "object") {
      const n = body.notify as Record<string, unknown>;
      const notify: Record<string, unknown> = {};
      if (typeof n.ntfy_url === "string") notify.ntfy_url = n.ntfy_url.trim().replace(/\/$/, "");
      if (typeof n.topic === "string") notify.topic = n.topic.trim();
      if (typeof n.escalate_after_s === "number" && n.escalate_after_s >= 0) notify.escalate_after_s = Math.round(n.escalate_after_s);
      patch.notify = notify;
    }
    ctx.settings.update(patch);
    ctx.log.info({ keys: Object.keys(patch) }, "settings updated");
    if ("room_name" in patch || "contact_phone" in patch) ctx.hub.broadcast({ type: "status", status: buildStatus(ctx, false) });
    return ctx.settings.public();
  });

  /** Sends a test message to the configured ntfy topic. */
  app.post("/api/v1/settings/test-notification", write, async (_req, reply) => {
    const r = await notifyTest(ctx.settings.value, ctx.log);
    if (!r.ok) return fail(reply, 502, "notify", r.error);
    return { sent: true };
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
