// Phone notifications through ntfy (plan-v2 §7.3, D8).
// One HTTP POST. Payload carries no health detail: "Alert — Room 1 — open dashboard".
import type { Alert } from "./alerts.js";
import type { Settings } from "./settings.js";

type Logger = { info: (o: unknown, msg?: string) => void; warn: (o: unknown, msg?: string) => void };

const PRIORITY: Record<Alert["level"], string> = { high: "5", medium: "4", low: "3" };

export type NotifyResult = { ok: true } | { ok: false; error: string };

async function post(settings: Settings, headers: Record<string, string>, body: string, log: Logger): Promise<NotifyResult> {
  const { ntfy_url, topic } = settings.notify;
  if (!topic) return { ok: false, error: "ntfy topic not set" };
  const url = `${ntfy_url.replace(/\/$/, "")}/${encodeURIComponent(topic)}`;
  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      log.warn({ status: res.status }, "ntfy POST failed");
      return { ok: false, error: `ntfy answered ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    log.warn({ err: (err as Error).message }, "ntfy POST error");
    return { ok: false, error: (err as Error).message };
  }
}

export async function notifyPhone(alert: Alert, kind: "open" | "escalation", settings: Settings, log: Logger, ackToken: string | null = null): Promise<NotifyResult> {
  const headers: Record<string, string> = {
    Title: kind === "escalation" ? "Life-Fi alert (not acknowledged)" : "Life-Fi alert",
    Priority: PRIORITY[alert.level],
    Tags: alert.level === "high" ? "rotating_light" : "warning",
  };
  if (settings.dashboard_url) {
    headers.Click = settings.dashboard_url;
    // A per-alert token, not the PIN: the relay and every subscriber see this header.
    if (ackToken) headers.Actions = `http, Acknowledge, ${settings.dashboard_url.replace(/\/$/, "")}/api/v1/alerts/${alert.id}/ack?token=${ackToken}, method=POST, clear=true`;
  }
  const r = await post(settings, headers, `Alert — ${settings.room_name || "Room 1"} — open dashboard`, log);
  if (r.ok) log.info({ alert: alert.id, kind }, "phone notified");
  else log.info({ alert: alert.id, reason: r.error }, "phone not notified");
  return r;
}

/** A harmless message to check that the phone is subscribed to the topic. */
export function notifyTest(settings: Settings, log: Logger): Promise<NotifyResult> {
  const headers: Record<string, string> = { Title: "Life-Fi test", Priority: "3", Tags: "white_check_mark" };
  if (settings.dashboard_url) headers.Click = settings.dashboard_url;
  return post(settings, headers, "Test notification from the Life-Fi dashboard. Alerts will arrive here.", log);
}
