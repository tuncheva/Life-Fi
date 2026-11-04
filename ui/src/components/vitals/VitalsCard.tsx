"use client";
// Vital signs (docs/overnight/2026-11-04/plans/M-dashboard-model.md §4): breaths and,
// experimental, heart beats per minute, each with its reason in words when there is no
// trusted number, a 10 min sparkline, and the breathing wave below. The card reads only
// the slow live state; the numbers are leaves on the 2 Hz result, and the wave chart is
// passed in as an element so the 2 Hz leaves never re-render it.
import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useLiveSlow, useResult, type LiveBuffers } from "@/lib/live";
import type { TrendSample } from "@/lib/model";
import { BREATH_SPARK, HEART_SPARK, vitalsView, vitalsWaiting, type VitalView, type Vitals } from "@/lib/vitals";
import { BreathingChart } from "../BreathingChart";
import { useRoomStatus } from "../RoomView";
import { Card, Pill, btn } from "../ui";
import { Sparkline } from "./Sparkline";
import { StaleDim } from "./StaleDim";

const pickBreath = (s: TrendSample) => s.breath;
const pickHeart = (s: TrendSample) => s.heart;

export const HEART_CAPTION = "From one Wi-Fi link. Not a medical measurement.";

/** The current vitals for leaf components (2 Hz). */
export function useVitals(): Vitals {
  const result = useResult();
  const { blind } = useRoomStatus();
  return result ? vitalsView(result, blind) : vitalsWaiting(blind);
}

/** "Experimental" beside every heart-rate label. */
export function ExperimentalPill() {
  return (
    <Pill tone="warn" title="Heart rate from one Wi-Fi link is near the limit of what it can pick up">
      Experimental
    </Pill>
  );
}

/** The number slot keeps its size with or without a number ("—"), and the reason is a small line under it, so the card does not jump. */
function Reading({ v, big }: { v: VitalView; big: boolean }) {
  const none = v.value === null;
  return (
    <>
      <p className="flex items-baseline gap-1.5">
        <span className={`font-bold tabular-nums ${big ? "text-4xl" : "text-3xl"} ${none ? "text-subtle" : ""}`} aria-hidden={none || undefined}>
          {none ? "—" : v.value}
        </span>
        <span className="text-sm text-muted">{v.unit}</span>
      </p>
      <p className="text-sm text-muted">{none ? v.text : v.quality === "steady" ? "Steady reading" : "Rough reading"}</p>
    </>
  );
}

function BreathNumber() {
  return <Reading v={useVitals().breath} big />;
}

/** Whether the engine sends a heart estimate at all, then the number or reason. */
function HeartColumn({ buffers }: { buffers: LiveBuffers }) {
  const result = useResult();
  const vitals = useVitals();
  // "not estimated" only when a result exists without `heart`; before any result it is just no reading yet
  const heart = vitals.heart ?? (result ? null : { ...vitals.breath, unit: "beats/min" as const });
  if (!heart) return <p className="text-sm text-muted">Heart rate is not estimated by this engine.</p>;
  return (
    <>
      <div className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="text-sm font-semibold">Heart</h3>
        <ExperimentalPill />
      </div>
      <div className="mt-1 min-h-14">
        <Reading v={heart} big={false} />
      </div>
      <div className="mt-2">
        <StaleDim>
          <Sparkline buffers={buffers} pick={pickHeart} range={HEART_SPARK} color="--chart-heart" label="Heart rate, last 10 minutes" />
        </StaleDim>
      </div>
      <p className="mt-1 text-xs text-subtle">{HEART_CAPTION}</p>
    </>
  );
}

/** Dims the wave while there is no breathing reading; `children` is created by the slow parent. */
function Dim({ children }: { children: ReactNode }) {
  const on = useVitals().breath.state === "reading";
  return <div className={`mt-4 transition-opacity ${on ? "" : "opacity-40"}`}>{children}</div>;
}

/** One polite sentence for screen readers, changed only when a vital's state changes, not its number. */
function Announce() {
  const v = useVitals();
  const b = v.breath.state;
  const h = v.heart?.state ?? "absent";
  const sentence = useMemo(() => {
    const bs = b === "reading" ? "Breathing rate is being read." : b === "off" ? "Vital signs are not available." : "No breathing reading right now.";
    const hs = h === "reading" ? " Experimental heart rate is being read." : "";
    return bs + hs;
  }, [b, h]);
  return (
    <p className="sr-only" aria-live="polite">
      {sentence}
    </p>
  );
}

export function VitalsCard({ trendsLink = true, className = "" }: { trendsLink?: boolean; className?: string }) {
  const { buffers } = useLiveSlow();
  const [seconds, setSeconds] = useState(30);
  const wave = useMemo(() => <BreathingChart buffers={buffers} seconds={seconds} />, [buffers, seconds]);
  return (
    <Card
      title="Vital signs"
      className={className}
      actions={
        <div className="flex rounded-lg bg-surface-2 p-0.5" role="group" aria-label="Breathing wave window">
          {[30, 300].map((sec) => (
            <button key={sec} type="button" onClick={() => setSeconds(sec)} aria-pressed={seconds === sec} className={btn.segment(seconds === sec)}>
              {sec === 30 ? "30 s" : "5 min"}
            </button>
          ))}
        </div>
      }
    >
      <Announce />
      <div className="grid grid-cols-2 gap-4 [&>*]:min-w-0">
        <div>
          <h3 className="flex min-h-6 items-center text-sm font-semibold">Breathing</h3>
          <div className="mt-1 min-h-14">
            <BreathNumber />
          </div>
          <div className="mt-2">
            <StaleDim>
              <Sparkline buffers={buffers} pick={pickBreath} range={BREATH_SPARK} color="--chart-breath" label="Breathing rate, last 10 minutes" />
            </StaleDim>
          </div>
          <p className="mt-1 text-xs text-subtle">Last 10 min</p>
        </div>
        <div>
          <HeartColumn buffers={buffers} />
        </div>
      </div>
      <Dim>{wave}</Dim>
      <p className="mt-2 text-xs text-muted">
        Picked up from the Wi-Fi signal, for one still person near the sensor. Not a medical measurement. Heart rate is experimental.
        {trendsLink && (
          <>
            {" "}
            <Link href="/model#breathing" className="font-medium text-link hover:underline">
              See trends →
            </Link>
          </>
        )}
      </p>
    </Card>
  );
}
