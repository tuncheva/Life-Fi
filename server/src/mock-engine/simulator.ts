// Turns a scenario into a stream of schema-valid results (contracts/results.schema.json).
import type { EventType, Result } from "../contracts.gen.js";
import { DEFAULT_SCENE, SCENARIOS, type Scenario, type Scene } from "./scenarios.js";

const SUBCARRIERS = 52;
const WAVE_HZ = 10; // breathing waveform samples per second
const STEP_S = 0.5; // one result per 0.5 s

function randn(): number {
  // Box-Muller
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round = (x: number, d = 3) => Number(x.toFixed(d));

interface ActiveEvent {
  id: number;
  type: EventType;
  t: number;
  data: Record<string, unknown>;
}

export interface CalibrationState {
  state: "none" | "running" | "ok" | "stale";
  id: string | null;
  at: number | null;
}

export class Simulator {
  private scenario: Scenario;
  private scenarioStart: number;
  private phaseIndex = 0;
  private phaseStart: number;
  private phaseEntered = false;
  private nextEventId = 1;
  private active = new Map<EventType, ActiveEvent>();
  private posture: { label: NonNullable<Result["posture"]>["label"]; since: number } | null = null;
  private bootId: number;
  private bootAt: number;
  private wavePhase = 0;
  private csiBase: number[];
  source: "live" | "replay" = "live";
  calibration: CalibrationState;
  private calSeq = 1;
  readonly configHash = "mock01";
  readonly pipelineVersion = 2;
  private lastScene: Scene = DEFAULT_SCENE;

  constructor(initial: string, now: number) {
    const s = SCENARIOS[initial];
    if (!s) throw new Error(`unknown scenario '${initial}'`);
    this.scenario = s;
    this.scenarioStart = now;
    this.phaseStart = now;
    this.bootId = Math.floor(Math.random() * 2 ** 31);
    this.bootAt = now;
    this.csiBase = Array.from({ length: SUBCARRIERS }, (_, k) => -42 + 1.5 * Math.sin((k / SUBCARRIERS) * 4 * Math.PI) + 0.4 * randn());
    this.calibration = { state: "ok", id: `cal-${String(this.calSeq++).padStart(4, "0")}`, at: now - 300_000 };
  }

  get scenarioName(): string {
    return this.scenario.name;
  }

  get phaseLabel(): string {
    return this.scenario.phases[this.phaseIndex]?.label ?? "";
  }

  setScenario(name: string, now: number): boolean {
    const s = SCENARIOS[name];
    if (!s) return false;
    this.scenario = s;
    this.scenarioStart = now;
    this.phaseIndex = 0;
    this.phaseStart = now;
    this.phaseEntered = false;
    return true;
  }

  reboot(now: number): void {
    this.bootId = Math.floor(Math.random() * 2 ** 31);
    this.bootAt = now;
    this.active.clear(); // the engine lost its events; ids start over
    this.nextEventId = 1;
    this.posture = null;
  }

  startCalibration(now: number, durationS: number): void {
    this.calibration = { state: "running", id: null, at: now };
    setTimeout(() => {
      this.calibration = { state: "ok", id: `cal-${String(this.calSeq++).padStart(4, "0")}`, at: Date.now() };
    }, durationS * 1000);
  }

  /** Current motion level, used to refuse an empty calibration when someone moves. */
  currentMotion(): number {
    return this.lastScene.motion;
  }

  private currentScene(now: number): Scene {
    // advance phases
    for (;;) {
      const phase = this.scenario.phases[this.phaseIndex];
      if (!phase) break;
      if (now - this.phaseStart < phase.for_s * 1000) break;
      this.phaseStart += phase.for_s * 1000;
      this.phaseIndex++;
      this.phaseEntered = false;
      if (this.phaseIndex >= this.scenario.phases.length) {
        if (this.scenario.loop) {
          this.phaseIndex = 0;
          this.scenarioStart = this.phaseStart;
        } else {
          const next = SCENARIOS[this.scenario.then ?? "normal"] ?? SCENARIOS.normal!;
          this.scenario = next;
          this.phaseIndex = 0;
          this.scenarioStart = this.phaseStart;
        }
      }
    }
    const phase = this.scenario.phases[this.phaseIndex]!;
    const scene: Scene = { ...DEFAULT_SCENE, ...this.scenario.base, ...phase.scene };
    if (!this.phaseEntered) {
      this.phaseEntered = true;
      if (scene.reboot) this.reboot(now);
    }
    return scene;
  }

  /** Produces the next result, or null when the scene is silent. */
  step(now: number): Result | null {
    const scene = this.currentScene(now);
    this.lastScene = scene;
    if (scene.silent) return null;

    const warmup = scene.warmup || now - this.bootAt < 3000;

    // posture state machine: null when not present, "unknown" until something is known
    if (scene.presence !== "present") {
      this.posture = null;
    } else if (scene.posture !== null && (!this.posture || this.posture.label !== scene.posture)) {
      this.posture = { label: scene.posture, since: now };
    }

    // events: diff the wanted set against the active set (never during warm-up)
    const events: Result["events"] = [];
    const wanted = new Set<EventType>(warmup ? [] : scene.events);
    for (const [type, ev] of this.active) {
      if (!wanted.has(type)) {
        events.push({ id: ev.id, type, state: "cleared", t: now, data: {} });
        this.active.delete(type);
      }
    }
    for (const type of wanted) {
      if (!this.active.has(type)) {
        const ev: ActiveEvent = { id: this.nextEventId++, type, t: now, data: this.eventData(type) };
        this.active.set(type, ev);
        events.push({ id: ev.id, type, state: "active", t: now, data: ev.data });
      }
    }

    // numbers
    const motion = clamp(scene.motion * (0.85 + 0.3 * Math.random()) + 0.004 * Math.abs(randn()), 0, 1);
    const breathingValid = scene.breathing !== null && motion < 0.25 && !warmup;
    const bpm = scene.breathing;
    const wave: number[] = [];
    if (scene.breathing !== null) {
      const f = scene.breathing / 60;
      for (let i = 0; i < WAVE_HZ * STEP_S; i++) {
        this.wavePhase += (2 * Math.PI * f) / WAVE_HZ;
        wave.push(round(0.2 * Math.sin(this.wavePhase) + 0.02 * randn() + motion * 0.3 * randn()));
      }
    } else {
      for (let i = 0; i < WAVE_HZ * STEP_S; i++) wave.push(round(0.015 * randn() + motion * 0.3 * randn()));
    }

    const S = scene.presence === "empty" ? 0.02 : scene.presence === "uncertain" ? 0.08 : 0.2 + 0.1 * motion;
    const B = breathingValid ? 0.7 + 0.15 * Math.random() : 0.03 + 0.03 * Math.random();

    const breathMod = scene.breathing !== null ? 0.3 * Math.sin(this.wavePhase) : 0;
    const csi: number[][] = [];
    for (let r = 0; r < 5; r++) {
      csi.push(this.csiBase.map((b, k) => round(b + breathMod * Math.sin(k / 7) + motion * 3 * randn() + 0.15 * randn(), 1)));
    }

    const rate = scene.rate_hz ?? 88 + 1.5 * randn();
    const calAge = this.calibration.at === null ? null : Math.max(0, Math.round((now - this.calibration.at) / 1000));

    return {
      type: "result",
      v: 2,
      ts: now,
      t_rx_last_us: now * 1000 - 6000,
      node: 1,
      boot_id: this.bootId,
      source: this.source,
      config_hash: this.configHash,
      pipeline_version: this.pipelineVersion,
      health: {
        rate_hz: round(Math.max(0, rate), 1),
        loss_udp: round(0.003 + 0.002 * Math.random()),
        loss_air: round(0.02 + 0.02 * Math.random()),
        invalid_ratio: 0,
        rejected: { layout: 0, gain_invalid: 0 },
        warmup,
      },
      calibration: { state: this.calibration.state, id: this.calibration.id, age_s: calAge },
      presence: {
        value: scene.presence === "present",
        state: scene.presence,
        S: round(S + 0.01 * randn()),
        B: round(B),
        M: round(motion),
      },
      motion: round(motion),
      posture: this.posture ? { label: this.posture.label, since: this.posture.since, src: this.posture.label === "standing" ? "walking" : "transitions" } : null,
      count: scene.count === null ? null : { value: scene.count, p: scene.count === 1 ? [0.9, 0.1] : [0.2, 0.8], src: "model" },
      breathing: {
        bpm: breathingValid && bpm !== null ? round(bpm + 0.4 * randn(), 1) : null,
        confidence: round(breathingValid ? 0.75 + 0.2 * Math.random() : 0.1 + 0.2 * Math.random(), 2),
        valid: breathingValid,
        wave,
      },
      csi,
      events,
      active: [...this.active.values()].map((e) => e.id),
    };
  }

  private eventData(type: EventType): Record<string, unknown> {
    switch (type) {
      case "fall":
        return { peak: round(0.85 + 0.1 * Math.random(), 2) };
      case "fainted_suspected":
        return { still_s: 20 };
      case "no_breathing":
        return { since_s: 12 };
      default:
        return {};
    }
  }

  statusData(now: number): Record<string, unknown> {
    const calAge = this.calibration.at === null ? null : Math.round((now - this.calibration.at) / 1000);
    return {
      engine: {
        version: "mock-0.1.0",
        pipeline_version: this.pipelineVersion,
        config_hash: this.configHash,
        source: this.source,
        uptime_s: Math.floor((now - this.bootAt) / 1000),
        inference_ms: { p50: 3.2, p95: 7.9 },
        models: [{ name: "transitions", loaded: true, pipeline_version: 2 }],
        calibration: { state: this.calibration.state, id: this.calibration.id, age_s: calAge },
        recording: null,
        active_events: [...this.active.values()].map((e) => ({ id: e.id, type: e.type, t: e.t, data: e.data })),
        mock: { scenario: this.scenario.name, phase: this.phaseLabel },
      },
      device: this.lastScene.silent
        ? null
        : {
            node: 1,
            boot_id: this.bootId,
            fw_version: "mock-0.1.0",
            rssi_dbm: -52 + Math.round(2 * randn()),
            channel: 6,
            uptime_s: Math.floor((now - this.bootAt) / 1000) + 3600,
            rate_hz: this.lastScene.rate_hz ?? 88,
            loss_udp: 0.004,
            loss_air: 0.03,
            rejected: { layout: 0, gain_invalid: 0 },
            queue_drops: 0,
            send_errors: 0,
            wifi_disconnects: 1,
            ping_rate_hz: 100,
            ping_timeouts_last_s: 0,
            last_status_us: now * 1000,
          },
    };
  }
}
