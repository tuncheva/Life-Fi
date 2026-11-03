"use client";
// The room from above (docs/overnight/plans/B-ui-ux.md B1.2): occupancy first, distance
// second. The whole room fills when someone is there; the distance is a band around the
// sensor (one link has no direction, so it is a radius, never a dot), drawn only with
// its quality label. Reads the result itself so the dashboard around it does not
// re-render on every 0.5 s result.
import { useEffect, useId, useState } from "react";
import type { ProfileName } from "@/lib/api";
import { useLiveSlow, useNow, useResult, useStale } from "@/lib/live";
import { DEFAULT_ROOM, distanceRange, positionView, readRoomGeometry, ROOM_EVENT, ROOM_KEY, type RoomGeometry, type WhereState } from "@/lib/room";
import { roomStatus, whereText, type RoomStatus } from "@/lib/words";

/** The derived room status every view shares. */
export function useRoomStatus(): RoomStatus & { profile: ProfileName } {
  const { connected, status, presenceSince } = useLiveSlow();
  const result = useResult();
  const stale = useStale(result);
  const now = useNow();
  const profile = status?.server.profile ?? "home";
  return { ...roomStatus({ connected, status, result, stale, presenceSince, profile, now }), profile };
}

/** Where is someone, and the sentence for it. */
export function useWhere(): { where: WhereState; text: ReturnType<typeof whereText>; status: RoomStatus } {
  const status = useRoomStatus();
  const result = useResult();
  const { positionHeldSince } = useLiveSlow();
  const where = positionView({ status, result, heldSince: positionHeldSince });
  return { where, text: whereText(where), status };
}

/** The room saved in this browser; the default during the server render, then the saved one. */
export function useRoomGeometry(): RoomGeometry {
  const [g, setG] = useState<RoomGeometry>(DEFAULT_ROOM);
  useEffect(() => {
    const read = () => setG(readRoomGeometry());
    read();
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === ROOM_KEY) read();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(ROOM_EVENT, read);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(ROOM_EVENT, read);
    };
  }, []);
  return g;
}

const PX = 100; // viewBox units per metre
const ZONE_RINGS = [1.5, 3.5]; // lifefi.position: near < 1.5 m, middle 1.5..3.5 m, far beyond
const metres = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

