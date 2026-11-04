"use client";
// Dims a chart while results have stopped: the trend charts and sparklines anchor "now" to the
// newest sample, so frozen data would otherwise look current. A leaf on the 2 Hz result:
// `children` is created by the slow parent, so the chart inside does not re-render.
import type { ReactNode } from "react";
import { useResult, useStale } from "@/lib/live";

export function StaleDim({ children, note = false }: { children: ReactNode; note?: boolean }) {
  const result = useResult();
  const late = useStale(result);
  const stale = !!result && late; // before the first result there is nothing to call old
  return (
    <div className={`relative transition-opacity ${stale ? "opacity-50" : ""}`}>
      {children}
      {stale && note && <p className="pointer-events-none absolute right-1 top-0 rounded bg-surface/90 px-1.5 text-xs text-muted">No new readings: last values shown</p>}
    </div>
  );
}
