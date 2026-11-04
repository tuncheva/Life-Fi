// The Life-Fi backend inside the Next.js process: engine client, alerts, history, ntfy,
// watchdog and the live hub. Started once (instrumentation.ts or the first API request)
// and kept on globalThis so route bundles and dev hot reloads share one engine socket.
import { randomBytes } from "node:crypto";
import { AlertManager } from "./alerts";
import { config, ConfigError, DEFAULT_PIN } from "./config";
import { buildStatus, type AppContext, type AppState, type EngineStatus } from "./context";
import { ChangeTracker } from "./changes";
import { EngineClient } from "./engine-client";
import { History } from "./history";
import { LiveHub } from "./hub";
import { recentBuffer } from "./recent";
import { createLogger } from "./log";
import { notifyPhone } from "./notify";
import { loadProfiles } from "./profiles";
import { ServerRules } from "./rules";
import { SettingsStore } from "./settings";
import { MemoryStore, type Store } from "./store";
import { firebaseEnv, FirestoreStore } from "./store-firestore";
import { resultValidator } from "./validate";
import type { Result } from "@/lib/contracts.gen";
import { Watchdog } from "./watchdog";

const KEY = Symbol.for("lifefi.runtime");
const LOAD_WAIT_MS = 10_000;
/** A posture or people-count change is recorded once it has held this long (no flicker events). */
const CHANGE_HOLD_MS = 10_000;
type Holder = { [KEY]?: AppContext };

/** The running backend; starts it on first use. */
export function getRuntime(): AppContext {
  const g = globalThis as Holder;
  return (g[KEY] ??= start());
}

function start(): AppContext {
  // Not cached by getRuntime: every API call answers 500 "config" with the list (http.ts).
  if (config.problems.length) throw new ConfigError(config.problems);
  const log = createLogger();
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
  const store = openStore(log);
  const history = new History(store);
  const alerts = new AlertManager(profiles, () => settings.value.profile);
  alerts.setEscalateAfter(() => settings.value.notify.escalate_after_s);
  alerts.on("alert", (a) => store.saveAlert(a));
  // Firestore reads are async. Sensing starts once saved alerts are loaded, so a new alert never
  // reuses (and overwrites) a saved id; after LOAD_WAIT_MS it starts anyway with ids reserved
  // above any saved one (a monitor must not wait on the network).
  let loadedOk = false;
  const loading = store
    .loadAlerts()
    .then(async (saved) => {
      const restored = alerts.load(saved);
      loadedOk = true;
      log.info({ store: store.kind, history: await store.historySize(), alerts: restored }, "store opened");
    })
    .catch((err) => log.error({ error: (err as Error)?.message ?? String(err) }, "store load failed"));
  const ready = Promise.race([loading, new Promise((r) => setTimeout(r, LOAD_WAIT_MS).unref())]).then(() => {
    if (!loadedOk) alerts.reserveIds(Math.floor(Date.now() / 1000));
  });
  const purge = () => {
    void store
      .purge(settings.value.retention_days)
      .then((gone) => {
        if (gone) log.info({ rows: gone, days: settings.value.retention_days }, "history purged");
      })
      .catch((err) => log.warn({ error: (err as Error)?.message ?? String(err) }, "purge failed"));
  };
  purge();
  setInterval(purge, 3600_000).unref();
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
  const ctx: AppContext = { log, ackTokens, engine, alerts, watchdog, history, store, settings, profiles, state, hub, version: config.version };

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
  const changes = new ChangeTracker(CHANGE_HOLD_MS);
  const recordChanges = (r: Result) => {
    for (const e of changes.onResult(r)) store.addEvent(e);
  };
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
    guard("events", () => recordChanges(r));
    guard("recent", () => recentBuffer().add(r));
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

  void ready.then(() => {
    watchdog.start();
    rules.start();
    engine.start();
  });
  log.info({ engine: `${config.engineHost}:${config.enginePort}`, profile: settings.value.profile, config_hash: profiles.hash }, "life-fi backend up");
  if (settings.value.pin === DEFAULT_PIN) log.warn({}, `the PIN is still the default ${DEFAULT_PIN}: change it in Settings`);

  const shutdown = () => {
    if (statusPoll) clearInterval(statusPoll);
    watchdog.stop();
    rules.stop();
    alerts.stop();
    engine.stop();
    hub.closeAll();
    void store.close();
  };
  process.once("exit", shutdown);
  return ctx;
}

/** Firestore when FIREBASE_* is set, else memory (nothing kept). LIFEFI_DB=:memory: forces memory. */
function openStore(log: ReturnType<typeof createLogger>): Store {
  const fe = config.dbPath === ":memory:" ? null : firebaseEnv();
  if (fe) {
    try {
      const store = new FirestoreStore(fe, log);
      log.info({ project: fe.projectId, prefix: fe.prefix, emulator: fe.emulator }, "event store: firestore");
      return store;
    } catch (err) {
      // a bad key must not take the dashboard down: run unpersisted and say why
      log.error({ project: fe.projectId, error: (err as Error)?.message ?? String(err) }, "firestore setup failed, check FIREBASE_* in ui/.env; using memory only");
    }
  } else {
    log.warn({}, "event store: memory only (set FIREBASE_PROJECT_ID and credentials in ui/.env to persist)");
  }
  return new MemoryStore();
}
