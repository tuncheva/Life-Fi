// Phone notifications through ntfy (plan-v2 §7.3, D8).
// One HTTP POST. Payload carries no health detail: "Alert — Room 1 — open dashboard".
import type { Alert } from "./alerts.js";
import type { Settings } from "./settings.js";

type Logger = { info: (o: unknown, msg?: string) => void; warn: (o: unknown, msg?: string) => void };

const PRIORITY: Record<Alert["level"], string> = { high: "5", medium: "4", low: "3" };

export async function notifyPhone(alert: Alert, kind: "open" | "escalation", settings: Settings, log: Logger): Promise<void> {
  const { ntfy_url, topic } = settings.notify;
  if (!topic) {
    log.info({ alert: alert.id }, "ntfy topic not set, skipping phone notification");
    return;
  }
  const url = `${ntfy_url.replace(/\/$/, "")}/${encodeURIComponent(topic)}`;
  const headers: Record<string, string> = {
    Title: kind === "escalation" ? "Life-Fi alert (not acknowledged)" : "Life-Fi alert",
    Priority: PRIORITY[alert.level],
    Tags: alert.level === "high" ? "rotating_light" : "warning",
  };
  if (settings.dashboard_url) {
    headers.Click = settings.dashboard_url;
    headers.Actions = `http, Acknowledge, ${settings.dashboard_url.replace(/\/$/, "")}/api/v1/alerts/${alert.id}/ack, method=POST, headers.X-Lifefi-Pin=${settings.pin}, clear=true`;
  }
  const body = `Alert — Room 1 — open dashboard`;
  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(5000) });
    if (!res.ok) log.warn({ status: res.status, alert: alert.id }, "ntfy POST failed");
    else log.info({ alert: alert.id, kind }, "phone notified");
  } catch (err) {
    log.warn({ err: (err as Error).message, alert: alert.id }, "ntfy POST error");
  }
}
