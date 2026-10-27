"use client";
// Always-visible elements (plan-v2 §8): connection state, replay banner that
// cannot be dismissed, calibration state, warm-up / uncertain indicators.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLive, useStale } from "@/lib/live";
import { ensurePin, setPin, setProfile, type ProfileName } from "@/lib/api";

const NAV: { href: string; label: string }[] = [
  { href: "/", label: "Dashboard" },
  { href: "/alerts/", label: "Alerts" },
  { href: "/calibrate/", label: "Calibrate" },
  { href: "/source/", label: "Source" },
  { href: "/settings/", label: "Settings" },
];

const PROFILES: ProfileName[] = ["home", "school", "clinic"];

export function TopBar() {
  const { connected, result, status } = useLive();
  const stale = useStale(result);
  const path = usePathname();
  const source = status?.source.mode ?? result?.source ?? "live";
  const profile = status?.server.profile ?? "home";
  const cal = result?.calibration ?? status?.engine.status?.calibration ?? null;

  const onProfile = async (p: ProfileName) => {
    if (!ensurePin()) return;
    try {
      await setProfile(p);
    } catch (e) {
      const err = e as { status?: number; message: string };
      if (err.status === 401) setPin("");
      alert(err.message);
    }
  };

  return (
    <header className="sticky top-0 z-20 border-b border-zinc-200 bg-white/90 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
      {source !== "live" && (
        <div className="bg-amber-500 px-4 py-1.5 text-center text-sm font-semibold text-black" role="status">
          REPLAY — this is a recording ({status?.source.file ?? "file"}), not the live room
        </div>
      )}
      {!connected && (
        <div className="bg-red-600 px-4 py-1.5 text-center text-sm font-semibold text-white" role="alert">
          Connection to the server lost — reconnecting…
        </div>
      )}
      {connected && status && !status.engine.connected && (
        <div className="bg-red-600 px-4 py-1.5 text-center text-sm font-semibold text-white" role="alert">
          Engine not connected — no sensor data
        </div>
      )}
      {connected && status?.engine.connected && stale && (
        <div className="bg-orange-500 px-4 py-1.5 text-center text-sm font-semibold text-black" role="alert">
          No results from the engine for a few seconds
        </div>
      )}
      {/* Row 1: brand, status chips, profile. Row 2 on phones: the nav, scrollable. */}
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 sm:py-2">
        <Link href="/" className="text-lg font-bold tracking-tight">
          Life-Fi
        </Link>
        <nav className="order-last -mx-4 flex w-[calc(100%+2rem)] gap-1 overflow-x-auto px-4 pb-1 text-sm whitespace-nowrap sm:order-none sm:mx-0 sm:w-auto sm:px-0 sm:pb-0">
          {NAV.map((n) => {
            const active = path === n.href || (n.href !== "/" && path.startsWith(n.href.replace(/\/$/, "")));
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`rounded px-2 py-1 ${active ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"}`}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex min-w-0 items-center gap-1.5 text-xs sm:gap-2">
          {result?.health.warmup && <Chip tone="warn">warm-up</Chip>}
          {result?.presence.state === "uncertain" && <Chip tone="warn">uncertain</Chip>}
          {/* On phones the calibration chip appears only when it needs attention. */}
          <span className={cal?.state === "ok" ? "hidden sm:inline" : ""}>
            <CalibrationChip state={cal?.state ?? null} age={cal?.age_s ?? null} />
          </span>
          <Chip tone={connected ? "ok" : "bad"}>{connected ? "live" : "offline"}</Chip>
          <label className="flex items-center gap-1 text-zinc-500">
            <span className="hidden sm:inline">profile</span>
            <select
              aria-label="profile"
              className="rounded border border-zinc-300 bg-white px-1 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
              value={profile}
              onChange={(e) => void onProfile(e.target.value as ProfileName)}
            >
              {PROFILES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </header>
  );
}

export function Chip({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "ok" | "warn" | "bad" | "neutral" }) {
  const cls = {
    ok: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
    warn: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
    bad: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
    neutral: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  }[tone];
  return <span className={`rounded-full px-2 py-0.5 font-medium ${cls}`}>{children}</span>;
}

function CalibrationChip({ state, age }: { state: string | null; age: number | null }) {
  if (!state) return <Chip tone="neutral">calibration: —</Chip>;
  const tone = state === "ok" ? "ok" : state === "running" ? "warn" : "bad";
  const ageText = age === null ? "" : age < 3600 ? ` · ${Math.round(age / 60)} min` : ` · ${(age / 3600).toFixed(1)} h`;
  return (
    <Chip tone={tone}>
      calibration: {state}
      {state === "ok" ? ageText : ""}
    </Chip>
  );
}
