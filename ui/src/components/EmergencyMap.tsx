"use client";
// Emergency screen maps: the 2D plan of one floor and the 3D stack of all three
// (oblique projection). Pure drawing from the simulation; clicks go to the page.
// Markers glide between the 1-second ticks with a CSS transition.
import type { KeyboardEvent, ReactNode } from "react";
import { EXITS, FLOORS, OUTLINE, PLAN, ROOMS, SCENARIOS, STATE_TEXT, floorStats, roomCounts, type Person, type Rescuer, type Sim } from "@/lib/emergency";
import { stopwatch } from "@/lib/words";
import { Icon } from "./ui";

const GLIDE = "transition-transform duration-1000 ease-linear motion-reduce:transition-none";
/** halo behind text drawn over the plan */
const HALO = { paintOrder: "stroke" as const, strokeWidth: 4, strokeLinejoin: "round" as const };

function press(fn: () => void) {
  return {
    role: "button",
    tabIndex: 0,
    onClick: fn,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fn();
      }
    },
  } as const;
}

/** "P1 · 2:04", or "P1 · R1 with them" once the rescuer has arrived */
function helpLabel(sim: Sim, p: Person): string {
  const r = sim.rescuers.find((x) => x.target === p.id && x.arrived);
  if (r) return `${p.id} · ${r.id} with them`;
  return `${p.id} · ${stopwatch((sim.t - (p.stillSince ?? sim.t)) * 1000)}`;
}

function stateText(p: Person): string {
  return p.state === "out" ? "Out of the building" : STATE_TEXT[p.state];
}

function Tag({ y, text, tone }: { y: number; text: string; tone: "danger" | "fg" }) {
  const w = text.length * 7.4 + 16;
  return (
    <g transform={`translate(0 ${y})`} className="pointer-events-none">
      <rect x={-w / 2} y={-13} width={w} height={22} rx={6} className={tone === "danger" ? "fill-danger" : "fill-fg"} />
      <text y={3} textAnchor="middle" className="fill-surface text-[13px] font-semibold">
        {text}
      </text>
    </g>
  );
}

function Hatch({ id }: { id: string }) {
  return (
    <pattern id={id} width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="5" height="12" className="fill-danger" opacity={0.22} />
    </pattern>
  );
}

function PersonMark({ sim, p, selected, onSelect }: { sim: Sim; p: Person; selected: boolean; onSelect: (id: string) => void }) {
  const deg = (p.heading * 180) / Math.PI;
  const label = p.state === "help" ? helpLabel(sim, p) : selected ? p.id : null;
  return (
    <g className={`${GLIDE} cursor-pointer`} style={{ transform: `translate(${p.x}px, ${p.y}px)` }} {...press(() => onSelect(p.id))} aria-label={`${p.id}, ${stateText(p)}`} aria-pressed={selected}>
      {selected && <circle r={23} className="fill-none stroke-fg" strokeWidth={2.5} strokeDasharray="5 4" />}
      {p.state === "help" ? (
        <>
          <circle r={14} className="fill-danger stroke-surface" strokeWidth={2.5} />
          <text y={6.5} textAnchor="middle" className="pointer-events-none fill-surface text-[19px] font-black">
            !
          </text>
        </>
      ) : p.state === "still" ? (
        <circle r={10} className="fill-uncertain stroke-surface" strokeWidth={2.5} />
      ) : (
        <>
          <circle r={10} className="fill-ok stroke-surface" strokeWidth={2.5} />
          <path d="M-3.5 -4.5 4.5 0 -3.5 4.5z" transform={`rotate(${deg})`} className="fill-surface" />
        </>
      )}
      {label && <Tag y={p.state === "help" ? -28 : -24} text={label} tone={p.state === "help" ? "danger" : "fg"} />}
    </g>
  );
}

function RescuerMark({ r, size = 9, label = true }: { r: { x: number; y: number; id: string }; size?: number; label?: boolean }) {
  return (
    <g className={`${GLIDE} pointer-events-none`} style={{ transform: `translate(${r.x}px, ${r.y}px)` }}>
      <rect x={-size} y={-size} width={size * 2} height={size * 2} transform="rotate(45)" className="fill-rescuer stroke-surface" strokeWidth={2.5} />
      {label && (
        <text x={size + 7} y={5} className="fill-rescuer-fg stroke-surface text-[14px] font-bold" style={HALO}>
          {r.id}
        </text>
      )}
    </g>
  );
}

