"use client";
// The /model (Insights) sections, one small component each (plan M §5): a live header
// summary (a leaf on the 2 Hz result), a "what this tells you" line, the chart, and a
// stat line from the trend ring that refreshes every 2 s. Every empty state says why.
import { useState } from "react";
import Link from "next/link";
import { useLiveSlow, useNow, useResult } from "@/lib/live";
import { minutesText, secondsWhere, spanSeconds, trendSnapshot, trendStats, windowed, windowText, type TrendSample } from "@/lib/model";
import { occupancyOf, qualityOf, reasonsOf } from "@/lib/room";
import { BREATH_TYPICAL, MOTION_ON, STILL_FOR_S } from "@/lib/vitals";
import { activityText, clock, reasonLinks } from "@/lib/words";
import { CsiHeatmap, DetectorCard, HealthCard } from "../Cards";
import { CsiSurface3DLazy, Room3DLazy } from "../LiveViews";
import type { PositionSource } from "../Room3D";
import { SignalsChart } from "../SignalsChart";
import { Card, btn } from "../ui";
import { ExperimentalPill, HEART_CAPTION, useVitals } from "../vitals/VitalsCard";
import { TrendChart, type TrendChartSpec } from "./TrendChart";

/** The trend samples of the window, re-read every 2 s (stat lines, empty states). */
function useTrendRows(windowS: number): readonly TrendSample[] {
  const { buffers } = useLiveSlow();
  useNow(2000);
  return windowed(trendSnapshot(buffers), windowS);
}

const Tells = ({ children }: { children: React.ReactNode }) => <p className="mb-3 text-sm text-muted">{children}</p>;
const Stat = ({ children }: { children: React.ReactNode }) => <p className="mt-2 text-sm font-medium tabular-nums">{children}</p>;

/** "of the last 15 min", or "since 14:02" while the ring covers less than the window. */
function windowPhrase(rows: readonly TrendSample[], windowS: number): string {
  if (rows.length && spanSeconds(rows) < windowS - 10) return `since ${clock(rows[0]!.t)}`;
  return `of the last ${windowText(windowS)}`;
}

const NO_DATA = "No data from the engine yet";
const pct = (x: number) => `${Math.round(x * 100)} %`;

// ---- 1. Presence ----

const PRESENCE_TOKEN: Record<TrendSample["presence"], string> = { present: "--present", uncertain: "--uncertain", empty: "--timeline-empty" };
const PRESENCE_SPEC: TrendChartSpec = {
  series: [{ label: "Occupancy level", color: "--chart-occupancy", pick: (s) => s.occP, scale: "p" }],
  axes: [{ scale: "p", range: [0, 1], digits: 1 }],
  strip: (s) => PRESENCE_TOKEN[s.presence],
};
const PRESENCE_WORD: Record<TrendSample["presence"], string> = { present: "Someone there", empty: "Nobody there", uncertain: "Not sure" };

export function PresenceSummary() {
  const r = useResult();
  if (!r) return null;
  const occ = occupancyOf(r);
  return (
    <>
      {PRESENCE_WORD[r.presence.state]}
      {occ ? ` · level ${occ.p.toFixed(2)}` : ""}
    </>
  );
}

export function PresenceBody({ windowS }: { windowS: number }) {
  const { buffers } = useLiveSlow();
  const rows = useTrendRows(windowS);
  const anyOcc = rows.some((s) => s.occP !== null);
  const there = secondsWhere(rows, (s) => s.presence === "present");
  return (
    <>
      <Tells>Was someone there, and how sure is the system? The strip at the bottom is the decision (teal: someone there, amber: not sure, grey: nobody); the line is the occupancy level behind it, 0 to 1.</Tells>
      <TrendChart buffers={buffers} spec={PRESENCE_SPEC} windowS={windowS} label={`Presence and occupancy level over the last ${windowText(windowS)}`} />
      <Legend items={[["--present", "Someone there"], ["--uncertain", "Not sure"], ["--timeline-empty", "Nobody"], ["--chart-occupancy", "Occupancy level"]]} />
      <Stat>{rows.length ? `Someone there ${minutesText(there)} ${windowPhrase(rows, windowS)}` : NO_DATA}</Stat>
      {rows.length > 0 && !anyOcc && <p className="mt-1 text-sm text-muted">This engine gives no occupancy level; showing the decision only.</p>}
      <p className="mt-1 text-xs text-subtle">The level is a fitted score, not a calibrated probability for this room.</p>
    </>
  );
}

function Legend({ items }: { items: [string, string][] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {items.map(([tok, text]) => (
        <li key={tok} className="flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: `var(${tok})` }} />
          {text}
        </li>
      ))}
    </ul>
  );
}

