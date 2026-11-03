// Step 1: is the sensor connected? A live check list; each failing line names the action.
import { btn, Notice } from "@/components/ui";
import type { Check, SetupResponse } from "@/lib/setup";
import { CheckRow } from "./StepShell";

export function StepSensor({ checks, ok, replay, setup, onNext }: { checks: Check[]; ok: boolean; replay: boolean; setup: SetupResponse | null; onNext: () => void }) {
  // The server's own words for the two checks it knows (track C), when it says something.
  const notes = (setup?.steps ?? []).filter((s) => (s.id === "engine" || s.id === "board") && !s.done && s.detail).map((s) => s.detail as string);
  return (
    <>
      <p className="text-base">Plug the sensor board into this computer with USB and switch on the Wi-Fi transmitter.</p>
      <ul role="status" aria-label="Sensor checks" className="mt-3 divide-y divide-line">
        {checks.map((c) => (
          <CheckRow key={c.id} state={c.state} label={c.label} detail={c.detail} />
        ))}
      </ul>
      {!ok && notes.length > 0 && <p className="mt-2 text-xs text-subtle">The box reports: {notes.join("; ")}.</p>}
      {replay && (
        <Notice tone="warn" className="mt-3">
          You are setting up on a recording. The room view will show the recording, not this room, until the live sensor is chosen under Source &amp; replay.
        </Notice>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={onNext} disabled={!ok} className={btn.primary}>
          {replay ? "Continue anyway" : "Continue"}
        </button>
        {!ok && <span className="self-center text-sm text-muted">This list updates by itself. Fix the first red line, then wait a few seconds.</span>}
      </div>
    </>
  );
}
