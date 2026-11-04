"use client";
// One trend chart for the /model (Insights) sections: uPlot over the 15 min trend ring
// (buffers.trend, seeded from GET /api/v1/recent), x in seconds ago like SignalsChart,
// fixed y ranges so the shape means the same every time, and optional guide lines, a
// neutral reference band, a ±sd band and a state strip drawn in uPlot hooks. Same idiom
// as the other charts: created in an effect keyed on the theme, colours from tokens,
// width from a ResizeObserver, redrawn on requestAnimationFrame only when
// buffers.version changed, data copied once per tick for every chart (trendSnapshot).
import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { LiveBuffers } from "@/lib/live";
import { trendSnapshot, windowed, type Pick, type TrendSample } from "@/lib/model";
import { token, useResolvedTheme } from "@/lib/useTheme";

export interface TrendSeriesSpec {
  label: string;
  /** CSS custom property, e.g. "--chart-breath". */
  color: string;
  pick: Pick;
  scale?: string;
  dash?: number[];
  width?: number;
}

export interface TrendAxisSpec {
  scale: string;
  /** Fixed range, or "auto" for the visible values with headroom. */
  range: readonly [number, number] | "auto";
  unit?: string;
  digits?: number;
  side?: "left" | "right";
}

export interface TrendChartSpec {
  series: TrendSeriesSpec[];
  axes: TrendAxisSpec[];
  /** Dashed horizontal lines with a small label. */
  guides?: { scale: string; value: number; label: string }[];
  /** A neutral filled band, e.g. "typical at rest"; never an alarm colour. */
  band?: { scale: string; lo: number; hi: number; label: string };
  /** Shaded ±spread around a value (distance ± sd). */
  spread?: { scale: string; color: string; lo: Pick; hi: Pick };
  /** A coloured strip along the bottom, one CSS token per sample (null = nothing). */
  strip?: (s: TrendSample) => string | null;
}