export function RoomView({ className = "" }: { className?: string }) {
  const { where, text, status } = useWhere();
  const g = useRoomGeometry();
  const { status: server } = useLiveSlow();
  const result = useResult();
  const replay = (server?.source.mode ?? result?.source) === "replay";

  const W = g.width_m * PX;
  const L = g.length_m * PX;
  const fs = Math.max(W, L) / 22; // ≈ 13 px when the drawing is 300 px wide
  const pad = fs * 2.6;
  const sx = W / 2; // sensor: middle of the bottom wall
  const sy = L;
  const clipId = `room-clip-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;

  const fill =
    where.kind === "here"
      ? { color: "var(--present)", opacity: 0.18, outline: "var(--present)" }
      : where.kind === "unsure"
        ? { color: "var(--uncertain)", opacity: 0.12, outline: "var(--uncertain)" }
        : where.kind === "nobody"
          ? { color: "transparent", opacity: 0, outline: "var(--empty)" }
          : { color: "transparent", opacity: 0, outline: status.tone === "offline" ? "var(--offline)" : "var(--line)" };

  const dist = where.kind === "here" ? where.distance : null;
  const spot = where.kind === "here" ? where.spot : null;
  let label: string | null = null;
  if (dist) {
    const r = distanceRange(dist.d, dist.sd);
    label = dist.quality === "medium" ? `roughly ${metres(r.lo)}–${metres(r.hi)} m` : "rough guess";
    if (dist.held) label += " · standing still";
  }
  const labelY = dist ? Math.max(fs * 1.4, Math.min(L - fs * 2, sy - (dist.d + Math.max(dist.sd, 0.1)) * PX - fs * 0.5)) : 0;
  const txY = g.tx_m === null ? null : Math.max(fs * 0.6, sy - g.tx_m * PX);
  const aria = `${text.headline}${text.detail ? `. ${text.detail}` : ""}`;

  return (
    <svg
      role="img"
      aria-label={aria}
      viewBox={`${-pad} ${-pad} ${W + 2 * pad} ${L + 2 * pad}`}
      className={`block w-full ${className}`}
      style={{ fontSize: fs }}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={0} y={0} width={W} height={L} />
        </clipPath>
      </defs>

      {/* occupancy: the whole room */}
      <rect x={0} y={0} width={W} height={L} rx={fs * 0.4} fill={fill.color} fillOpacity={fill.opacity} stroke={fill.outline} strokeWidth={fs * 0.18} />

      <g clipPath={`url(#${clipId})`}>
        {/* zone rings, faint, for scale */}
        {ZONE_RINGS.map((r) => (
          <circle key={r} cx={sx} cy={sy} r={r * PX} fill="none" stroke="var(--chart-axis)" strokeOpacity={0.35} strokeWidth={fs * 0.08} strokeDasharray={`${fs * 0.3} ${fs * 0.4}`} />
        ))}
        {/* the distance band: d − sd … d + sd around the sensor */}
        {dist && (
          <>
            <circle
              cx={sx}
              cy={sy}
              fill="none"
              stroke="var(--present)"
              strokeOpacity={dist.quality === "medium" && !dist.held ? 0.3 : 0.12}
              className="transition-[r,stroke-width] duration-700 ease-out motion-reduce:transition-none"
              style={{ r: dist.d * PX, strokeWidth: Math.max(2 * dist.sd * PX, fs * 0.6) }}
            />
            <circle
              cx={sx}
              cy={sy}
              fill="none"
              stroke="var(--present)"
              strokeWidth={fs * (dist.quality === "medium" ? 0.16 : 0.1)}
              strokeDasharray={dist.quality === "low" || dist.held ? `${fs * 0.5} ${fs * 0.4}` : undefined}
              className="transition-[r] duration-700 ease-out motion-reduce:transition-none"
              style={{ r: dist.d * PX }}
            />
          </>
        )}
        {spot && spot.d !== null && (
          <g>
            <line x1={sx - fs * 0.5} x2={sx + fs * 0.5} y1={sy - spot.d * PX} y2={sy - spot.d * PX} stroke="var(--present-fg)" strokeWidth={fs * 0.2} />
            <text x={sx + fs * 0.8} y={sy - spot.d * PX} dominantBaseline="middle" fill="var(--present-fg)">
              probably: {spot.name.replace(/_/g, " ")}
            </text>
          </g>
        )}
      </g>

      {/* ring labels, once, up and to the left of the sensor */}
      {ZONE_RINGS.map((r) => {
        const x = sx - r * PX * Math.SQRT1_2;
        const y = sy - r * PX * Math.SQRT1_2;
        if (x < fs * 1.5 || y < fs) return null;
        return (
          <text key={r} x={x} y={y - fs * 0.3} textAnchor="end" fill="var(--subtle)" fontSize={fs * 0.8}>
            {metres(r)} m
          </text>
        );
      })}

      {dist && label && (
        <text x={sx} y={labelY} textAnchor="middle" fill="var(--present-fg)" fontWeight={600} paintOrder="stroke" stroke="var(--surface)" strokeWidth={fs * 0.3} strokeLinejoin="round">
          {label}
        </text>
      )}

      {/* the state in the room, when there is no band to read */}
      {where.kind !== "here" && (
        <text x={W / 2} y={L / 2} textAnchor="middle" dominantBaseline="middle" fill={where.kind === "blind" ? "var(--muted)" : where.kind === "unsure" ? "var(--uncertain-fg)" : "var(--empty-fg)"} fontWeight={600} fontSize={fs * 1.1} paintOrder="stroke" stroke="var(--surface)" strokeWidth={fs * 0.3} strokeLinejoin="round">
          {where.kind !== "blind" ? text.headline : status.tone === "connecting" ? "Connecting…" : status.tone === "uncertain" ? "Starting up" : "Not watching"}
        </text>
      )}

      {/* transmitter along the centre line, with the link */}
      {txY !== null && (
        <g>
          <line x1={sx} y1={sy} x2={sx} y2={txY} stroke="var(--chart-axis)" strokeOpacity={0.5} strokeWidth={fs * 0.08} />
          <rect x={sx - fs * 0.45} y={txY - fs * 0.45} width={fs * 0.9} height={fs * 0.9} rx={fs * 0.15} fill="var(--surface)" stroke="var(--fg)" strokeWidth={fs * 0.12} />
          <text x={sx + fs * 0.8} y={txY} dominantBaseline="middle" fill="var(--muted)" fontSize={fs * 0.85}>
            transmitter{g.tx_m !== null && g.tx_m > g.length_m ? ` (${metres(g.tx_m)} m)` : ""}
          </text>
        </g>
      )}

      {/* sensor at the middle of the bottom wall */}
      <rect x={sx - fs * 0.6} y={sy - fs * 0.45} width={fs * 1.2} height={fs * 0.9} rx={fs * 0.15} fill="var(--fg)" />
      <text x={sx} y={sy + fs * 1.5} textAnchor="middle" fill="var(--muted)">
        sensor
      </text>

      {/* scale bar */}
      <g transform={`translate(${W - PX}, ${L + fs * 1.3})`}>
        <line x1={0} x2={PX} y1={0} y2={0} stroke="var(--subtle)" strokeWidth={fs * 0.1} />
        <line x1={0} x2={0} y1={-fs * 0.25} y2={fs * 0.25} stroke="var(--subtle)" strokeWidth={fs * 0.1} />
        <line x1={PX} x2={PX} y1={-fs * 0.25} y2={fs * 0.25} stroke="var(--subtle)" strokeWidth={fs * 0.1} />
        <text x={PX / 2} y={-fs * 0.45} textAnchor="middle" fill="var(--subtle)" fontSize={fs * 0.8}>
          1 m
        </text>
      </g>

      {replay && (
        <g transform={`translate(${-pad + fs * 0.3}, ${-pad + fs * 0.3})`}>
          <rect width={fs * 6} height={fs * 1.6} rx={fs * 0.8} fill="var(--replay)" />
          <text x={fs * 3} y={fs * 0.8} textAnchor="middle" dominantBaseline="middle" fill="var(--replay-fg)" fontWeight={600} fontSize={fs * 0.9}>
            Recording
          </text>
        </g>
      )}
    </svg>
  );
}
