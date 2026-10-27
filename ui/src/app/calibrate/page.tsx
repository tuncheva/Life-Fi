"use client";
// Guided empty-room calibration (plan-v2 §6.6, §8): numbered steps, "leave the
// room now", a countdown readable from the doorway, a motion warning, and an
// outcome that says what to do next.
import { useState } from "react";
import Link from "next/link";
import { calibrate } from "@/lib/api";
import { useLive, useNow } from "@/lib/live";
import { friendlyError, usePin } from "@/lib/pin";
import { calibrationText, clock } from "@/lib/words";
import { Card, Icon, Notice, Pill, btn } from "@/components/ui";

const DURATIONS = [
  { s: 120, label: "2 min", note: "the real one" },
  { s: 30, label: "30 s", note: "quick check" },
  { s: 10, label: "10 s", note: "demo only" },
];

function Step({ n, done, children }: { n: number; done?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold ${done ? "bg-ok text-white" : "bg-surface-2 text-muted"}`}>{done ? <Icon name="check" className="h-4 w-4" /> : n}</span>
      <div className="pt-0.5 text-sm">{children}</div>
    </li>
  );
}

export default function CalibratePage() {
  const { result, status } = useLive();
  const { withPin } = usePin();
  const job = status?.calibration_job ?? null;
  const [duration, setDuration] = useState(120);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(250);

  const running = job?.state === "running";
  const remaining = running ? Math.max(0, Math.ceil((job.started_at + job.duration_s * 1000 - now) / 1000)) : 0;
  const motion = result?.motion ?? 0;
  const motionSeen = running && motion > 0.1;
  const cal = calibrationText(result?.calibration ?? status?.engine.status?.calibration ?? null);
  const engineUp = !!status?.engine.connected;

  const start = async () => {
    setError(null);
    try {
      await withPin(() => calibrate("empty", duration));
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="md:col-span-2">
        <h1 className="text-2xl font-bold tracking-tight">Empty-room calibration</h1>
        <p className="text-sm text-muted">
          Life-Fi learns what the room looks like with nobody in it. Noticing a person who sits very still depends on it; movement, breathing and falls do not.
        </p>
      </div>

      <Card title="How to do it">
        <ol className="space-y-4">
          <Step n={1}>
            <p className="font-medium">Choose how long</p>
            <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Duration">
              {DURATIONS.map((d) => (
                <button
                  key={d.s}
                  role="radio"
                  aria-checked={duration === d.s}
                  disabled={running}
                  onClick={() => setDuration(d.s)}
                  className={`rounded-lg border px-3 py-2 text-left ${duration === d.s ? "border-primary ring-1 ring-primary" : "border-line hover:bg-surface-2"}`}
                >
                  <span className="block font-semibold">{d.label}</span>
                  <span className="block text-xs text-muted">{d.note}</span>
                </button>
              ))}
            </div>
          </Step>
          <Step n={2} done={running || job?.state === "ok"}>
            <p className="font-medium">Press start, then everyone leaves the room and closes the door</p>
            <button onClick={() => void start()} disabled={running || !engineUp} className={`${btn.primary} mt-2 px-6 py-3 text-base`}>
              {running ? "Calibrating…" : "Start calibration"}
            </button>
            {status && !engineUp && <p className="mt-2 text-sm text-danger">The sensor software is not running, so it can&apos;t calibrate now.</p>}
            {error && <Notice tone="danger" className="mt-2">{error}</Notice>}
          </Step>
          <Step n={3} done={job?.state === "ok"}>
            <p className="font-medium">Stay out until the countdown ends</p>
            <p className="text-muted">Any movement in the room makes it refuse the calibration, and you start again.</p>
          </Step>
        </ol>
      </Card>

      <Card title="Progress">
        {!job && <p className="text-sm text-muted">Nothing running. The countdown appears here, big enough to read from the doorway.</p>}
        {running && (
          <div aria-live="polite">
            <div className="text-7xl font-bold tabular-nums sm:text-8xl">{remaining}s</div>
            <div className="mt-3 h-3 w-full overflow-hidden rounded-full bg-surface-2">
              <div className="h-full bg-fg transition-[width] duration-300" style={{ width: `${100 - (remaining / job.duration_s) * 100}%` }} />
            </div>
            <p className={`mt-4 flex items-center gap-2 text-xl font-semibold ${motionSeen ? "text-danger" : "text-ok"}`} role={motionSeen ? "alert" : undefined}>
              <Icon name={motionSeen ? "alert" : "check"} className="h-6 w-6" />
              {motionSeen ? "Movement seen! Everyone must leave the room." : "No movement seen. Stay out."}
            </p>
          </div>
        )}
        {job?.state === "ok" && (
          <div>
            <p className="flex items-center gap-2 text-xl font-semibold text-ok">
              <Icon name="check" className="h-6 w-6" /> Done. The empty room is saved.
            </p>
            <p className="mt-1 text-sm text-muted">
              Calibration {job.id ?? ""} finished at {job.finished_at ? clock(job.finished_at) : "—"}. You can go back in.
            </p>
            <Link href="/" className={`${btn.secondary} mt-3`}>
              Back to the room
            </Link>
          </div>
        )}
        {job?.state === "failed" && (
          <div>
            <p className="flex items-center gap-2 text-xl font-semibold text-danger">
              <Icon name="alert" className="h-6 w-6" /> It didn&apos;t work
            </p>
            <p className="mt-1 text-sm">{job.error}</p>
            <p className="mt-1 text-sm text-muted">Usually someone moved or was still in the room. Make sure it is empty and start again.</p>
          </div>
        )}
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-sm">
          <span className="text-muted">Right now:</span>
          {status ? <Pill tone={cal.tone}>{cal.text}</Pill> : <span className="text-muted">connecting…</span>}
        </div>
      </Card>
    </div>
  );
}