const autoRange = (_u: uPlot, lo: number | null, hi: number | null): uPlot.Range.MinMax => {
  if (lo === null || hi === null || !Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  const pad = Math.max(1, (hi - lo) * 0.15);
  return [lo - pad, hi + pad];
};

/** "#0d9488" → "rgba(13, 148, 136, a)"; other colour syntaxes are returned as they are. */
function withAlpha(c: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  if (!m) return c;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const STRIP_PX = 8;
const GAP_S = 2;

/** "now", "30 s", "5 min" for the seconds-ago axis. */
function agoText(v: number, windowS: number): string {
  if (v === 0) return "now";
  const s = Math.round(-v);
  return windowS >= 300 ? `${Math.round(s / 60)} min` : `${s} s`;
}

/** Inserts null where the data stops for more than 2 s, so lines break instead of bridging the gap. */
function withGaps(cols: (number | null)[][]): (number | null)[][] {
  const xs = cols[0]!;
  const out: (number | null)[][] = cols.map(() => []);
  for (let i = 0; i < xs.length; i++) {
    if (i > 0 && (xs[i] as number) - (xs[i - 1] as number) > GAP_S) {
      out[0]!.push(((xs[i] as number) + (xs[i - 1] as number)) / 2);
      for (let c = 1; c < cols.length; c++) out[c]!.push(null);
    }
    for (let c = 0; c < cols.length; c++) out[c]!.push(cols[c]![i]!);
  }
  return out;
}

export function TrendChart({ buffers, spec, windowS, label, emptyText }: { buffers: LiveBuffers; spec: TrendChartSpec; windowS: number; label: string; emptyText?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const theme = useResolvedTheme();
  const [points, setPoints] = useState<number | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const height = window.innerWidth < 640 ? 120 : 160;
    const axis = token("--chart-axis");
    const grid = token("--chart-grid");
    const muted = token("--muted") || axis;
    let rows: readonly TrendSample[] = [];

    const scales: uPlot.Scales = { x: { time: false, range: [-windowS, 0] } };
    for (const a of spec.axes) scales[a.scale] = { range: a.range === "auto" ? autoRange : (a.range as [number, number]) };
    const axes: uPlot.Axis[] = [
      { stroke: axis, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, values: (_u, vs) => vs.map((v) => agoText(v, windowS)) },
      ...spec.axes.map(
        (a, i): uPlot.Axis => ({
          scale: a.scale,
          side: a.side === "right" ? 1 : 3,
          stroke: axis,
          grid: { show: i === 0, stroke: grid, width: 1 },
          ticks: { stroke: grid },
          size: 44,
          values: (_u, vs) => vs.map((v) => `${v.toFixed(a.digits ?? 0)}${a.unit ?? ""}`),
        }),
      ),
    ];
    const series: uPlot.Series[] = [{}];
    const bands: uPlot.Band[] = [];
    if (spec.spread) {
      const fill = token(spec.spread.color);
      series.push({ scale: spec.spread.scale, stroke: "transparent", points: { show: false }, spanGaps: false });
      series.push({ scale: spec.spread.scale, stroke: "transparent", points: { show: false }, spanGaps: false });
      bands.push({ series: [1, 2], fill: withAlpha(fill, 0.18) });
    }
    for (const s of spec.series) series.push({ label: s.label, scale: s.scale ?? spec.axes[0]!.scale, stroke: token(s.color), width: s.width ?? 2, dash: s.dash, points: { show: false }, spanGaps: false });
    const picks: Pick[] = [...(spec.spread ? [spec.spread.hi, spec.spread.lo] : []), ...spec.series.map((s) => s.pick)];

    const dpr = () => window.devicePixelRatio || 1;
    const drawClear = (u: uPlot) => {
      const ctx = u.ctx;
      const { left, top, width, height: h } = u.bbox;
      if (spec.band) {
        const y1 = u.valToPos(spec.band.hi, spec.band.scale, true);
        const y2 = u.valToPos(spec.band.lo, spec.band.scale, true);
        ctx.save();
        ctx.fillStyle = grid;
        ctx.globalAlpha = 0.7;
        ctx.fillRect(left, y1, width, y2 - y1);
        ctx.globalAlpha = 1;
        ctx.fillStyle = muted;
        ctx.font = `${11 * dpr()}px system-ui, sans-serif`;
        ctx.textBaseline = "top";
        ctx.fillText(spec.band.label, left + 4 * dpr(), y1 + 2 * dpr());
        ctx.restore();
      }
      if (spec.strip && rows.length) {
        const now = rows[rows.length - 1]!.t;
        const sh = STRIP_PX * dpr();
        const colours = new Map<string, string>();
        ctx.save();
        for (let i = 0; i < rows.length; i++) {
          const name = spec.strip(rows[i]!);
          if (!name) continue;
          const next = rows[i + 1];
          const x0 = u.valToPos((rows[i]!.t - now) / 1000, "x", true);
          const x1 = next && next.t - rows[i]!.t <= GAP_S * 1000 ? u.valToPos((next.t - now) / 1000, "x", true) : x0 + Math.max(1, (0.5 / windowS) * width);
          if (!colours.has(name)) colours.set(name, token(name));
          ctx.fillStyle = colours.get(name)!;
          ctx.fillRect(x0, top + h - sh, Math.max(1, x1 - x0), sh);
        }
        ctx.restore();
      }
    };
    const draw = (u: uPlot) => {
      if (!spec.guides?.length) return;
      const ctx = u.ctx;
      const { left, width } = u.bbox;
      ctx.save();
      ctx.font = `${11 * dpr()}px system-ui, sans-serif`;
      ctx.textBaseline = "bottom";
      for (const g of spec.guides) {
        const y = u.valToPos(g.value, g.scale, true);
        ctx.strokeStyle = axis;
        ctx.lineWidth = 1 * dpr();
        ctx.setLineDash([5 * dpr(), 4 * dpr()]);
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(left + width, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = muted;
        ctx.textAlign = "right";
        ctx.fillText(g.label, left + width - 4 * dpr(), y - 2 * dpr());
      }
      ctx.restore();
    };

    const plot = new uPlot(
      {
        width: el.clientWidth || 300,
        height,
        scales,
        axes,
        series,
        bands,
        legend: { show: false },
        cursor: { show: false },
        padding: [8, 4, 0, 0],
        hooks: { drawClear: [drawClear], draw: [draw] },
      },
      [[], ...picks.map(() => [])],
      el,
    );

    let drawn = -1;
    let raf = 0;
    let lastPoints = -1;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (drawn === buffers.version) return;
      drawn = buffers.version;
      rows = windowed(trendSnapshot(buffers), windowS);
      const now = rows.length ? rows[rows.length - 1]!.t : 0;
      const cols: (number | null)[][] = [rows.map((r) => (r.t - now) / 1000), ...picks.map((p) => rows.map(p))];
      plot.setData(withGaps(cols) as uPlot.AlignedData);
      // the empty state follows the main series only (the first one after a spread)
      const main = cols[1 + (spec.spread ? 2 : 0)]!;
      let n = 0;
      for (const v of main) if (v !== null) n++;
      const capped = Math.min(n, 2);
      if (capped !== lastPoints) {
        lastPoints = capped;
        setPoints(capped);
      }
    };
    raf = requestAnimationFrame(tick);

    const ro = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height }));
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      plot.destroy();
    };
  }, [buffers, spec, windowS, theme]);

  const empty = points !== null && points < 2;
  return (
    <div className="relative">
      <div ref={host} role="img" aria-label={label} className={`w-full text-xs text-muted transition-opacity ${empty && !spec.strip ? "opacity-40" : ""}`} />
      {empty && emptyText && (
        <p className="pointer-events-none absolute inset-x-0 top-1/3 mx-auto w-fit max-w-[90%] rounded-lg bg-surface/90 px-3 py-1.5 text-center text-sm text-muted shadow-sm">{emptyText}</p>
      )}
    </div>
  );
}
