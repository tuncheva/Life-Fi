// Life-Fi server: engine client, REST + WebSocket, alerts, history, ntfy, watchdog.
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
import { SettingsStore } from "./settings.js";
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
  const state: AppState = {
    startedAt: Date.now(),
    latest: null,
    lastResultAt: null,
    engineStatus: null,
    source: { mode: "live", file: null, speed: 1, loop: false, state: "running" },
    calibration: null,
  };
  const hub = new LiveHub(log);
  const history = new History();
  const alerts = new AlertManager(profiles, () => settings.value.profile);
  const watchdog = new Watchdog({
    raise: (reason) => {
      log.warn({ reason }, "sensor offline");
      alerts.raiseServer("sensor_offline", { reason });
      hub.broadcast({ type: "status", status: buildStatus(ctx, false) });
    },
    clear: () => {
      log.info({}, "sensor back online");
      alerts.clearServer("sensor_offline");
      hub.broadcast({ type: "status", status: buildStatus(ctx, false) });
    },
  });
  const engine = new EngineClient(config.engineHost, config.enginePort, log);

  const ctx: AppContext = { log, engine, alerts, watchdog, history, settings, profiles, state, hub, version: config.version, dev: config.devCors };

  // ---- engine events --------------------------------------------------------
  let statusPoll: NodeJS.Timeout | null = null;
  const pollStatus = async () => {
    if (!engine.connected) return;
    try {
      const ack = await engine.send("get_status", {}, 2000);
      const data = ack.data as unknown as EngineStatus;
      state.engineStatus = data;
      watchdog.onDeviceStatus(typeof data.device?.last_status_us === "number" ? data.device.last_status_us : null);
      hub.broadcast({ type: "status", status: buildStatus(ctx, false) });
    } catch (err) {
      log.debug({ err: (err as Error).message }, "get_status failed");
    }
  };

  engine.on("connected", () => {
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
    hub.broadcast({ type: "status", status: buildStatus(ctx, false) });
  });
  engine.on("result", (r) => {
    state.latest = r;
    state.lastResultAt = Date.now();
    if (r.source !== state.source.mode) {
      state.source = { ...state.source, mode: r.source };
      hub.broadcast({ type: "status", status: buildStatus(ctx, false) });
    }
    watchdog.onResult(r);
    alerts.onResult(r);
    history.add(r, profiles.profiles[settings.value.profile].breathing.store);
    hub.broadcast(r);
  });
  engine.on("unknown", (msg) => log.debug({ type: msg.type }, "unknown engine message"));

  alerts.on("alert", (a) => {
    log.info({ id: a.id, type: a.type, state: a.state, level: a.level }, "alert");
    hub.broadcast({ type: "alert", alert: a });
  });
  alerts.on("notify", (a, kind) => void notifyPhone(a, kind, settings.value, log));

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
  engine.start();
  await app.listen({ port: config.port, host: config.host });
  log.info({ engine: `${config.engineHost}:${config.enginePort}`, profile: settings.value.profile, config_hash: profiles.hash }, "life-fi server up");

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    if (statusPoll) clearInterval(statusPoll);
    watchdog.stop();
    alerts.stop();
    engine.stop();
    hub.closeAll();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