/** The parts of a rescuer's remaining route that lie on this floor. */
function routeRuns(r: Rescuer, f: number): string[] {
  const runs: string[][] = [];
  let cur: string[] = [];
  let prev = r.f;
  for (const p of [r, ...r.path]) {
    if (p.f !== prev) {
      if (cur.length > 1) runs.push(cur);
      cur = [];
      prev = p.f;
    }
    if (p.f === f) cur.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
  }
  if (cur.length > 1) runs.push(cur);
  return runs.map((run) => run.join(" "));
}

function Plan2D({ sim, f, selected, onSelect }: { sim: Sim; f: number; selected: string | null; onSelect: (id: string) => void }) {
  const rooms = ROOMS.filter((r) => r.f === f);
  const counts = roomCounts(sim, f);
  const hazards = SCENARIOS[sim.incident].hazards.filter((h) => h.f === f);
  // Needs-help and the selected person are drawn last, on top.
  const rank = (p: Person) => (p.id === selected ? 3 : p.state === "help" ? 2 : p.state === "still" ? 1 : 0);
  const people = sim.people.filter((p) => p.f === f && p.state !== "out").sort((a, b) => rank(a) - rank(b));
  const rescuers = sim.rescuers.filter((r) => r.f === f);
  const counted = (n: number) => (n === 0 ? "Empty" : n === 1 ? "1 person" : `${n} people`);

  return (
    <svg viewBox={`0 0 ${PLAN.w} ${PLAN.h}`} className="block h-auto w-full min-w-[640px] select-none" role="group" aria-label={`Floor ${f} plan`}>
      <defs>
        <Hatch id="hz-2d" />
      </defs>
      {rooms.map((r) => (
        <rect key={r.id} x={r.x} y={r.y} width={r.w} height={r.h} strokeWidth={2} className={`stroke-subtle ${counts.get(r.id)?.help && r.kind !== "corridor" ? "fill-danger-soft" : r.kind === "room" ? "fill-surface" : "fill-surface-2"}`} />
      ))}
      <rect x={OUTLINE.x} y={OUTLINE.y} width={OUTLINE.w} height={OUTLINE.h} strokeWidth={5} className="fill-none stroke-muted" />
      {rooms
        .filter((r) => r.kind !== "corridor")
        .map((r) => (
          <rect key={r.id} x={r.door.x - 20} y={r.door.y - 4} width={40} height={8} className="fill-surface-2" />
        ))}
      {f === 1 &&
        EXITS.map((e) => {
          const west = e.x < PLAN.w / 2;
          return (
            <g key={e.x}>
              <rect x={e.x - 5} y={e.y - 24} width={10} height={48} className="fill-surface-2" />
              <text x={west ? e.x + 12 : e.x - 12} y={e.y + 26} textAnchor={west ? "start" : "end"} className="fill-ok-fg text-[13px] font-bold">
                {west ? "← Exit" : "Exit →"}
              </text>
            </g>
          );
        })}
      {rooms
        .filter((r) => r.kind === "stairs")
        .map((r) =>
          Array.from({ length: Math.floor((r.h - 76) / 16) }, (_, i) => <line key={`${r.id}-${i}`} x1={r.x + 16} x2={r.x + r.w - 16} y1={r.y + 66 + i * 16} y2={r.y + 66 + i * 16} strokeWidth={2} className="stroke-line" />),
        )}
      {hazards.map((h) => {
        const w = h.label.length * 8 + 22;
        return (
          <g key={h.label}>
            <rect x={h.x} y={h.y} width={h.w} height={h.h} fill="url(#hz-2d)" strokeWidth={2} strokeDasharray="8 6" className="stroke-danger" />
            <rect x={h.x + h.w - 10 - w} y={h.y + h.h - 34} width={w} height={24} rx={6} className="fill-danger" />
            <text x={h.x + h.w - 10 - w / 2} y={h.y + h.h - 17} textAnchor="middle" className="fill-surface text-[14px] font-semibold">
              {h.label}
            </text>
          </g>
        );
      })}
      {rooms.map((r) => {
        const c = counts.get(r.id);
        if (r.kind === "corridor")
          return (
            <text key={r.id} x={500} y={252} textAnchor="middle" className="fill-subtle stroke-surface-2 text-[14px] font-medium" style={HALO}>
              Corridor{c ? ` · ${counted(c.n)}` : ""}
            </text>
          );
        return (
          <g key={r.id}>
            <text x={r.x + 14} y={r.y + 30} className={`text-[19px] font-semibold ${c?.help ? "fill-danger-fg" : "fill-fg"}`}>
              {r.code}
            </text>
            <text x={r.x + 14} y={r.y + 52} className={`text-[14px] ${c?.help ? "fill-danger-fg" : "fill-muted"}`}>
              {counted(c?.n ?? 0)}
            </text>
            {c?.help && <Icon name="alert" x={r.x + 20 + r.code.length * 11.5} y={r.y + 11} width={24} height={24} className="text-danger" />}
          </g>
        );
      })}
      {sim.sensors
        .filter((s) => s.f === f)
        .map((s) => {
          const low = s.on && s.battery < 20;
          return (
            <g key={s.id} transform={`translate(${s.x} ${s.y})`}>
              <title>{s.on ? `Sensor ${s.label}, battery ${Math.round(s.battery)}%` : `Sensor ${s.label} stopped, battery empty`}</title>
              <rect x={-18} y={-11} width={36} height={22} rx={6} strokeWidth={1.5} className={!s.on ? "fill-danger-soft stroke-danger" : low ? "fill-warn-soft stroke-warn" : "fill-surface stroke-subtle"} />
              <text y={4.5} textAnchor="middle" className={`text-[12px] font-bold ${!s.on ? "fill-danger-fg" : "fill-fg"}`}>
                {s.label}
              </text>
              <text x={s.lx} y={s.ly} textAnchor={s.lx > 0 ? "start" : "middle"} className={`text-[12px] font-semibold ${!s.on ? "fill-danger-fg" : low ? "fill-warn-fg" : "fill-muted"}`}>
                {s.on ? `${Math.round(s.battery)}%` : "off"}
              </text>
            </g>
          );
        })}
      {sim.rescuers
        .filter((r) => r.target && !r.arrived)
        .flatMap((r) => routeRuns(r, f).map((pts, i) => <polyline key={`${r.id}-${i}`} points={pts} strokeWidth={3} strokeDasharray="10 7" strokeLinecap="round" className="fill-none stroke-rescuer" opacity={0.85} />))}
      {people.map((p) => (
        <PersonMark key={p.id} sim={sim} p={p} selected={p.id === selected} onSelect={onSelect} />
      ))}
      {rescuers.map((r) => (
        <RescuerMark key={r.id} r={r} />
      ))}
    </svg>
  );
}

