"use client";
// Alert history as a story (docs/plan/ui-ux.md §4.7): grouped by day, each alert
// a short timeline of what happened and what was done about it. Short events
// that cleared before alerting are hidden unless asked for.
import { useEffect, useState } from "react";
import { getAlerts, getSettings, type Alert } from "@/lib/api";
import { useLive } from "@/lib/live";
import { roomName, alertTitle, clearedText, clock, duration, levelText } from "@/lib/words";
import { Icon, Notice, Pill, type PillTone } from "@/components/ui";

const STATE: Record<Alert["state"], { text: string; tone: PillTone }> = {
  pending: { text: "Checking", tone: "warn" },
  open: { text: "Open, not acknowledged", tone: "danger" },
  acked: { text: "Someone is on it", tone: "warn" },
  resolved: { text: "Resolved", tone: "ok" },
  dropped: { text: "Cleared before alerting", tone: "neutral" },
};

const BAR: Record<Alert["level"], string> = { high: "bg-alert-high", medium: "bg-alert-medium", low: "bg-alert-low" };

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}

interface Step {
  t: number;
  text: string;
  icon: "alert" | "bell" | "bell-off" | "check" | "clock";
}

function story(a: Alert, phoneSetUp: boolean | null): { steps: Step[]; summary: string } {
  const start = a.created_at;
  const steps: Step[] = [{ t: start, text: `${alertTitle(a.type)} detected`, icon: "alert" }];
  if (a.opened_at && a.opened_at - start > 1000) steps.push({ t: a.opened_at, text: `Still there after ${duration(a.opened_at - start)}, alert raised`, icon: "clock" });
  if (a.opened_at) {
    if (a.notify === "sent") steps.push({ t: a.notified_at ?? a.opened_at, text: "Phone notification sent", icon: "bell" });
    else if (a.notify === "failed") steps.push({ t: a.notified_at ?? a.opened_at, text: `Phone notification failed: ${a.notify_error ?? "unknown error"}`, icon: "bell-off" });
    else if (a.notify === "not_configured" || phoneSetUp === false) steps.push({ t: a.opened_at, text: "Shown on the dashboard. Phone notifications were not set up", icon: "bell-off" });
    else if (a.notified_at) steps.push({ t: a.notified_at, text: "Phone notification sent", icon: "bell" });
  }
  if (a.escalated_at) steps.push({ t: a.escalated_at, text: "Nobody acknowledged, sent to the phone again", icon: "bell" });
  if (a.acked_at) steps.push({ t: a.acked_at, text: `Acknowledged${a.acked_by ? ` by ${a.acked_by}` : ""}, ${duration(a.acked_at - (a.opened_at ?? start))} after the alert`, icon: "check" });
  if (a.resolved_at) {
    const closedBy = typeof a.data.closed_by === "string" ? a.data.closed_by : null;
    if (a.state === "dropped") steps.push({ t: a.resolved_at, text: `Stopped after ${duration(a.resolved_at - start)}, before an alert was needed`, icon: "check" });
    else if (closedBy && /restart|stopped reporting/.test(closedBy)) steps.push({ t: a.resolved_at, text: `Closed because the ${closedBy}; not confirmed as over`, icon: "clock" });
    else steps.push({ t: a.resolved_at, text: `All clear: ${clearedText(a.type)}${closedBy ? ` (${closedBy})` : ""}`, icon: "check" });
  }
  steps.sort((x, y) => x.t - y.t);

  let summary: string;
  if (a.state === "open") summary = "Waiting for someone to acknowledge.";
  else if (a.state === "acked") summary = "Acknowledged and still being detected.";
  else if (a.state === "pending") summary = "Being checked before alerting.";
  else if (a.state === "dropped") summary = "Too short to alert anyone.";
  else {
    const lasted = a.resolved_at ? duration(a.resolved_at - start) : null;
    summary = `${lasted ? `Lasted ${lasted}. ` : ""}${a.acked_at ? `Acknowledged${a.acked_by ? ` by ${a.acked_by}` : ""} after ${duration(a.acked_at - (a.opened_at ?? start))}.` : "Cleared before anyone acknowledged."}`;
  }
  return { steps, summary };
}

