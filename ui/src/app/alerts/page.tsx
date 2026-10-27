"use client";
import { useEffect, useState } from "react";
import { getAlerts, type Alert } from "@/lib/api";
import { useLive } from "@/lib/live";
import { alertText } from "@/components/AlertBanner";
import { Card } from "@/components/Cards";
import { Chip } from "@/components/TopBar";

const TONE: Record<Alert["state"], "ok" | "warn" | "bad" | "neutral"> = { pending: "warn", open: "bad", acked: "warn", resolved: "ok", dropped: "neutral" };

export default function AlertsPage() {
  const { alerts: live } = useLive();
  const [history, setHistory] = useState<Alert[]>([]);
  useEffect(() => {
    getAlerts("pending,open,acked,resolved,dropped")
      .then((r) => setHistory(r.alerts))
      .catch(() => {});
  }, [live]);
  const fmt = (t: number | null) => (t ? new Date(t).toLocaleTimeString() : "—");
  return (
    <Card title="Alert history">
      {history.length === 0 && <div className="text-sm text-zinc-500">No alerts yet.</div>}
      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
        {history.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
            <Chip tone={TONE[a.state]}>{a.state}</Chip>
            <span className="font-medium">{alertText(a.type)}</span>
            <span className="text-zinc-500">{a.level}</span>
            <span className="ml-auto text-xs text-zinc-400">
              created {fmt(a.created_at)} · opened {fmt(a.opened_at)} · acked {fmt(a.acked_at)} · resolved {fmt(a.resolved_at)} · {a.profile} · {a.id}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
