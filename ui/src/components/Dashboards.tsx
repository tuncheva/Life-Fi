"use client";
// One dashboard per profile (plan-v2 §11). The engine output is the same; the
// profile decides what is shown. Order by what the reader needs first
// (docs/plan/ui-ux.md §4.3): room state, then breathing, then the day, then
// the technical section for installers.
import { useEffect, useState } from "react";
import { getProfile, type ProfileView } from "@/lib/api";
import { useLive, useNow } from "@/lib/live";
import { BreathingCard, CsiHeatmap, DetectorCard, HealthCard, RoomCard, SensorDetails } from "./Cards";
import { Timeline } from "./Timeline";

function useProfileView(): ProfileView | null {
  const { status } = useLive();
  const [view, setView] = useState<ProfileView | null>(null);
  useEffect(() => {
    getProfile().then(setView).catch(() => {});
  }, [status?.server.profile]);
  return view;
}

function Details() {
  return (
    <SensorDetails>
      <HealthCard />
      <DetectorCard />
      <CsiHeatmap />
    </SensorDetails>
  );
}

export function HomeDashboard() {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <RoomCard />
      </div>
      <BreathingCard />
      <Timeline />
      <Details />
    </div>
  );
}

export function ClinicDashboard() {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <RoomCard />
      </div>
      <BreathingCard />
      <Timeline />
      <Details />
    </div>
  );
}

export function SchoolDashboard() {
  const view = useProfileView();
  const { status } = useLive();
  const now = useNow(30_000);
  const after = view?.profiles.school.occupancy?.after_hours;
  const inAfterHours = after ? inside(after.from, after.to, minutesOfDayIn(status?.server.time_zone, now)) : false;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="lg:col-span-3">
        <RoomCard afterHours={after ? { from: after.from, to: after.to, now: inAfterHours } : null} />
      </div>
      <Timeline showPosture={false} />
      <Details />
    </div>
  );
}

/** Minutes since midnight in the room's time zone (falls back to the browser's). */
function minutesOfDayIn(zone: string | undefined, at: number): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(at));
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return h * 60 + m;
  } catch {
    const d = new Date(at);
    return d.getHours() * 60 + d.getMinutes();
  }
}

function inside(from: string, to: string, minutes: number): boolean {
  const [fh, fm] = from.split(":").map(Number);
  const [th, tm] = to.split(":").map(Number);
  const f = fh * 60 + fm;
  const t = th * 60 + tm;
  return f <= t ? minutes >= f && minutes < t : minutes >= f || minutes < t;
}
