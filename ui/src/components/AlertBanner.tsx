"use client";
// Alerts on top of every page (docs/plan/ui-ux.md §4.4). An open alert says what
// happened, for how long, whether the phone was told and what to do, with one
// big Acknowledge button. Acknowledged and cleared alerts de-escalate calmly.
// Presentation mode draws its own full-screen version.
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ackAlert, getSettings, type Alert } from "@/lib/api";
import { useLive, useNow } from "@/lib/live";
import { friendlyError, usePin } from "@/lib/pin";
import { ROOM_NAME, alertAction, alertTitle, clock, duration, levelText, stopwatch } from "@/lib/words";
import { Icon } from "./ui";

export function useAck() {
  const { refreshAlerts } = useLive();
  const { withPin } = usePin();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ack = async (a: Alert) => {
    setError(null);
    setBusy(a.id);
    try {
      await withPin(() => ackAlert(a.id));
    } catch (e) {
      setError(friendlyError(e));
      await refreshAlerts();
    } finally {
      setBusy(null);
    }
  };
  return { ack, busy, error };
}

const FILL: Record<Alert["level"], string> = { high: "bg-alert-high", medium: "bg-alert-medium", low: "bg-alert-low" };

/**
 * The server stamps notified_at when it tries to notify, even with no topic set,
 * so "the phone was told" is only claimed when a topic is configured.
 */
export function notifiedText(a: Alert, phoneSetUp: boolean | null): { text: string; sent: boolean } {
  if (phoneSetUp === false) return { text: "Phone notifications are not set up (Setup → Settings)", sent: false };
  if (!a.notified_at) return { text: "Phone not notified yet", sent: false };
  const again = a.escalated_at ? ` · sent again at ${clock(a.escalated_at)} because nobody acknowledged` : "";
  return { text: `Phone notification sent at ${clock(a.notified_at, true)}${again}`, sent: true };
}

/** Whether a phone topic is configured; re-read when open alerts change. */
export function usePhoneSetUp(key: unknown): boolean | null {
  const [v, setV] = useState<boolean | null>(null);
  useEffect(() => {
    getSettings()
      .then((s) => setV(!!s.notify.topic))
      .catch(() => setV(null));
  }, [key]);
  return v;
}

export function AlertBanner() {
  const { alerts, cleared, dismissCleared } = useLive();
  const path = usePathname();
  const now = useNow();
  const { ack, busy, error } = useAck();
  const open = alerts.filter((a) => a.state === "open");
  const acked = alerts.filter((a) => a.state === "acked");
  const phone = usePhoneSetUp(open.length);
  const recent = cleared.filter((a) => a.resolved_at && now - a.resolved_at < 90_000);
  if (path.startsWith("/present")) return null;
  if (open.length === 0 && acked.length === 0 && recent.length === 0) return null;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-2 px-4 pt-3">
      {open.map((a) => {
        const opened = a.opened_at ?? a.created_at;
        const n = notifiedText(a, phone);
        return (
          <section key={a.id} role="alert" aria-live="assertive" className={`rounded-card p-4 text-alert-fg shadow-lg sm:p-5 ${FILL[a.level]}`}>
            <div className="flex items-start gap-3 sm:gap-4">
              <span className="relative mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/20 motion-safe:animate-beacon sm:h-12 sm:w-12">
                <Icon name="alert" className="h-6 w-6 sm:h-7 sm:w-7" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-3 text-sm font-medium opacity-95">
                  <span className="uppercase tracking-wide">{levelText(a.level)}</span>
                  <span>{ROOM_NAME}</span>
                  <span className="ml-auto font-mono tabular-nums" title={`Opened at ${clock(opened, true)}`}>
                    open {stopwatch(now - opened)}
                  </span>
                </div>
                <h2 className="mt-0.5 text-2xl font-bold leading-tight sm:text-3xl">{alertTitle(a.type)}</h2>
                <p className="mt-1 text-base font-medium sm:text-lg">{alertAction(a.type, a.profile)}</p>
                <p className="mt-2 flex items-center gap-1.5 text-sm opacity-95">
                  <Icon name={n.sent ? "bell" : "bell-off"} className="h-4 w-4 shrink-0" />
                  {n.text}
                </p>
              </div>
            </div>
            <div className="mt-3 flex flex-col gap-2 sm:ml-16 sm:flex-row sm:items-center">
              <button
                onClick={() => void ack(a)}
                disabled={busy === a.id}
                className="rounded-lg bg-white px-5 py-3.5 text-lg font-bold text-black shadow hover:bg-white/90 disabled:opacity-60 sm:py-3"
              >
                {busy === a.id ? "Acknowledging…" : "I'm on it · Acknowledge"}
              </button>
              <span className="text-sm opacity-90">Acknowledging tells everyone watching that someone is handling it. It does not call anyone.</span>
            </div>
            {error && <p className="mt-2 rounded bg-black/25 px-3 py-2 text-sm font-medium sm:ml-16">{error}</p>}
          </section>
        );
      })}

      {acked.map((a) => (
        <section key={a.id} aria-live="polite" className="flex items-start gap-3 rounded-card border border-line border-l-4 border-l-warn bg-surface px-4 py-3 shadow-sm">
          <Icon name="check" className="mt-0.5 h-5 w-5 shrink-0 text-warn" />
          <div className="text-sm">
            <span className="font-semibold">{alertTitle(a.type)}</span> · someone is on it
            {a.acked_at && (
              <span className="text-muted">
                {" "}
                (acknowledged {clock(a.acked_at)}, {duration(a.acked_at - (a.opened_at ?? a.created_at))} after it started)
              </span>
            )}
            <div className="text-muted">Still being detected. This turns into &ldquo;all clear&rdquo; when it stops.</div>
          </div>
        </section>
      ))}

      {recent.length > 0 && (
        <section aria-live="polite" className="flex items-center gap-3 rounded-card bg-ok-soft px-4 py-3 text-ok-fg">
          <Icon name="check" className="h-5 w-5 shrink-0" />
          <div className="flex-1 text-sm">
            <span className="font-semibold">All clear:</span> {recent.map((a) => alertTitle(a.type).toLowerCase()).join(", ")} stopped at {clock(recent[0].resolved_at!)}.
          </div>
          <button onClick={() => recent.forEach((a) => dismissCleared(a.id))} className="rounded-md px-2 py-1 text-sm font-medium hover:bg-black/5 dark:hover:bg-white/10">
            Dismiss
          </button>
        </section>
      )}
    </div>
  );
}
