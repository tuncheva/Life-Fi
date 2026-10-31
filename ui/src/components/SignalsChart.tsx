"use client";
// Live signals over the last 2 minutes, one point per result (2 Hz): motion M,
// the deviation from the empty room S, the breathing-band energy B, the link's
// RSSI and the estimated distance. Each series has its own scale (their units
// differ); the left axis is motion 0..1, the right axis metres. Click a legend
// entry to hide or show it. Fed from the ref-held ring buffer on
// requestAnimationFrame, like BreathingChart.
import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { SIGNAL_SECONDS, useLive } from "@/lib/live";
import { token, useResolvedTheme } from "@/lib/useTheme";

const fmt = (digits: number, unit = "") => (_u: uPlot, v: number | null) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : `${v.toFixed(digits)}${unit}`);

/** Range of the visible values with a little headroom; [0, 1] when there are none. */
const autoRange = (_u: uPlot, lo: number | null, hi: number | null): uPlot.Range.MinMax => {
  if (lo === null || hi === null || !Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  const pad = Math.max(1e-3, (hi - lo) * 0.15);
  return [lo - pad, hi + pad];
};

export function SignalsChart({ height = 220 }: { height?: number }) {
  const { buffers } = useLive();
  const host = useRef<HTMLDivElement>(null);
  const theme = useResolvedTheme();

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const axis = token("--chart-axis");
    const grid = token("--chart-grid");
    const plot = new uPlot(
      {
        width: el.clientWidth || 300,
        height,
        scales: {
          x: { time: false, range: [-SIGNAL_SECONDS, 0] },
          m: { range: [0, 1] },
          s: { range: autoRange },
          b: { range: autoRange },
          dbm: { range: autoRange },
          d: { range: [0, 8] },
        },
        axes: [
          { stroke: axis, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, values: (_u, vs) => vs.map((v) => (v === 0 ? "now" : `${Math.round(-v)} s`)) },
          { scale: "m", stroke: axis, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, size: 36 },
          { scale: "d", side: 1, stroke: axis, grid: { show: false }, ticks: { stroke: grid }, size: 36, values: (_u, vs) => vs.map((v) => `${v} m`) },
        ],
        series: [
          { label: "time", value: (_u, v) => (v === null ? "–" : `${Math.round(-v)} s ago`) },
          { label: "Motion", scale: "m", stroke: token("--chart-motion"), width: 2, points: { show: false }, value: fmt(2) },
          { label: "Room change S", scale: "s", stroke: token("--chart-deviation"), width: 1.5, points: { show: false }, value: fmt(3) },
          { label: "Breathing band B", scale: "b", stroke: token("--chart-breath"), width: 1.5, points: { show: false }, value: fmt(4) },
          { label: "RSSI", scale: "dbm", stroke: token("--chart-rssi"), width: 1.5, dash: [4, 3], points: { show: false }, value: fmt(1, " dBm") },
          { label: "Distance", scale: "d", stroke: token("--chart-distance"), width: 2.5, points: { show: false }, spanGaps: false, value: fmt(1, " m") },
        ],
        legend: { live: true },
        cursor: { drag: { x: false, y: false } },
        padding: [8, 4, 0, 0],
      },
      [[], [], [], [], [], []],
      el,
    );

    let drawn = -1;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (drawn === buffers.version) return;
      drawn = buffers.version;
      const rows = buffers.signals.toArray();
      const now = rows.length ? rows[rows.length - 1]!.t : 0;
      plot.setData([
        rows.map((r) => (r.t - now) / 1000),
        rows.map((r) => r.M),
        rows.map((r) => r.S),
        rows.map((r) => r.B),
        rows.map((r) => r.rssi),
        rows.map((r) => r.d),
      ]);
    };
    raf = requestAnimationFrame(tick);

    const ro = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height }));
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      plot.destroy();
    };
  }, [buffers, height, theme]);

  return (
    <div>
      <div ref={host} role="img" aria-label="Live signals over the last 2 minutes: motion, room change, breathing band, RSSI and distance" className="w-full text-xs text-muted" />
      <p className="mt-2 text-sm text-muted">What the detectors read, twice a second, straight from the board. Click a name to hide or show it.</p>
    </div>
  );
}
