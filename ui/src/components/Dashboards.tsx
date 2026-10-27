"use client";
// One dashboard per profile (plan-v2 §11). The engine output is the same;
// the profile decides what is shown.
import { useEffect, useState } from "react";
import Link from "next/link";
import { getProfile, type ProfileView } from "@/lib/api";
import { useLive } from "@/lib/live";
import { BreathingCard, Card, CsiHeatmap, HealthCard, MotionCard, StateCard } from "./Cards";
import { Timeline } from "./Timeline";
import { Chip } from "./TopBar";
import { alertText } from "./AlertBanner";

function since(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function useProfileView(): ProfileView | null {
  const { status } = useLive();
  const [view, setView] = useState<ProfileView | null>(null);
  useEffect(() => {
    getProfile().then(setView).catch(() => {});
  }, [status?.server.profile]);
  return view;
}

export function HomeDashboard() {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      <StateCard />
      <MotionCard />
      <HealthCard />
      <BreathingCard />
      <CsiHeatmap />
      <ActiveAlertsCard />
      <Timeline />
    </div>
  );
}

export function ClinicDashboard() {
  const { result, alerts } = useLive();
  const bedExit = alerts.find((a) => a.type === "bed_exit" && (a.state === "open" || a.state === "acked"));
  const p = result?.presence.state;
  const bed =
    !result || p === "empty"
      ? { label: "Room empty", tone: "neutral" as const }
      : bedExit
        ? { label: "Out of bed", tone: "warn" as const }
        : result.posture?.label === "lying"
          ? { label: "In bed", tone: "ok" as const }
          : result.posture
            ? { label: `Up (${result.posture.label})`, tone: "warn" as const }
            : { label: p === "uncertain" ? "Uncertain" : "Present", tone: "warn" as const };

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      <Card title="Patient">
        <div className="flex items-baseline gap-3">
          <span className="text-3xl font-bold">{bed.label}</span>
          <Chip tone={bed.tone}>{p ?? "—"}</Chip>
        </div>
        <div className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
          {result?.posture ? (
            <>
              {result.posture.label} · since {since(result.posture.since)} <span className="text-xs text-zinc-400">(last known)</span>
            </>
          ) : (
            <span className="text-zinc-400">no posture</span>
          )}
        </div>
        {bedExit && <div className="mt-1 text-sm text-amber-600">Bed exit since {since(bedExit.created_at)}</div>}
        <div className="mt-3 text-xs text-zinc-400">Assumes a single patient in the room. Assistive notification, not a medical device.</div>
      </Card>
      <BreathingCard />
      <ActiveAlertsCard />
      <MotionCard />
      <HealthCard />
      <CsiHeatmap />
      <Timeline />
    </div>
  );
}

export function SchoolDashboard() {
  const { result, status } = useLive();
  const view = useProfileView();
  const after = view?.profiles.school.occupancy?.after_hours;
  const p = result?.presence.state;
  const occ = !result ? { label: "—", tone: "neutral" as const } : p === "present" ? { label: "In use", tone: "ok" as const } : p === "empty" ? { label: "Empty", tone: "neutral" as const } : { label: "Uncertain", tone: "warn" as const };
  const minutes = (() => {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  })();
  const inAfterHours = after ? inside(after.from, after.to, minutes) : false;

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      <Card title="Room occupancy">
        <div className="flex items-baseline gap-3">
          <span className="text-3xl font-bold">{occ.label}</span>
          <Chip tone={occ.tone}>{p ?? "—"}</Chip>
        </div>
        <div className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
          {result?.count ? (result.count.value === 2 ? "several people" : "one person") : "people count not available"}
          {result?.motion !== undefined && ` · motion ${result.motion.toFixed(2)}`}
        </div>
        {after && (
          <div className="mt-1 text-sm">
            After hours {after.from}–{after.to}:{" "}
            {inAfterHours ? <Chip tone={p === "present" ? "warn" : "ok"}>{p === "present" ? "occupied after hours" : "now"}</Chip> : <Chip tone="neutral">not now</Chip>}
          </div>
        )}
        <div className="mt-3 text-xs text-zinc-400">Multiple people are normal here. Breathing is neither shown nor stored in the School profile.</div>
      </Card>
      <ActiveAlertsCard />
      <HealthCard />
      <Timeline showPosture={false} />
      {status?.server.profile === "school" && <CsiHeatmap />}
    </div>
  );
}

function inside(from: string, to: string, minutes: number): boolean {
  const [fh, fm] = from.split(":").map(Number);
  const [th, tm] = to.split(":").map(Number);
  const f = fh * 60 + fm;
  const t = th * 60 + tm;
  return f <= t ? minutes >= f && minutes < t : minutes >= f || minutes < t;
}

export function ActiveAlertsCard() {
  const { alerts } = useLive();
  const active = alerts.filter((a) => a.state === "open" || a.state === "acked" || a.state === "pending");
  return (
    <Card title="Active alerts">
      {active.length === 0 ? (
        <div className="text-sm text-zinc-500">None. All quiet.</div>
      ) : (
        <ul className="space-y-1 text-sm">
          {active.map((a) => (
            <li key={a.id} className="flex items-center gap-2">
              <Chip tone={a.state === "open" ? "bad" : "warn"}>{a.state}</Chip>
              <span>{alertText(a.type)}</span>
              <span className="ml-auto text-xs text-zinc-400">{since(a.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
      <Link href="/alerts/" className="mt-2 inline-block text-xs text-sky-600 hover:underline">
        history →
      </Link>
    </Card>
  );
}
