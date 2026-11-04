"use client";
// Stored events (track FB): presence, posture and people-count changes and every assistant
// answer, grouped by day, newest first. Read from the event store (Firestore, or memory).
import { useCallback, useEffect, useState } from "react";
import { ApiError, getAgentStatus, getEvents, type EventKind, type StoredEvent } from "@/lib/api";
import { friendlyError, usePin } from "@/lib/pin";
import { byDay, EVENT_FILTERS, EVENT_HOURS, eventText, hoursText } from "@/lib/events";
import { clock } from "@/lib/words";
import { EmptyState, Icon, Notice, PageHeader, Skeleton, btn } from "@/components/ui";

const REFRESH_MS = 30_000;

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}

function AgentDetails({ e }: { e: StoredEvent }) {
  const d = e.data ?? {};
  if (d.ok === false || typeof d.answer !== "string") return null;
  const tools = Array.isArray(d.tools) ? d.tools.length : 0;
  return (
    <details className="mt-1 text-sm">
      <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium text-muted">Show the answer</summary>
      <p className="rounded-lg border border-line px-3 py-2 whitespace-pre-wrap">{d.answer}</p>
      <p className="mt-1 text-xs text-subtle">
        {String(d.provider ?? "")} · {String(d.model ?? "")} · {tools} lookup{tools === 1 ? "" : "s"}
        {typeof d.ms === "number" ? ` · ${(d.ms / 1000).toFixed(1)} s` : ""}
      </p>
    </details>
  );
}

export default function EventsPage() {
  const [kind, setKind] = useState<EventKind | null>(null);
  const [hours, setHours] = useState<number>(24);
  const [events, setEvents] = useState<StoredEvent[] | null>(null);
  const [total, setTotal] = useState(0);
  const [failed, setFailed] = useState(false);
  const [memory, setMemory] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const { withPin } = usePin();

  const load = useCallback(() => {
    getEvents(hours, kind ?? undefined)
      .then((r) => {
        setEvents(r.events);
        setTotal(r.total);
        setHidden(r.private && r.events.some((e) => e.kind === "agent"));
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [hours, kind]);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);
  useEffect(() => {
    getAgentStatus()
      .then((s) => setMemory(s.store === "memory"))
      .catch(() => {});
  }, []);

  const groups = byDay(events ?? [], dayLabel);
  // the PIN dialog saves the PIN; the next load sends it
  const unlock = async () => {
    setPinError(null);
    try {
      const r = await withPin(async () => {
        const res = await getEvents(hours, kind ?? undefined);
        if (res.private) throw new ApiError(401, "pin", "That PIN is not right.");
        return res;
      });
      if (r) {
        setEvents(r.events);
        setTotal(r.total);
        setHidden(false);
      }
    } catch (e) {
      setPinError(friendlyError(e));
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Events"
        description="Every change the sensor saw and every assistant answer, newest first."
        actions={
          <button type="button" onClick={load} className={btn.secondary}>
            Refresh
          </button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap rounded-lg bg-surface-2 p-0.5" role="group" aria-label="Kind of event">
          {EVENT_FILTERS.map((f) => (
            <button key={f.label} type="button" onClick={() => setKind(f.kind)} aria-pressed={kind === f.kind} className={btn.segment(kind === f.kind)}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex rounded-lg bg-surface-2 p-0.5" role="group" aria-label="Time range">
          {EVENT_HOURS.map((h) => (
            <button key={h} type="button" onClick={() => setHours(h)} aria-pressed={hours === h} className={btn.segment(hours === h)}>
              {hoursText(h)}
            </button>
          ))}
        </div>
      </div>

      {memory && (
        <Notice tone="warn" className="mb-4">
          Events are kept in memory only and are lost when the dashboard restarts. Set the Firebase keys in ui/.env to keep them.
        </Notice>
      )}
      {hidden && (
        <Notice tone="neutral" className="mb-4">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            Assistant questions and answers are hidden until the dashboard PIN is entered on this device.
            <button type="button" onClick={unlock} className="inline-flex min-h-11 items-center font-semibold underline">
              Enter PIN
            </button>
          </span>
          {pinError && <span className="mt-1 block text-danger">{pinError}</span>}
        </Notice>
      )}
      {failed && <Notice tone="danger">Can&apos;t load the events. Check that this device can reach the Life-Fi box.</Notice>}
      {!events && !failed && (
        <div className="space-y-3" aria-busy="true">
          <span className="sr-only" role="status">
            Loading events…
          </span>
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-16 w-full rounded-card" />
          <Skeleton className="h-16 w-full rounded-card" />
        </div>
      )}
      {events && events.length === 0 && (
        <EmptyState icon="clock" title={`Nothing in the last ${hoursText(hours)}`}>
          <p>Changes in presence, posture and the number of people appear here as the sensor sees them, and so does every assistant answer.</p>
        </EmptyState>
      )}
      {events && total > events.length && (
        <p className="mb-3 text-sm text-muted">
          Showing the newest {events.length} of {total}.
        </p>
      )}

      <div className="space-y-6">
        {groups.map((g) => (
          <section key={g.day}>
            <h2 className="mb-2 text-sm font-semibold text-muted">{g.day}</h2>
            <ol className="divide-y divide-line rounded-card border border-line bg-surface shadow-sm">
              {g.items.map((e, i) => {
                const t = eventText(e);
                return (
                  <li key={`${e.t}-${e.kind}-${i}`} className="flex gap-3 px-4 py-3">
                    <span className="w-16 shrink-0 whitespace-nowrap font-mono text-xs leading-6 tabular-nums text-subtle">{clock(e.t)}</span>
                    <Icon name={t.icon} className={`mt-0.5 h-5 w-5 shrink-0 ${t.icon === "alert" ? "text-danger" : "text-muted"}`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">{t.title}</p>
                      {t.detail && <p className="break-words text-sm text-muted">{t.detail}</p>}
                      {e.kind === "agent" && <AgentDetails e={e} />}
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
