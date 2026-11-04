import { fail, read } from "@/server/http";
import { parseMinutes, parseSince, recentBuffer } from "@/server/recent";

export const dynamic = "force-dynamic";

// The last N minutes (1..15) of trend samples since the current boot and source, from memory;
// with `since=<t ms>` only the samples after t (a reconnecting client already has the rest).
export const GET = read((_ctx, req) => {
  const q = new URL(req.url).searchParams;
  const m = parseMinutes(q.get("minutes"));
  if (m === null) return fail(400, "bad_request", "minutes must be a whole number 1..15");
  const since = parseSince(q.get("since"));
  if (since === null) return fail(400, "bad_request", "since must be a time in ms");
  const rb = recentBuffer();
  const now = Date.now();
  return { boot_id: rb.boot, source: rb.source, now, samples: rb.since(Math.max(now - m * 60_000, since + 1)) };
});
