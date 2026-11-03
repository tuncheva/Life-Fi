"use client";
// First-run setup (B-ui-ux B2.2): a vertical stepper, one step open at a time,
// mobile first. `?step=sensor|transmitter|calibrate|fit|spots` opens a step
// directly (links from the room view's "why it is rough" lines and Settings).
// While this page is open it asks the server's /health and /setup every 5 s;
// on an older server (404) the checks come from the live stream instead.
import { useEffect, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { useLiveSlow, useResult, useStale } from "@/lib/live";
import { ROOM_EVENT, ROOM_KEY } from "@/lib/room";
import { doneSteps, fetchOptional, parseStep, sensorChecks, STEPS, transmitterMoving, type HealthResponse, type SetupResponse, type StepId } from "@/lib/setup";
import { roomName } from "@/lib/words";
import { StepShell } from "./StepShell";
import { StepSensor } from "./StepSensor";
import { StepRoom } from "./StepRoom";
import { StepCalibrate } from "./StepCalibrate";
import { StepFit } from "./StepFit";
import { StepDone, StepSpots } from "./StepDone";

const POLL_MS = 5000;

function subscribeRoom(cb: () => void): () => void {
  window.addEventListener(ROOM_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(ROOM_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

/** True once this browser has a room with a transmitter distance saved. */
function roomSavedSnapshot(): boolean {
  try {
    const g = JSON.parse(localStorage.getItem(ROOM_KEY) ?? "null") as { tx_m?: unknown } | null;
    return typeof g?.tx_m === "number";
  } catch {
    return false;
  }
}

/** Server truth for the checks, polled while the page is visible. */
function useServerSetup(): { health: HealthResponse | null; setup: SetupResponse | null } {
  const [v, setV] = useState<{ health: HealthResponse | null; setup: SetupResponse | null }>({ health: null, setup: null });
  useEffect(() => {
    let live = true;
    const poll = async () => {
      if (document.visibilityState === "hidden") return;
      const [health, setup] = await Promise.all([fetchOptional<HealthResponse>("/health"), fetchOptional<SetupResponse>("/setup")]);
      if (live) setV({ health, setup });
    };
    void poll();
    const t = setInterval(() => void poll(), POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return v;
}

export function SetupWizard() {
  const asked = parseStep(useSearchParams().get("step"));
  const { connected, status } = useLiveSlow();
  const result = useResult();
  const stale = useStale(result);
  const { health, setup } = useServerSetup();
  const roomSaved = useSyncExternalStore(subscribeRoom, roomSavedSnapshot, () => false);

  const sensor = sensorChecks({ connected, status, stale, rateHz: result?.health.rate_hz ?? null, health, setup });
  const engineUp = connected && !!status?.engine.connected;
  const calibration = result?.calibration ?? status?.engine.status?.calibration ?? null;
  const done = doneSteps({ sensorOk: sensor.ok, setup, calibration: calibration?.state ?? null, roomSaved });

  // The open step: the one asked for in the URL, then the one the person clicked, else the first not done.
  const [picked, setPicked] = useState<StepId | null>(null);
  const [lastAsked, setLastAsked] = useState(asked);
  if (asked !== lastAsked) {
    setLastAsked(asked);
    setPicked(asked);
  }
  const firstOpen = STEPS.find((s) => !s.optional && !done.has(s.id))?.id ?? "done";
  const open: StepId = picked ?? asked ?? firstOpen;
  const go = (id: StepId) => {
    setPicked(id);
    // keep the opened step in view on a phone
    requestAnimationFrame(() => document.getElementById(`step-${id}`)?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
  };
  // A link straight to a step (?step=…) scrolls it into view once.
  useEffect(() => {
    if (asked) document.getElementById(`step-${asked}`)?.scrollIntoView({ block: "start" });
  }, [asked]);
  const next = (id: StepId) => () => go(STEPS[Math.min(STEPS.length - 1, STEPS.findIndex((s) => s.id === id) + 1)].id);

  const failing = sensor.checks.find((c) => c.state === "fail");
  const summary: Record<StepId, string | null> = {
    sensor: sensor.ok ? (sensor.replay ? "Working, on a recording" : "Working") : failing ? failing.label + ": not yet" : "Checking…",
    transmitter: roomSaved ? "Saved in this browser" : null,
    calibrate: calibration?.state === "ok" ? "Calibrated" : calibration?.state === "stale" ? "Needs redoing with the room empty" : null,
    fit: null,
    spots: null,
    done: null,
  };

  const body = (id: StepId) => {
    switch (id) {
      case "sensor":
        return <StepSensor checks={sensor.checks} ok={sensor.ok} replay={sensor.replay} setup={setup} onNext={next("sensor")} />;
      case "transmitter":
        return <StepRoom roomName={status?.server.room_name ?? ""} moving={transmitterMoving(result)} onNext={next("transmitter")} />;
      case "calibrate":
        return <StepCalibrate job={status?.calibration_job ?? null} calibration={calibration} engineUp={engineUp} onNext={next("calibrate")} onSensor={() => go("sensor")} />;
      case "fit":
        return <StepFit engineUp={engineUp} onNext={next("fit")} />;
      case "spots":
        return <StepSpots onNext={next("spots")} />;
      case "done":
        return <StepDone done={done} setup={setup} />;
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold tracking-tight">Set up {status ? roomName(status) : "this room"}</h1>
      <p className="mt-1 text-sm text-muted">About five minutes. Each step checks itself; you can come back to any of them later.</p>
      <ol className="mt-5 space-y-2">
        {STEPS.map((s, i) => (
          <StepShell key={s.id} n={i + 1} id={s.id} title={s.title} optional={s.optional} done={done.has(s.id)} open={open === s.id} summary={summary[s.id]} onOpen={() => go(s.id)}>
            {body(s.id)}
          </StepShell>
        ))}
      </ol>
    </div>
  );
}
