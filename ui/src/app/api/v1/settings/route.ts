import { fail, read, readBody, write } from "@/server/http";
import { broadcastStatus } from "@/server/recordings";

export const dynamic = "force-dynamic";

export const GET = read((ctx) => ctx.settings.public());

export const PUT = write(async (ctx, req) => {
  const body = await readBody(req);
  const patch: Record<string, unknown> = {};
  if (typeof body.pin === "string") {
    if (!/^\d{4,8}$/.test(body.pin)) return fail(400, "bad_request", "pin must be 4 to 8 digits");
    patch.pin = body.pin;
  }
  if (typeof body.zone === "string") {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: body.zone });
    } catch {
      return fail(400, "bad_request", `unknown time zone '${body.zone}'`);
    }
    patch.zone = body.zone;
    ctx.profiles.zone = body.zone;
  }
  if (typeof body.dashboard_url === "string") patch.dashboard_url = body.dashboard_url.trim();
  if (typeof body.room_name === "string" && body.room_name.trim()) patch.room_name = body.room_name.trim().slice(0, 40);
  if (typeof body.contact_phone === "string") patch.contact_phone = body.contact_phone.replace(/[^+\d\s()-]/g, "").trim().slice(0, 30);
  if (typeof body.retention_days === "number" && body.retention_days >= 1) patch.retention_days = Math.round(body.retention_days);
  if (body.notify && typeof body.notify === "object") {
    const n = body.notify as Record<string, unknown>;
    const notify: Record<string, unknown> = {};
    if (typeof n.ntfy_url === "string") notify.ntfy_url = n.ntfy_url.trim().replace(/\/$/, "");
    if (typeof n.topic === "string") notify.topic = n.topic.trim();
    if (typeof n.escalate_after_s === "number" && n.escalate_after_s >= 0) notify.escalate_after_s = Math.round(n.escalate_after_s);
    patch.notify = notify;
  }
  ctx.settings.update(patch);
  ctx.log.info({ keys: Object.keys(patch) }, "settings updated");
  if ("room_name" in patch || "contact_phone" in patch) broadcastStatus(ctx);
  return ctx.settings.public();
});
