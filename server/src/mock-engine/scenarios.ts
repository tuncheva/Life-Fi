// Scripted scenarios for the mock engine. Each scenario is a list of phases;
// the simulator walks through them and emits schema-valid results.
import type { EventType, Result } from "../contracts.gen.js";

export type PostureLabel = NonNullable<Result["posture"]>["label"];

export interface Scene {
  presence: "empty" | "present" | "uncertain";
  /** null when nobody is there */
  posture: PostureLabel | null;
  /** mean motion level 0..1 */
  motion: number;
  /** breaths per minute; null = no valid breathing signal */
  breathing: number | null;
  /** 1, 2 (= 2+) or null when the count model is "not loaded" */
  count: 1 | 2 | null;
  /** engine events active in this phase */
  events: EventType[];
  /** emit no results at all (sensor / engine silent) */
  silent: boolean;
  /** report warm-up */
  warmup: boolean;
  /** start a new boot_id at the start of this phase */
  reboot: boolean;
  /** override CSI rate */
  rate_hz: number | null;
}

export interface Phase {
  for_s: number;
  /** a label for logs and the dev panel */
  label: string;
  scene: Partial<Scene>;
}

export interface Scenario {
  name: string;
  description: string;
  /** when the last phase ends: loop, or switch to `then` */
  loop: boolean;
  then?: string;
  base: Partial<Scene>;
  phases: Phase[];
}

export const DEFAULT_SCENE: Scene = {
  presence: "present",
  posture: "lying",
  motion: 0.03,
  breathing: 14,
  count: 1,
  events: [],
  silent: false,
  warmup: false,
  reboot: false,
  rate_hz: null,
};

const lying = (s = 60, extra: Partial<Scene> = {}): Phase => ({ for_s: s, label: "lying still", scene: { posture: "lying", motion: 0.03, breathing: 14, ...extra } });
const sitting = (s = 60, extra: Partial<Scene> = {}): Phase => ({ for_s: s, label: "sitting", scene: { posture: "sitting", motion: 0.06, breathing: 15, ...extra } });
const walking = (s = 15, extra: Partial<Scene> = {}): Phase => ({ for_s: s, label: "walking", scene: { posture: "standing", motion: 0.65, breathing: null, ...extra } });
const transition = (label: string, posture: PostureLabel, s = 4): Phase => ({ for_s: s, label, scene: { posture, motion: 0.35, breathing: null } });

