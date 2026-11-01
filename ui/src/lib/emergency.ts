// Emergency screen prototype: a made-up 3-floor school and a client-side
// simulation of an incident (fire, collapse, lockdown). Nothing here talks to
// the server or the sensors; the page labels it as simulated. `step` is pure:
// randomness comes from a seed kept in the state, the wall clock is passed in.
import { POSTURE_TEXT } from "./words";

export type Incident = "fire" | "rubble" | "lockdown";
export type PersonState = "help" | "still" | "moving" | "out";
export type Posture = "lying" | "sitting" | "standing" | "walking";
export type Level = "high" | "medium" | "low";
type Side = "W" | "E";

export interface Point {
  x: number;
  y: number;
}
export interface Pos extends Point {
  f: number;
}

// ---------------------------------------------------------------- geometry
// Plan units: 1000 x 560, about 30 units to a metre. Every floor has the same
// footprint (4 rooms, corridor, stairs / 2 rooms / WC / stairs) so the 3D view stacks.

export const PLAN = { w: 1000, h: 560 };
export const FLOORS = [1, 2, 3];
const L = 20;
const R = 980;
const T = 20;
const B = 540;
const TOP_B = 230;
const COR_B = 310;
/** corridor centre line, the walkway between rooms and stairs */
const CY = 270;
const STAIR_Y = 425;
const STAIR_X: Record<Side, number> = { W: 85, E: 915 };
/** seconds spent on one flight of stairs */
const STAIR_TICKS = 3;

export interface Room {
  id: string;
  f: number;
  /** short label on the plan: "204", "WC", "Stairs W" */
  code: string;
  /** in sentences: "Room 204", "WC", "Corridor" */
  name: string;
  kind: "room" | "stairs" | "wc" | "corridor";
  x: number;
  y: number;
  w: number;
  h: number;
  door: Point;
  side?: Side;
}

function room(f: number, code: string, kind: Room["kind"], x: number, y: number, w: number, h: number, door: Point, side?: Side): Room {
  return { id: `${f}:${code}`, f, code, name: kind === "room" ? `Room ${code}` : code, kind, x, y, w, h, door, side };
}

function floorRooms(f: number): Room[] {
  const top = [0, 1, 2, 3].map((i) => room(f, `${f}0${i + 1}`, "room", L + i * 240, T, 240, TOP_B - T, { x: L + i * 240 + 120, y: TOP_B }));
  const h = B - COR_B;
  return [
    room(f, "Corridor", "corridor", L, TOP_B, R - L, COR_B - TOP_B, { x: 500, y: CY }),
    ...top,
    room(f, "Stairs W", "stairs", L, COR_B, 130, h, { x: STAIR_X.W, y: COR_B }, "W"),
    room(f, `${f}05`, "room", 150, COR_B, 260, h, { x: 280, y: COR_B }),
    room(f, `${f}06`, "room", 410, COR_B, 260, h, { x: 540, y: COR_B }),
    room(f, "WC", "wc", 670, COR_B, 180, h, { x: 760, y: COR_B }),
    room(f, "Stairs E", "stairs", 850, COR_B, 130, h, { x: STAIR_X.E, y: COR_B }, "E"),
  ];
}

export const ROOMS: Room[] = FLOORS.flatMap(floorRooms);
export const OUTLINE = { x: L, y: T, w: R - L, h: B - T };
/** ground-floor doors to the outside, at both ends of the corridor */
export const EXITS: Pos[] = [
  { f: 1, x: L, y: CY },
  { f: 1, x: R, y: CY },
];

export function roomAt(p: Pos): Room {
  const here = ROOMS.filter((r) => r.f === p.f);
  const inside = (r: Room) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  return here.find((r) => r.kind !== "corridor" && inside(r)) ?? here.find((r) => r.kind === "corridor")!;
}

function findRoom(f: number, code: string): Room {
  return ROOMS.find((r) => r.f === f && r.code === code)!;
}

