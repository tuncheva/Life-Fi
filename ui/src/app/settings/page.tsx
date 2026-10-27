"use client";
// Settings (PIN-protected writes): phone notifications through ntfy, time
// zone, dashboard URL for the notification's click / acknowledge action,
// retention, and the PIN itself.
import { useEffect, useState } from "react";
import Link from "next/link";
import { API_BASE, ensurePin, getPin, getSettings, setPin, testNotification, updateSettings, type PublicSettings } from "@/lib/api";
import { useLive } from "@/lib/live";
import { Card } from "@/components/Cards";
import { Chip } from "@/components/TopBar";

const inputCls = "mt-1 block w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900";
const btnCls = "rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black";

function randomTopic(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return "lifefi-" + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export default function SettingsPage() {
  const { status } = useLive();
  const [saved, setSaved] = useState<PublicSettings | null>(null);
  const [form, setForm] = useState<PublicSettings | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  // localStorage is read lazily on the client; the static export renders "" on the server.
  const [browserPin, setBrowserPin] = useState(() => (typeof window === "undefined" ? "" : getPin()));
  const [newPin, setNewPin] = useState("");
  const [newPin2, setNewPin2] = useState("");

  useEffect(() => {
    getSettings()
      .then((s) => {
        setSaved(s);
        setForm(s);
      })
      .catch(() => {});
  }, []);

  const dirty = form && saved && JSON.stringify(form) !== JSON.stringify(saved);
  const set = (patch: Partial<PublicSettings>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const setNotify = (patch: Partial<PublicSettings["notify"]>) => setForm((f) => (f ? { ...f, notify: { ...f.notify, ...patch } } : f));

  const run = async (fn: () => Promise<PublicSettings | { sent: boolean }>, okText: string) => {
    setMsg(null);
    if (!ensurePin()) return;
    setBusy(true);
    try {
      const r = await fn();
      if ("pin_set" in r) {
        setSaved(r);
        setForm(r);
      }
      setMsg({ text: okText, ok: true });
    } catch (e) {
      const err = e as { status?: number; message: string };
      if (err.status === 401) setPin("");
      setMsg({ text: err.message, ok: false });
    } finally {
      setBusy(false);
    }
  };

  const save = () => form && run(() => updateSettings({ notify: form.notify, zone: form.zone, dashboard_url: form.dashboard_url, retention_days: form.retention_days }), "Settings saved.");
  const changePin = () =>
    run(async () => {
      const r = await updateSettings({ pin: newPin });
      setPin(newPin);
      setBrowserPin(newPin);
      setNewPin("");
      setNewPin2("");
      return r;
    }, "PIN changed. This browser now uses the new one.");

  const thisOrigin = API_BASE || (typeof window !== "undefined" ? window.location.origin : "");

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Phone notifications (ntfy)" className="md:col-span-2">
        {!form ? (
          <div className="text-sm text-zinc-500">Loading…</div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm">
              ntfy server
              <input className={inputCls} value={form.notify.ntfy_url} onChange={(e) => setNotify({ ntfy_url: e.target.value })} placeholder="https://ntfy.sh" />
            </label>
            <label className="text-sm">
              Topic <span className="text-zinc-400">(secret, ≥ 20 characters)</span>
              <div className="mt-1 flex gap-2">
                <input className={`${inputCls} mt-0 font-mono`} value={form.notify.topic} onChange={(e) => setNotify({ topic: e.target.value })} placeholder="not set: no phone notifications" />
                <button type="button" onClick={() => setNotify({ topic: randomTopic() })} className="shrink-0 rounded border border-zinc-300 px-2 text-xs dark:border-zinc-700">
                  generate
                </button>
              </div>
            </label>
            <label className="text-sm">
              Re-notify if not acknowledged after (s)
              <input type="number" min={0} className={inputCls} value={form.notify.escalate_after_s} onChange={(e) => setNotify({ escalate_after_s: Number(e.target.value) })} />
            </label>
            <label className="text-sm">
              Dashboard URL <span className="text-zinc-400">(the notification opens it; acknowledge works on the same LAN)</span>
              <div className="mt-1 flex gap-2">
                <input className={`${inputCls} mt-0`} value={form.dashboard_url} onChange={(e) => set({ dashboard_url: e.target.value })} placeholder="http://192.168.1.10:8080" />
                <button type="button" onClick={() => set({ dashboard_url: thisOrigin })} className="shrink-0 rounded border border-zinc-300 px-2 text-xs dark:border-zinc-700">
                  this address
                </button>
              </div>
            </label>
            <label className="text-sm">
              Time zone <span className="text-zinc-400">(after-hours and bed-exit windows)</span>
              <input className={inputCls} value={form.zone} onChange={(e) => set({ zone: e.target.value })} placeholder="Europe/Sofia" />
            </label>
            <label className="text-sm">
              Keep history for (days)
              <input type="number" min={1} className={inputCls} value={form.retention_days} onChange={(e) => set({ retention_days: Number(e.target.value) })} />
            </label>
            <div className="flex flex-wrap items-center gap-2 md:col-span-2">
              <button onClick={() => void save()} disabled={!dirty || busy} className={btnCls}>
                Save
              </button>
              <button
                onClick={() => void run(() => testNotification(), "Test message sent. Check the phone.")}
                disabled={busy || dirty || !saved?.notify.topic}
                title={dirty ? "Save first" : !saved?.notify.topic ? "Set a topic first" : ""}
                className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold dark:border-zinc-700"
              >
                Send test notification
              </button>
              {saved?.notify.topic ? <Chip tone="ok">phone alerts on</Chip> : <Chip tone="warn">phone alerts off: no topic</Chip>}
            </div>
            <p className="text-xs text-zinc-400 md:col-span-2">
              On the phone: install the ntfy app (Android / iOS), subscribe to the topic above on the same server. Anyone who knows the topic can read the alerts, so keep it
              secret. The message says only &quot;Alert — Room 1 — open dashboard&quot;, never any health detail.
            </p>
          </div>
        )}
      </Card>

      <Card title="Dashboard PIN">
        <p className="mb-2 text-sm text-zinc-500">Writes (acknowledge, profile, calibration, settings) need the shared PIN. Default is 1234 until changed.</p>
        <label className="block text-sm">
          PIN kept in this browser
          <input type="password" value={browserPin} onChange={(e) => setBrowserPin(e.target.value)} onBlur={() => setPin(browserPin)} className={`${inputCls} w-40`} placeholder="PIN" />
        </label>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="text-sm">
            New PIN (4–8 digits)
            <input type="password" inputMode="numeric" value={newPin} onChange={(e) => setNewPin(e.target.value)} className={inputCls} />
          </label>
          <label className="text-sm">
            Repeat
            <input type="password" inputMode="numeric" value={newPin2} onChange={(e) => setNewPin2(e.target.value)} className={inputCls} />
          </label>
        </div>
        <button onClick={() => void changePin()} disabled={busy || !/^\d{4,8}$/.test(newPin) || newPin !== newPin2} className={`${btnCls} mt-3`}>
          Change PIN
        </button>
      </Card>

      <Card title="Server and engine">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-zinc-500">server</dt>
          <dd>{status?.server.version ?? "—"}</dd>
          <dt className="text-zinc-500">engine</dt>
          <dd>{status?.engine.status?.version ?? "—"}</dd>
          <dt className="text-zinc-500">models</dt>
          <dd>{status?.engine.status?.models.map((m) => `${m.name}${m.loaded ? "" : " (not loaded)"}`).join(", ") ?? "—"}</dd>
          <dt className="text-zinc-500">calibration</dt>
          <dd>
            {status?.engine.status?.calibration.state ?? "—"} {status?.engine.status?.calibration.id ?? ""} ·{" "}
            <Link href="/calibrate/" className="text-sky-600 hover:underline">
              guided calibration →
            </Link>
          </dd>
        </dl>
      </Card>

      {msg && (
        <div className={`md:col-span-2 text-sm ${msg.ok ? "text-emerald-600" : "text-red-600"}`} role="status">
          {msg.text}
        </div>
      )}
    </div>
  );
}