export const SCENARIOS: Record<string, Scenario> = {
  normal: {
    name: "normal",
    description: "One person at home: lying, sits up, walks around, sits down. Loops.",
    loop: true,
    base: {},
    phases: [
      lying(90),
      transition("get up", "sitting"),
      sitting(45),
      transition("stand up", "standing"),
      walking(20),
      transition("sit down", "sitting"),
      sitting(60),
      transition("lie down", "lying"),
    ],
  },

  empty: {
    name: "empty",
    description: "Empty room, calibrated. Loops.",
    loop: true,
    base: { presence: "empty", posture: null, motion: 0.005, breathing: null, count: null },
    phases: [{ for_s: 60, label: "empty", scene: {} }],
  },

  leave_room: {
    name: "leave_room",
    description: "Person sits, walks out, room becomes empty. Then: empty.",
    loop: false,
    then: "empty",
    base: {},
    phases: [
      sitting(10),
      transition("stand up", "standing"),
      walking(6),
      { for_s: 5, label: "exit burst decays", scene: { presence: "present", posture: "standing", motion: 0.15, breathing: null } },
      { for_s: 60, label: "settling to empty", scene: { presence: "present", posture: "standing", motion: 0.01, breathing: null } },
    ],
  },

  enter_room: {
    name: "enter_room",
    description: "Empty room, person walks in and sits down. Then: normal.",
    loop: false,
    then: "normal",
    base: {},
    phases: [
      { for_s: 10, label: "empty", scene: { presence: "empty", posture: null, motion: 0.005, breathing: null, count: null } },
      walking(8, { posture: "unknown" }),
      transition("sit down", "sitting"),
      sitting(10),
    ],
  },

  fall: {
    name: "fall",
    description: "Walking, a fall, 20 s still -> fainted_suspected, then gets up. Then: normal.",
    loop: false,
    then: "normal",
    base: {},
    phases: [
      walking(8),
      { for_s: 1.5, label: "FALL", scene: { posture: "unknown", motion: 0.95, breathing: null } },
      { for_s: 20, label: "fall: still on the floor", scene: { posture: "lying", motion: 0.01, breathing: 16, events: ["fall"] } },
      { for_s: 40, label: "fainted suspected", scene: { posture: "lying", motion: 0.005, breathing: 16, events: ["fall", "fainted_suspected"] } },
      { for_s: 5, label: "gets up", scene: { posture: "standing", motion: 0.5, breathing: null, events: [] } },
      sitting(5),
    ],
  },

  breath_hold: {
    name: "breath_hold",
    description: "Lying, breathing stops for 30 s -> no_breathing after 12 s, then resumes. Then: normal.",
    loop: false,
    then: "normal",
    base: {},
    phases: [
      lying(12),
      { for_s: 12, label: "breath hold (engine counting)", scene: { posture: "lying", motion: 0.01, breathing: null } },
      { for_s: 18, label: "NO BREATHING", scene: { posture: "lying", motion: 0.01, breathing: null, events: ["no_breathing"] } },
      { for_s: 10, label: "breathing again", scene: { posture: "lying", motion: 0.02, breathing: 15, events: [] } },
    ],
  },

  sensor_offline: {
    name: "sensor_offline",
    description: "Normal, then the engine goes silent for 25 s, reboots with warm-up, recovers. Then: normal.",
    loop: false,
    then: "normal",
    base: {},
    phases: [
      lying(5),
      { for_s: 25, label: "SILENT", scene: { silent: true } },
      { for_s: 4, label: "warm-up after reboot", scene: { reboot: true, warmup: true, presence: "uncertain", posture: null, motion: 0, breathing: null, rate_hz: 40 } },
      lying(5),
    ],
  },

  low_rate: {
    name: "low_rate",
    description: "CSI rate drops below 50 Hz for 90 s (watchdog -> sensor_offline after 60 s). Then: normal.",
    loop: false,
    then: "normal",
    base: {},
    phases: [lying(5), { for_s: 90, label: "rate 30 Hz", scene: { rate_hz: 30 } }, lying(15)],
  },

  two_people: {
    name: "two_people",
    description: "Two people moving: count 2, breathing invalid. Loops.",
    loop: true,
    base: { count: 2, breathing: null },
    phases: [
      { for_s: 30, label: "two people, moving", scene: { posture: "standing", motion: 0.45 } },
      { for_s: 30, label: "two people, sitting", scene: { posture: "sitting", motion: 0.12 } },
    ],
  },

  uncertain: {
    name: "uncertain",
    description: "Still presence with no breathing ever seen -> presence uncertain. Loops.",
    loop: true,
    base: { presence: "uncertain", posture: "unknown", motion: 0.005, breathing: null, count: null, events: ["presence_uncertain"] },
    phases: [{ for_s: 60, label: "uncertain", scene: {} }],
  },

  warmup: {
    name: "warmup",
    description: "Fresh boot: 10 s warm-up with no calibration. Then: normal.",
    loop: false,
    then: "normal",
    base: {},
    phases: [{ for_s: 10, label: "warm-up", scene: { reboot: true, warmup: true, presence: "uncertain", posture: null, motion: 0, breathing: null } }],
  },

  clinic_night: {
    name: "clinic_night",
    description: "Patient in bed, then leaves the bed (bed_exit), then returns. Then: normal.",
    loop: false,
    then: "normal",
    base: {},
    phases: [
      lying(15),
      transition("get up", "sitting"),
      { for_s: 30, label: "out of bed", scene: { posture: "standing", motion: 0.3, breathing: null, events: ["bed_exit"] } },
      transition("lie down", "lying"),
      lying(10, { events: [] }),
    ],
  },
};

export function listScenarios(): { name: string; description: string; duration_s: number; loop: boolean }[] {
  return Object.values(SCENARIOS).map((s) => ({
    name: s.name,
    description: s.description,
    duration_s: s.phases.reduce((a, p) => a + p.for_s, 0),
    loop: s.loop,
  }));
}
