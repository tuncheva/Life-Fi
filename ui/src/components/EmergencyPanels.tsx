"use client";
// Emergency screen side panels: people on the floor shown, the building-wide
// priority list (who to reach first, with "Send" for a free rescuer) and the
// incident's alerts.
import { SCENARIOS, breathLabel, eta, floorStats, idRange, nearestFree, postureLabel, priority, roomAt, type PersonState, type Sim, type SimAlert } from "@/lib/emergency";
import { clock, duration, stopwatch } from "@/lib/words";
import { Card, Pill, btn } from "./ui";

const TILE = {
  help: "bg-danger-soft text-danger-fg",
  still: "bg-warn-soft text-warn-fg",
  moving: "bg-ok-soft text-ok-fg",
};

const DOT: Record<Exclude<PersonState, "out">, string> = { help: "bg-danger", still: "bg-uncertain", moving: "bg-ok" };

const LEVEL: Record<SimAlert["level"], string> = { high: "bg-alert-high", medium: "bg-alert-medium", low: "bg-alert-low" };

function Tile({ n, label, tone }: { n: number; label: string; tone: keyof typeof TILE }) {
  return (
    <div className={`rounded-lg px-3 py-2 ${n ? TILE[tone] : "bg-surface-2 text-muted"}`}>
      <div className="text-2xl font-bold tabular-nums">{n}</div>
      <div className="text-xs font-medium leading-tight">{label}</div>
    </div>
  );
}

export function FloorSummary({ sim, f }: { sim: Sim; f: number }) {
  const st = floorStats(sim, f);
  const out = sim.people.filter((p) => p.state === "out").length;
  return (
    <Card title={`People on floor ${f}`}>
      <div className="flex items-end gap-3">
        <span className="text-5xl font-bold leading-none tabular-nums">{st.total}</span>
        <p className="pb-0.5 text-sm text-muted">
          {st.total === 1 ? "person" : "people"} detected
          <br />
          <span className="font-medium text-rescuer-fg">
            {st.rescuers} rescuer{st.rescuers === 1 ? "" : "s"}
          </span>{" "}
          on this floor
        </p>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        <Tile n={st.help} label="Needs help" tone="help" />
        <Tile n={st.still} label="Still · breathing" tone="still" />
        <Tile n={st.moving} label="Moving" tone="moving" />
      </div>
      {SCENARIOS[sim.incident].movers === "evacuate" && (
        <p className="mt-3 text-sm text-muted">
          <span className="font-semibold text-ok-fg">{out}</span> {out === 1 ? "person has" : "people have"} left the building
        </p>
      )}
    </Card>
  );
}

export function PriorityList({ sim, selected, onSelect, onSend, onFloor }: { sim: Sim; selected: string | null; onSelect: (id: string) => void; onSend: (id: string) => void; onFloor: (f: number) => void }) {
  const rows = priority(sim);
  const help = rows.filter((r) => r.kind === "person" && r.p.state === "help").length;
  return (
    <Card title="Priority · whole building" actions={help > 0 && <Pill tone="danger">{help} need help</Pill>} className="min-w-0">
      {rows.length === 0 && <p className="text-sm text-muted">Nobody detected inside.</p>}
      <ol className="space-y-2">
        {rows.map((row) => {
          if (row.kind === "group")
            return (
              <li key={`g${row.f}`} className="rounded-lg border border-line">
                <button onClick={() => onFloor(row.f)} className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-surface-2">
                  <span aria-hidden className={`mt-1.5 h-3 w-3 shrink-0 rounded-full ${DOT.moving}`} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-semibold">{idRange(row.ids)}</span>
                      <span className="text-sm">{row.rooms.join(", ")}</span>
                      <Pill className="px-2 py-0.5">F{row.f}</Pill>
                    </span>
                    <span className="block text-sm text-muted">{SCENARIOS[sim.incident].movingText}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block font-mono text-lg font-semibold tabular-nums text-ok-fg">{row.ids.length}</span>
                    <span className="block text-xs text-subtle">moving</span>
                  </span>
                </button>
              </li>
            );

          const p = row.p;
          const isHelp = p.state === "help";
          const r = sim.rescuers.find((x) => x.target === p.id);
          const free = isHelp && !r ? nearestFree(sim, p.id) : null;
          const on = p.id === selected;
          return (
            <li key={p.id} className={`flex items-center gap-1 rounded-lg border ${on ? "border-fg bg-surface-2" : "border-line"}`}>
              <button onClick={() => onSelect(p.id)} aria-pressed={on} className="flex min-w-0 flex-1 items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-surface-2">
                <span aria-hidden className={`mt-1.5 h-3 w-3 shrink-0 rounded-full ${p.state === "out" ? "bg-subtle" : DOT[p.state]}`} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="font-semibold">{p.id}</span>
                    <span className="text-sm">{roomAt(p).name}</span>
                    <Pill className="px-2 py-0.5">F{p.f}</Pill>
                  </span>
                  <span className="block text-sm text-muted">
                    {postureLabel(p.posture)} · {breathLabel(p)}
                  </span>
                  {r && <span className="block text-sm font-medium text-rescuer-fg">{r.arrived ? `${r.id} with them` : `${r.id} on the way · about ${duration(eta(r) * 1000)}`}</span>}
                </span>
                <span className="shrink-0 text-right">
                  <span className={`block font-mono text-lg font-semibold tabular-nums ${isHelp ? "text-danger-fg" : "text-warn-fg"}`}>{stopwatch((sim.t - (p.stillSince ?? sim.t)) * 1000)}</span>
                  <span className="block text-xs text-subtle">{isHelp ? "not moving" : "still"}</span>
                </span>
              </button>
              {isHelp &&
                !r &&
                (free ? (
                  <button onClick={() => onSend(p.id)} className={`${btn.danger} mr-2 shrink-0 px-3 py-2`}>
                    Send {free.id}
                  </button>
                ) : (
                  <span className="mr-3 shrink-0 text-xs text-muted">No rescuer free</span>
                ))}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

export function AlertList({ sim, onPick, onSeenAll }: { sim: Sim; onPick: (a: SimAlert) => void; onSeenAll: () => void }) {
  const list = [...sim.alerts].reverse();
  const fresh = list.filter((a) => !a.seen).length;
  return (
    <Card
      title="Alerts"
      actions={
        <>
          {fresh > 0 && <Pill tone="danger">{fresh} new</Pill>}
          <button onClick={onSeenAll} disabled={!fresh} className={`${btn.secondary} px-2.5 py-1 text-xs`}>
            Mark all seen
          </button>
        </>
      }
    >
      <ol className="-mx-2 max-h-[30rem] space-y-0.5 overflow-y-auto" aria-live="polite">
        {list.map((a) => (
          <li key={a.id}>
            <button onClick={() => onPick(a)} className={`flex w-full gap-3 rounded-lg px-2 py-2 text-left hover:bg-surface-2 ${a.seen ? "" : "bg-surface-2"}`}>
              <span aria-hidden className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${LEVEL[a.level]}`} />
              <span className="min-w-0 flex-1">
                <span className={`block text-sm ${a.seen ? "font-medium" : "font-semibold"}`}>{a.title}</span>
                <span className="block text-xs text-muted">{a.detail}</span>
              </span>
              <span className="shrink-0 text-right">
                <time className="block font-mono text-xs tabular-nums text-subtle">{clock(sim.startedAt + a.t * 1000, true)}</time>
                {!a.seen && <span className="text-xs font-semibold text-danger-fg">New</span>}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </Card>
  );
}
