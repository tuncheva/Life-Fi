import { fail, write } from "@/server/http";
import { notifyTest } from "@/server/notify";

export const dynamic = "force-dynamic";

/** Sends a test message to the configured ntfy topic. */
export const POST = write(async (ctx) => {
  const r = await notifyTest(ctx.settings.value, ctx.log);
  if (!r.ok) return fail(502, "notify", r.error);
  return { sent: true };
});
