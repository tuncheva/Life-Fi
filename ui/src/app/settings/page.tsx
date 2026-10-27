"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { getPin, getSettings, setPin, type PublicSettings } from "@/lib/api";
import { useLive } from "@/lib/live";
import { Card } from "@/components/Cards";

export default function SettingsPage() {
  const { status } = useLive();
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  // localStorage is read lazily on the client; the static export renders "" on the server.
  const [pin, setPinState] = useState(() => (typeof window === "undefined" ? "" : getPin()));

  useEffect(() => {
    getSettings().then(setSettings).catch(() => {});
  }, []);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Dashboard PIN (this browser)">
        <p className="mb-2 text-sm text-zinc-500">Writes (acknowledge, profile, calibration, settings) need the shared PIN. It is kept only in this browser.</p>
        <input
          type="password"
          value={pin}
          onChange={(e) => setPinState(e.target.value)}
          onBlur={() => setPin(pin)}
          className="w-40 rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
          placeholder="PIN"
        />
      </Card>
      <Card title="Calibration">
        <p className="mb-2 text-sm text-zinc-500">
          Current: {status?.engine.status?.calibration.state ?? "—"} {status?.engine.status?.calibration.id ?? ""}
        </p>
        <Link href="/calibrate/" className="text-sm text-sky-600 hover:underline">
          Guided calibration →
        </Link>
      </Card>
      <Card title="Notifications (ntfy)">
        {settings ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-zinc-500">server</dt>
            <dd>{settings.notify.ntfy_url}</dd>
            <dt className="text-zinc-500">topic</dt>
            <dd>{settings.notify.topic || <span className="text-zinc-400">not set: no phone notifications</span>}</dd>
            <dt className="text-zinc-500">escalate after</dt>
            <dd>{settings.notify.escalate_after_s} s</dd>
            <dt className="text-zinc-500">time zone</dt>
            <dd>{settings.zone}</dd>
          </dl>
        ) : (
          "—"
        )}
        <p className="mt-2 text-xs text-zinc-400">Editing from the UI comes next; for now change data/settings.json on the server.</p>
      </Card>
      <Card title="Server">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-zinc-500">version</dt>
          <dd>{status?.server.version ?? "—"}</dd>
          <dt className="text-zinc-500">engine</dt>
          <dd>{status?.engine.status?.version ?? "—"}</dd>
          <dt className="text-zinc-500">models</dt>
          <dd>{status?.engine.status?.models.map((m) => `${m.name}${m.loaded ? "" : " (not loaded)"}`).join(", ") ?? "—"}</dd>
        </dl>
      </Card>
    </div>
  );
}
