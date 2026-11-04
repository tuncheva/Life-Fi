import { fail, read } from "@/server/http";
import { parseMinutes, recentBuffer } from "@/server/recent";

export const dynamic = "force-dynamic";

// The last N minutes (1..15) of trend samples since the current boot and source, from memory.
export const GET = read((_ctx, req) => {
  const m = parseMinutes(new URL(req.url).searchParams.get("minutes"));
  if (m === null) return fail(400, "bad_request", "minutes must be a whole number 1..15");
  const rb = recentBuffer();
  const now = Date.now();
  return { boot_id: rb.boot, source: rb.source, now, samples: rb.since(now - m * 60_000) };
});
