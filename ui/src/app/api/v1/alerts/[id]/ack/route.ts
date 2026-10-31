import { fail, pinOk, read, readBody } from "@/server/http";

export const dynamic = "force-dynamic";

// Acknowledge: with the PIN (dashboard) or with the one-time token from the phone notification.
export const POST = read<{ id: string }>(async (ctx, req, { id }) => {
  const token = new URL(req.url).searchParams.get("token");
  const viaPhone = !!token && ctx.ackTokens.get(id) === token;
  if (!viaPhone && !pinOk(ctx, req)) return fail(401, "pin", "wrong or missing X-Lifefi-Pin header");
  const body = await readBody(req);
  const by = typeof body.by === "string" && body.by.trim() ? body.by.trim().slice(0, 40) : viaPhone ? "phone notification" : null;
  const r = ctx.alerts.ack(id, by);
  if (viaPhone && r) ctx.ackTokens.delete(id);
  if (r === null) return fail(404, "not_found", `no alert '${id}'`);
  if (r === false) return fail(409, "conflict", "alert is not open");
  return r;
});
