// Plain words for stored events (track FB, the /events page). Pure, so tests can import it.
import type { EventKind, StoredEvent } from "./api";
import { POSTURE_TEXT } from "./words";

export const EVENT_FILTERS: { kind: EventKind | null; label: string }[] = [
  { kind: null, label: "All" },
  { kind: "presence", label: "Presence" },
  { kind: "posture", label: "Posture" },
  { kind: "count", label: "People" },
  { kind: "agent", label: "Assistant" },
];

export const EVENT_HOURS = [6, 24, 168] as const;
export const hoursText = (h: number) => (h >= 48 ? `${h / 24} days` : `${h} h`);

const MODE_TEXT: Record<string, string> = { summary: "summary", explain: "alert explained", chat: "question" };

const posture = (v: unknown) => (v === null || v === undefined ? "not known" : (POSTURE_TEXT[String(v)] ?? String(v)).toLowerCase());
const num = (v: unknown) => (v === null || v === undefined ? "unknown" : String(v));

export type EventIcon = "person" | "empty" | "question" | "bed" | "chart" | "alert";

/** One line for an event, an optional detail line, and its icon. */
export function eventText(e: StoredEvent): { title: string; detail: string | null; icon: EventIcon } {
  switch (e.kind) {
    case "presence":
      if (e.to === "present") return { title: e.from === "empty" ? "Someone came in" : "Someone is there", detail: null, icon: "person" };
      if (e.to === "empty") return { title: "The room became empty", detail: null, icon: "empty" };
      return { title: "Not sure if someone is there", detail: "The signal was unclear for a moment.", icon: "question" };
    case "posture":
      return { title: `Now ${posture(e.to)}`, detail: `Was ${posture(e.from)}`, icon: "bed" };
    case "count":
      return { title: `People in the room: ${num(e.to)}`, detail: `Was ${num(e.from)}`, icon: "person" };
    case "agent": {
      const d = e.data ?? {};
      const mode = MODE_TEXT[String(d.mode)] ?? "answer";
      if (d.ok === false) return { title: `Assistant ${mode} failed`, detail: typeof d.error === "string" ? d.error : null, icon: "alert" };
      return { title: `Assistant ${mode}`, detail: typeof d.question === "string" ? d.question : null, icon: "chart" };
    }
  }
}

/** Groups newest-first items by a day label, keeping their order. */
export function byDay<T extends { t: number }>(items: T[], label: (t: number) => string): { day: string; items: T[] }[] {
  const groups: { day: string; items: T[] }[] = [];
  for (const it of items) {
    const day = label(it.t);
    if (groups.at(-1)?.day !== day) groups.push({ day, items: [] });
    groups.at(-1)!.items.push(it);
  }
  return groups;
}