/** Walking route: out of the room, along the corridor, up or down the stairs, into the target room. */
export function route(a: Pos, b: Pos, sides: Side[]): Pos[] {
  const ra = roomAt(a);
  const rb = roomAt(b);
  if (ra.id === rb.id) return [b];
  const out: Pos[] = [];
  let f = a.f;
  const add = (x: number, y: number) => out.push({ f, x, y });
  if (a.f !== b.f) {
    const side = sides.reduce((best, s) => (Math.abs(a.x - STAIR_X[s]) + Math.abs(b.x - STAIR_X[s]) < Math.abs(a.x - STAIR_X[best]) + Math.abs(b.x - STAIR_X[best]) ? s : best));
    const sx = STAIR_X[side];
    if (ra.kind === "stairs" && ra.side === side) add(sx, STAIR_Y);
    else {
      if (ra.kind !== "corridor") add(ra.door.x, ra.door.y);
      add(ra.kind === "corridor" ? a.x : ra.door.x, CY);
      add(sx, CY);
      add(sx, COR_B);
      add(sx, STAIR_Y);
    }
    const dir = b.f > a.f ? 1 : -1;
    while (f !== b.f) {
      f += dir;
      add(sx, STAIR_Y);
    }
    if (rb.kind === "stairs" && rb.side === side) {
      out.push(b);
      return out;
    }
    add(sx, COR_B);
    add(sx, CY);
  } else if (ra.kind !== "corridor") {
    add(ra.door.x, ra.door.y);
    add(ra.door.x, CY);
  }
  if (rb.kind !== "corridor") {
    add(rb.door.x, CY);
    add(rb.door.x, rb.door.y);
  }
  out.push(b);
  return out;
}

// ---------------------------------------------------------------- state

export interface Person extends Pos {
  id: string;
  state: PersonState;
  posture: Posture;
  /** breaths a minute; null while moving (it cannot be read then) */
  bpm: number | null;
  /** sim second they stopped moving; null while moving */
  stillSince: number | null;
  path: Pos[];
  /** ticks to stand still (start delay, pause, a flight of stairs) */
  wait: number;
  speed: number;
  /** radians, for the arrow on moving markers */
  heading: number;
  /** rescuer on the way or with them */
  rescuer: string | null;
  /** "not moving" alert already raised */
  flagged: boolean;
}

export interface Rescuer extends Pos {
  id: string;
  path: Pos[];
  wait: number;
  speed: number;
  heading: number;
  target: string | null;
  arrived: boolean;
}

export interface Sensor extends Point {
  id: string;
  f: number;
  label: string;
  battery: number;
  /** % per second */
  drain: number;
  on: boolean;
  /** where the battery % goes, relative to the node */
  lx: number;
  ly: number;
  /** room it mainly covers, for the "stopped" alert */
  near: string;
}

