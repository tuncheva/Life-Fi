import { ALERT_STATES, type AlertState } from "@/server/alerts";
import { fail, read } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = read((ctx, req) => {
  const states = (new URL(req.url).searchParams.get("state") ?? "open,acked").split(",").map((s) => s.trim());
  const bad = states.find((s) => !(ALERT_STATES as string[]).includes(s));
  if (bad) return fail(400, "bad_request", `unknown state '${bad}'`);
  return { alerts: ctx.alerts.list(states as AlertState[]) };
});
