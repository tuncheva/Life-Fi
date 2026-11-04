import { EVENT_KINDS, type EventKind } from "@/server/store";
import { fail, read, trusted } from "@/server/http";

export const dynamic = "force-dynamic";

const MAX_HOURS = 24 * 30;

/** What an agent run shows without the PIN: what and when, not the conversation. */
const PRIVATE = ["question", "answer", "error"];

/**
 * Stored events (track FB): state changes and agent runs, newest first, at most 500. Questions and
 * answers of agent runs need the PIN (header or trust cookie); `private: true` says they were hidden.
 */
export const GET = read(async (ctx, req) => {
  const q = new URL(req.url).searchParams;
  const hours = q.get("hours") ? Number(q.get("hours")) : 24;
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HOURS) return fail(400, "bad_request", `hours must be 1 to ${MAX_HOURS}`);
  const kind = q.get("kind");
  if (kind && !(EVENT_KINDS as readonly string[]).includes(kind)) return fail(400, "bad_request", `unknown kind '${kind}'`);
  const to = Date.now();
  const events = await ctx.store.queryEvents(to - hours * 3600_000, to, (kind as EventKind) || undefined);
  const full = trusted(ctx, req);
  const shown = events
    .slice(-500)
    .reverse()
    .map((e) => (full || e.kind !== "agent" ? e : { ...e, data: Object.fromEntries(Object.entries(e.data ?? {}).filter(([k]) => !PRIVATE.includes(k))) }));
  return { from: to - hours * 3600_000, to, total: events.length, private: !full, events: shown };
});
