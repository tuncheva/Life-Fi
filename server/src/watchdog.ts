// Watchdog (plan-v2 §7.1): a silent sensor must never look like "all OK".
//   engine disconnected for > 10 s, no result for > 10 s, rate_hz < 50 for 60 s,
//   or no device status for 10 s → sensor_offline in every profile. Cleared when
//   results are healthy for 10 s. The 10 s grace on a disconnect means an engine
//   restart, or the server starting before the engine, does not notify the phone.
import type { Result } from "./contracts.gen.js";

export interface WatchdogSink {
  raise(reason: string): void;
  clear(): void;
}

export interface WatchdogOptions {
  noResultMs?: number;
  lowRateHz?: number;
  lowRateForMs?: number;
  noStatusMs?: number;
  healthyForMs?: number;
  disconnectGraceMs?: number;
}

export class Watchdog {
  private lastResultAt: number | null = null;
  private lowRateSince: number | null = null;
  private lastDeviceStatusAt: number | null = null;
  private healthySince: number | null = null;
  private offline = false;
  private engineConnected = false;
  private disconnectedSince: number;
  private timer: NodeJS.Timeout | null = null;
  private readonly opt: Required<WatchdogOptions>;
  reason: string | null = null;

  constructor(
    private readonly sink: WatchdogSink,
    private readonly now: () => number = () => Date.now(),
    opt: WatchdogOptions = {},
  ) {
    this.opt = {
      noResultMs: opt.noResultMs ?? 10_000,
      lowRateHz: opt.lowRateHz ?? 50,
      lowRateForMs: opt.lowRateForMs ?? 60_000,
      noStatusMs: opt.noStatusMs ?? 10_000,
      healthyForMs: opt.healthyForMs ?? 10_000,
      disconnectGraceMs: opt.disconnectGraceMs ?? 10_000,
    };
    this.disconnectedSince = this.now();
  }

  start(intervalMs = 1000): void {
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  setEngineConnected(v: boolean): void {
    if (v === this.engineConnected) return;
    this.engineConnected = v;
    if (!v) {
      this.disconnectedSince = this.now();
      this.tick();
    }
  }

  onResult(r: Result): void {
    const t = this.now();
    this.lastResultAt = t;
    if (r.health.rate_hz < this.opt.lowRateHz && !r.health.warmup) {
      this.lowRateSince ??= t;
    } else {
      this.lowRateSince = null;
    }
  }

  /** Call with device.last_status_us from get_status (µs since epoch), or null when there is no device yet. */
  onDeviceStatus(lastStatusUs: number | null): void {
    this.lastDeviceStatusAt = lastStatusUs === null ? null : Math.floor(lastStatusUs / 1000);
  }

  get isOffline(): boolean {
    return this.offline;
  }

  tick(): void {
    const t = this.now();
    let reason: string | null = null;
    if (!this.engineConnected) {
      if (t - this.disconnectedSince < this.opt.disconnectGraceMs) {
        this.healthySince = null; // not healthy, but not offline yet either
        return;
      }
      reason = "engine disconnected";
    } else if (this.lastResultAt === null || t - this.lastResultAt > this.opt.noResultMs) reason = "no result for 10 s";
    else if (this.lowRateSince !== null && t - this.lowRateSince > this.opt.lowRateForMs) reason = "CSI rate below 50 Hz for 60 s";
    else if (this.lastDeviceStatusAt !== null && t - this.lastDeviceStatusAt > this.opt.noStatusMs) reason = "no device status for 10 s";

    if (reason) {
      this.healthySince = null;
      if (!this.offline || this.reason !== reason) {
        this.offline = true;
        this.reason = reason;
        this.sink.raise(reason);
      }
      return;
    }
    this.healthySince ??= t;
    if (this.offline && t - this.healthySince >= this.opt.healthyForMs) {
      this.offline = false;
      this.reason = null;
      this.sink.clear();
    }
  }
}
