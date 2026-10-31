"use client";
// Settings (PIN-protected writes): where Life-Fi is installed (profile), phone
// notifications through ntfy, time zone, dashboard URL for the notification's
// click / acknowledge action, retention, and the PIN itself.
import { useEffect, useState } from "react";
import { API_BASE, getDeviceName, getPin, getSettings, setDeviceName, setPin, setProfile, testNotification, updateSettings, type ProfileName, type PublicSettings } from "@/lib/api";
import { useLive } from "@/lib/live";
import { friendlyError, usePin } from "@/lib/pin";
import { PROFILE_TEXT } from "@/lib/words";
import { Card, Notice, Pill, btn, inputCls } from "@/components/ui";

function randomTopic(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return "lifefi-" + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

const PROFILE_DETAIL: Record<ProfileName, string> = {
  home: "Alerts for a fall, no movement after a fall, breathing stopping, long inactivity and an offline sensor.",
  clinic: "Bed state first. Alerts for a fall, breathing stopping, leaving the bed at night (21:00–07:00) and an offline sensor.",
  school: "Occupancy and falls only. Breathing is never shown or stored.",
};

export default function SettingsPage() {
  const { status } = useLive();
  const { withPin } = usePin();
  const [saved, setSaved] = useState<PublicSettings | null>(null);
  const [form, setForm] = useState<PublicSettings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean; where: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // localStorage is read lazily on the client; the static export renders "" on the server.
  const [browserPin, setBrowserPin] = useState(() => (typeof window === "undefined" ? "" : getPin()));
  const [newPin, setNewPin] = useState("");
  const [newPin2, setNewPin2] = useState("");
  const profile = status?.server.profile ?? null;
  // Name sent with "I'm on it", kept on this device only.
  const [device, setDevice] = useState(() => (typeof window === "undefined" ? "" : getDeviceName()));

  useEffect(() => {
    getSettings()
      .then((s) => {
        setSaved(s);
        setForm(s);
      })
      .catch(() => setLoadFailed(true));
  }, []);

  const dirty = form && saved && JSON.stringify(form) !== JSON.stringify(saved);
  const set = (patch: Partial<PublicSettings>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const setNotify = (patch: Partial<PublicSettings["notify"]>) => setForm((f) => (f ? { ...f, notify: { ...f.notify, ...patch } } : f));

  const run = async (where: string, fn: () => Promise<unknown>, okText: string) => {
    setMsg(null);
    setBusy(true);
    try {
      const r = await withPin(fn);
      if (r === undefined) return;
      if (r && typeof r === "object" && "pin_set" in r) {
        setSaved(r as PublicSettings);
        setForm(r as PublicSettings);
      }
      setMsg({ text: okText, ok: true, where });
    } catch (e) {
      setMsg({ text: friendlyError(e), ok: false, where });
    } finally {
      setBusy(false);
    }
  };

  const save = () => form && run("notify", () => updateSettings({ notify: form.notify, zone: form.zone, dashboard_url: form.dashboard_url, retention_days: form.retention_days, room_name: form.room_name, contact_phone: form.contact_phone }), "Saved.");
  const changePin = () =>
    run(
      "pin",
      async () => {
        const r = await updateSettings({ pin: newPin });
        setPin(newPin);
        setBrowserPin(newPin);
        setNewPin("");
        setNewPin2("");
        return r;
      },
      "PIN changed. This browser now uses the new one.",
    );

  const thisOrigin = API_BASE || (typeof window !== "undefined" ? window.location.origin : "");
  const note = (where: string) => msg?.where === where && <Notice tone={msg.ok ? "ok" : "danger"} className="mt-3">{msg.text}</Notice>;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="md:col-span-2">
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted">Changes need the dashboard PIN.</p>
      </div>

      <Card title="Where is this sensor installed?" className="md:col-span-2">
        <p className="mb-3 text-sm text-muted">The sensor works the same everywhere. The profile decides which events alert someone and what the dashboard shows.</p>
        <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Profile">
          {(["home", "clinic", "school"] as ProfileName[]).map((p) => {
            const on = profile === p;
            return (
              <button
                key={p}
                role="radio"
                aria-checked={on}
                disabled={busy}
                onClick={() => !on && void run("profile", () => setProfile(p), `Switched to ${PROFILE_TEXT[p].title}.`)}
                className={`rounded-lg border p-3 text-left ${on ? "border-primary bg-surface-2 ring-1 ring-primary" : "border-line hover:bg-surface-2"}`}
              >
                <span className="flex items-center gap-2 font-semibold">
                  {PROFILE_TEXT[p].title}
                  {on && <Pill tone="ok">active</Pill>}
                </span>
                <span className="mt-0.5 block text-sm font-medium">{PROFILE_TEXT[p].who}</span>
                <span className="mt-1 block text-xs text-muted">{PROFILE_DETAIL[p]}</span>
              </button>
            );
          })}
        </div>
        {note("profile")}
      </Card>

      <Card title="Phone notifications" className="md:col-span-2">
        {loadFailed && <Notice tone="danger">Can&apos;t load the settings. Check that this device can reach the Life-Fi box.</Notice>}
        {!form && !loadFailed && <div className="text-sm text-muted">Loading…</div>}
        {form && (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              {saved?.notify.topic ? <Pill tone="ok" dot>Phone alerts on</Pill> : <Pill tone="warn" dot>Phone alerts off: no topic set</Pill>}
              <span className="text-sm text-muted">Uses the free ntfy app. The message only says &ldquo;Alert, Room 1, open dashboard&rdquo;, never any health detail.</span>
            </div>
            <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-muted">
              <li>Install the ntfy app on the phone (Android or iOS).</li>
              <li>Press &ldquo;generate&rdquo; below, save, and subscribe to that topic in the app. Keep it secret: anyone who knows it can read the alerts.</li>
              <li>Press &ldquo;Send test notification&rdquo; and check the phone.</li>
            </ol>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-sm font-medium">
                Topic <span className="font-normal text-subtle">(secret, 20+ characters)</span>
                <div className="mt-1 flex gap-2">
                  <input className={`${inputCls} mt-0 font-mono`} value={form.notify.topic} onChange={(e) => setNotify({ topic: e.target.value })} placeholder="not set: no phone notifications" />
                  <button type="button" onClick={() => setNotify({ topic: randomTopic() })} className={btn.secondary}>
                    generate
                  </button>
                </div>
              </label>
              <label className="text-sm font-medium">
                ntfy server
                <input className={inputCls} value={form.notify.ntfy_url} onChange={(e) => setNotify({ ntfy_url: e.target.value })} placeholder="https://ntfy.sh" />
              </label>
              <label className="text-sm font-medium">
                Send again if nobody acknowledges within (seconds)
                <input type="number" min={0} className={inputCls} value={form.notify.escalate_after_s} onChange={(e) => setNotify({ escalate_after_s: Number(e.target.value) })} />
              </label>
              <label className="text-sm font-medium">
                Dashboard address <span className="font-normal text-subtle">(the notification opens it; acknowledge works on the same network)</span>
                <div className="mt-1 flex gap-2">
                  <input className={`${inputCls} mt-0`} value={form.dashboard_url} onChange={(e) => set({ dashboard_url: e.target.value })} placeholder="http://192.168.1.10:8080" />
                  <button type="button" onClick={() => set({ dashboard_url: thisOrigin })} className={btn.secondary}>
                    this address
                  </button>
                </div>
              </label>
              <label className="text-sm font-medium">
                Room name <span className="font-normal text-subtle">(on the dashboard and in notifications)</span>
                <input className={inputCls} value={form.room_name} onChange={(e) => set({ room_name: e.target.value })} placeholder="Room 1" maxLength={40} />
              </label>
              <label className="text-sm font-medium">
                Phone to call when an alert opens <span className="font-normal text-subtle">(shown as a Call button; nothing is dialled automatically)</span>
                <input type="tel" className={inputCls} value={form.contact_phone} onChange={(e) => set({ contact_phone: e.target.value })} placeholder="+359 88 123 4567" />
              </label>
              <label className="text-sm font-medium">
                This device&apos;s name <span className="font-normal text-subtle">(kept on this phone or browser; shown as who acknowledged)</span>
                <input className={inputCls} value={device} onChange={(e) => { setDevice(e.target.value); setDeviceName(e.target.value); }} placeholder="Maria&apos;s phone" maxLength={40} />
              </label>
              <label className="text-sm font-medium">
                Time zone <span className="font-normal text-subtle">(after-hours and night windows)</span>
                <input className={inputCls} value={form.zone} onChange={(e) => set({ zone: e.target.value })} placeholder="Europe/Sofia" />
              </label>
              <label className="text-sm font-medium">
                Keep history for (days)
                <input type="number" min={1} className={inputCls} value={form.retention_days} onChange={(e) => set({ retention_days: Number(e.target.value) })} />
              </label>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button onClick={() => void save()} disabled={!dirty || busy} className={btn.primary}>
                Save
              </button>
              <button
                onClick={() => void run("notify", () => testNotification(), "Test message sent. Check the phone.")}
                disabled={busy || !!dirty || !saved?.notify.topic}
                className={btn.secondary}
              >
                Send test notification
              </button>
              <span className="text-xs text-muted">{dirty ? "Save first, then test." : !saved?.notify.topic ? "Set a topic and save first." : ""}</span>
            </div>
            {note("notify")}
          </>
        )}
      </Card>

      <Card title="Dashboard PIN">
        <p className="mb-3 text-sm text-muted">Acknowledging alerts and changing the setup need this shared PIN. The default is 1234 until changed; change it before real use.</p>
        <label className="block text-sm font-medium">
          PIN remembered in this browser
          <input type="password" value={browserPin} onChange={(e) => setBrowserPin(e.target.value)} onBlur={() => setPin(browserPin)} className={`${inputCls} w-40`} placeholder="PIN" />
        </label>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="text-sm font-medium">
            New PIN (4–8 digits)
            <input type="password" inputMode="numeric" value={newPin} onChange={(e) => setNewPin(e.target.value)} className={inputCls} />
          </label>
          <label className="text-sm font-medium">
            Repeat
            <input type="password" inputMode="numeric" value={newPin2} onChange={(e) => setNewPin2(e.target.value)} className={inputCls} />
          </label>
        </div>
        <button onClick={() => void changePin()} disabled={busy || !/^\d{4,8}$/.test(newPin) || newPin !== newPin2} className={`${btn.primary} mt-3`}>
          Change PIN
        </button>
        {newPin && newPin2 && newPin !== newPin2 && <p className="mt-2 text-sm text-danger">The two PINs are different.</p>}
        {note("pin")}
      </Card>

      <Card title="Server and engine">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-muted">Server</dt>
          <dd>{status?.server.version ?? "—"}</dd>
          <dt className="text-muted">Engine</dt>
          <dd>{status?.engine.status?.version ?? (status?.engine.connected === false ? "not running" : "—")}</dd>
          <dt className="text-muted">Models</dt>
          <dd>{status?.engine.status?.models.map((m) => `${m.name}${m.loaded ? "" : " (not loaded)"}`).join(", ") || "—"}</dd>
          <dt className="text-muted">Calibration</dt>
          <dd>
            {status?.engine.status?.calibration.state ?? "—"} {status?.engine.status?.calibration.id ?? ""}
          </dd>
          <dt className="text-muted">Time zone</dt>
          <dd>{status?.server.time_zone ?? "—"}</dd>
        </dl>
      </Card>
    </div>
  );
}
