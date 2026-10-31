// Settings persisted to data/settings.json. The PIN is never returned to clients.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProfileName, ProfilesConfig } from "./profiles";

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
    const { pin, profile: _profile, ...rest } = this.value;
    return { ...rest, pin_set: pin.length > 0 };
  }

  checkPin(candidate: string | undefined): boolean {
    return typeof candidate === "string" && candidate.length > 0 && candidate === this.value.pin;
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
