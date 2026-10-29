"use client";
// Breathing waveform on uPlot (plan-v2 §8), fed from the ref-held ring buffer
// without React re-renders: the chart is updated on requestAnimationFrame
// whenever a new result has arrived. The amplitude has no unit a person can
// use, so there is no y-axis; the x-axis reads "30 s ago … now". Colours come
// from the design tokens and follow the theme.
import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { WAVE_HZ, type LiveBuffers } from "@/lib/live";
import { token, useResolvedTheme } from "@/lib/useTheme";

export function BreathingChart({ buffers, seconds, height = 110, big = false }: { buffers: LiveBuffers; seconds: number; height?: number; big?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const theme = useResolvedTheme();

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const n = seconds * WAVE_HZ;

    const plot = new uPlot(
      {
        width: el.clientWidth || 300,
        height,
        scales: { x: { time: false, range: [-seconds, 0] }, y: { range: [-0.45, 0.45] } },
        axes: [
          { show: false },
          { show: false },
        ],
        series: [{}, { stroke: token("--chart-breath"), width: big ? 3 : 2, points: { show: false }, spanGaps: false }],
        legend: { show: false },
        cursor: { show: false },
        padding: [6, 0, 6, 0],
      },
      [[], []],
      el,
    );

    let drawn = -1;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (drawn === buffers.version) return;
      drawn = buffers.version;
      const ys = buffers.wave.toArray().slice(-n);
      const xs = ys.map((_, i) => (i - ys.length + 1) / WAVE_HZ);
      plot.setData([xs, ys]);
    };
    raf = requestAnimationFrame(tick);

    const ro = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height }));
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      plot.destroy();
    };
  }, [buffers, seconds, height, big, theme]);

  const span = seconds >= 60 ? `${seconds / 60} min` : `${seconds} s`;
  return (
    <div role="img" aria-label={`Breathing movement over the last ${span}`}>
      <div ref={host} className="w-full border-b border-line" />
      <div className={`mt-1 flex justify-between text-subtle ${big ? "text-base" : "text-xs"}`}>
        <span>{span} ago</span>
        <span>now</span>
      </div>
    </div>
  );
}
