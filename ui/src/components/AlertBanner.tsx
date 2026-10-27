"use client";
// Open alerts, always on top of every page. Phone layout first.
import { useState } from "react";
import { ackAlert, ensurePin, setPin, type Alert } from "@/lib/api";
import { useLive } from "@/lib/live";

export const ALERT_TEXT: Record<string, string> = {
  fall: "Fall detected",
  fainted_suspected: "No movement after a fall",
  no_breathing: "Breathing not detected",
  presence_uncertain: "Cannot tell if someone is there",
  recalibrate_needed: "Calibration needed",
  bed_exit: "Left the bed",
  sensor_offline: "Sensor offline",
  long_inactivity: "No movement for a long time",
};

export function alertText(type: string): string {
  return ALERT_TEXT[type] ?? type;
}

export function AlertBanner() {
  const { alerts, refreshAlerts } = useLive();
  const [busy, setBusy] = useState<string | null>(null);
  const open = alerts.filter((a) => a.state === "open");
  const acked = alerts.filter((a) => a.state === "acked");
  if (open.length === 0 && acked.length === 0) return null;

  const onAck = async (a: Alert) => {
    if (!ensurePin()) return;
    setBusy(a.id);
    try {
      await ackAlert(a.id);
    } catch (e) {
      const err = e as { status?: number; message: string };
      if (err.status === 401) setPin("");
      window.alert(err.message);
      await refreshAlerts();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 pt-3">
      {open.map((a) => (
        <div
          key={a.id}
          role="alert"
          className={`mb-2 flex flex-wrap items-center gap-3 rounded-xl px-4 py-3 text-white shadow-lg ${a.level === "high" ? "bg-red-600 animate-pulse" : a.level === "medium" ? "bg-orange-500" : "bg-zinc-600"}`}
        >
          <div className="flex-1">
            <div className="text-lg font-bold">{alertText(a.type)}</div>
            <div className="text-sm opacity-90">
              Room 1 · {new Date(a.opened_at ?? a.created_at).toLocaleTimeString()} · {a.level}
              {a.escalated_at ? " · not acknowledged, re-notified" : ""}
            </div>
          </div>
          <button
            onClick={() => void onAck(a)}
            disabled={busy === a.id}
            className="w-full rounded-lg bg-white px-4 py-3 text-base font-semibold text-red-700 disabled:opacity-50 sm:w-auto sm:py-2"
          >
            {busy === a.id ? "…" : "Acknowledge"}
          </button>
        </div>
      ))}
      {acked.map((a) => (
        <div key={a.id} className="mb-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100">
          {alertText(a.type)} · acknowledged {a.acked_at ? new Date(a.acked_at).toLocaleTimeString() : ""} · still active
        </div>
      ))}
    </div>
  );
}
