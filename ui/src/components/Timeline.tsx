"use client";
// The day at a glance: who was in the room, in what position, how active, and
// when alerts happened, over the last 1 / 6 / 24 h, from /api/v1/history (5 s
// rows) and /api/v1/alerts plus the live tail. Colours are the design tokens,
// so "present" here is the same teal as the room card. Pointer and touch both
// show the moment under the finger in words.
import { useEffect, useRef, useState } from "react";
import { getAlerts, getHistory, type Alert, type HistoryRow } from "@/lib/api";
import { useLive, usePublished } from "@/lib/live";
import { token, useResolvedTheme } from "@/lib/useTheme";
import { POSTURE_TEXT, activityText, alertTitle, clock } from "@/lib/words";
import { Card, btn } from "./ui";

const RANGES: { label: string; hours: number }[] = [
  { label: "1 h", hours: 1 },
  { label: "6 h", hours: 6 },
  { label: "24 h", hours: 24 },
];

const PRESENCE_VAR: Record<string, string> = { present: "--present", empty: "--timeline-empty", uncertain: "--uncertain" };
const POSTURE_VAR: Record<string, string> = { lying: "--posture-lying", sitting: "--posture-sitting", standing: "--posture-standing", unknown: "--posture-unknown" };
const LEVEL_VAR: Record<string, string> = { high: "--alert-high", medium: "--alert-medium", low: "--alert-low" };
const PRESENCE_WORD: Record<string, string> = { present: "Someone there", empty: "Nobody there", uncertain: "Not sure" };
const BUCKET_MS = 5000;
const GUTTER = 64; // px for lane labels on the left

interface Hover {
  x: number;
  text: string;
}

