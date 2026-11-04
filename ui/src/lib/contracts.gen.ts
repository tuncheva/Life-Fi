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
    /**
     * Breaths per minute of the last 30 s window; null unless `valid`
     */
    bpm: number | null;
    confidence: number;
    valid: boolean;
    /**
     * Breathing waveform samples produced in this window
     */
    wave: number[];
    /**
     * Why bpm is null right now, for the UI wording; null while bpm is shown. warming_up: under 30 s of packets; no_person: presence is not present; motion: the person moves (the rate needs about 30 s of stillness); noise: no clear peak above the noise floor; unstable: windows disagree or too few are valid. Optional: older engines leave it out.
     */
    reason?: "warming_up" | "no_person" | "motion" | "noise" | "unstable" | null;
  };
  /**
   * EXPERIMENTAL heart rate (lifefi.heart): breathing harmonics removed, from the last 30 s of raw CSI every 5 s, only while someone is present and still. One ESP32 link is near its limit for 0.1-0.5 mm chest motion, so this is NOT a medical measurement and the UI must label it experimental. null when the engine has no heart estimator or rules.yaml heart.publish is false; before the first window it is an object with bpm null and reason warming_up. Optional: older engines leave it out.
   */
  heart?: null | {
    /**
     * Beats per minute: median of the valid windows of the last 60 s; null unless `valid`
     */
    bpm: number | null;
    /**
     * true only when enough recent windows pass every lifefi.heart check and agree
     */
    valid: boolean;
    /**
     * Share of the allowed heart-band power near the peak in the last window (lifefi.heart confidence); 0 when no window ran
     */
    confidence: number;
    /**
     * Peak vs mean power of the allowed band in the last window; null when no window ran
     */
    snr?: number | null;
    /**
     * Share of the windows of the last 60 s that passed every check
     */
    valid_share?: number;
    /**
     * Why bpm is null right now, for the UI wording; null while bpm is shown. warming_up: under 30 s of packets; no_person: presence is not present; motion: the person moves (the rate needs about 30 s of stillness); noise: no clear peak above the noise floor; unstable: windows disagree or too few are valid.
     */
    reason: "warming_up" | "no_person" | "motion" | "noise" | "unstable" | null;
  };
  /**
   * Rows of exactly 52 log-amplitude (dB) values, the most recent frames of this window, for the heatmap only. (Length is checked by scripts/check-contracts.mjs, not by the schema, so the generated type stays number[][].)
   */
  csi: number[][];
  /**
   * Experimental (lifefi.position): distance of the moving or breathing body from the link, from the last 10 s of packets. One link gives no direction, so this is a radius. Measured only while the person moves, held while they stay still. null while warming up or without enough packets. Optional: older engines leave it out.
   */
  position?: null | {
    /**
     * true when the disturbance stands above the noise and d_m is set
     */
    valid: boolean;
    /**
     * Kalman-smoothed distance in metres (0.2..8)
     */
    d_m: number | null;
    /**
     * Standard deviation of d_m in metres
     */
    d_sd: number | null;
    /**
     * Body disturbance, dB re 1 dB²
     */
    R_db: number;
    /**
     * White-noise level left in the 0.25 s bin means, dB re 1 dB²
     */
    noise_db: number;
    /**
     * true while the person stands still: d_m is the last distance measured while they moved (stillness would read as far away)
     */
    held: boolean;
    /**
     * near < 1.5 m, middle 1.5-3.5 m, far beyond; null without a distance
     */
    zone: null | ("near" | "middle" | "far");
    /**
     * How many people to mark: the board's own head count from its USB log, at least 1 while presence is present, 0 when empty. One link cannot place them separately.
     */
    people: number;
    /**
     * The taught spot of this room from the spot model (engine/lifefi/spots.py, ml/train_spots.py), next to the distance estimate; null without a model or enough packets. Optional.
     */
    spot?: null | {
      name: string;
      /**
       * Smoothed probability of that spot
       */
      p: number;
      /**
       * The distance measured for that spot when it was taught; null for `empty`
       */
      d_m: number | null;
      /**
       * The model's cross-session (leave-one-session-out) balanced accuracy from ml/train_spots.py; null when unknown (one session, or an older model file). Optional.
       */
      model_accuracy?: number | null;
      /**
       * true only when model_accuracy >= 1/k + rules.yaml spots.reliable_margin; show the spot name only then. Optional.
       */
      reliable?: boolean;
    };
    /**
     * How far d_m can be trusted: none when valid is false; low when quality_reasons is non-empty; else medium. Optional: older engines leave it out.
     */
    quality?: "none" | "low" | "medium";
    /**
     * Why quality is low: transmitter_not_fixed (rules.yaml position.transmitter_fixed is false, e.g. a phone hotspot); no_distance_fit (no saved position_fit at >= 2 distances); no_empty_calibration (no empty-room disturbance levels); low_packet_rate (< 20 Hz over the 10 s window). Optional.
     */
    quality_reasons?: ("transmitter_not_fixed" | "no_distance_fit" | "no_empty_calibration" | "low_packet_rate")[];
  };
  /**
   * Is anybody in the link area at all (lifefi.occupancy): from the body disturbance P of the last 4 s as an absolute level, no calibration needed. Independent of `position`, which needs 10 s of packets. null while warming up or with fewer than 8 Hz x 4 s of packets. Optional: older engines leave it out.
   */
  occupancy?: null | {
    /**
     * occupied when p >= p_on; empty when p <= p_off and presence is not `present` (never empty while presence sees someone); unsure otherwise. Changes only after 3 ticks of the same raw state
     */
    state: "empty" | "occupied" | "unsure";
    /**
     * Logistic of log10 P fitted on the labelled spot sessions (ml/eval_position.py); NOT a calibrated probability for a new room
     */
    p: number;
  };
  /**
   * The radio link and the board's own view of it. Optional: older engines leave it out.
   */
  link?: {
    /**
     * Mean RSSI of the packets of the last 2 s, null when none arrived
     */
    rssi_dbm: number | null;
    /**
     * The firmware's own estimate from its USB log line (firmware/src/estimator.c), null when not reading the board over USB or it has not logged for 5 s
     */
    board: null | {
      state: "calibrating" | "empty" | "present" | "uncertain";
      /**
       * Head count estimate, null when the board does not know ("?")
       */
      people: number | null;
    };
  };
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
