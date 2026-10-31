"use client";
// Always-visible elements (plan-v2 §8): replay banner that cannot be dismissed,
// connection lost, sensor silent, calibration state, warm-up / uncertain.
// Navigation by audience (docs/plan/ui-ux.md §4.6): "Room" and "Alerts" for
// everyone; installer pages, presentation mode and theme under "Setup".
import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLive, useNow, useStale } from "@/lib/live";
import { applyTheme, type Theme } from "@/lib/theme";
import { useThemeChoice } from "@/lib/useTheme";
import { roomName, calibrationText, duration } from "@/lib/words";
import { Icon, Pill } from "./ui";

const SETUP: { href: string; label: string; hint: string }[] = [
  { href: "/calibrate/", label: "Calibration", hint: "Teach it the empty room" },
  { href: "/source/", label: "Source & replay", hint: "Live sensor or a recording" },
  { href: "/label/", label: "Labelling", hint: "Record training sessions" },
  { href: "/settings/", label: "Settings", hint: "Phone alerts, profile, PIN" },
];

export function SystemBanners() {
  const { connected, result, status, alerts } = useLive();
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
        </div>
      )}
      {!connected && status && (
        <div className={`${bar} bg-danger text-white`} role="alert">
          Can&apos;t reach the Life-Fi box. Reconnecting…
        </div>
      )}
      {connected && status && !status.engine.connected && (
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

export function TopBar() {
  const { connected, result, status, alerts } = useLive();
  const stale = useStale(result);
  const path = usePathname();
  const theme = useThemeChoice();
  const menu = useRef<HTMLDetailsElement>(null);
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

  const replay = (status?.source.mode ?? result?.source) === "replay";
  const calState = result?.calibration ?? status?.engine.status?.calibration ?? null;
  const cal = calibrationText(calState);
  const open = alerts.filter((a) => a.state === "open" && a.level !== "low").length;
  const onSetup = SETUP.some((s) => path.startsWith(s.href.replace(/\/$/, "")));
  const closeMenu = () => {
    if (menu.current) menu.current.open = false;
  };

  const navCls = (active: boolean) =>
    `relative inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium ${active ? "bg-fg text-bg" : "text-muted hover:bg-surface-2 hover:text-fg"}`;

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-surface/90 backdrop-blur">
      <SystemBanners />
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
        <Link href="/" className="flex items-center gap-2" aria-label={`Life-Fi, ${roomName(status)}`}>
          <span aria-hidden className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-fg">
            <Icon name="wave" className="h-5 w-5" />
          </span>
          <span className="text-lg font-bold tracking-tight">Life-Fi</span>
          <span className="hidden text-sm text-muted sm:inline">· {roomName(status)}</span>
        </Link>

        {/* Always-visible status (plan-v2 §8), in words. On phones this is its own row. */}
        <div className="order-last flex w-full min-w-0 flex-wrap items-center gap-1.5 sm:order-none sm:w-auto sm:flex-1">
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
          {calState && (
            <Link href="/calibrate/" className={cal.tone === "ok" ? "hidden sm:inline-flex" : "inline-flex"} title="Empty-room calibration">
              <Pill tone={cal.tone}>{cal.text}</Pill>
            </Link>
          )}
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
          <Link href="/emergency/" className={navCls(path.startsWith("/emergency"))} aria-current={path.startsWith("/emergency") ? "page" : undefined}>
            Emergency
          </Link>
          <details ref={menu} className="relative">
            <summary className={navCls(onSetup)} aria-label="Setup menu">
              <Icon name="settings" className="h-4 w-4" />
              <span className="hidden sm:inline">Setup</span>
            </summary>
            <div className="absolute right-0 z-30 mt-2 w-64 rounded-card border border-line bg-surface p-1.5 shadow-xl">
              <p className="px-3 pb-1 pt-1.5 text-xs font-medium text-subtle">For installers</p>
              {SETUP.map((s) => (
                <Link key={s.href} href={s.href} onClick={closeMenu} className="block rounded-lg px-3 py-2 hover:bg-surface-2">
                  <span className="block text-sm font-medium">{s.label}</span>
                  <span className="block text-xs text-muted">{s.hint}</span>
                </Link>
              ))}
              <div className="my-1.5 border-t border-line" />
              <Link href="/present/" onClick={closeMenu} className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium hover:bg-surface-2">
                <Icon name="monitor" className="h-4 w-4" /> Presentation mode
              </Link>
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
  return `rounded-md px-2 py-1 text-xs font-medium ${on ? "bg-surface text-fg shadow-sm" : "text-muted"}`;
}

