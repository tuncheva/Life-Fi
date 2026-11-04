import { health } from "@/server/health";
import { read } from "@/server/http";

export const dynamic = "force-dynamic";

/**
 * 200 when the server can do its job, 503 when not; the body is the same either way.
 * `?soft=1` always answers 200 (for a page that polls it and reads `ok` itself).
 */
export const GET = read((ctx, req) => {
  const h = health(ctx);
  const soft = new URL(req.url).searchParams.get("soft") === "1";
  return Response.json(h, { status: h.ok || soft ? 200 : 503, headers: { "Cache-Control": "no-store" } });
});