// 3D: x runs right, plan depth goes up and to the right, floors stack upwards.
const SX = 0.62;
const K = 0.3;
const OX = 175;
const GAP = 205;
const THICK = 9;
const oy = (f: number) => 22 + (FLOORS.length - f) * GAP;
const pt = (f: number, x: number, y: number): [number, number] => [OX + x * SX + (PLAN.h - y) * K, oy(f) + y * K];
const poly = (ps: [number, number][]) => ps.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
const quad = (f: number, x: number, y: number, w: number, h: number) => poly([pt(f, x, y), pt(f, x + w, y), pt(f, x + w, y + h), pt(f, x, y + h)]);
const down = ([x, y]: [number, number]): [number, number] => [x, y + THICK];

function Stack3D({ sim, current, onOpenFloor }: { sim: Sim; current: number; onOpenFloor: (f: number) => void }) {
  const o = OUTLINE;
  const corners: [number, number][] = [
    [o.x, o.y],
    [o.x + o.w, o.y],
    [o.x + o.w, o.y + o.h],
    [o.x, o.y + o.h],
  ];
  return (
    <svg viewBox={`0 0 ${PLAN.w} 620`} className="block h-auto w-full min-w-[640px] select-none" role="group" aria-label="All floors, stacked">
      <defs>
        <Hatch id="hz-3d" />
      </defs>
      {corners.map(([x, y]) => {
        const [x1, y1] = pt(1, x, y);
        const [x3, y3] = pt(3, x, y);
        return <line key={`${x}-${y}`} x1={x1} y1={y1 + THICK} x2={x3} y2={y3} strokeDasharray="4 5" className="stroke-line" />;
      })}
      {FLOORS.map((f) => {
        const st = floorStats(sim, f);
        const counts = roomCounts(sim, f);
        const fl = pt(f, o.x, o.y + o.h);
        const fr = pt(f, o.x + o.w, o.y + o.h);
        const br = pt(f, o.x + o.w, o.y);
        const on = f === current;
        return (
          <g key={f} {...press(() => onOpenFloor(f))} aria-label={`Floor ${f}, ${st.total} people${st.help ? `, ${st.help} need help` : ""}. Open in 2D`} className="group cursor-pointer">
            <polygon points={poly([fl, fr, down(fr), down(fl)])} className="fill-line" />
            <polygon points={poly([br, fr, down(fr), down(br)])} className="fill-line" />
            {ROOMS.filter((r) => r.f === f).map((r) => (
              <polygon key={r.id} points={quad(f, r.x, r.y, r.w, r.h)} strokeWidth={1} className={`stroke-subtle ${counts.get(r.id)?.help && r.kind !== "corridor" ? "fill-danger-soft" : r.kind === "room" ? "fill-surface" : "fill-surface-2"}`} />
            ))}
            {SCENARIOS[sim.incident].hazards
              .filter((h) => h.f === f)
              .map((h) => (
                <polygon key={h.label} points={quad(f, h.x, h.y, h.w, h.h)} fill="url(#hz-3d)" strokeWidth={1.5} strokeDasharray="6 4" className="stroke-danger" />
              ))}
            <polygon points={quad(f, o.x, o.y, o.w, o.h)} strokeWidth={on ? 3 : 1.5} className={`fill-none ${on ? "stroke-fg" : "stroke-muted group-hover:stroke-fg"}`} />
            {sim.people
              .filter((p) => p.f === f && p.state !== "out")
              .map((p) => {
                const [x, y] = pt(f, p.x, p.y);
                return (
                  <g key={p.id} className={GLIDE} style={{ transform: `translate(${x}px, ${y}px)` }}>
                    <circle r={p.state === "help" ? 8 : 6} strokeWidth={2} className={`stroke-surface ${p.state === "help" ? "fill-danger" : p.state === "still" ? "fill-uncertain" : "fill-ok"}`} />
                    {p.state === "help" && (
                      <text y={-13} textAnchor="middle" className="fill-danger-fg stroke-surface text-[13px] font-bold" style={HALO}>
                        {p.id}
                      </text>
                    )}
                  </g>
                );
              })}
            {sim.rescuers
              .filter((r) => r.f === f)
              .map((r) => {
                const [x, y] = pt(f, r.x, r.y);
                return <RescuerMark key={r.id} r={{ id: r.id, x, y }} size={6} label={false} />;
              })}
            <text x={OX - 25} y={oy(f) + 62} textAnchor="end" className={`text-[24px] font-bold ${on ? "fill-fg" : "fill-muted group-hover:fill-fg"}`}>
              Floor {f}
            </text>
            <text x={OX - 25} y={oy(f) + 88} textAnchor="end" className="fill-muted text-[16px]">
              {st.total === 1 ? "1 person" : `${st.total} people`}
            </text>
            {st.help > 0 && (
              <text x={OX - 25} y={oy(f) + 110} textAnchor="end" className="fill-danger-fg text-[16px] font-semibold">
                {st.help} need{st.help === 1 ? "s" : ""} help
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function Key({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-1.5">
      <svg viewBox="-12 -12 24 24" className="h-4 w-4 shrink-0" aria-hidden>
        {icon}
      </svg>
      {children}
    </li>
  );
}

function Legend({ view }: { view: "2d" | "3d" }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted">
      <Key icon={<circle r={10} className="fill-danger" />}>Needs help</Key>
      <Key icon={<circle r={8} className="fill-uncertain" />}>Still · breathing</Key>
      <Key
        icon={
          <>
            <circle r={8} className="fill-ok" />
            <path d="M-3 -4 4 0 -3 4z" className="fill-surface" />
          </>
        }
      >
        Moving
      </Key>
      <Key icon={<rect x={-7} y={-7} width={14} height={14} transform="rotate(45)" className="fill-rescuer" />}>Rescuer</Key>
      {view === "2d" && (
        <>
          <Key icon={<line x1={-11} x2={11} strokeWidth={3} strokeDasharray="5 3" className="stroke-rescuer" />}>Rescuer route</Key>
          <Key icon={<rect x={-10} y={-7} width={20} height={14} rx={3} strokeWidth={2} className="fill-surface stroke-subtle" />}>Sensor · battery</Key>
        </>
      )}
      <Key icon={<rect x={-11} y={-11} width={22} height={22} fill={view === "2d" ? "url(#hz-2d)" : "url(#hz-3d)"} strokeWidth={2} strokeDasharray="4 3" className="stroke-danger" />}>Hazard zone</Key>
      {view === "3d" && <li className="text-subtle">Click a floor to open it in 2D</li>}
    </ul>
  );
}

export function EmergencyMap({
  sim,
  floor,
  view,
  selected,
  onSelect,
  onOpenFloor,
}: {
  sim: Sim;
  floor: number;
  view: "2d" | "3d";
  selected: string | null;
  onSelect: (id: string) => void;
  onOpenFloor: (f: number) => void;
}) {
  return (
    <div>
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">{view === "2d" ? <Plan2D sim={sim} f={floor} selected={selected} onSelect={onSelect} /> : <Stack3D sim={sim} current={floor} onOpenFloor={onOpenFloor} />}</div>
      <Legend view={view} />
    </div>
  );
}
