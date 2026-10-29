import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Watchdog, type WatchdogSink } from "../src/watchdog.js";
import type { Result } from "../src/contracts.gen.js";

const T0 = 1_700_000_000_000;

function mkResult(now: number, o: { rate_hz?: number; warmup?: boolean } = {}): Result {
  return {
    type: "result",
    v: 2,
    ts: now,
    t_rx_last_us: now * 1000,
    node: 1,
    boot_id: 1,
    source: "live",
    config_hash: "x",
    pipeline_version: 2,
    health: { rate_hz: o.rate_hz ?? 88, loss_udp: 0, loss_air: 0, invalid_ratio: 0, rejected: { layout: 0, gain_invalid: 0 }, warmup: o.warmup ?? false },
    calibration: { state: "ok", id: "cal-0001", age_s: 10 },
    presence: { value: true, state: "present", S: 0.2, B: 0.7, M: 0.03 },
    motion: 0.03,
    posture: null,
    count: null,
    breathing: { bpm: null, confidence: 0.1, valid: false, wave: [] },
    csi: [],
    events: [],
    active: [],
  };
}

describe("Watchdog", () => {
  let now: number;
  let raised: string[];
  let cleared: number;
  let sink: WatchdogSink;
  let wd: Watchdog;

  /** Advances the clock one second at a time so every 1 s tick sees the right `now`. */
  const advance = (ms: number) => {
    let left = ms;
    while (left > 0) {
      const step = Math.min(1000, left);
      now += step;
      vi.advanceTimersByTime(step);
      left -= step;
    }
  };

  /** Feeds a healthy result and a fresh device status every second for `ms`. */
  const healthyFor = (ms: number, rate_hz = 88) => {
    let left = ms;
    while (left > 0) {
      const step = Math.min(1000, left);
      wd.onResult(mkResult(now, { rate_hz }));
      wd.onDeviceStatus(now * 1000);
      advance(step);
      left -= step;
    }
  };

  beforeEach(() => {
    vi.useFakeTimers();
    now = T0;
    raised = [];
    cleared = 0;
    sink = { raise: (r) => raised.push(r), clear: () => cleared++ };
    wd = new Watchdog(sink, () => now);
  });

  afterEach(() => {
    wd.stop();
    vi.useRealTimers();
  });

  it("raises when the engine is disconnected", () => {
    wd.start();
    expect(raised).toEqual([]);
    expect(wd.isOffline).toBe(false);
    advance(1000);
    expect(raised).toEqual(["engine disconnected"]);
    expect(wd.isOffline).toBe(true);
    expect(wd.reason).toBe("engine disconnected");
    // not raised again while the reason is unchanged
    advance(5000);
    expect(raised).toHaveLength(1);
  });

  it("setEngineConnected(false) ticks immediately", () => {
    wd.setEngineConnected(true);
    wd.start();
    wd.setEngineConnected(false);
    expect(raised).toEqual(["engine disconnected"]);
  });

  it("raises when connected but no result arrives for more than 10 s", () => {
    wd.setEngineConnected(true);
    wd.start();
    wd.onResult(mkResult(now));
    wd.onDeviceStatus(now * 1000);
    advance(10_000);
    expect(raised).toEqual([]);
    expect(wd.isOffline).toBe(false);
    advance(1000);
    expect(raised).toEqual(["no result for 10 s"]);
    expect(wd.isOffline).toBe(true);
  });

  it("raises when connected and no result has ever arrived", () => {
    wd.setEngineConnected(true);
    wd.start();
    advance(1000);
    expect(raised).toEqual(["no result for 10 s"]);
  });

  it("raises when rate_hz stays below 50 for more than 60 s", () => {
    wd.setEngineConnected(true);
    wd.start();
    healthyFor(60_000, 30);
    expect(raised).toEqual([]);
    healthyFor(1000, 30);
    expect(raised).toEqual(["CSI rate below 50 Hz for 60 s"]);
    expect(wd.isOffline).toBe(true);
  });

  it("a low rate during warm-up does not count", () => {
    wd.setEngineConnected(true);
    wd.start();
    for (let i = 0; i < 70; i++) {
      wd.onResult(mkResult(now, { rate_hz: 30, warmup: true }));
      wd.onDeviceStatus(now * 1000);
      advance(1000);
    }
    expect(raised).toEqual([]);
  });

  it("a rate that recovers resets the 60 s window", () => {
    wd.setEngineConnected(true);
    wd.start();
    healthyFor(40_000, 30);
    healthyFor(1000, 88);
    healthyFor(40_000, 30);
    expect(raised).toEqual([]);
  });

  it("raises when the device status is older than 10 s", () => {
    wd.setEngineConnected(true);
    wd.start();
    wd.onResult(mkResult(now));
    wd.onDeviceStatus((now - 10_001) * 1000);
    wd.onResult(mkResult(now));
    advance(1000);
    expect(raised).toEqual(["no device status for 10 s"]);
    expect(wd.isOffline).toBe(true);
  });

  it("a null device status (no device yet) does not raise", () => {
    wd.setEngineConnected(true);
    wd.start();
    wd.onDeviceStatus(null);
    healthyFor(3000);
    wd.onDeviceStatus(null);
    advance(1000);
    expect(raised).toEqual([]);
  });

  it("clears after 10 s of healthy results once raised", () => {
    wd.start();
    advance(1000);
    expect(raised).toEqual(["engine disconnected"]);

    wd.setEngineConnected(true);
    healthyFor(9000);
    expect(cleared).toBe(0);
    expect(wd.isOffline).toBe(true);
    healthyFor(2000);
    expect(cleared).toBe(1);
    expect(wd.isOffline).toBe(false);
    expect(wd.reason).toBeNull();

    // stays clear and does not clear again
    healthyFor(30_000);
    expect(cleared).toBe(1);
    expect(raised).toHaveLength(1);
  });

  it("an unhealthy tick in the middle restarts the healthy window", () => {
    wd.start();
    advance(1000);
    expect(raised).toEqual(["engine disconnected"]);

    wd.setEngineConnected(true);
    healthyFor(8000);
    // one tick without any result in the last 10 s is not possible here, so drop the connection briefly
    wd.setEngineConnected(false);
    expect(raised).toHaveLength(1); // same reason, no re-raise
    wd.setEngineConnected(true);
    healthyFor(9000);
    expect(cleared).toBe(0);
    healthyFor(2000);
    expect(cleared).toBe(1);
  });

  it("re-raises when the reason changes", () => {
    wd.start();
    advance(1000);
    expect(raised).toEqual(["engine disconnected"]);

    wd.setEngineConnected(true);
    advance(1000);
    expect(raised).toEqual(["engine disconnected", "no result for 10 s"]);
    expect(wd.reason).toBe("no result for 10 s");

    wd.onResult(mkResult(now));
    wd.onDeviceStatus((now - 20_000) * 1000);
    advance(1000);
    expect(raised).toEqual(["engine disconnected", "no result for 10 s", "no device status for 10 s"]);

    // the same reason again does not re-raise
    wd.onResult(mkResult(now));
    advance(1000);
    expect(raised).toHaveLength(3);
    expect(cleared).toBe(0);
  });

  it("honours custom thresholds", () => {
    wd.stop();
    wd = new Watchdog(sink, () => now, { noResultMs: 2000, healthyForMs: 3000 });
    wd.setEngineConnected(true);
    wd.start();
    wd.onResult(mkResult(now));
    advance(2000);
    expect(raised).toEqual([]);
    advance(1000);
    expect(raised).toEqual(["no result for 10 s"]);
    // the healthy window starts at the first healthy tick, so 3 s of health needs 4 ticks
    healthyFor(3000);
    expect(cleared).toBe(0);
    healthyFor(1000);
    expect(cleared).toBe(1);
  });
});
