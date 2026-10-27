"use client";
// Guided empty-room calibration (plan-v2 §6.6, §8): "leave the room now",
// a countdown, a motion warning, and the outcome.
import { useEffect, useState } from "react";
import { calibrate, ensurePin } from "@/lib/api";
import { useLive } from "@/lib/live";
import { Card } from "@/components/Cards";
import { Chip } from "@/components/TopBar";

const DURATIONS = [
  { s: 120, label: "2 min (real)" },
  { s: 30, label: "30 s" },
  { s: 10, label: "10 s (demo)" },
];

export default function CalibratePage() {
  const { result, status } = useLive();
  const job = status?.calibration_job ?? null;
  const [duration, setDuration] = useState(120);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  const running = job?.state === "running";
  const remaining = running ? Math.max(0, Math.ceil((job.started_at + job.duration_s * 1000 - now) / 1000)) : 0;
  const motion = result?.motion ?? 0;
  const motionSeen = running && motion > 0.1;
  const cal = result?.calibration;

  const start = async () => {
    setError(null);
    if (!ensurePin()) return;
    try {
      await calibrate("empty", duration);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Empty-room calibration">
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          The engine records what the room looks like with nobody in it. Still-person presence depends on it; motion, breathing and fall detection do not.
        </p>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm">
          <li>Pick the duration. Two minutes is the real one; the short ones are for demos.</li>
          <li>Press start, then <strong>everyone leaves the room and closes the door</strong>.</li>
          <li>Stay out until the countdown ends. Any motion makes the engine refuse the calibration.</li>
        </ol>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <select
            value={duration}
            disabled={running}
            onChange={(e) => setDuration(Number(e.target.value))}
            className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            {DURATIONS.map((d) => (
              <option key={d.s} value={d.s}>
                {d.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => void start()}
            disabled={running || !status?.engine.connected}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
          >
            {running ? "Running…" : "Start calibration"}
          </button>
          {!status?.engine.connected && <Chip tone="bad">engine offline</Chip>}
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </Card>

      <Card title="Progress">
        {!job && <div className="text-sm text-zinc-500">No calibration started from this dashboard yet.</div>}
        {running && (
          <div>
            <div className="text-5xl font-bold tabular-nums">{remaining}s</div>
            <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
              <div className="h-full bg-sky-500 transition-[width]" style={{ width: `${100 - (remaining / job.duration_s) * 100}%` }} />
            </div>
            <div className={`mt-3 text-lg font-semibold ${motionSeen ? "text-red-600" : "text-emerald-600"}`}>
              {motionSeen ? "Motion seen! Leave the room." : "Leave the room now and stay out."}
            </div>
            <div className="mt-1 text-sm text-zinc-500">motion {motion.toFixed(2)}</div>
          </div>
        )}
        {job?.state === "ok" && (
          <div>
            <Chip tone="ok">calibration saved</Chip>
            <div className="mt-2 text-sm">
              New calibration id <code>{job.id ?? "—"}</code> at {job.finished_at ? new Date(job.finished_at).toLocaleTimeString() : ""}.
            </div>
          </div>
        )}
        {job?.state === "failed" && (
          <div>
            <Chip tone="bad">calibration failed</Chip>
            <div className="mt-2 text-sm">{job.error}</div>
            <div className="mt-1 text-xs text-zinc-500">Usually: someone moved during it. Leave the room and try again.</div>
          </div>
        )}
        <div className="mt-4 border-t border-zinc-200 pt-3 text-sm dark:border-zinc-800">
          Engine calibration now:{" "}
          {cal ? (
            <Chip tone={cal.state === "ok" ? "ok" : cal.state === "running" ? "warn" : "bad"}>
              {cal.state}
              {cal.id ? ` · ${cal.id}` : ""}
              {cal.age_s !== null ? ` · ${Math.round(cal.age_s / 60)} min old` : ""}
            </Chip>
          ) : (
            "—"
          )}
        </div>
      </Card>
    </div>
  );
}
