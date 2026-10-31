/* eslint-disable */
/**
 * GENERATED from contracts/results.schema.json by scripts/gen-types.mjs.
 * Do not edit. Change the schema and run `npm run gen:types`.
 */

export type ActivityLabel = "none" | "walking" | "sit_down" | "lie_down" | "rise" | "fall";
export type EventType =
  | "fall"
  | "fainted_suspected"
  | "no_breathing"
  | "presence_uncertain"
  | "recalibrate_needed"
  | "bed_exit"
  | "sensor_offline"
  | "long_inactivity"
  | "after_hours_occupancy";

/**
 * One result from the engine to the server, every 0.5 s (plan-v2 §4.5, version 2). Also the payload of the `result` WebSocket message.
 */
export interface Result {
  type: "result";
  v: 2;
  /**
   * Host wall-clock, ms since epoch, when the result was produced
   */
  ts: number;
  /**
   * Host wall-clock, µs since epoch, of the last CSI frame used
   */
  t_rx_last_us: number;
  node: number;
  boot_id: number;
  source: "live" | "replay";
  /**
   * Hash of rules.yaml + profiles.yml the engine is running with
   */
  config_hash: string;
  pipeline_version: number;
  health: {
    rate_hz: number;
    loss_udp: number;
    loss_air: number;
    invalid_ratio: number;
    rejected: {
      layout: number;
      gain_invalid: number;
      [k: string]: number | undefined;
    };
    /**
     * True for 3 s after a new boot_id and until every detector has its history. No event can start during warm-up.
     */
    warmup: boolean;
  };
  calibration: {
    state: "none" | "running" | "ok" | "stale";
    id: string | null;
    age_s: number | null;
  };
  presence: {
    value: boolean;
    state: "empty" | "present" | "uncertain";
    /**
     * Static deviation
     */
    S: number;
    /**
     * Breathing-band energy
     */
    B: number;
    /**
     * Motion
     */
    M: number;
  };
  motion: number;
  /**
   * null when not present. label is unknown until the first transition or walking has been seen.
   */
  posture: null | {
    label: "unknown" | "standing" | "sitting" | "lying";
    /**
     * ms since epoch of the last known transition
     */
    since: number;
    src: "transitions" | "walking" | "start";
  };
  /**
   * null when the count model is not loaded.
   */
  count: null | {
    /**
     * 2 means 2+
     */
    value: 1 | 2;
    /**
     * @minItems 2
     * @maxItems 2
     */
    p: [number, number];
    src: "model";
  };
  /**
   * The movement model's guess for the last window: the top label, its probability and every class's probability. Experimental (below a constant guess on unseen people, docs/models.md): the dashboard shows it in the technical section only. null when no model is loaded or the window is less than 90 % valid.
   */
  activity: null | {
    label: ActivityLabel;
    p: number;
    probs: {
      [k: string]: number | undefined;
    };
    src: "model";
  };
  breathing: {
    bpm: number | null;
    confidence: number;
    valid: boolean;
    /**
     * Breathing waveform samples produced in this window
     */
    wave: number[];
  };
  /**
   * Rows of exactly 52 log-amplitude (dB) values, the most recent frames of this window, for the heatmap only. (Length is checked by scripts/check-contracts.mjs, not by the schema, so the generated type stays number[][].)
   */
  csi: number[][];
  /**
   * Only the changes in this window
   */
  events: Event[];
  /**
   * Ids of every currently active event. The server reconciles its open alerts against this list on every result.
   */
  active: number[];
}
export interface Event {
  /**
   * Unique per engine run, and not reused by the next run (the engine seeds them from its start time), so the server can reconcile alerts across engine restarts
   */
  id: number;
  type: EventType;
  state: "active" | "cleared";
  /**
   * ms since epoch of the change
   */
  t: number;
  data: {};
}
