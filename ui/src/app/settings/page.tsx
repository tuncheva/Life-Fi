"use client";
// Settings (PIN-protected writes): where Life-Fi is installed (profile), the room,
// phone notifications through ntfy, this device, and the PIN itself. One Save bar
// for the server settings stays in view while there are unsaved changes.
import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { API_BASE, getDeviceName, getPin, getSettings, setDeviceName, setPin, setProfile, testNotification, updateSettings, type ProfileName, type PublicSettings } from "@/lib/api";
import { useLiveSlow } from "@/lib/live";
import { friendlyError, usePin } from "@/lib/pin";
import { calibrationText, parseWholeNumber, PROFILE_TEXT } from "@/lib/words";
import { Card, Field, Notice, PageHeader, Pill, Skeleton, btn, inputCls, inputRowCls } from "@/components/ui";

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

// localStorage values: "" on the server and in the first client render, the stored
// value after hydration (no mismatch). Nothing to subscribe to: re-read on render.
const noSubscribe = () => () => {};
const serverEmpty = () => "";

export default function SettingsPage() {
  const { status } = useLiveSlow();
  const { withPin } = usePin();
  const [saved, setSaved] = useState<PublicSettings | null>(null);
  const [form, setForm] = useState<PublicSettings | null>(null);
  // The two number fields as typed, so an emptied field is an error, not a 0.
  const [escText, setEscText] = useState("");
  const [retText, setRetText] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean; where: "profile" | "save" | "test" | "pin" } | null>(null);
  const [busy, setBusy] = useState(false);
  const storedPin = useSyncExternalStore(noSubscribe, getPin, serverEmpty);
  const [pinDraft, setPinDraft] = useState<string | null>(null);
  const browserPin = pinDraft ?? storedPin;
  const [newPin, setNewPin] = useState("");
  const [newPin2, setNewPin2] = useState("");
  const profile = status?.server.profile ?? null;
  // Name sent with "I'm on it", kept on this device only.
  const storedDevice = useSyncExternalStore(noSubscribe, getDeviceName, serverEmpty);
  const [deviceDraft, setDeviceDraft] = useState<string | null>(null);
  const device = deviceDraft ?? storedDevice;

  /** The one place a server answer becomes the page's state: load, Save and Discard. */
  const applySaved = (s: PublicSettings) => {
    setSaved(s);
    setForm(s);
    setEscText(String(s.notify.escalate_after_s));
    setRetText(String(s.retention_days));
  };

  useEffect(() => {
    getSettings()
      .then(applySaved)
      .catch(() => setLoadFailed(true));
  }, []);

  const esc = parseWholeNumber(escText, 0, 86400);
  const ret = parseWholeNumber(retText, 1, 3650);
  const nameMissing = !!form && !form.room_name.trim();
  const invalid = esc === null || ret === null || nameMissing;
  const dirty =
    !!form &&
    !!saved &&
    (JSON.stringify(form) !== JSON.stringify(saved) || escText !== String(saved.notify.escalate_after_s) || retText !== String(saved.retention_days));
  const set = (patch: Partial<PublicSettings>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const setNotify = (patch: Partial<PublicSettings["notify"]>) => setForm((f) => (f ? { ...f, notify: { ...f.notify, ...patch } } : f));

  // Leaving with unsaved changes: covers reload and closing the tab. In-app link
  // navigation is not covered (the App Router has no blocking API); the sticky bar
  // makes pending edits obvious instead.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // "Saved." fades after a few seconds; errors stay until the next try.
  useEffect(() => {
    if (!msg?.ok || msg.where !== "save") return;
    const t = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(t);
  }, [msg]);

  const run = async (where: NonNullable<typeof msg>["where"], fn: () => Promise<unknown>, okText: string) => {
    setMsg(null);
    setBusy(true);
    try {
      const r = await withPin(fn);
      if (r === undefined) return;
      setMsg({ text: okText, ok: true, where });
    } catch (e) {
      setMsg({ text: friendlyError(e), ok: false, where });
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    form &&
    esc !== null &&
    ret !== null &&
    run(
      "save",
      async () => {
        const r = await updateSettings({
          notify: { ...form.notify, escalate_after_s: esc },
          zone: form.zone,
          dashboard_url: form.dashboard_url,
          retention_days: ret,
          room_name: form.room_name,
          contact_phone: form.contact_phone,
        });
        applySaved(r);
        return r;
      },
      "Saved.",
    );
  const discard = () => {
    if (saved) applySaved(saved);
    setMsg(null);
  };
  // Changing the PIN leaves unsaved edits alone: its answer is not copied into the form.
  const changePin = () =>
    run(
      "pin",
      async () => {
        const r = await updateSettings({ pin: newPin });
        setPin(newPin);
        setPinDraft(newPin);
        setNewPin("");
        setNewPin2("");
        return r;
      },
      "PIN changed. This browser now uses the new one.",
    );

  const thisOrigin = API_BASE || (typeof window !== "undefined" ? window.location.origin : "");
  const note = (where: NonNullable<typeof msg>["where"]) => msg?.where === where && <Notice tone={msg.ok ? "ok" : "danger"} className="mt-3">{msg.text}</Notice>;
  const loading = (
    <>
      {loadFailed && <Notice tone="danger">Can&apos;t load the settings. Check that this device can reach the Life-Fi box.</Notice>}
      {!loadFailed && (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}
    </>
  );

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <PageHeader
        className="mb-0! md:col-span-2"
        title="Settings"
        description="Changes need the dashboard PIN."
        actions={
          <Link href="/setup" className={btn.secondary}>
            Re-run setup
          </Link>
        }
      />

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

      <Card title="This room" className="md:col-span-2">
        {!form ? (
          loading
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Room name" hint="On the dashboard and in notifications." error={nameMissing && "The room needs a name."}>
              <input className={inputCls} value={form.room_name} onChange={(e) => set({ room_name: e.target.value })} placeholder="Room 1" maxLength={40} aria-invalid={nameMissing} />
            </Field>
            <Field label="Phone to call when an alert opens" hint="Shown as a Call button; nothing is dialled automatically.">
              <input type="tel" className={inputCls} value={form.contact_phone} onChange={(e) => set({ contact_phone: e.target.value })} placeholder="+359 88 123 4567" />
            </Field>
            <Field label="Time zone" hint="For after-hours and night windows.">
              <input className={inputCls} value={form.zone} onChange={(e) => set({ zone: e.target.value })} placeholder="Europe/Sofia" />
            </Field>
            <Field label="Keep history for (days)" error={ret === null && "Enter 1 to 3650 days."}>
              <input inputMode="numeric" className={inputCls} value={retText} onChange={(e) => setRetText(e.target.value)} aria-invalid={ret === null} />
            </Field>
          </div>
        )}
      </Card>

      <Card title="Phone notifications" className="md:col-span-2">
        {!form ? (
          loading
        ) : (
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
              <Field label="Topic" hint="Secret, 20 or more characters.">
                <div className="mt-1 flex gap-2">
                  <input className={`${inputRowCls} font-mono`} value={form.notify.topic} onChange={(e) => setNotify({ topic: e.target.value })} placeholder="not set: no phone notifications" />
                  <button type="button" onClick={() => setNotify({ topic: randomTopic() })} className={btn.secondary}>
                    generate
                  </button>
                </div>
              </Field>
              <Field label="ntfy server">
                <input className={inputCls} value={form.notify.ntfy_url} onChange={(e) => setNotify({ ntfy_url: e.target.value })} placeholder="https://ntfy.sh" />
              </Field>
              <Field
                label="Send again if nobody acknowledges within (seconds)"
                hint="0 means the phone is told once and never again."
                error={esc === null && "Enter a whole number of seconds (0 = never send again)."}
              >
                <input inputMode="numeric" className={inputCls} value={escText} onChange={(e) => setEscText(e.target.value)} aria-invalid={esc === null} />
              </Field>
              <Field label="Dashboard address" hint="The notification opens it; acknowledge works on the same network.">
                <div className="mt-1 flex gap-2">
                  <input className={inputRowCls} value={form.dashboard_url} onChange={(e) => set({ dashboard_url: e.target.value })} placeholder="http://192.168.1.10:8080" />
                  <button type="button" onClick={() => set({ dashboard_url: thisOrigin })} className={btn.secondary}>
                    this address
                  </button>
                </div>
              </Field>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                onClick={() => void run("test", () => testNotification(), "Test message sent. Check the phone.")}
                disabled={busy || dirty || !saved?.notify.topic}
                className={btn.secondary}
              >
                Send test notification
              </button>
              <span className="text-xs text-muted">{dirty ? "Save first, then test." : !saved?.notify.topic ? "Set a topic and save first." : ""}</span>
            </div>
            {note("test")}
          </>
        )}
      </Card>

      <Card title="This device">
        <div className="space-y-3">
          <Field label="This device's name" hint="Saved on this device as you type; shown as who acknowledged.">
            <input
              className={inputCls}
              value={device}
              onChange={(e) => {
                setDeviceDraft(e.target.value);
                setDeviceName(e.target.value);
              }}
              placeholder="Maria&apos;s phone"
              maxLength={40}
            />
          </Field>
          <Field label="PIN remembered in this browser">
            <input
              type="password"
              name="lifefi-browser-pin"
              autoComplete="off"
              inputMode="numeric"
              value={browserPin}
              onChange={(e) => setPinDraft(e.target.value)}
              onBlur={() => setPin(browserPin)}
              className={`${inputCls} max-w-40`}
              placeholder="PIN"
            />
          </Field>
        </div>
      </Card>

      <Card title="Change the dashboard PIN">
        <p className="mb-3 text-sm text-muted">Acknowledging alerts and changing the setup need this shared PIN. The default is 1234 until changed; change it before real use.</p>
        <div className="grid grid-cols-2 gap-2">
          <Field label="New PIN (4–8 digits)">
            <input type="password" name="lifefi-new-pin" autoComplete="new-password" inputMode="numeric" value={newPin} onChange={(e) => setNewPin(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Repeat">
            <input type="password" name="lifefi-new-pin-2" autoComplete="new-password" inputMode="numeric" value={newPin2} onChange={(e) => setNewPin2(e.target.value)} className={inputCls} />
          </Field>
        </div>
        <button onClick={() => void changePin()} disabled={busy || !/^\d{4,8}$/.test(newPin) || newPin !== newPin2} className={`${btn.primary} mt-3`}>
          Change PIN
        </button>
        {newPin && newPin2 && newPin !== newPin2 && <p className="mt-2 text-sm text-danger">The two PINs are different.</p>}
        {note("pin")}
      </Card>

      <Card title="Server and engine" className="md:col-span-2">
        {!status ? (
          <div className="space-y-2" aria-busy="true">
            {[0, 1, 2, 3, 4].map((k) => (
              <Skeleton key={k} className="h-5 w-full" />
            ))}
          </div>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-muted">Server</dt>
            <dd>{status.server.version}</dd>
            <dt className="text-muted">Engine</dt>
            <dd>{status.engine.status?.version ?? (status.engine.connected ? "connected" : "not running")}</dd>
            <dt className="text-muted">Models</dt>
            <dd>{status.engine.status?.models.map((m) => `${m.name}${m.loaded ? "" : " (not loaded)"}`).join(", ") || "none reported"}</dd>
            <dt className="text-muted">Calibration</dt>
            <dd className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>{status.engine.status ? calibrationText(status.engine.status.calibration).text : "unknown while the sensor software is off"}</span>
              <Link href="/setup?step=calibrate" className="inline-flex min-h-11 items-center font-semibold underline">
                Recalibrate
              </Link>
            </dd>
            <dt className="text-muted">Time zone</dt>
            <dd>{status.server.time_zone}</dd>
          </dl>
        )}
      </Card>

      {(dirty || msg?.where === "save") && (
        <div role="region" aria-label="Unsaved changes" className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-2 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur md:col-span-2">
          {msg?.where === "save" ? (
            <Notice tone={msg.ok ? "ok" : "danger"} className="min-w-0 flex-1">
              {msg.text}
            </Notice>
          ) : (
            <span className="min-w-0 flex-1 text-sm font-medium">{invalid ? "Fix the marked fields to save." : "You have unsaved changes."}</span>
          )}
          {dirty && (
            <>
              <button onClick={discard} disabled={busy} className={btn.secondary}>
                Discard
              </button>
              <button onClick={() => void save()} disabled={!dirty || invalid || busy} className={btn.primary}>
                Save
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
