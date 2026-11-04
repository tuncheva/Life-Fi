"use client";
// A tiny trend line on a plain 2D canvas (no uPlot: several per page, drawn at 2 Hz):
// the last few minutes of one TrendSample field on a fixed y range, gaps where the
// value is null or the data stops. Redraws on requestAnimationFrame only when
// buffers.version changed, like the other charts.
import { useEffect, useRef } from "react";
import type { LiveBuffers } from "@/lib/live";
import { trendSnapshot, windowed, type Pick } from "@/lib/model";
import { token, useResolvedTheme } from "@/lib/useTheme";

const GAP_MS = 2000;

export function Sparkline({
  buffers,
  pick,
  range,
  color,
  label,
  seconds = 600,
  height = 32,
}: {
  buffers: LiveBuffers;
  pick: Pick;
  range: readonly [number, number];
  /** CSS custom property of the line colour, e.g. "--chart-breath". */
  color: string;
  label: string;
  seconds?: number;
  height?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useResolvedTheme();
  const pickRef = useRef(pick);
  useEffect(() => {
    pickRef.current = pick;
  }, [pick]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const stroke = token(color);
    const grid = token("--chart-grid");
    let drawn = -1;
    let raf = 0;
    let width = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const w = c.clientWidth;
      if (drawn === buffers.version && w === width) return;
      drawn = buffers.version;
      width = w;
      const dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(height * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(height * dpr);
      }
      const g = c.getContext("2d");
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, height);
      g.strokeStyle = grid;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, height - 0.5);
      g.lineTo(w, height - 0.5);
      g.stroke();
      const rows = windowed(trendSnapshot(buffers), seconds);
      if (!rows.length) return;
      const now = rows[rows.length - 1]!.t;
      const [lo, hi] = range;
      const x = (t: number) => w - ((now - t) / (seconds * 1000)) * w;
      const y = (v: number) => height - 2 - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (height - 4);
      g.strokeStyle = stroke;
      g.lineWidth = 1.5;
      g.lineJoin = "round";
      g.beginPath();
      let pen = false;
      let lastT = 0;
      for (const s of rows) {
        const v = pickRef.current(s);
        if (v === null || !Number.isFinite(v)) {
          pen = false;
          continue;
        }
        if (pen && s.t - lastT <= GAP_MS) g.lineTo(x(s.t), y(v));
        else g.moveTo(x(s.t), y(v));
        pen = true;
        lastT = s.t;
      }
      g.stroke();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [buffers, range, color, seconds, height, theme]);

  return <canvas ref={canvas} role="img" aria-label={label} className="block w-full" style={{ height }} />;
}
