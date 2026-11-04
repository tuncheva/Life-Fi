import { fail, pinGate, read, readBody, withTrust } from "@/server/http";

export const dynamic = "force-dynamic";

// Acknowledge: with the PIN (dashboard) or with the one-time token from the phone notification.
// The token path does not count towards the wrong-PIN limiter. A browser that has given the
// right PIN before (trust cookie) still gets through a lockout, so a fall alert stays
// acknowledgeable while someone on the LAN hammers wrong PINs (http.ts PinLimiter).
export const POST = read<{ id: string }>(async (ctx, req, { id }) => {
  const token = new URL(req.url).searchParams.get("token");
  const viaPhone = !!token && ctx.ackTokens.get(id) === token;
  if (!viaPhone) {
    const denied = pinGate(ctx, req);
    if (denied) return denied;
  }
  const body = await readBody(req);
  const by = typeof body.by === "string" && body.by.trim() ? body.by.trim().slice(0, 40) : viaPhone ? "phone notification" : null;
  const r = ctx.alerts.ack(id, by);
  if (viaPhone && r) ctx.ackTokens.delete(id);
  const res = r === null ? fail(404, "not_found", `no alert '${id}'`) : r === false ? fail(409, "conflict", "alert is not open") : Response.json(r);
  return viaPhone ? res : withTrust(ctx, req, res);
});
