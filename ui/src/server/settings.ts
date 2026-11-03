// Settings persisted to data/settings.json. The PIN is never returned to clients.
import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProfileName, ProfilesConfig } from "./profiles";

/**
 * The room drawn to scale (metres; origin = a corner, x along the width, y along the depth).
 * For drawing only: the engine does not use it, and one link still gives only a distance from the sensor.
 */
export interface RoomGeometry {
  width_m: number;
  depth_m: number;
  sensor: { x_m: number; y_m: number };
  transmitter: { x_m: number; y_m: number } | null;
}

/** A valid RoomGeometry from a request body, else the reason it is not one. */
export function parseRoom(v: unknown): RoomGeometry | string {
  if (!v || typeof v !== "object") return "room must be an object or null";
  const r = v as Record<string, unknown>;
  const num = (x: unknown, min: number, max: number) => (typeof x === "number" && Number.isFinite(x) && x >= min && x <= max ? x : null);
  const width = num(r.width_m, 1, 30);
  const depth = num(r.depth_m, 1, 30);
  if (width === null || depth === null) return "room width_m and depth_m must be 1 to 30 m";
  const point = (p: unknown) => {
    if (!p || typeof p !== "object") return null;
    const q = p as Record<string, unknown>;
    const x = num(q.x_m, 0, width);
    const y = num(q.y_m, 0, depth);
    return x === null || y === null ? null : { x_m: x, y_m: y };
  };
  const sensor = point(r.sensor);
  if (!sensor) return "room sensor must be { x_m, y_m } inside the room";
  const transmitter = r.transmitter === null || r.transmitter === undefined ? null : point(r.transmitter);
  if (r.transmitter != null && !transmitter) return "room transmitter must be { x_m, y_m } inside the room, or null";
  return { width_m: width, depth_m: depth, sensor, transmitter };
}

export interface Settings {
  pin: string;
  profile: ProfileName;
  notify: { ntfy_url: string; topic: string; escalate_after_s: number };
  zone: string;
  dashboard_url: string;
  retention_days: number;
  /** Shown on the dashboard and in notifications. */
  room_name: string;
  /** Who to call when an alert opens; offered as a tel: link, never dialled automatically. */
  contact_phone: string;
  /** null until someone draws the room in settings. */
  room: RoomGeometry | null;
}

export type PublicSettings = Omit<Settings, "pin" | "profile"> & { pin_set: boolean };

export class SettingsStore {
  private readonly path: string;
  value: Settings;

  constructor(dataDir: string, defaults: { pin: string; profiles: ProfilesConfig }) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, "settings.json");
    const base: Settings = {
      pin: defaults.pin,
      profile: "home",
      notify: { ...defaults.profiles.notify },
      zone: defaults.profiles.zone,
      dashboard_url: "",
      retention_days: 30,
      room_name: "Room 1",
      contact_phone: "",
      room: null,
    };
    if (existsSync(this.path)) {
      try {
        const saved = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Settings>;
        this.value = { ...base, ...saved, notify: { ...base.notify, ...(saved.notify ?? {}) } };
      } catch {
        this.value = base;
      }
    } else {
      this.value = base;
      this.save();
    }
  }

  public(): PublicSettings {
    const { pin, profile, ...rest } = this.value;
    void profile;
    return { ...rest, pin_set: pin.length > 0 };
  }

  /** Constant-time compare, so response timing does not leak how many digits are right. */
  checkPin(candidate: string | undefined): boolean {
    if (typeof candidate !== "string" || candidate.length === 0) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.value.pin);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  update(patch: Partial<Settings> & { notify?: Partial<Settings["notify"]> }): void {
    const next: Settings = {
      ...this.value,
      ...patch,
      notify: { ...this.value.notify, ...(patch.notify ?? {}) },
    };
    if (typeof patch.pin === "string" && patch.pin.length === 0) next.pin = this.value.pin;
    this.value = next;
    this.save();
  }

  private save(): void {
    writeFileSync(this.path, JSON.stringify(this.value, null, 2) + "\n");
  }
}
