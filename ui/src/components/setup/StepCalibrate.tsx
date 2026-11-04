// Step 3: empty-room calibration. The countdown and the outcome come from the
// server's calibration job (Status.calibration_job), so a calibration started on
// another device is joined, not started twice.
import { useState } from "react";
import { ApiError, calibrate, type CalibrationJob } from "@/lib/api";
import { useNow } from "@/lib/live";
import { friendlyError, usePin } from "@/lib/pin";
import { CALIBRATION_SECONDS, calibrationProgress } from "@/lib/setup";
import { calibrationText, stopwatch } from "@/lib/words";
import type { Result } from "@/lib/contracts.gen";
import { btn, Notice } from "@/components/ui";

export function StepCalibrate({
  job,
  calibration,
  engineUp,
  onNext,
  onSensor,
}: {
  job: CalibrationJob | null;
  calibration: Result["calibration"] | null;
  engineUp: boolean;
  onNext: () => void;
  onSensor: () => void;
}) {
  const { withPin } = usePin();
  // Outcomes of jobs that ended before this page opened are old news.
  const [openedAt] = useState(() => Date.now());
  const [seconds, setSeconds] = useState<(typeof CALIBRATION_SECONDS)[number]>(60);
  const [error, setError] = useState<{ text: string; offline: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useNow(500);
  const p = calibrationProgress(job, now, openedAt);
  const current = calibrationText(calibration);

  const start = async () => {
    setError(null);
    setBusy(true);
    try {
      await withPin(() => calibrate("empty", seconds));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return; // already running: the job below shows it
      setError({ text: e instanceof ApiError && e.status === 503 ? "The sensor software is not running, so the room can't be calibrated." : friendlyError(e), offline: e instanceof ApiError && e.status === 503 });
    } finally {
      setBusy(false);
    }
  };

  if (p.phase === "running")
    return (
      <div role="status" aria-live="polite">
        <p className="text-base font-semibold">Calibrating. Keep the room empty and the door closed.</p>
        <p className="mt-3 font-mono text-5xl font-bold tabular-nums" aria-label={`${p.remaining_s} seconds left`}>
          {p.remaining_s > 0 ? stopwatch(p.remaining_s * 1000) : "Finishing…"}
        </p>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden>
          <div className="h-full rounded-full bg-primary motion-safe:transition-[width] motion-safe:duration-500" style={{ width: `${Math.round(p.fraction * 100)}%` }} />
        </div>
      </div>
    );

  return (
    <>
      <p className="text-base">Everyone out, close the door, press Start. The sensor learns what the empty room looks like.</p>
      {calibration && <p className="mt-1 text-sm text-muted">Now: {current.text}.</p>}
      {p.phase === "ok" && (
        <Notice tone="ok" className="mt-3">
          Calibrated. The sensor now knows this room empty.
        </Notice>
      )}
      {p.phase === "failed" && (
        <Notice tone="danger" className="mt-3">
          {p.error}
        </Notice>
      )}
      {error && (
        <Notice tone="danger" className="mt-3">
          {error.text}{" "}
          {error.offline && (
            <button type="button" onClick={onSensor} className="font-semibold underline">
              Check step 1
            </button>
          )}
        </Notice>
      )}
      {!engineUp && !error && (
        <Notice tone="warn" className="mt-3">
          The sensor software is not running.{" "}
          <button type="button" onClick={onSensor} className="font-semibold underline">
            Check step 1
          </button>
        </Notice>
      )}
      {p.phase !== "ok" && (
        <div className="mt-4">
          <span className="text-sm font-medium">How long</span>
          <div className="mt-1 flex w-fit gap-1 rounded-lg bg-surface-2 p-1" role="radiogroup" aria-label="Calibration length">
            {CALIBRATION_SECONDS.map((s) => (
              <button key={s} type="button" role="radio" aria-checked={seconds === s} onClick={() => setSeconds(s)} className={btn.segment(seconds === s)}>
                {s === 60 ? "1 minute" : "2 minutes (steadier)"}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {p.phase === "ok" || (calibration?.state === "ok" && p.phase === "idle") ? (
          <>
            <button type="button" onClick={onNext} className={btn.primary}>
              Continue
            </button>
            <button type="button" onClick={() => void start()} disabled={!engineUp || busy} className={btn.secondary}>
              Calibrate again
            </button>
          </>
        ) : (
          <button type="button" onClick={() => void start()} disabled={!engineUp || busy} className={btn.primary}>
            {busy ? "Starting…" : p.phase === "failed" ? "Retry" : "Start"}
          </button>
        )}
      </div>
    </>
  );
}