// ---- 2. Breathing ----

const BREATH_SPEC: TrendChartSpec = {
  series: [{ label: "Breaths/min", color: "--chart-breath", pick: (s) => s.breath, scale: "bpm", width: 2.5 }],
  axes: [{ scale: "bpm", range: [0, 40] }],
  band: { scale: "bpm", lo: BREATH_TYPICAL[0], hi: BREATH_TYPICAL[1], label: "typical at rest" },
};

export function BreathSummary() {
  const b = useVitals().breath;
  return <>{b.value ? `${b.value} breaths/min` : "No reading"}</>;
}

export function BreathingBody({ windowS }: { windowS: number }) {
  const { buffers } = useLiveSlow();
  const rows = useTrendRows(windowS);
  const st = trendStats(rows, (s) => s.breath);
  return (
    <>
      <Tells>Was the breathing rate steady, and when could it be read? Gaps are moments without a trusted reading (movement, nobody there, a weak signal). The grey band is a typical adult range at rest, for orientation only.</Tells>
      <TrendChart buffers={buffers} spec={BREATH_SPEC} windowS={windowS} label={`Breathing rate over the last ${windowText(windowS)}`} emptyText="No reading in this window" />
      <Stat>
        {!rows.length ? NO_DATA : st.read === 0 ? <NoReading /> : `Read ${pct(st.share)} of the time · median ${Math.round(st.median!)} · range ${Math.round(st.min!)}–${Math.round(st.max!)} breaths/min`}
      </Stat>
    </>
  );
}

function NoReading({ heart = false }: { heart?: boolean }) {
  const v = useVitals();
  const now = heart ? v.heart : v.breath;
  return <>No reading in this window{now && now.state !== "reading" ? `: ${now.text}` : ""}</>;
}

// ---- 3. Heart (experimental) ----

const HEART_SPEC: TrendChartSpec = {
  series: [{ label: "Beats/min", color: "--chart-heart", pick: (s) => s.heart, scale: "bpm", width: 2 }],
  axes: [{ scale: "bpm", range: [40, 140] }],
};

export function HeartSummary() {
  const r = useResult();
  const h = useVitals().heart;
  if (!r) return null;
  if (!h) return <>Not estimated by this engine</>;
  return <>{h.value ? `${h.value} beats/min` : "No reading"}</>;
}

export function HeartBody({ windowS }: { windowS: number }) {
  const { buffers } = useLiveSlow();
  const rows = useTrendRows(windowS);
  // from the ring, not the 2 Hz result, so the chart does not re-render twice a second
  const on = rows.some((s) => s.heartOn);
  // "not estimated" only when there are results and none carries `heart`; no results is just no data
  const none = !rows.length ? NO_DATA : null;
  const st = trendStats(rows, (s) => s.heart);
  return (
    <>
      <div className="mb-2">
        <ExperimentalPill />
      </div>
      <Tells>Roughly what heart rate does the signal suggest? One Wi-Fi link is near the limit of what it can pick up, so read this as a rough trend, never as a measurement.</Tells>
      {none ? (
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">{none}</p>
      ) : on ? (
        <>
          <TrendChart buffers={buffers} spec={HEART_SPEC} windowS={windowS} label={`Experimental heart rate over the last ${windowText(windowS)}`} emptyText="No reading in this window" />
          <Stat>{st.read === 0 ? <NoReading heart /> : `Read ${pct(st.share)} of the time · median ${Math.round(st.median!)} beats/min`}</Stat>
        </>
      ) : (
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">Heart rate is not estimated by this engine. When it is, the trend appears here.</p>
      )}
      <p className="mt-1 text-xs text-subtle">Experimental. {HEART_CAPTION}</p>
    </>
  );
}

// ---- 4. Movement ----

/** The engine's own motion gate for vital signs (lib/vitals.ts MOTION_ON), not a separate UI threshold. */
export const STILL_BELOW = MOTION_ON;
const MOVEMENT_SPEC: TrendChartSpec = {
  series: [{ label: "Motion", color: "--chart-motion", pick: (s) => (s.presence === "empty" ? null : s.motion), scale: "m" }],
  axes: [{ scale: "m", range: [0, 1], digits: 1 }],
  guides: [{ scale: "m", value: STILL_BELOW, label: "Above this counts as moving: vital signs pause" }],
};

export function MovementSummary() {
  const r = useResult();
  if (!r) return null;
  return <>{r.presence.state === "empty" ? "Nobody in range" : activityText(r.motion)}</>;
}