export function Timeline({ showPosture: wantPosture = true }: { showPosture?: boolean }) {
  const { alerts: liveAlerts, result } = useLive();
  const published = usePublished();
  const showPosture = wantPosture && published.posture;
  const theme = useResolvedTheme();
  const [hours, setHours] = useState(1);
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loaded, setLoaded] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  // Refetch on range change, on alert changes, and every 15 s.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const to = Date.now();
      const from = to - hours * 3600 * 1000;
      try {
        const [h, a] = await Promise.all([getHistory(from, to), getAlerts("open,acked,resolved")]);
        if (cancelled) return;
        setRows(h.rows);
        setAlerts(a.alerts.filter((x) => x.created_at >= from));
        setLoaded(true);
      } catch {
        /* offline: keep what we have */
      }
    };
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [hours, liveAlerts]);

  // Draw whenever data, the latest result or the theme changes.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== W * dpr || c.height !== h * dpr) {
      c.width = W * dpr;
      c.height = h * dpr;
    }
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, h);

    const w = W - GUTTER;
    const to = Date.now();
    const from = to - hours * 3600 * 1000;
    const x = (t: number) => GUTTER + ((t - from) / (to - from)) * w;
    const bucketW = Math.max(1, (BUCKET_MS / (to - from)) * w);

    const laneTop = 16;
    const laneH = 16;
    const gap = 6;
    const presenceY = laneTop;
    const postureY = presenceY + laneH + gap;
    const motionY = (showPosture ? postureY + laneH : presenceY + laneH) + gap;
    const motionH = h - motionY - 20;

    const muted = token("--muted");
    const grid = token("--chart-grid");
    // lane guides (no data stays unfilled, so it never looks like "nobody") and labels
    g.fillStyle = grid;
    g.fillRect(GUTTER, presenceY + laneH / 2, w, 1);
    if (showPosture) g.fillRect(GUTTER, postureY + laneH / 2, w, 1);
    g.fillRect(GUTTER, motionY + motionH, w, 1);
    g.fillStyle = muted;
    g.font = "500 11px system-ui, sans-serif";
    g.textAlign = "left";
    g.textBaseline = "middle";
    g.fillText("In room", 0, presenceY + laneH / 2);
    if (showPosture) g.fillText("Position", 0, postureY + laneH / 2);
    g.fillText("Activity", 0, motionY + motionH / 2);

    // live tail: the latest result is newer than the last 5 s row
    const all =
      result && (rows.length === 0 || result.ts > rows[rows.length - 1].t + BUCKET_MS)
        ? [...rows, { t: result.ts, presence: result.presence.state, posture: result.posture?.label ?? null, motion: result.motion }]
        : rows;

    const colors = {
      presence: Object.fromEntries(Object.entries(PRESENCE_VAR).map(([k, v]) => [k, token(v)])),
      posture: Object.fromEntries(Object.entries(POSTURE_VAR).map(([k, v]) => [k, token(v)])),
      activity: token("--chart-activity"),
    };
    for (const r of all) {
      const px = x(r.t);
      if (px + bucketW < GUTTER || px > W) continue;
      if (r.presence) {
        g.fillStyle = colors.presence[r.presence] ?? grid;
        g.fillRect(px, presenceY, bucketW + 0.5, laneH);
      }
      if (showPosture && r.posture) {
        g.fillStyle = colors.posture[r.posture] ?? grid;
        g.fillRect(px, postureY, bucketW + 0.5, laneH);
      }
      if (typeof r.motion === "number") {
        const mh = Math.max(1, Math.min(1, r.motion) * motionH);
        g.fillStyle = colors.activity;
        g.fillRect(px, motionY + motionH - mh, bucketW + 0.5, mh);
      }
    }

    // time axis
    g.fillStyle = muted;
    g.font = "11px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "alphabetic";
    const stepMs = hours <= 1 ? 15 * 60_000 : hours <= 6 ? 60 * 60_000 : 4 * 3600_000;
    const first = Math.ceil(from / stepMs) * stepMs;
    for (let t = first; t <= to; t += stepMs) {
      const px = x(t);
      if (px < GUTTER + 16 || px > W - 24) continue;
      g.fillRect(px, h - 18, 1, 4);
      g.fillText(clock(t), px, h - 3);
    }
    g.textAlign = "right";
    g.fillText("now", W - 1, h - 3);

    // alert markers
    for (const a of alerts) {
      const px = x(a.created_at);
      if (px < GUTTER || px > W) continue;
      g.fillStyle = token(LEVEL_VAR[a.level] ?? "--alert-low");
      g.beginPath();
      g.moveTo(px, 12);
      g.lineTo(px - 5, 2);
      g.lineTo(px + 5, 2);
      g.closePath();
      g.fill();
      g.fillRect(px - 0.75, 12, 1.5, h - 30);
    }
    // now line
    g.fillStyle = token("--fg");
    g.fillRect(W - 1.5, presenceY - 2, 1.5, h - presenceY - 18);
  }, [rows, alerts, hours, result, showPosture, theme]);

  const onPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvas.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < GUTTER) return setHover(null);
    const frac = (px - GUTTER) / (rect.width - GUTTER);
    const to = Date.now();
    const from = to - hours * 3600 * 1000;
    const t = from + frac * (to - from);
    const near = alerts.find((a) => Math.abs(a.created_at - t) < (to - from) * 0.015);
    let row: HistoryRow | undefined;
    for (const r of rows) if (Math.abs(r.t - t) < BUCKET_MS * Math.max(1, hours)) row = r;
    const time = clock(t);
    let text = `${time} · no data`;
    if (near) text = `${clock(near.created_at)} · Alert: ${alertTitle(near.type)}`;
    else if (row) {
      const parts = [time, PRESENCE_WORD[row.presence ?? ""] ?? "no data"];
      if (showPosture && row.posture && row.presence === "present") parts.push((POSTURE_TEXT[row.posture] ?? row.posture).toLowerCase());
      if (typeof row.motion === "number" && row.presence !== "empty") parts.push(activityText(row.motion).toLowerCase());
      text = parts.join(" · ");
    }
    setHover({ x: px, text });
  };

  const empty = loaded && rows.length === 0 && !result;

  return (
    <Card
      title="Today in the room"
      className="lg:col-span-3"
      actions={
        <div className="flex rounded-lg bg-surface-2 p-0.5" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r.hours} onClick={() => setHours(r.hours)} aria-pressed={hours === r.hours} className={btn.segment(hours === r.hours)}>
              {r.label}
            </button>
          ))}
        </div>
      }
    >
      <div className="relative">
        <canvas
          ref={canvas}
          onPointerMove={onPoint}
          onPointerDown={onPoint}
          onPointerLeave={() => setHover(null)}
          className={`w-full touch-pan-y ${showPosture ? "h-36" : "h-28"}`}
          role="img"
          aria-label={`Timeline of the last ${hours} hour${hours > 1 ? "s" : ""}: presence, ${showPosture ? "position, " : ""}activity and alerts`}
        />
        {hover && (
          <div
            className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-fg px-2 py-1 text-xs font-medium text-bg shadow"
            style={{ left: `clamp(80px, ${hover.x}px, calc(100% - 80px))` }}
          >
            {hover.text}
          </div>
        )}
        {empty && <p className="absolute inset-0 flex items-center justify-center pl-16 text-sm text-muted">No history yet. It fills in as the sensor runs.</p>}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted">
        <Legend v="--present">Someone there</Legend>
        <Legend v="--uncertain">Not sure</Legend>
        <Legend v="--timeline-empty">Nobody</Legend>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-px w-3 bg-line" /> No data
        </span>
        {showPosture && (
          <>
            <Legend v="--posture-lying">Lying</Legend>
            <Legend v="--posture-sitting">Sitting</Legend>
            <Legend v="--posture-standing">Standing</Legend>
          </>
        )}
        <Legend v="--chart-activity">Activity (taller = more movement)</Legend>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="text-alert-high">▼</span> Alert
        </span>
        <span className="text-subtle">Tap or hover for details</span>
      </div>
    </Card>
  );
}

function Legend({ v, children, outline }: { v: string; children: React.ReactNode; outline?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={`inline-block h-3 w-3 rounded-sm ${outline ? "border border-line" : ""}`} style={{ background: `var(${v})` }} />
      {children}
    </span>
  );
}
