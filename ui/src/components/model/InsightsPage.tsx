"use client";
// The /model page, "Insights" (plan M §5): what the sensor sees over the last 15 minutes,
// one collapsible section per question a user asks, each with a live summary in its
// header. Charts come from the trend ring (live results, seeded from the server's
// in-memory last 15 min on load). This component reads the slow live state only.
import { useEffect, useState } from "react";
import { readWindow, safeStorage, WINDOWS, windowText, writeWindow, type WindowS } from "@/lib/model";
import { RoomCard } from "../Cards";
import { Section } from "../Section";
import { btn } from "../ui";
import { VitalsCard } from "../vitals/VitalsCard";
import { HoursBody } from "./HoursSection";
import {
  BreathingBody,
  BreathSummary,
  HealthBody,
  HealthSummary,
  HeartBody,
  HeartSummary,
  MovementBody,
  MovementSummary,
  PresenceBody,
  PresenceSummary,
  RawBody,
  WhereBody,
  WhereSummary,
} from "./sections";

export function InsightsPage() {
  const [windowS, setWindowS] = useState<WindowS>(900);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage exists only after hydration
    setWindowS(readWindow(safeStorage()));
  }, []);
  const pick = (w: WindowS) => {
    setWindowS(w);
    writeWindow(safeStorage(), w);
  };

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-x-6">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Insights</h1>
          <p className="text-base font-medium text-muted">What the sensor sees</p>
          <p className="mt-1 max-w-2xl text-sm text-muted">Everything the system reads from the Wi-Fi signal over the last 15 minutes, and breathing, heart and movement over the last hours. Open a section for its chart.</p>
        </div>
        <div className="flex self-start rounded-lg bg-surface-2 p-0.5 sm:self-auto" role="group" aria-label="Time window">
          {WINDOWS.map((w) => (
            <button key={w} type="button" onClick={() => pick(w)} aria-pressed={windowS === w} className={btn.segment(windowS === w)}>
              {windowText(w)}
            </button>
          ))}
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 [&>*]:min-w-0">
        <VitalsCard trendsLink={false} className="lg:self-start" />
        <div className="lg:col-span-2">
          <RoomCard headingLevel={2} />
        </div>
      </div>

      <Section id="presence" title="Presence" subtitle="Was someone there?" defaultOpen summary={<PresenceSummary />}>
        <PresenceBody windowS={windowS} />
      </Section>
      <Section id="breathing" title="Breathing" subtitle="Rate over time" defaultOpen summary={<BreathSummary />}>
        <BreathingBody windowS={windowS} />
      </Section>
      <Section id="heart" title="Heart rate, experimental" subtitle="A rough trend only" defaultOpen summary={<HeartSummary />}>
        <HeartBody windowS={windowS} />
      </Section>
      <Section id="movement" title="Movement" subtitle="Why vitals go missing" defaultOpen summary={<MovementSummary />}>
        <MovementBody windowS={windowS} />
      </Section>
      {/* not open by default: its body queries up to 24 h of stored rows (track H) */}
      <Section id="hours" title="Last hours" subtitle="How was the night?">
        <HoursBody />
      </Section>
      <Section id="where" title="Where" subtitle="Distance and the taught spots" defaultOpen summary={<WhereSummary />}>
        <WhereBody windowS={windowS} />
      </Section>
      <Section id="health" title="Sensor health" subtitle="Can the rest be trusted?" summary={<HealthSummary />}>
        <HealthBody windowS={windowS} />
      </Section>
      <Section id="raw" title="Raw signal" subtitle="For installers">
        <RawBody />
      </Section>
    </div>
  );
}
