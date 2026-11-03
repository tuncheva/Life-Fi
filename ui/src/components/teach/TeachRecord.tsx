"use client";
// /teach recording: "Before you record" (checks, transmitter, distances, rounds, voice) and the
// guided run. The server owns the schedule and the labels; the page only shows and speaks it,
// computing the step locally every 250 ms from the server clock (plan F, R5).
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { friendlyError, usePin } from "@/lib/pin";
import { currentStep, secondsLeft, totalSeconds, type RunState, type SpotsOverview } from "@/lib/teach";
import { Card, Icon, Notice, btn, inputCls } from "@/components/ui";

const DEFAULTS: Record<string, number> = { close: 0.5, middle: 1.5, far: 3 };
const STORE = "lifefi.teach.distances";

function speak(text: string) {
  try {
    const s = window.speechSynthesis;
    if (!s) return;
    s.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    s.speak(u);
  } catch {
    // no speech here: the screen still shows every prompt
  }
}

function loadDistances(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "null") as Record<string, number> | null;
    return v && typeof v === "object" ? { ...DEFAULTS, ...v } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function TeachSetup({ data, refresh }: { data: SpotsOverview; refresh: () => void }) {
  const { withPin } = usePin();
  const [tx, setTx] = useState<"fixed" | "phone" | null>(null);
  const [rounds, setRounds] = useState<1 | 2>(2);
  // the same distances as last time: every session must teach the same spots (rendered after the first fetch: client only)
  const [dist, setDist] = useState<Record<string, number>>(loadDistances);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const failing = data.readiness.find((c) => !c.ok);
  const badDist = data.spot_names.find((n) => !(dist[n] >= 0.2 && dist[n] <= 10));
  const reason = failing?.label ?? (badDist ? `${badDist}: distance must be 0.2 to 10 m` : !tx ? "Choose the transmitter" : null);
  const minutes = Math.round(totalSeconds(data.timing, data.spot_names.length, rounds) / 60);

  const start = async () => {
    setError(null);
    setStarting(true);
    try {
      localStorage.setItem(STORE, JSON.stringify(dist));
    } catch {
      // private window: fine, the defaults come back next time
    }
    speak("Starting. Leave the room when told.");
    try {
      await withPin(() => api<RunState>("/spots/teach", { method: "POST", body: JSON.stringify({ distances: dist, rounds, transmitter: tx }), pin: true }));
    } catch (e) {
      setError(friendlyError(e));
    }
    setStarting(false);
    refresh();
  };

  return (
    <Card title="Before you record">
      <ul className="space-y-1">
        {data.readiness.map((c) => (
          <li key={c.id} className="flex items-center gap-2 text-sm">
            <Icon name={c.ok ? "check" : "chevron"} className={`h-4 w-4 shrink-0 ${c.ok ? "text-ok" : "text-danger"}`} />
            <span className={c.ok ? "" : "font-medium text-danger"}>{c.label}</span>
          </li>
        ))}
      </ul>

      <fieldset className="mt-4">
        <legend className="text-sm font-semibold">Transmitter</legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {(
            [
              ["fixed", "Fixed (router or 2nd ESP32)"],
              ["phone", "Phone hotspot"],
            ] as const
          ).map(([v, label]) => (
            <label key={v} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm ${tx === v ? "border-primary" : "border-line"}`}>
              <input type="radio" name="tx" checked={tx === v} onChange={() => setTx(v)} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-4">
        <legend className="text-sm font-semibold">Spots: distance from the sensor (measure it with a tape)</legend>
        <div className="mt-1 grid grid-cols-3 gap-2">
          {data.spot_names.map((n) => (
            <label key={n} className="text-sm">
              {n}
              <span className="flex items-center gap-1">
                <input
                  type="number"
                  inputMode="decimal"
                  min={0.2}
                  max={10}
                  step={0.1}
                  value={Number.isFinite(dist[n]) ? dist[n] : ""}
                  onChange={(e) => setDist({ ...dist, [n]: e.target.value === "" ? NaN : Number(e.target.value) })}
                  className={inputCls}
                />
                <span className="mt-1 text-muted">m</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-4">
        <legend className="text-sm font-semibold">Rounds</legend>
        <div className="mt-1 inline-flex rounded-lg border border-line p-0.5">
          {([2, 1] as const).map((r) => (
            <button key={r} type="button" className={btn.segment(rounds === r)} onClick={() => setRounds(r)}>
              {r === 2 ? "2 rounds (better)" : "1 round"}
            </button>
          ))}
        </div>
        <p className="mt-1 text-sm text-muted">
          About {minutes} min: an empty room at the start and the end, each spot held {data.timing.hold_s} s per round.
        </p>
      </fieldset>

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className={btn.secondary} onClick={() => speak("Voice is working.")}>
          Test voice
        </button>
        <button type="button" className={btn.primary} disabled={!!reason || starting} onClick={start}>
          Start recording
        </button>
      </div>
      {reason && <p className="mt-2 text-sm text-muted">Can&rsquo;t start yet: {reason}.</p>}
      {error && (
        <Notice tone="danger" className="mt-3">
          {error}
        </Notice>
      )}
    </Card>
  );
}

const BAND: Record<string, { cls: string; label: string }> = {
  lead: { cls: "bg-surface-2 text-fg", label: "Get ready" },
  empty: { cls: "bg-primary text-primary-fg", label: "Room must be empty" },
  walk: { cls: "bg-warn text-warn-fg", label: "Move now" },
  hold: { cls: "bg-ok text-ok-fg", label: "Stay here" },
  end: { cls: "bg-surface-2 text-fg", label: "Done" },
};

function instruction(s: { kind: string; name: string | null; d_m: number | null }): string {
  if (s.kind === "hold") return `Stand at ${s.name!.toUpperCase()} · ${s.d_m} m`;
  if (s.kind === "walk" && s.name) return `Go to ${s.name.toUpperCase()} · ${s.d_m} m`;
  if (s.kind === "walk") return "Leave the room";
  if (s.kind === "empty") return "Stay outside";
  if (s.kind === "lead") return "Leave the room, close the door";
  return "All done";
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export function TeachRunView({ run, refresh, onDismiss }: { run: RunState; refresh: () => void; onDismiss: () => void }) {
  const { withPin } = usePin();
  // the server's clock, ticked locally every 250 ms
  const [serverNow, setServerNow] = useState(() => run.server_now_ms);
  const [error, setError] = useState<string | null>(null);
  const skew = useRef(0);
  const spoken = useRef<string>("");
  const counted = useRef<string>("");

  // the server clock: skew from each poll's server_now_ms
  useEffect(() => {
    skew.current = run.server_now_ms - Date.now();
  }, [run.server_now_ms]);

  useEffect(() => {
    if (run.state !== "running") return;
    const t = setInterval(() => setServerNow(Date.now() + skew.current), 250);
    return () => clearInterval(t);
  }, [run.state]);

  // keep the phone awake while the run is on
  useEffect(() => {
    if (run.state !== "running") return;
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
    const ask = () => {
      nav.wakeLock?.request("screen").then((l) => (lock = l)).catch(() => {});
    };
    ask();
    const vis = () => document.visibilityState === "visible" && ask();
    document.addEventListener("visibilitychange", vis);
    return () => {
      document.removeEventListener("visibilitychange", vis);
      lock?.release().catch(() => {});
    };
  }, [run.state]);

  const step = run.state === "running" ? currentStep(run.steps, serverNow) : run.steps[run.steps.length - 1];
  const left = step ? secondsLeft(step, serverNow) : 0;
  const next = step ? run.steps[step.id + 1] : undefined;
  const total = Math.max(0, Math.ceil((run.ends_ms - serverNow) / 1000));

  // speak each step once, plus 3-2-1 at the end of a walk
  useEffect(() => {
    if (run.state !== "running" || !step) return;
    const key = `${run.session}:${step.id}`;
    if (spoken.current !== key) {
      spoken.current = key;
      speak(step.say);
    } else if (step.kind === "walk" && left >= 1 && left <= 3 && counted.current !== `${key}:${left}`) {
      counted.current = `${key}:${left}`;
      speak(String(left));
    }
  }, [run.state, run.session, step, left]);

  const stop = async () => {
    if (!window.confirm("Stop and discard this session?")) return;
    try {
      await withPin(() => api("/spots/teach/stop", { method: "POST", body: "{}", pin: true }));
    } catch (e) {
      setError(friendlyError(e));
    }
    refresh();
  };

  if (run.state !== "running")
    return (
      <Card title="Recording">
        {run.state === "done" ? (
          <Notice tone="ok">
            Session {run.session} saved{run.frames !== null ? ` (${run.frames} readings)` : ""}. Train below, or record another one later.
          </Notice>
        ) : (
          <Notice tone="danger">
            Session {run.session} stopped: {run.reason}. It is kept on disk but not used for training.
          </Notice>
        )}
        <button type="button" className={`${btn.secondary} mt-3`} onClick={onDismiss}>
          Record another session
        </button>
      </Card>
    );

  const band = BAND[step?.kind ?? "lead"];
  return (
    <section className="overflow-hidden rounded-card border border-line bg-surface" aria-label="Recording in progress">
      <div className={`px-4 py-3 text-center text-lg font-bold ${band.cls}`}>{band.label}</div>
      <div className="px-4 py-6 text-center">
        <p aria-live="assertive" className="text-4xl font-bold leading-tight sm:text-5xl">
          {step ? instruction(step) : "Starting…"}
        </p>
        <p className="mt-4 font-mono text-8xl font-bold tabular-nums" aria-label={`${left} seconds left in this step`}>
          {left}
        </p>
        {next && next.kind !== "end" && <p className="mt-2 text-lg text-muted">Next: {instruction(next)}</p>}
        <div className="mt-4 h-2 w-full rounded bg-surface-2">
          <div className="h-2 rounded bg-primary" style={{ width: `${Math.min(100, (100 * (serverNow - run.started_ms)) / (run.ends_ms - run.started_ms))}%` }} />
        </div>
        <p className="mt-1 text-sm text-muted">
          Step {(step?.id ?? 0) + 1} of {run.steps.length} · {mmss(total)} left
        </p>
        <button type="button" className={`${btn.secondary} mt-6`} onClick={stop}>
          Stop
        </button>
        {error && (
          <Notice tone="danger" className="mt-3">
            {error}
          </Notice>
        )}
      </div>
    </section>
  );
}
