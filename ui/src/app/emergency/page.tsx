"use client";
// Emergency screen (prototype) for an incident commander during a fire, a
// collapse or a lockdown: who is still inside, where, who to reach first and
// where the rescuers are. It runs on a simulated building (lib/emergency.ts),
// not on the sensors, and says so on the page.
import { useCallback, useEffect, useRef, useState } from "react";
import { EmergencyMap } from "@/components/EmergencyMap";
import { AlertList, FloorSummary, PriorityList } from "@/components/EmergencyPanels";
import { Card, Icon, btn } from "@/components/ui";
import { FLOORS, INCIDENTS, SCENARIOS, createSim, floorStats, hms, markSeen, send, step, type Incident, type Sim, type SimAlert } from "@/lib/emergency";
import { useNow } from "@/lib/live";
import { duration } from "@/lib/words";

/** Short beeps through WebAudio. The context is made on first use, inside a click. */
function useBeep(): (times?: number) => void {
  const ctx = useRef<AudioContext | null>(null);
  useEffect(() => () => void ctx.current?.close(), []);
  return useCallback((times = 2) => {
    ctx.current ??= new AudioContext();
    const ac = ctx.current;
    void ac.resume();
    for (let i = 0; i < times; i++) {
      const at = ac.currentTime + i * 0.22;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.17);
      osc.connect(gain).connect(ac.destination);
      osc.start(at);
      osc.stop(at + 0.2);
    }
  }, []);
}

const seg = (on: boolean) => `inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium ${on ? "bg-fg text-bg" : "text-muted hover:bg-surface hover:text-fg"}`;

