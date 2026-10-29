"use client";
// Development only: drives the mock engine's scenarios. Hidden in production builds.
import { useEffect, useState } from "react";
import { devScenarios, devSetScenario, type ScenarioInfo } from "@/lib/api";
import { useLive } from "@/lib/live";

export function DevPanel() {
  const { status } = useLive();
  const [scenarios, setScenarios] = useState<ScenarioInfo[] | null>(null);
  const [open, setOpen] = useState(false);
  const mock = status?.engine.status?.mock;

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    devScenarios()
      .then((r) => setScenarios(r.scenarios))
      .catch(() => setScenarios(null));
  }, [status?.engine.connected]);

  if (process.env.NODE_ENV === "production" || !scenarios) return null;

  return (
    <div className="fixed bottom-3 right-3 z-30 max-w-[60vw] text-xs sm:max-w-xs">
      <button onClick={() => setOpen(!open)} className="max-w-full truncate rounded-lg bg-zinc-900 px-3 py-2 font-mono text-white shadow-lg dark:bg-zinc-100 dark:text-black">
        mock: {mock?.scenario ?? "?"} · {mock?.phase ?? ""} {open ? "▾" : "▴"}
      </button>
      {open && (
        <div className="mt-2 rounded-lg border border-zinc-300 bg-white p-2 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
          {scenarios.map((s) => (
            <button
              key={s.name}
              title={s.description}
              onClick={() => void devSetScenario(s.name)}
              className={`mb-1 block w-full rounded px-2 py-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 ${mock?.scenario === s.name ? "font-bold" : ""}`}
            >
              {s.name} <span className="text-zinc-400">{s.loop ? "loop" : `${s.duration_s}s`}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
