"use client";
// One small chart for the "Last hours" section (track H): the median per bucket from
// GET /api/v1/history/vitals, x on the local clock, one line, a fixed y range so the shape
// means the same every night, gaps where there was no reading (never bridged). Same idiom as
// TrendChart: created in an effect keyed on the theme and the data, colours from tokens,
// width from a ResizeObserver, destroyed on unmount. No animation loop: the data changes
// only when the section refetches.
import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { token, useResolvedTheme } from "@/lib/useTheme";

export function HoursChart({
  xs,
  ys,
  range,
  color,
  digits = 0,
  label,
  emptyText,
}: {
  /** Bucket starts, ms since epoch. */
  xs: number[];
  ys: (number | null)[];
  range: readonly [number, number];
  /** CSS custom property, e.g. "--chart-breath". */
  color: string;
  digits?: number;
  label: string;
  emptyText: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const theme = useResolvedTheme();
  const points = ys.filter((v) => v !== null).length;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const height = window.innerWidth < 640 ? 120 : 140;
    const axis = token("--chart-axis");
    const grid = token("--chart-grid");
    const plot = new uPlot(
      {
        width: el.clientWidth || 300,
        height,
        scales: { x: { time: true }, y: { range: [range[0], range[1]] } },
        axes: [
          { stroke: axis, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid } },
          { stroke: axis, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, size: 44, values: (_u, vs) => vs.map((v) => v.toFixed(digits)) },
        ],
        series: [{}, { stroke: token(color), width: 2, points: { show: true, size: 4 }, spanGaps: false }],
        legend: { show: false },
        cursor: { show: false },
        padding: [8, 16, 0, 0],
      },
      // uPlot's time axis is in seconds
      [xs.map((t) => t / 1000), ys] as uPlot.AlignedData,
      el,
    );
    const ro = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      plot.destroy();
    };
  }, [xs, ys, range, color, digits, theme]);

  const empty = points < 2;
  return (
    <div className="relative">
      <div ref={host} role="img" aria-label={label} className={`w-full text-xs text-muted ${empty ? "opacity-40" : ""}`} />
      {empty && (
        <p className="pointer-events-none absolute inset-x-0 top-1/3 mx-auto w-fit max-w-[90%] rounded-lg bg-surface/90 px-3 py-1.5 text-center text-sm text-muted shadow-sm">{emptyText}</p>
      )}
    </div>
  );
}