export interface Hazard {
  f: number;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

export interface SimAlert {
  id: number;
  /** sim second */
  t: number;
  level: Level;
  title: string;
  detail: string;
  seen: boolean;
  person: string | null;
}

export interface Sim {
  incident: Incident;
  /** seconds since the incident started */
  t: number;
  /** wall-clock ms when the incident started (t = 0) */
  startedAt: number;
  /** wall-clock ms of the last tick */
  updatedAt: number;
  seed: number;
  people: Person[];
  rescuers: Rescuer[];
  sensors: Sensor[];
  alerts: SimAlert[];
  nextAlert: number;
  /** sim second of the scripted fall */
  fallAt: number;
  /** floors already announced as clear */
  clear: number[];
}

// ---------------------------------------------------------------- scenarios

interface Seed {
  id: string;
  f: number;
  room: string;
  state: Exclude<PersonState, "out">;
  posture?: Posture;
  bpm?: number;
  /** seconds already still when the page opens */
  still?: number;
  /** seconds before a moving person sets off */
  delay?: number;
}

interface Scenario {
  label: string;
  hint: string;
  icon: "flame" | "rubble" | "shield";
  /** seconds since the incident started when the page opens */
  t0: number;
  /** floor shown first */
  focus: number;
  hazards: Hazard[];
  stairs: Side[];
  /** fire: walk out of the building; otherwise move around inside the room */
  movers: "evacuate" | "wander";
  movingText: string;
  people: Seed[];
  /** a moving person falls this many seconds after the page opens */
  fall: { id: string; after: number };
  /** before the page opened; t in sim seconds */
  history: Omit<SimAlert, "id">[];
}

const help = (id: string, f: number, roomCode: string, bpm: number, still: number): Seed => ({ id, f, room: roomCode, state: "help", posture: "lying", bpm, still });
const still = (id: string, f: number, roomCode: string, posture: Posture, bpm: number, s: number): Seed => ({ id, f, room: roomCode, state: "still", posture, bpm, still: s });
const moving = (id: string, f: number, roomCode: string, delay = 0): Seed => ({ id, f, room: roomCode, state: "moving", delay });

export const SCENARIOS: Record<Incident, Scenario> = {
  fire: {
    label: "Fire",
    hint: "Fire alarm, evacuation under way",
    icon: "flame",
    t0: 151,
    focus: 2,
    hazards: [
      { f: 2, x: 680, y: T, w: R - 680, h: B - T, label: "Smoke" },
      { f: 3, x: 740, y: T, w: R - 740, h: COR_B - T, label: "Smoke" },
    ],
    stairs: ["W"],
    movers: "evacuate",
    movingText: "Walking toward exits",
    people: [
      help("P1", 2, "204", 13, 124),
      still("P2", 2, "206", "sitting", 17, 95),
      still("P3", 2, "WC", "standing", 21, 70),
      moving("P4", 2, "202"),
      moving("P5", 2, "202", 2),
      moving("P6", 2, "203", 1),
      moving("P7", 2, "205", 26),
      moving("P8", 3, "301"),
      moving("P9", 3, "303", 3),
      moving("P10", 3, "305"),
      moving("P11", 3, "306", 8),
      moving("P12", 1, "101"),
      moving("P13", 1, "104", 2),
      moving("P14", 1, "106", 5),
    ],
    fall: { id: "P7", after: 30 },
    history: [
      { t: 0, level: "medium", title: "Fire alarm · Block A", detail: "Alarm panel went off. Evacuation started.", seen: true, person: null },
      { t: 27, level: "high", title: "Possible fall · Room 204 · P1", detail: "Floor 2. A fall-like movement, then lying still.", seen: false, person: "P1" },
      { t: 87, level: "high", title: "Person not moving · Room 204 · 1 min", detail: "Floor 2 · P1. Breathing still seen.", seen: false, person: "P1" },
      { t: 146, level: "low", title: "R1 sent to P1 · Room 204", detail: "Via stairs W and the floor 2 corridor.", seen: true, person: "P1" },
    ],
  },
  rubble: {
    label: "Rubble",
    hint: "Part of the building collapsed",
    icon: "rubble",
    t0: 420,
    focus: 3,
    hazards: [
      { f: 3, x: 500, y: T, w: R - 500, h: COR_B - T, label: "Collapsed" },
      { f: 2, x: 740, y: T, w: R - 740, h: TOP_B - T, label: "Cracked ceiling" },
    ],
    stairs: ["W"],
    movers: "wander",
    movingText: "Moving inside their rooms",
    people: [
      help("P1", 3, "304", 12, 124),
      still("P2", 3, "303", "lying", 16, 400),
      still("P3", 2, "204", "sitting", 19, 380),
      moving("P4", 2, "202"),
      moving("P5", 2, "203"),
      moving("P6", 2, "205"),
      moving("P7", 2, "206"),
      moving("P8", 3, "301"),
      moving("P9", 3, "302"),
      moving("P10", 1, "101"),
      moving("P11", 1, "102"),
      moving("P12", 1, "105"),
    ],
    fall: { id: "P5", after: 30 },
    history: [
      { t: 0, level: "medium", title: "Strong shaking · Block A", detail: "Part of floor 3 came down on the east side.", seen: true, person: null },
      { t: 356, level: "high", title: "Person not moving · Room 304 · 1 min", detail: "Floor 3 · P1, inside the collapsed area. Breathing still seen.", seen: false, person: "P1" },
      { t: 415, level: "low", title: "R1 sent to P1 · Room 304", detail: "Via stairs W and the floor 3 corridor.", seen: true, person: "P1" },
    ],
  },
  lockdown: {
    label: "Lockdown",
    hint: "Threat reported, everyone stays in their rooms",
    icon: "shield",
    t0: 245,
    focus: 2,
    hazards: [{ f: 1, x: 680, y: TOP_B, w: R - 680, h: B - TOP_B, label: "Threat reported" }],
    stairs: ["W"],
    movers: "wander",
    movingText: "Moving inside their rooms",
    people: [
      help("P1", 2, "204", 14, 124),
      still("P2", 2, "203", "sitting", 16, 200),
      still("P3", 2, "203", "sitting", 18, 200),
      moving("P4", 2, "202"),
      moving("P5", 2, "202"),
      moving("P6", 2, "205"),
      moving("P7", 2, "206"),
      still("P8", 3, "301", "sitting", 15, 210),
      moving("P9", 3, "303"),
      still("P10", 3, "WC", "standing", 22, 180),
      still("P11", 1, "101", "sitting", 17, 220),
      moving("P12", 1, "102"),
      moving("P13", 1, "105"),
    ],
    fall: { id: "P6", after: 30 },
    history: [
      { t: 0, level: "medium", title: "Lockdown started · Block A", detail: "Doors locked. Everyone told to stay in their room.", seen: true, person: null },
      { t: 121, level: "high", title: "Possible fall · Room 204 · P1", detail: "Floor 2. A fall-like movement, then lying still.", seen: false, person: "P1" },
      { t: 181, level: "high", title: "Person not moving · Room 204 · 1 min", detail: "Floor 2 · P1. Breathing still seen.", seen: false, person: "P1" },
      { t: 240, level: "low", title: "R1 sent to P1 · Room 204", detail: "Via stairs W and the floor 2 corridor.", seen: true, person: "P1" },
    ],
  },
};

export const INCIDENTS: Incident[] = ["fire", "rubble", "lockdown"];

/** N1–N5 on the walls of every floor; [label, x, y, label dx, label dy, room covered] */
const NODES: [string, number, number, number, number, string][] = [
  ["N1", L, 125, 24, 4, "01"],
  ["N2", 380, T, 0, 30, "02"],
  ["N3", 860, T, 0, 30, "04"],
  ["N4", 620, B, 0, -18, "06"],
  ["N5", 200, B, 0, -18, "05"],
];
/** battery % where the "low" alert is raised */
const LOW = 18.5;
/** sensor battery labels, kept clear of people markers */
const NODE_LABELS: Point[] = NODES.map(([, x, y, lx, ly]) => ({ x: x + lx + (lx > 0 ? 12 : 0), y: y + ly - 4 }));

// ---------------------------------------------------------------- simulation

/** Small seeded PRNG (mulberry32), so `step` stays pure. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A free spot inside a room, clear of its label and of people already placed. */
function spot(r: Room, rand: () => number, taken: Point[]): Point {
  let p: Point = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  for (let i = 0; i < 12; i++) {
    p = { x: r.x + 32 + rand() * (r.w - 64), y: r.y + 86 + rand() * (r.h - 112) };
    if (taken.every((q) => Math.hypot(q.x - p.x, q.y - p.y) > 36)) break;
  }
  return p;
}

function exitRoute(p: Pos, sides: Side[]): Pos[] {
  const routes = EXITS.map((e) => route(p, e, sides));
  return routes.reduce((a, b) => (eta({ ...p, path: b, speed: 1, wait: 0 }) < eta({ ...p, path: a, speed: 1, wait: 0 }) ? b : a));
}

/** Seconds to the end of the path at the walker's speed. */
export function eta(a: Pos & { path: Pos[]; speed: number; wait: number }): number {
  let s = a.wait;
  let p: Pos = a;
  for (const n of a.path) {
    s += n.f === p.f ? Math.hypot(n.x - p.x, n.y - p.y) / a.speed : STAIR_TICKS;
    p = n;
  }
  return Math.round(s);
}

/** One second of walking along the path; a change of floor costs a few seconds on the stairs. */
function walk<A extends Pos & { path: Pos[]; wait: number; speed: number; heading: number }>(a: A): A {
  if (a.wait > 0) return { ...a, wait: a.wait - 1 };
  let { f, x, y, heading } = a;
  const path = [...a.path];
  let budget = a.speed;
  let wait = 0;
  while (budget > 0 && path.length) {
    const n = path[0];
    if (n.f !== f) {
      ({ f, x, y } = n);
      path.shift();
      wait = STAIR_TICKS - 1;
      break;
    }
    const d = Math.hypot(n.x - x, n.y - y);
    if (d > 0.5) heading = Math.atan2(n.y - y, n.x - x);
    if (d <= budget) {
      x = n.x;
      y = n.y;
      budget -= d;
      path.shift();
    } else {
      x += ((n.x - x) / d) * budget;
      y += ((n.y - y) / d) * budget;
      budget = 0;
    }
  }
  return { ...a, f, x, y, heading, path, wait };
}

export function createSim(incident: Incident, wall: number): Sim {
  const sc = SCENARIOS[incident];
  const rand = rng(wall);
  const placed: Pos[] = [];
  const people: Person[] = sc.people.map((s) => {
    const at = spot(findRoom(s.f, s.room), rand, [...NODE_LABELS, ...placed.filter((q) => q.f === s.f)]);
    placed.push({ f: s.f, ...at });
    const p: Person = {
      id: s.id,
      f: s.f,
      ...at,
      state: s.state,
      posture: s.posture ?? "walking",
      bpm: s.bpm ?? null,
      stillSince: s.still === undefined ? null : sc.t0 - s.still,
      path: [],
      wait: s.delay ?? 0,
      speed: s.state === "moving" ? (sc.movers === "evacuate" ? 15 + rand() * 6 : 8 + rand() * 6) : 0,
      heading: rand() * Math.PI * 2,
      rescuer: null,
      flagged: s.state === "help" && (s.still ?? 0) >= 60,
    };
    if (p.state === "moving" && sc.movers === "evacuate") p.path = exitRoute(p, sc.stairs);
    return p;
  });

  // R1 is already on the way to P1; R2 waits at the west entrance.
  const target = people.find((p) => p.id === "P1")!;
  const r1: Rescuer = { id: "R1", f: 1, x: 100, y: 262, path: [], wait: 0, speed: 26, heading: 0, target: "P1", arrived: false };
  r1.path = route(r1, beside(target), sc.stairs);
  target.rescuer = "R1";
  const r2: Rescuer = { id: "R2", f: 1, x: 48, y: 288, path: [], wait: 0, speed: 26, heading: 0, target: null, arrived: false };

  const sensors: Sensor[] = FLOORS.flatMap((f) =>
    NODES.map(([label, x, y, lx, ly, near]) => {
      // One node on floor 2 is on its last bit of battery, for the demo.
      const weak = f === 2 && label === "N3";
      return { id: `${f}:${label}`, f, label, x, y, lx, ly, near: `${f}${near}`, battery: weak ? 21.5 : Math.round(58 + rand() * 38), drain: weak ? 0.08 : 0.002, on: true };
    }),
  );

  const alerts = sc.history.map((a, i) => ({ ...a, id: i + 1 }));
  return {
    incident,
    t: sc.t0,
    startedAt: wall - sc.t0 * 1000,
    updatedAt: wall,
    seed: Math.floor(rand() * 2 ** 32),
    people,
    rescuers: [r1, r2],
    sensors,
    alerts,
    nextAlert: alerts.length + 1,
    fallAt: sc.t0 + sc.fall.after,
    clear: [],
  };
}

/** Advance the simulation by one second. */
export function step(sim: Sim, wall: number): Sim {
  const sc = SCENARIOS[sim.incident];
  const rand = rng(sim.seed);
  const t = sim.t + 1;
  const raised: SimAlert[] = [];
  let nextAlert = sim.nextAlert;
  const raise = (level: Level, title: string, detail: string, person: string | null = null) => raised.push({ id: nextAlert++, t, level, title, detail, seen: false, person });
  const jitter = (bpm: number | null, lo: number, hi: number) => (bpm === null ? null : Math.min(hi, Math.max(lo, bpm + (rand() - 0.5) * 0.8)));

  const rescuers = sim.rescuers.map((r) => {
    if (!r.target || r.arrived) return r;
    const n = walk(r);
    if (n.path.length || n.wait) return n;
    raise("low", `${r.id} reached ${r.target} · ${roomAt(n).name}`, `${r.id} is with them now.`, r.target);
    return { ...n, arrived: true };
  });
  const withRescuer = (id: string) => rescuers.some((r) => r.target === id && r.arrived);

  const people = sim.people.map((p): Person => {
    if (p.state === "out") return p;
    if (p.id === sc.fall.id && t === sim.fallAt && p.state === "moving") {
      const where = roomAt(p).name;
      raise("high", `Possible fall · ${where} · ${p.id}`, `Floor ${p.f}. A fall-like movement, then lying still. Nobody sent yet.`, p.id);
      return { ...p, state: "help", posture: "lying", bpm: 12 + rand() * 2, stillSince: t, path: [], wait: 0 };
    }
    if (p.state === "moving") {
      let q = p;
      if (!q.path.length && !q.wait) {
        if (sc.movers === "evacuate") {
          if (q.f === 1 && (q.x <= L + 1 || q.x >= R - 1)) return { ...q, state: "out" };
          q = { ...q, path: exitRoute(q, sc.stairs) };
        } else if (rand() < 0.35) {
          return { ...q, wait: 1 + Math.floor(rand() * 3) };
        } else {
          q = { ...q, path: [{ f: q.f, ...spot(roomAt(q), rand, NODE_LABELS) }] };
        }
      }
      return walk(q);
    }
    let q: Person = { ...p, bpm: p.state === "help" ? jitter(p.bpm, 9, 16) : jitter(p.bpm, 13, 24) };
    if (q.state === "help" && !q.flagged && q.stillSince !== null && t - q.stillSince >= 60 && !withRescuer(q.id)) {
      raise("high", `Person not moving · ${roomAt(q).name} · 1 min`, `Floor ${q.f} · ${q.id}. Breathing still seen.`, q.id);
      q = { ...q, flagged: true };
    }
    return q;
  });

  const sensors = sim.sensors.map((s) => {
    if (!s.on) return s;
    const battery = Math.max(0, s.battery - s.drain);
    if (battery <= 0) {
      raise("medium", `Sensor ${s.label} stopped · floor ${s.f}`, `Battery empty. Room ${s.near} is now seen by fewer sensors, so readings there are less sure.`);
      return { ...s, battery: 0, on: false };
    }
    if (s.battery >= LOW && battery < LOW) {
      const min = Math.max(1, Math.round(battery / s.drain / 60));
      raise("medium", `Sensor ${s.label} battery low · ${Math.round(battery)}% · about ${min} min left`, `Floor ${s.f}, near room ${s.near}. Swap the battery or plug it in.`);
    }
    return { ...s, battery };
  });

  let clear = sim.clear;
  if (sc.movers === "evacuate") {
    for (const f of FLOORS) {
      // People still walking down from above will pass through this floor.
      if (clear.includes(f) || people.some((p) => (p.f === f && p.state !== "out") || (p.f > f && p.state === "moving"))) continue;
      clear = [...clear, f];
      raise("low", `Floor ${f} looks clear · nobody detected`, "Based on this floor's sensors only. Check before you stop searching it.");
    }
  }

  return { ...sim, t, updatedAt: wall, seed: Math.floor(rand() * 2 ** 32), people, rescuers, sensors, alerts: [...sim.alerts, ...raised], nextAlert, clear };
}

// ---------------------------------------------------------------- actions

export function nearestFree(sim: Sim, personId: string): Rescuer | null {
  const p = sim.people.find((q) => q.id === personId);
  if (!p) return null;
  const stairs = SCENARIOS[sim.incident].stairs;
  const free = sim.rescuers.filter((r) => !r.target);
  if (!free.length) return null;
  return free.reduce((a, b) => (eta({ ...b, path: route(b, beside(p), stairs) }) < eta({ ...a, path: route(a, beside(p), stairs) }) ? b : a));
}

/** Where a rescuer stops: next to the person, not on top of their marker. */
function beside(p: Pos): Pos {
  return { f: p.f, x: p.x + 24, y: p.y };
}

/** Send the nearest free rescuer to a person, routed via the corridor and stairs. */
export function send(sim: Sim, personId: string): Sim {
  const p = sim.people.find((q) => q.id === personId);
  const r = nearestFree(sim, personId);
  if (!p || !r) return sim;
  const path = route(r, beside(p), SCENARIOS[sim.incident].stairs);
  const stairs = path.find((n) => n.y === STAIR_Y);
  const via = stairs ? `Via stairs ${stairs.x === STAIR_X.W ? "W" : "E"} and the floor ${p.f} corridor.` : "Along the corridor.";
  const alert: SimAlert = { id: sim.nextAlert, t: sim.t, level: "low", title: `${r.id} sent to ${p.id} · ${roomAt(p).name}`, detail: via, seen: true, person: p.id };
  return {
    ...sim,
    rescuers: sim.rescuers.map((x) => (x.id === r.id ? { ...x, path, target: p.id } : x)),
    people: sim.people.map((x) => (x.id === p.id ? { ...x, rescuer: r.id } : x)),
    alerts: [...sim.alerts, alert],
    nextAlert: sim.nextAlert + 1,
  };
}

export function markSeen(sim: Sim, id?: number): Sim {
  return { ...sim, alerts: sim.alerts.map((a) => (id === undefined || a.id === id ? { ...a, seen: true } : a)) };
}

// ---------------------------------------------------------------- derived views

export function inside(sim: Sim): Person[] {
  return sim.people.filter((p) => p.state !== "out");
}

export function floorStats(sim: Sim, f: number) {
  const here = inside(sim).filter((p) => p.f === f);
  return {
    total: here.length,
    help: here.filter((p) => p.state === "help").length,
    still: here.filter((p) => p.state === "still").length,
    moving: here.filter((p) => p.state === "moving").length,
    rescuers: sim.rescuers.filter((r) => r.f === f).length,
  };
}

/** People per room on one floor, and whether anyone there needs help. */
export function roomCounts(sim: Sim, f: number): Map<string, { n: number; help: boolean }> {
  const m = new Map<string, { n: number; help: boolean }>();
  for (const p of inside(sim)) {
    if (p.f !== f) continue;
    const id = roomAt(p).id;
    const c = m.get(id) ?? { n: 0, help: false };
    m.set(id, { n: c.n + 1, help: c.help || p.state === "help" });
  }
  return m;
}

export type Row = { kind: "person"; p: Person } | { kind: "group"; f: number; ids: string[]; rooms: string[] };

/** Needs help (longest not moving first), then still, then moving people grouped per floor. */
export function priority(sim: Sim): Row[] {
  const all = inside(sim);
  const byStill = (a: Person, b: Person) => (a.stillSince ?? 0) - (b.stillSince ?? 0);
  const rows: Row[] = [...all.filter((p) => p.state === "help").sort(byStill), ...all.filter((p) => p.state === "still").sort(byStill)].map((p) => ({ kind: "person", p }));
  for (const f of [...FLOORS].reverse()) {
    const movers = all.filter((p) => p.state === "moving" && p.f === f);
    if (!movers.length) continue;
    const rooms = [...new Set(movers.map((p) => roomAt(p).code))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    rows.push({ kind: "group", f, ids: movers.map((p) => p.id), rooms });
  }
  return rows;
}

// ---------------------------------------------------------------- words

/** "P4–P7, P9" */
export function idRange(ids: string[]): string {
  const ns = ids.map((i) => Number(i.slice(1))).sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < ns.length; ) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++;
    parts.push(j - i >= 2 ? `P${ns[i]}–P${ns[j]}` : ns.slice(i, j + 1).map((n) => `P${n}`).join(", "));
    i = j + 1;
  }
  return parts.join(", ");
}

/** "00:02:31" */
export function hms(s: number): string {
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");
}

export function postureLabel(p: Posture): string {
  return POSTURE_TEXT[p] ?? "Walking";
}

export function breathLabel(p: Person): string {
  return p.bpm === null ? "breathing can't be read while moving" : `about ${Math.round(p.bpm)} breaths/min`;
}

export const STATE_TEXT: Record<Exclude<PersonState, "out">, string> = { help: "Needs help", still: "Still · breathing", moving: "Moving" };
