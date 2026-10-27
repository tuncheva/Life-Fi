"use client";
// Breathing waveform on uPlot (plan-v2 §8), fed from the ref-held ring buffer
// without React re-renders: the chart is updated on requestAnimationFrame
// whenever a new result has arrived.
import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { WAVE_HZ, type LiveBuffers } from "@/lib/live";

export function BreathingChart({ buffers, seconds, height = 110 }: { buffers: LiveBuffers; seconds: number; height?: number }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const axis = dark ? "#71717a" : "#a1a1aa";
    const grid = dark ? "#27272a" : "#e4e4e7";
    const n = seconds * WAVE_HZ;

    const plot = new uPlot(
      {
        width: el.clientWidth || 300,
        height,
        scales: { x: { time: false, range: [-seconds, 0] }, y: { range: [-0.45, 0.45] } },
        axes: [
          { stroke: axis, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, values: (_u, vals) => vals.map((v) => (v === 0 ? "now" : `${v}s`)), font: "10px system-ui" },
          { stroke: axis, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, size: 34, font: "10px system-ui", values: (_u, vals) => vals.map((v) => v.toFixed(1)) },
        ],
        series: [{}, { stroke: "#0ea5e9", width: 1.5, points: { show: false }, spanGaps: false }],
        legend: { show: false },
        cursor: { show: false },
        padding: [8, 8, 0, 0],
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
  }, [buffers, seconds, height]);

  return <div ref={host} className="w-full" aria-label={`breathing waveform, last ${seconds} seconds`} />;
}
