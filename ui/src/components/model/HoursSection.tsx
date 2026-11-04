"use client";
// "Last hours" on Insights (track H, "how was the night?"): breathing, experimental heart rate
// and movement over 1, 6 or 24 h from the stored 5 s history (GET /api/v1/history/vitals),
// one median per bucket. Its own range control, separate from the page's short live window.
// The server decides what counts as a reading (server/vitals-history.ts); this only draws it
// and says plainly when there is nothing to draw.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getVitalsHistory } from "@/lib/api";
import { minutesText, safeStorage } from "@/lib/model";
import { BREATH_SPARK, HEART_SPARK } from "@/lib/vitals";
import { bucketText, HISTORY_HOURS, shareText, withBucketGaps, type HistoryHours, type VitalsBucket, type VitalsHistoryReply } from "@/lib/vitals-history";
import { btn } from "../ui";
import { ExperimentalPill, HEART_CAPTION } from "../vitals/VitalsCard";
import { HoursChart } from "./HoursChart";

const KEY = "lifefi.model.hours";
const REFRESH_MS = 60_000;
const ROW_S = 5;
const MOTION_RANGE: readonly [number, number] = [0, 1];

function readHours(): HistoryHours {
  try {
    const v = Number(safeStorage()?.getItem(KEY));
    return (HISTORY_HOURS as readonly number[]).includes(v) ? (v as HistoryHours) : 24;
  } catch {
    return 24;
  }
}

function writeHours(h: HistoryHours) {
  try {
    safeStorage()?.setItem(KEY, String(h));
  } catch {
    // storage full or blocked: the choice just isn't remembered
  }
}

const Note = ({ children }: { children: ReactNode }) => <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">{children}</p>;
const Stat = ({ children }: { children: ReactNode }) => <p className="mt-2 text-sm tabular-nums">{children}</p>;
const Block = ({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) => (
  <div className="min-w-0">
    <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
      {title}
      {extra}
    </h3>
    {children}
  </div>
);

export function HoursBody() {
  // null until the remembered range is read after mount, so a 24 h query is not sent first for nothing
  const [hours, setHours] = useState<HistoryHours | null>(null);
  const [data, setData] = useState<VitalsHistoryReply | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage exists only after hydration
    setHours(readHours());
  }, []);

  useEffect(() => {
    if (hours === null) return;
    let stale = false;
    const load = () =>
      getVitalsHistory(hours).then(
        (reply) => {
          if (stale) return;
          setData(reply);
          setFailed(false);
        },
        () => {
          if (!stale) setFailed(true);
        },
      );
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => {
      stale = true;
      clearInterval(id);
    };
  }, [hours]);

  const pick = (h: HistoryHours) => {
    if (h === hours) return;
    setHours(h);
    writeHours(h);
    // the old range's data would be mislabelled while the new one loads
    setData(null);
    setFailed(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg bg-surface-2 p-0.5" role="group" aria-label="History range">
          {HISTORY_HOURS.map((h) => (
            <button key={h} type="button" onClick={() => pick(h)} aria-pressed={hours === h} className={btn.segment(hours === h)}>
              {h} h
            </button>
          ))}
        </div>
        {failed && data && <span className="text-sm text-muted">Couldn&apos;t refresh: showing the last data.</span>}
      </div>
      <HoursContent data={data} failed={failed} />
    </div>
  );
}

function HoursContent({ data, failed }: { data: VitalsHistoryReply | null; failed: boolean }) {
  const bucketMs = (data?.bucket_s ?? 0) * 1000;
  const series = useMemo(() => {
    if (!data) return null;
    const g = (p: (b: VitalsBucket) => number | null) => withBucketGaps(data.buckets, bucketMs, p);
    return { breath: g((b) => b.breath_med), heart: g((b) => b.heart_med), motion: g((b) => b.motion_med) };
  }, [data, bucketMs]);

  if (!data || !series) return <Note>{failed ? "Couldn't load history." : "Loading…"}</Note>;
  if (data.buckets.length === 0) return <Note>No history yet. It builds up while the app runs, one reading every 5 seconds.</Note>;
  const s = data.summary;
  const per = bucketText(data.bucket_s);
  const span = `last ${Math.round((data.to - data.from) / 3_600_000)} h`;
  const movement = (
    <Block title="Movement">
      <HoursChart
        xs={series.motion[0]}
        ys={series.motion[1]}
        range={MOTION_RANGE}
        digits={1}
        color="--chart-motion"
        label={`Movement level, median per ${per}, ${span}`}
        emptyText="Nobody there in these hours"
      />
      {s.present_n > 0 && <Stat>Still {minutesText(s.still_n * ROW_S)} of the {minutesText(s.present_n * ROW_S)} someone was there</Stat>}
    </Block>
  );
  if (s.present_n === 0) {
    return (
      <>
        <Note>Nobody was there in these hours.</Note>
        <Footnote per={per} />
      </>
    );
  }
  if (!data.stored) {
    return (
      <>
        <Note>This profile does not keep breathing or heart history.</Note>
        {movement}
        <Footnote per={per} />
      </>
    );
  }
  const breathShare = shareText(s.breath_n, s.present_n);
  const heartShare = shareText(s.heart_n, s.present_n);
  return (
    <>
      <Block title="Breathing">
        <HoursChart
          xs={series.breath[0]}
          ys={series.breath[1]}
          range={BREATH_SPARK}
          color="--chart-breath"
          label={`Breathing rate, median per ${per}, ${span}`}
          emptyText="Not enough readings in these hours"
        />
        <Stat>
          Read {breathShare ?? "0 %"} of the time someone was there
          {s.breath_med !== null && ` · median ${s.breath_med.toFixed(1)} breaths/min`}
          {s.breath_q1 !== null && s.breath_q3 !== null && ` (typical ${s.breath_q1.toFixed(1)}–${s.breath_q3.toFixed(1)})`}
        </Stat>
      </Block>
      <Block title="Heart rate" extra={<ExperimentalPill />}>
        {s.heart_on_n === 0 ? (
          <Note>Not measured in these hours (no heart estimate, or data from before this update).</Note>
        ) : (
          <>
            <HoursChart
              xs={series.heart[0]}
              ys={series.heart[1]}
              range={HEART_SPARK}
              color="--chart-heart"
              label={`Experimental heart rate, median per ${per}, ${span}`}
              emptyText="Not enough readings in these hours"
            />
            <Stat>
              Read {heartShare ?? "0 %"} of the time someone was there
              {s.heart_med !== null && ` · median ${Math.round(s.heart_med)} beats/min`}
            </Stat>
          </>
        )}
        <p className="mt-1 text-xs text-subtle">Experimental. {HEART_CAPTION}</p>
      </Block>
      {movement}
      <Footnote per={per} />
    </>
  );
}

function Footnote({ per }: { per: string }) {
  return <p className="text-xs text-subtle">Each point is the median of one {per}. Gaps: nobody there, moving, too few readings, or the sensor was off.</p>;
}