export function MovementBody({ windowS }: { windowS: number }) {
  const { buffers } = useLiveSlow();
  const rows = useTrendRows(windowS);
  const anyone = rows.some((s) => s.presence !== "empty");
  const still = secondsWhere(rows, (s) => s.presence === "present" && s.motion <= STILL_BELOW);
  return (
    <>
      <Tells>{`How much were they moving, and is that why vital signs were missing? Breathing needs about ${STILL_FOR_S.breath} s below the dashed line, heart rate about ${STILL_FOR_S.heart} s.`}</Tells>
      <TrendChart buffers={buffers} spec={MOVEMENT_SPEC} windowS={windowS} label={`Movement over the last ${windowText(windowS)}`} emptyText="Nobody in range" />
      <Stat>{!rows.length ? NO_DATA : anyone ? `Still ${minutesText(still)} ${windowPhrase(rows, windowS)}` : "Nobody in range"}</Stat>
    </>
  );
}

// ---- 5. Where ----

const WHERE_SPEC: TrendChartSpec = {
  series: [
    { label: "Distance", color: "--chart-distance", pick: (s) => (s.lowQuality ? null : s.d), scale: "d", width: 2.5 },
    // a rough-guess distance (quality not "medium", lib/room.ts) is drawn thin and dashed, never like a good one
    { label: "Distance, rough guess", color: "--chart-distance", pick: (s) => (s.lowQuality ? s.d : null), scale: "d", dash: [2, 3], width: 1.5 },
    { label: "Taught spot", color: "--chart-deviation", pick: (s) => s.spotD, scale: "d", dash: [6, 4], width: 2 },
  ],
  axes: [{ scale: "d", range: [0, 6], unit: " m" }],
  spread: { scale: "d", color: "--chart-distance", lo: (s) => (s.d === null ? null : Math.max(0, s.d - (s.sd ?? 0))), hi: (s) => (s.d === null ? null : s.d + (s.sd ?? 0)) },
};

const zoneOf = (d: number) => (d < 1.5 ? "near, under 1.5 m" : d <= 3.5 ? "middle, 1.5–3.5 m" : "far, over 3.5 m");

/** The header describes this moment only, and says so: the body below covers the whole window. */
export function WhereSummary() {
  const r = useResult();
  const p = r?.position;
  if (!r) return null;
  if (!p?.valid || p.d_m === null) return <>No distance right now</>;
  return <>{qualityOf(p) === "medium" ? `about ${p.d_m.toFixed(1)} m now` : `rough guess, about ${p.d_m.toFixed(1)} m`}</>;
}