export default function AlertsPage() {
  const { alerts: live, status } = useLive();
  const [history, setHistory] = useState<Alert[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [showDropped, setShowDropped] = useState(false);
  const [phone, setPhone] = useState<boolean | null>(null);

  useEffect(() => {
    getAlerts("pending,open,acked,resolved,dropped")
      .then((r) => {
        setHistory(r.alerts);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [live]);
  useEffect(() => {
    getSettings()
      .then((s) => setPhone(!!s.notify.topic))
      .catch(() => {});
  }, []);

  const dropped = history?.filter((a) => a.state === "dropped").length ?? 0;
  const list = (history ?? []).filter((a) => showDropped || a.state !== "dropped");
  const groups: { day: string; items: Alert[] }[] = [];
  for (const a of list) {
    const day = dayLabel(a.created_at);
    if (groups.at(-1)?.day !== day) groups.push({ day, items: [] });
    groups.at(-1)!.items.push(a);
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Alerts</h1>
          <p className="text-sm text-muted">What happened in {roomName(status)} and what was done about it, newest first.</p>
        </div>
        {dropped > 0 && (
          <label className="ml-auto flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={showDropped} onChange={(e) => setShowDropped(e.target.checked)} className="h-4 w-4 accent-[var(--primary)]" />
            Show {dropped} short event{dropped > 1 ? "s" : ""} that stopped before alerting
          </label>
        )}
      </div>

      {failed && <Notice tone="danger">Can&apos;t load the alert history. Check that this device can reach the Life-Fi box.</Notice>}
      {!history && !failed && <p className="text-sm text-muted">Loading alerts…</p>}
      {history && list.length === 0 && (
        <div className="rounded-card border border-line bg-surface p-6 text-center">
          <Icon name="check" className="mx-auto h-8 w-8 text-ok" />
          <p className="mt-2 font-semibold">No alerts yet</p>
          <p className="text-sm text-muted">When something happens it is listed here, with when the phone was told and who acknowledged it.</p>
        </div>
      )}

      <div className="space-y-6">
        {groups.map((g) => (
          <section key={g.day}>
            <h2 className="mb-2 text-sm font-semibold text-muted">{g.day}</h2>
            <ol className="space-y-3">
              {g.items.map((a) => {
                const { steps, summary } = story(a, phone);
                const st = STATE[a.state];
                return (
                  <li key={a.id} className="relative overflow-hidden rounded-card border border-line bg-surface shadow-sm">
                    <span aria-hidden className={`absolute inset-y-0 left-0 w-1.5 ${a.state === "dropped" ? "bg-line" : BAR[a.level]}`} />
                    <div className="py-4 pl-6 pr-4">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <h3 className="text-lg font-semibold">{alertTitle(a.type)}</h3>
                        <Pill tone={st.tone}>{st.text}</Pill>
                        <span className="ml-auto text-sm tabular-nums text-muted">{clock(a.created_at)}</span>
                      </div>
                      <p className="mt-0.5 text-sm text-muted">
                        {levelText(a.level)} · {summary}
                      </p>
                      <ol className="mt-3 space-y-1.5 border-l border-line pl-4">
                        {steps.map((s, i) => (
                          <li key={i} className="relative flex gap-3 text-sm">
                            <span aria-hidden className="absolute -left-[1.4rem] top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-surface text-muted">
                              <Icon name={s.icon} className="h-3.5 w-3.5" />
                            </span>
                            <span className="w-20 shrink-0 font-mono text-xs leading-5 tabular-nums text-subtle">{clock(s.t, true)}</span>
                            <span>{s.text}</span>
                          </li>
                        ))}
                      </ol>
                      <p className="mt-3 font-mono text-[11px] text-subtle">
                        {a.id} · {a.type} · profile {a.profile} · config {a.config_hash}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}
