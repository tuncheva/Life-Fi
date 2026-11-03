"use client";
// Always-visible elements (plan-v2 §8): replay banner that cannot be dismissed,
// connection lost, sensor silent, warm-up / uncertain.
// Navigation by audience (docs/plan/ui-ux.md §4.6): "Room" and "Alerts" for
// everyone; installer pages, presentation mode and theme under "Setup".
// One problem, one message (B-ui-ux F4): the bars here step back when an open
// alert already says the same thing.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLiveSlow, useNow, useResult, useStale } from "@/lib/live";
import { fetchOptional, needsSetup, readLocalSetup, type SetupResponse } from "@/lib/setup";
import { useSound } from "@/lib/sound";
import { applyTheme, type Theme } from "@/lib/theme";
import { useThemeChoice } from "@/lib/useTheme";
import { roomName, duration } from "@/lib/words";
import { Icon, Pill } from "./ui";

const SETUP: { href: string; label: string; hint: string }[] = [
  { href: "/setup", label: "Set up this room", hint: "Sensor, room size, calibration" },
  { href: "/source/", label: "Source & replay", hint: "Live sensor or a recording" },
  { href: "/label/", label: "Labelling", hint: "Record training sessions" },
  { href: "/settings/", label: "Settings", hint: "Phone alerts, profile, PIN" },
  { href: "/model/", label: "Spot model view", hint: "3D view and live signals, experimental" },
  { href: "/emergency/", label: "Emergency (building demo, simulated)", hint: "Not real sensor data" },
];

export function SystemBanners() {
  const { connected, status, alerts } = useLiveSlow();
  const result = useResult();
  const stale = useStale(result);
  const now = useNow();
  const replay = (status?.source.mode ?? result?.source) === "replay";
  const offlineAlert = alerts.some((a) => a.type === "sensor_offline" && (a.state === "open" || a.state === "acked"));
  const bar = "px-4 py-2 text-center text-sm font-semibold";
  return (
    <>
      {replay && (
        <div className={`${bar} bg-replay text-replay-fg`} role="status">
          Replay: you are watching a recording{status?.source.file ? ` (${status.source.file.split(/[\\/]/).pop()}${status.source.speed !== 1 ? `, ${status.source.speed}×` : ""})` : ""}, not the live room
          {status?.source.state === "stopped" ? ". The recording has finished." : ""}
        </div>
      )}
      {connected && status?.engine.connected && status.source.state === "error" && (
        <div className={`${bar} bg-danger text-white`} role="alert">
          Can&apos;t read the sensor board{status.source.error ? `: ${status.source.error}` : ""}. Trying again every few seconds…
        </div>
      )}
      {!connected && status && (
        <div className={`${bar} bg-danger text-white`} role="alert">
          Can&apos;t reach the Life-Fi box. Reconnecting…
        </div>
      )}
      {connected && status && !status.engine.connected && !offlineAlert && (
        <div className={`${bar} bg-danger text-white`} role="alert">
          The sensor software is not running. The room is not being watched.
        </div>
      )}
      {connected && status?.engine.connected && (stale || status.server.sensor_offline) && !offlineAlert && (
        <div className={`${bar} bg-alert-medium text-white`} role="alert">
          No new readings from the sensor{result ? ` for ${duration(now - result.ts)}` : ""}. We cannot see the room.
        </div>
      )}
    </>
  );
}

/** The one always-visible status word, a leaf so the header does not re-render with every result. */
function StatusPills() {
  const { connected, status } = useLiveSlow();
  const result = useResult();
  const stale = useStale(result);
  const replay = (status?.source.mode ?? result?.source) === "replay";
  return (
    <>
      {!connected && !status ? (
        <Pill tone="neutral" dot>
          Connecting…
        </Pill>
      ) : !connected ? (
        <Pill tone="danger" dot>
          Offline
        </Pill>
      ) : status && (!status.engine.connected || status.server.sensor_offline || stale) ? (
        <Pill tone="danger" dot title="No readings from the sensor">
          Sensor offline
        </Pill>
      ) : replay ? (
        <Pill tone="replay" dot>
          Replay
        </Pill>
      ) : (
        <Pill tone="ok" dot title="Showing the room as it is now">
          Live
        </Pill>
      )}
      {result?.health.warmup && (
        <Pill tone="warn" title="Just restarted. Nothing can be detected for a few seconds.">
          Starting up
        </Pill>
      )}
      {result?.presence.state === "uncertain" && !result.health.warmup && <Pill tone="uncertain">Presence unclear</Pill>}
    </>
  );
}

function subscribeLocalSetup(cb: () => void): () => void {
  window.addEventListener("lifefi-setup", cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener("lifefi-setup", cb);
    window.removeEventListener("storage", cb);
  };
}

/**
 * "Finish setup" while the room is not set up: the server's GET /setup when it
 * exists, else this browser's record of /setup and the calibration state.
 * Fetched on mount and when the calibration state changes, never on a timer.
 */
function FinishSetupPill() {
  const { status } = useLiveSlow();
  const calibration = status?.engine.status?.calibration.state ?? null;
  const localDone = useSyncExternalStore(subscribeLocalSetup, () => readLocalSetup() !== null, () => true);
  const [setup, setSetup] = useState<SetupResponse | null>(null);
  useEffect(() => {
    let live = true;
    void fetchOptional<SetupResponse>("/setup").then((s) => {
      if (live) setSetup(s);
    });
    return () => {
      live = false;
    };
  }, [calibration, localDone]);
  // Nothing to say before the box answered at all.
  if (!status || !needsSetup({ setup, localDone, calibration })) return null;
  return (
    <Link href="/setup" className="inline-flex min-h-8 items-center gap-1 rounded-full bg-warn-soft px-2.5 py-1 text-xs font-semibold text-warn-fg hover:opacity-90">
      Finish setup
      <Icon name="chevron" className="h-3.5 w-3.5" />
    </Link>
  );
}

