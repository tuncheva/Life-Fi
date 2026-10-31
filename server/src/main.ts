// Life-Fi server: engine client, REST + WebSocket, alerts, history, ntfy, watchdog.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { AlertManager } from "./alerts.js";
import { registerApi } from "./api.js";
import { config } from "./config.js";
import { buildStatus, type AppContext, type AppState, type EngineStatus } from "./context.js";
import { EngineClient } from "./engine-client.js";
import { History } from "./history.js";
import { notifyPhone } from "./notify.js";
import { loadProfiles } from "./profiles.js";
import { ServerRules } from "./rules.js";
import { SettingsStore } from "./settings.js";
import { Store } from "./store.js";
import { resultValidator } from "./validate.js";
import { Watchdog } from "./watchdog.js";
import { LiveHub } from "./ws.js";

async function main() {
  const app = Fastify({
    disableRequestLogging: true,
    logger: { level: process.env.LIFEFI_LOG ?? "info", transport: config.devCors ? { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } } : undefined },
  });
  const log = app.log;

  const profiles = loadProfiles(config.profilesPath);
  const settings = new SettingsStore(config.dataDir, { pin: config.pin, profiles });
  // The saved time zone wins over profiles.yml for after-hours and night windows.
  profiles.zone = settings.value.zone;
  const state: AppState = {
    startedAt: Date.now(),
    latest: null,
    lastResultAt: null,
    engineStatus: null,
    source: { mode: "live", file: null, speed: 1, loop: false, state: "running", error: null },
    calibration: null,
    recording: null,
    presence: null,
  };
  const hub = new LiveHub(log);
  const store = new Store(config.dbPath);
  const history = new History(store);
  const alerts = new AlertManager(profiles, () => settings.value.profile);
  alerts.setEscalateAfter(() => settings.value.notify.escalate_after_s);
  alerts.on("alert", (a) => store.saveAlert(a));
  const restored = alerts.load(store.loadAlerts());
  log.info({ db: config.dbPath, history_rows: store.historySize(), alerts: restored }, "store opened");
  const purge = () => {
    const gone = store.purge(settings.value.retention_days);
    if (gone) log.info({ rows: gone, days: settings.value.retention_days }, "history purged");
  };
  purge();
  const purgeTimer = setInterval(purge, 3600_000);
  const rules = new ServerRules(alerts, profiles, () => settings.value.profile);
  const watchdog = new Watchdog({
    raise: (reason) => {
      log.warn({ reason }, "sensor offline");
      rules.onEngineLost();
      alerts.raiseServer("sensor_offline", { reason });
      hub.broadcast({ type: "status", status: buildStatus(ctx, false) });
    },
    clear: () => {
      log.info({}, "sensor back online");
      alerts.clearServer("sensor_offline");
      hub.broadcast({ type: "status", status: buildStatus(ctx, false) });
    },
  });
  const engine = new EngineClient(config.engineHost, config.enginePort, log, 1000, resultValidator());

  const ackTokens = new Map<string, string>();
  const ctx: AppContext = { log, ackTokens, engine, alerts, watchdog, history, settings, profiles, state, hub, version: config.version, dev: config.devCors };

  // ---- engine events --------------------------------------------------------
  /** Runs a listener body; one bad message is logged, never fatal to the server. */
  const guard = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      log.error({ err: (err as Error).stack ?? String(err) }, `${what} failed`);
    }
  };

  /** Keeps Status.source true to what the engine is reading (control.md source_info). */
  const syncSource = (data: EngineStatus) => {
    const info = data.engine.source_info;
    const mode = data.engine.source ?? state.source.mode;
    if (!info) return;
    const next = {
      mode,
      file: mode === "replay" ? info.file : null,
      speed: info.speed,
      loop: info.loop,
      state: info.state === "error" ? ("error" as const) : info.state === "running" ? ("running" as const) : ("stopped" as const),
      error: info.error,
    };
    const s = state.source;
    if (s.mode !== next.mode || s.file !== next.file || s.speed !== next.speed || s.loop !== next.loop || s.state !== next.state || s.error !== next.error) {
      if (next.error && next.error !== s.error) log.warn({ error: next.error }, "engine cannot read its source");
      state.source = next;
    }
  };

  let polling = false;
  let statusPoll: NodeJS.Timeout | null = null;
  const pollStatus = async () => {
    if (!engine.connected || polling) return; // one get_status at a time
    polling = true;
    try {
      const ack = await engine.send("get_status", {}, 2000);
      const data = ack.data as unknown as EngineStatus;
      state.engineStatus = data;
      watchdog.onDeviceStatus(typeof data.device?.last_status_us === "number" ? data.device.last_status_us : null);
      if (Array.isArray(data.engine.active_events)) {
        const n = alerts.syncActive(data.engine.active_events);
        if (n) log.info({ raised: n }, "alerts recovered from active engine events");
      }
      syncSource(data);
      if (state.recording && data.engine.recording === null) {
        // the engine restarted mid-recording: it has nothing open, so neither do we
        log.warn({ session: state.recording.session }, "engine is not recording any more; recording closed");
        state.recording = null;
      }
      hub.broadcast({ type: "status", status: buildStatus(ctx, false) });
    } catch (err) {
      log.debug({ err: (err as Error).message }, "get_status failed");
    } finally {
      polling = false;
    }
  };

  engine.on("connected", () => {
    alerts.onEngineConnected();
    watchdog.setEngineConnected(true);
    void pollStatus();
    statusPoll = setInterval(() => void pollStatus(), 1000);
    hub.broadcast({ type: "status", status: buildStatus(ctx, false) });
  });
  engine.on("disconnected", () => {
    if (statusPoll) clearInterval(statusPoll);
    statusPoll = null;
    state.engineStatus = null;
    watchdog.setEngineConnected(false);
    rules.onEngineLost();
    hub.broadcast({ type: "status", status: buildStatus(ctx, false) });
  });
  engine.on("result", (r) => {
    state.latest = r;
    state.lastResultAt = Date.now();
    guard("result status", () => {
      if (r.source !== state.source.mode) {
        state.source = { ...state.source, mode: r.source };
        hub.broadcast({ type: "status", status: buildStatus(ctx, false) });
      }
      if (state.presence?.state !== r.presence.state) {
        // The first result after a start cannot say when the state began: it is a lower bound.
        state.presence = { state: r.presence.state, since: r.ts, at_least: state.presence === null };
        hub.broadcast({ type: "status", status: buildStatus(ctx, false) });
      }
    });
    guard("watchdog", () => watchdog.onResult(r));
    guard("alerts", () => alerts.onResult(r));
    guard("server rules", () => rules.onResult(r));
    guard("history", () => history.add(r, profiles.profiles[settings.value.profile].breathing.store));
    guard("broadcast", () => hub.broadcast(r));
  });
  engine.on("unknown", (msg) => log.debug({ type: msg.type }, "unknown engine message"));

  alerts.on("alert", (a) =>
    guard("alert broadcast", () => {
      if (a.state === "resolved" || a.state === "dropped") ackTokens.delete(a.id);
      log.info({ id: a.id, type: a.type, state: a.state, level: a.level }, "alert");
      hub.broadcast({ type: "alert", alert: a });
    }),
  );
  alerts.on("notify", (a, kind) => {
    let token = ackTokens.get(a.id);
    if (!token) {
      token = randomBytes(16).toString("hex");
      ackTokens.set(a.id, token);
    }
    void notifyPhone(a, kind, settings.value, log, token).then((r) => alerts.setNotifyOutcome(a.id, r.ok ? "sent" : r.error === "ntfy topic not set" ? "not_configured" : "failed", r.ok ? null : r.error));
  });

  // ---- http -------------------------------------------------------------------
  // @fastify/cors v11 defaults to GET,HEAD,POST; the dashboard also uses PUT.
  if (config.devCors) {
    await app.register(cors, {
      origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/],
      methods: ["GET", "HEAD", "POST", "PUT", "DELETE"],
    });
  }
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  registerApi(app, ctx);

  if (existsSync(config.uiDir)) {
    await app.register(fastifyStatic, { root: config.uiDir, prefix: "/", index: ["index.html"], redirect: true });
    log.info({ dir: config.uiDir }, "serving dashboard");
  } else {
    app.get("/", async () => ({ name: "life-fi server", version: config.version, dashboard: "not built: run `npm run build -w ui`", api: "/api/v1/status" }));
  }

  // ---- start / stop --------------------------------------------------------------
  watchdog.start();
  rules.start();
  engine.start();
  await app.listen({ port: config.port, host: config.host });
  log.info({ engine: `${config.engineHost}:${config.enginePort}`, profile: settings.value.profile, config_hash: profiles.hash }, "life-fi server up");

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    if (statusPoll) clearInterval(statusPoll);
    clearInterval(purgeTimer);
    watchdog.stop();
    rules.stop();
    alerts.stop();
    engine.stop();
    hub.closeAll();
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