export default function EmergencyPage() {
  const [incident, setIncident] = useState<Incident>("fire");
  const [sim, setSim] = useState<Sim | null>(null);
  const [floor, setFloor] = useState(SCENARIOS.fire.focus);
  const [view, setView] = useState<"2d" | "3d">("2d");
  const [selected, setSelected] = useState<string | null>(null);
  const [sound, setSound] = useState(false);
  const now = useNow(500);
  const beep = useBeep();

  // Built here, not during render: the page is prerendered, and the simulation
  // reads the clock and random numbers. A new incident type starts it again.
  useEffect(() => {
    const start = setTimeout(() => setSim(createSim(incident, Date.now())), 0);
    const tick = setInterval(() => setSim((s) => s && step(s, Date.now())), 1000);
    return () => {
      clearTimeout(start);
      clearInterval(tick);
    };
  }, [incident]);

  // Beep on new urgent alerts (not on the ones already there when it started).
  const heard = useRef({ run: 0, id: 0 });
  useEffect(() => {
    if (!sim) return;
    const h = heard.current;
    const fresh = h.run === sim.startedAt && sim.alerts.some((a) => a.id > h.id && a.level === "high" && !a.seen);
    heard.current = { run: sim.startedAt, id: sim.alerts.at(-1)?.id ?? 0 };
    if (sound && fresh) beep();
  }, [sim, sound, beep]);

  const pickIncident = (k: Incident) => {
    if (k === incident) return;
    setIncident(k);
    setFloor(SCENARIOS[k].focus);
    setSelected(null);
  };
  const openFloor = (f: number) => {
    setFloor(f);
    setView("2d");
  };
  const select = (id: string) => {
    const p = sim?.people.find((q) => q.id === id);
    setSelected(id);
    if (p && p.state !== "out") openFloor(p.f);
  };
  const toggleSound = () => {
    setSound(!sound);
    if (!sound) beep(1);
  };
  const pickAlert = (a: SimAlert) => {
    setSim((s) => s && markSeen(s, a.id));
    if (a.person) select(a.person);
  };

  const online = sim?.sensors.filter((s) => s.on).length ?? 0;
  const total = sim?.sensors.length ?? 0;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">Emergency</h1>
            <span className="rounded-lg bg-replay px-2.5 py-1 text-xs font-medium text-replay-fg">Prototype · simulated building, not connected to sensors</span>
          </div>
          <p className="mt-0.5 text-sm text-muted">Who is still inside, where they are, and who to reach first.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:ml-auto">
          <p className="text-sm text-muted">
            Viewing as <span className="font-semibold text-fg">Incident commander · Unit 1</span>
          </p>
          <button onClick={toggleSound} aria-pressed={sound} className={`${btn.secondary} px-3 py-1.5`}>
            <Icon name={sound ? "sound" : "sound-off"} className="h-4 w-4" />
            Sound {sound ? "on" : "off"}
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-card border border-line bg-surface p-3 shadow-sm">
        <div role="radiogroup" aria-label="Incident type" className="flex gap-1 rounded-lg bg-surface-2 p-1">
          {INCIDENTS.map((k) => (
            <button key={k} role="radio" aria-checked={k === incident} title={SCENARIOS[k].hint} onClick={() => pickIncident(k)} className={seg(k === incident)}>
              <Icon name={SCENARIOS[k].icon} className="h-4 w-4" />
              {SCENARIOS[k].label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Icon name="clock" className="h-5 w-5 text-muted" />
          <div>
            <div className="text-xs text-subtle">Since the incident started</div>
            <div className="font-mono text-xl font-bold leading-tight tabular-nums">{sim ? hms(sim.t) : "--:--:--"}</div>
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <Icon name="network" className={`h-5 w-5 shrink-0 ${online < total ? "text-warn" : "text-ok"}`} />
          <span>
            <span className="font-medium">Own network</span>
            <span className="text-muted"> · works without internet · </span>
            <span className={online < total ? "font-semibold text-warn-fg" : "text-ok-fg"}>
              {online}/{total} sensors connected
            </span>
          </span>
        </div>
      </div>

      {!sim ? (
        <p className="text-sm text-muted">Setting up the simulated building…</p>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_21rem]">
          <Card className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              <h2 className="text-lg font-semibold">School building · Block A</h2>
              <div role="radiogroup" aria-label="Floor" className="flex gap-1 rounded-lg bg-surface-2 p-1">
                {FLOORS.map((f) => {
                  const st = floorStats(sim, f);
                  const on = f === floor;
                  return (
                    <button key={f} role="radio" aria-checked={on} aria-label={`Floor ${f}, ${st.total} people${st.help ? `, ${st.help} need help` : ""}`} onClick={() => openFloor(f)} className={seg(on)}>
                      F{f}
                      <span className={`inline-flex min-w-5 justify-center rounded-full px-1.5 text-xs font-bold tabular-nums ${st.help ? "bg-alert-high text-alert-fg" : on ? "bg-bg text-fg" : "bg-surface text-fg"}`}>{st.total}</span>
                    </button>
                  );
                })}
              </div>
              <div role="radiogroup" aria-label="View" className="flex gap-1 rounded-lg bg-surface-2 p-1">
                {(["2d", "3d"] as const).map((v) => (
                  <button key={v} role="radio" aria-checked={view === v} onClick={() => setView(v)} className={seg(view === v)}>
                    {v.toUpperCase()}
                  </button>
                ))}
              </div>
              <span className="inline-flex items-center gap-1.5 text-xs text-muted sm:ml-auto">
                <span aria-hidden className="h-2 w-2 rounded-full bg-ok" />
                Updated live · last update {duration(Math.max(1000, now - sim.updatedAt))} ago
              </span>
            </div>
            <EmergencyMap key={sim.startedAt} sim={sim} floor={floor} view={view} selected={selected} onSelect={(id) => (id === selected ? setSelected(null) : select(id))} onOpenFloor={openFloor} />
          </Card>

          <div className="grid content-start items-start gap-4 md:grid-cols-2 xl:row-span-2 xl:grid-cols-1">
            <FloorSummary sim={sim} f={floor} />
            <AlertList sim={sim} onPick={pickAlert} onSeenAll={() => setSim((s) => s && markSeen(s))} />
          </div>

          <PriorityList sim={sim} selected={selected} onSelect={select} onSend={(id) => setSim((s) => s && send(s, id))} onFloor={openFloor} />
        </div>
      )}
    </div>
  );
}