export function TopBar() {
  const { status, alerts } = useLiveSlow();
  const path = usePathname();
  const theme = useThemeChoice();
  const sound = useSound();
  const menu = useRef<HTMLDetailsElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // Close the Setup menu on a click outside it or on Escape.
  useEffect(() => {
    const close = (e: Event) => {
      const m = menu.current;
      if (!m?.open) return;
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !m.contains(e.target as Node)) m.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);
  // Presentation mode draws its own header and banners.
  if (path.startsWith("/present")) return null;

  const open = alerts.filter((a) => a.state === "open" && a.level !== "low").length;
  const onSetup = SETUP.some((s) => path.startsWith(s.href.replace(/\/$/, "")));
  const closeMenu = () => {
    if (menu.current) menu.current.open = false;
  };

  const navCls = (active: boolean) =>
    `relative inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium ${active ? "bg-fg text-bg" : "text-muted hover:bg-surface-2 hover:text-fg"}`;

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-surface/90 backdrop-blur">
      <SystemBanners />
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5">
        <Link href="/" className="flex min-h-11 items-center gap-2" aria-label={`Life-Fi, ${roomName(status)}`}>
          <span aria-hidden className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-fg">
            <Icon name="wave" className="h-5 w-5" />
          </span>
          <span className="text-lg font-bold tracking-tight">Life-Fi</span>
          <span className="hidden text-sm text-muted sm:inline">· {roomName(status)}</span>
        </Link>

        {/* Always-visible status (plan-v2 §8), in words. On phones this is its own row. */}
        <div className="order-last flex w-full min-w-0 flex-wrap items-center gap-1.5 pb-1 sm:order-none sm:w-auto sm:flex-1 sm:pb-0">
          <StatusPills />
          <FinishSetupPill />
        </div>

        <nav aria-label="Main" className="ml-auto flex items-center gap-1">
          <Link href="/" className={navCls(path === "/")} aria-current={path === "/" ? "page" : undefined}>
            Room
          </Link>
          <Link href="/alerts/" className={navCls(path.startsWith("/alerts"))} aria-current={path.startsWith("/alerts") ? "page" : undefined}>
            Alerts
            {open > 0 && (
              <span className="rounded-full bg-alert-high px-1.5 text-xs font-bold text-alert-fg" aria-label={`${open} open`}>
                {open}
              </span>
            )}
          </Link>
          <details ref={menu} className="relative" onToggle={(e) => setMenuOpen(e.currentTarget.open)}>
            <summary className={`${navCls(onSetup)} cursor-pointer list-none [&::-webkit-details-marker]:hidden`} aria-label="Setup menu" aria-expanded={menuOpen}>
              <Icon name="settings" className="h-5 w-5" />
              <span className="hidden sm:inline">Setup</span>
            </summary>
            <div className="absolute right-0 z-30 mt-2 max-h-[min(80vh,40rem)] w-[min(18rem,calc(100vw-2rem))] overflow-y-auto rounded-card border border-line bg-surface p-1.5 shadow-xl">
              <p className="px-3 pb-1 pt-1.5 text-xs font-medium text-subtle">For installers</p>
              {SETUP.map((s) => {
                const here = path.startsWith(s.href.replace(/\/$/, ""));
                return (
                  <Link
                    key={s.href}
                    href={s.href}
                    onClick={closeMenu}
                    aria-current={here ? "page" : undefined}
                    className={`flex min-h-11 flex-col justify-center rounded-lg px-3 py-1.5 hover:bg-surface-2 ${here ? "bg-surface-2" : ""}`}
                  >
                    <span className="block text-sm font-medium">{s.label}</span>
                    <span className="block text-xs text-muted">{s.hint}</span>
                  </Link>
                );
              })}
              <div className="my-1.5 border-t border-line" />
              <Link href="/present/" onClick={closeMenu} className="flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium hover:bg-surface-2">
                <Icon name="monitor" className="h-4 w-4" /> Presentation mode
              </Link>
              <div className="px-3 pb-1.5 pt-2">
                <span className="text-xs font-medium text-subtle">Alarm sound</span>
                <div className="mt-1 flex gap-1 rounded-lg bg-surface-2 p-1" role="radiogroup" aria-label="Alarm sound">
                  {(["on", "off"] as const).map((c) => (
                    <button key={c} role="radio" aria-checked={sound.choice === c} onClick={() => sound.setChoice(c)} className={`flex-1 ${btnSeg(sound.choice === c)}`}>
                      {c === "on" ? "Beep" : "Silent"}
                    </button>
                  ))}
                </div>
                {sound.choice === "on" && sound.locked && <span className="mt-1 block text-xs text-muted">Click anywhere once to let the browser play it.</span>}
              </div>
              <div className="px-3 pb-1.5 pt-2">
                <span className="text-xs font-medium text-subtle">Theme</span>
                <div className="mt-1 flex gap-1 rounded-lg bg-surface-2 p-1" role="radiogroup" aria-label="Theme">
                  {(["system", "light", "dark"] as Theme[]).map((t) => (
                    <button key={t} role="radio" aria-checked={theme === t} onClick={() => applyTheme(t)} className={`flex-1 ${btnSeg(theme === t)}`}>
                      {t === "system" ? "Auto" : t === "light" ? "Light" : "Dark"}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </details>
        </nav>
      </div>
    </header>
  );
}

function btnSeg(on: boolean): string {
  return `min-h-11 rounded-md px-2 py-1 text-xs font-medium ${on ? "bg-surface text-fg shadow-sm" : "text-muted"}`;
}