/** Why the distance is rough, with a link to fix each reason. */
function WhyRough() {
  const r = useResult();
  const reasons = r?.position?.valid && qualityOf(r.position) !== "medium" ? reasonLinks(reasonsOf(r.position)) : [];
  if (!reasons.length) return null;
  return (
    <ul className="mt-2 space-y-1 text-sm text-muted">
      <li className="text-xs font-medium text-subtle">The distance is only a rough guess because:</li>
      {reasons.map((f) => (
        <li key={f.href} className="flex flex-wrap items-baseline gap-x-2">
          <span>{f.text}</span>
          <Link href={f.href} className="font-medium text-link hover:underline">
            Fix
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function WhereBody({ windowS }: { windowS: number }) {
  const { buffers } = useLiveSlow();
  const rows = useTrendRows(windowS);
  const st = trendStats(rows, (s) => s.d);
  // same rule as the room view: only "medium" distances are more than a rough guess
  const rough = trendStats(rows, (s) => (s.lowQuality ? s.d : null)).read * 2 >= st.read;
  const spotOn = rows.some((s) => s.spotOn);
  const [show3d, setShow3d] = useState(false);
  const [src, setSrc] = useState<PositionSource>("distance");
  return (
    <>
      <Tells>How far from the sensor, and does the taught-spot model agree? One link gives a distance, not a direction. The shaded band is the uncertainty; the dashed line is the distance of the spot the model picked, when it is reliable for this room.</Tells>
      <TrendChart buffers={buffers} spec={WHERE_SPEC} windowS={windowS} label={`Distance from the sensor and the taught spot over the last ${windowText(windowS)}`} emptyText="No distance yet: needs movement and about 10 s of packets" />
      <Legend items={[["--chart-distance", "Distance (± uncertainty; thin dotted = rough guess)"], ["--chart-deviation", "Taught spot (dashed)"]]} />
      <Stat>{!rows.length ? NO_DATA : st.median === null ? "No distance yet: needs movement and about 10 s of packets" : rough ? `Rough guess only: mostly ${zoneOf(st.median)}` : `Mostly ${zoneOf(st.median)} · median ${st.median.toFixed(1)} m`}</Stat>
      {rows.length > 0 && !spotOn && (
        <p className="mt-1 text-sm text-muted">
          No taught-spot model loaded.{" "}
          <Link href="/teach" className="font-medium text-link hover:underline">
            Teach the room&apos;s spots
          </Link>
        </p>
      )}
      <WhyRough />
      <div className="mt-4 border-t border-line pt-4">
        {!show3d ? (
          <button type="button" className={btn.secondary} onClick={() => setShow3d(true)}>
            Show 3D room
          </button>
        ) : (
          <Card
            className="min-w-0"
            title={src === "model" ? "Where (3D, spot model)" : "Where (3D, distance)"}
            actions={
              <div className="flex rounded-lg bg-surface-2 p-0.5" role="group" aria-label="3D view driven by">
                {(["distance", "model"] as const).map((k) => (
                  <button key={k} type="button" onClick={() => setSrc(k)} aria-pressed={src === k} className={btn.segment(src === k)}>
                    {k === "distance" ? "Distance" : "Spot model"}
                  </button>
                ))}
              </div>
            }
          >
            <Room3DLazy source={src} />
          </Card>
        )}
      </div>
    </>
  );
}

// ---- 6. Sensor health ----

const HEALTH_SPEC: TrendChartSpec = {
  series: [
    { label: "Packets/s", color: "--chart-rate", pick: (s) => s.rateHz, scale: "hz", width: 2 },
    { label: "RSSI", color: "--chart-rssi", pick: (s) => s.rssi, scale: "dbm", dash: [4, 3], width: 1.5 },
  ],
  axes: [
    { scale: "hz", range: [0, 120] },
    { scale: "dbm", range: "auto", unit: "", side: "right" },
  ],
  guides: [
    { scale: "hz", value: 80, label: "good" },
    { scale: "hz", value: 50, label: "poor" },
  ],
};

const packetsText = (hz: number) => `${Math.round(hz)} ${Math.round(hz) === 1 ? "packet" : "packets"}/s`;

export function HealthSummary() {
  const r = useResult();
  if (!r) return <>No data</>;
  return <>{packetsText(r.health.rate_hz)}</>;
}

export function HealthBody({ windowS }: { windowS: number }) {
  const { buffers } = useLiveSlow();
  const rows = useTrendRows(windowS);
  const avg = (pick: (s: TrendSample) => number) => (rows.length ? rows.reduce((a, s) => a + pick(s), 0) / rows.length : 0);
  const poor = secondsWhere(rows, (s) => s.rateHz < 50);
  return (
    <div className="grid gap-4 lg:grid-cols-3 [&>*]:min-w-0">
      <div className="lg:col-span-2">
        <Tells>Is the signal good enough to trust the rest? Everything above needs a steady stream of Wi-Fi packets: 80 per second or more is good, under 50 is poor. The dashed line is the signal strength (RSSI, right axis, dBm).</Tells>
        <TrendChart buffers={buffers} spec={HEALTH_SPEC} windowS={windowS} label={`Packet rate and signal strength over the last ${windowText(windowS)}`} emptyText="No data from the engine" />
        <Legend items={[["--chart-rate", "Packets per second"], ["--chart-rssi", "Signal strength (dBm, dashed)"]]} />
        <Stat>{!rows.length ? NO_DATA : `Avg ${packetsText(avg((s) => s.rateHz))} · loss ${(avg((s) => s.lossUdp) * 100).toFixed(1)} %${poor >= 1 ? ` · poor for ${minutesText(poor)}` : ""}`}</Stat>
      </div>
      <HealthCard />
    </div>
  );
}

// ---- 7. Raw signal ----

export function RawBody() {
  const [show3d, setShow3d] = useState(false);
  return (
    <>
      <Tells>What does the raw Wi-Fi signal look like? For installers: the detector values and the signal the system works from. No camera, no microphone, no image.</Tells>
      <div className="grid gap-4 lg:grid-cols-3 [&>*]:min-w-0">
        <CsiHeatmap />
        <DetectorCard />
        <div>
          <h3 className="mb-2 text-sm font-semibold">Live signals (last 2 min)</h3>
          <SignalsChart />
        </div>
      </div>
      <div className="mt-4 border-t border-line pt-4">
        {!show3d ? (
          <button type="button" className={btn.secondary} onClick={() => setShow3d(true)}>
            Show 3D surface
          </button>
        ) : (
          <Card className="min-w-0" title="What the sensor sees (3D)">
            <CsiSurface3DLazy />
          </Card>
        )}
      </div>
    </>
  );
}
