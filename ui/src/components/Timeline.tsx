"use client";
// Day timeline: presence and posture bands, motion, and alert markers over
// the last 1 / 6 / 24 h, from /api/v1/history (5 s rows) and /api/v1/alerts.
import { useEffect, useRef, useState } from "react";
import { getAlerts, getHistory, type Alert, type HistoryRow } from "@/lib/api";
import { useLive } from "@/lib/live";
import { Card } from "./Cards";
import { alertText } from "./AlertBanner";

const RANGES: { label: string; hours: number }[] = [
  { label: "1 h", hours: 1 },
  { label: "6 h", hours: 6 },
  { label: "24 h", hours: 24 },
];

const PRESENCE_COLOR: Record<string, string> = { present: "#10b981", empty: "#52525b", uncertain: "#f59e0b" };
const POSTURE_COLOR: Record<string, string> = { lying: "#3b82f6", sitting: "#14b8a6", standing: "#f59e0b", unknown: "#71717a" };
const LEVEL_COLOR: Record<string, string> = { high: "#ef4444", medium: "#f97316", low: "#a1a1aa" };
const BUCKET_MS = 5000;

export function Timeline({ showPosture = true }: { showPosture?: boolean }) {
  const { alerts: liveAlerts, result } = useLive();
  const [hours, setHours] = useState(1);
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<string | null>(null);

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

  // Draw whenever data or the latest result changes.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== w * dpr || c.height !== h * dpr) {
      c.width = w * dpr;
      c.height = h * dpr;
    }
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const now = Date.now();
    const to = now;
    const from = to - hours * 3600 * 1000;
    const x = (t: number) => ((t - from) / (to - from)) * w;
    const bucketW = Math.max(1, (BUCKET_MS / (to - from)) * w);

    const laneTop = 18;
    const laneH = 12;
    const gap = 4;
    const presenceY = laneTop;
    const postureY = presenceY + laneH + gap;
    const motionY = (showPosture ? postureY + laneH : presenceY + laneH) + gap;
    const motionH = h - motionY - 18;

    // live tail: the latest result is newer than the last 5 s row
    const all = result && (rows.length === 0 || result.ts > rows[rows.length - 1].t + BUCKET_MS)
      ? [...rows, { t: result.ts, presence: result.presence.state, posture: result.posture?.label ?? null, motion: result.motion }]
      : rows;

    for (const r of all) {
      const px = x(r.t);
      if (px + bucketW < 0 || px > w) continue;
      if (r.presence) {
        g.fillStyle = PRESENCE_COLOR[r.presence] ?? "#52525b";
        g.fillRect(px, presenceY, bucketW + 0.5, laneH);
      }
      if (showPosture && r.posture) {
        g.fillStyle = POSTURE_COLOR[r.posture] ?? "#71717a";
        g.fillRect(px, postureY, bucketW + 0.5, laneH);
      }
      if (typeof r.motion === "number") {
        const mh = Math.min(1, r.motion) * motionH;
        g.fillStyle = r.motion > 0.6 ? "#ef4444" : r.motion > 0.2 ? "#f59e0b" : "#34d399";
        g.fillRect(px, motionY + motionH - mh, bucketW + 0.5, mh);
      }
    }

    // axis
    g.fillStyle = "#71717a";
    g.font = "10px system-ui, sans-serif";
    g.textAlign = "center";
    const stepMs = hours <= 1 ? 10 * 60_000 : hours <= 6 ? 60 * 60_000 : 3 * 3600_000;
    const first = Math.ceil(from / stepMs) * stepMs;
    for (let t = first; t <= to; t += stepMs) {
      const px = x(t);
      g.fillRect(px, h - 16, 1, 4);
      g.fillText(new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), px, h - 3);
    }
    // alert markers
    for (const a of alerts) {
      const px = x(a.created_at);
      if (px < 0 || px > w) continue;
      g.fillStyle = LEVEL_COLOR[a.level] ?? "#a1a1aa";
      g.beginPath();
      g.moveTo(px, 14);
      g.lineTo(px - 5, 3);
      g.lineTo(px + 5, 3);
      g.closePath();
      g.fill();
      g.fillRect(px - 0.5, 14, 1, h - 30);
    }
    // now line
    g.fillStyle = "#e4e4e7";
    g.fillRect(w - 1, 0, 1, h - 18);
  }, [rows, alerts, hours, result, showPosture]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const c = canvas.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const to = Date.now();
    const from = to - hours * 3600 * 1000;
    const t = from + frac * (to - from);
    const near = alerts.find((a) => Math.abs(a.created_at - t) < (to - from) * 0.01);
    const row = rows.find((r) => Math.abs(r.t - t) < BUCKET_MS);
    const time = new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (near) setHover(`${time} · ${alertText(near.type)} (${near.state})`);
    else if (row) setHover(`${time} · ${row.presence ?? "—"}${row.posture ? ` · ${row.posture}` : ""}${typeof row.motion === "number" ? ` · motion ${row.motion.toFixed(2)}` : ""}`);
    else setHover(time);
  };

  return (
    <Card title="Timeline" className="md:col-span-2 lg:col-span-3">
      <div className="mb-2 flex items-center gap-2 text-xs">
        {RANGES.map((r) => (
          <button
            key={r.hours}
            onClick={() => setHours(r.hours)}
            className={`rounded px-2 py-0.5 ${hours === r.hours ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-black" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"}`}
          >
            {r.label}
          </button>
        ))}
        <span className="ml-auto text-zinc-400">{hover ?? "hover for details"}</span>
      </div>
      <canvas ref={canvas} onMouseMove={onMove} onMouseLeave={() => setHover(null)} className={`w-full ${showPosture ? "h-32" : "h-28"}`} aria-label="timeline" />
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
        <Legend color={PRESENCE_COLOR.present}>present</Legend>
        <Legend color={PRESENCE_COLOR.uncertain}>uncertain</Legend>
        <Legend color={PRESENCE_COLOR.empty}>empty</Legend>
        {showPosture && (
          <>
            <Legend color={POSTURE_COLOR.lying}>lying</Legend>
            <Legend color={POSTURE_COLOR.sitting}>sitting</Legend>
            <Legend color={POSTURE_COLOR.standing}>standing</Legend>
          </>
        )}
        <Legend color="#34d399">motion</Legend>
        <Legend color={LEVEL_COLOR.high}>▲ alert</Legend>
      </div>
    </Card>
  );
}

function Legend({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
      {children}
    </span>
  );
}
