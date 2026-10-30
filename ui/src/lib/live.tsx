"use client";
// One WebSocket for the whole dashboard (plan-v2 §8): exponential backoff
// capped at 5 s, a `connected` flag for the "connection lost" state, and
// ref-held ring buffers for the breathing wave and the CSI heatmap so canvases
// can draw on requestAnimationFrame without re-rendering React.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getAlerts, getHistory, getStatus, wsUrl, type Alert, type Status, type WsMessage } from "./api";
import type { Result } from "./contracts.gen";
import type { PresenceSince } from "./words";

export const WAVE_HZ = 10;
const TICK_S = 0.5; // one result per 0.5 s (contracts/control.md)
export const WAVE_SECONDS = 300; // ring buffer length; the chart shows 30 s or 5 min of it
export const CSI_ROWS = 300; // ~30 s at 5 rows per 0.5 s

export class RingBuffer<T> {
  private buf: T[];
  private head = 0;
  private count = 0;
  constructor(readonly capacity: number) {
    this.buf = new Array<T>(capacity);
  }
  push(v: T): void {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }
  get length(): number {
    return this.count;
  }
  /** Oldest → newest. */
  toArray(): T[] {
    const out: T[] = new Array(this.count);
    const start = (this.head - this.count + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i++) out[i] = this.buf[(start + i) % this.capacity];
    return out;
  }
  clear(): void {
    this.head = 0;
    this.count = 0;
  }
}

export interface LiveBuffers {
  /** null = no sample for that moment (the engine had no breathing window): drawn as a gap. */
  wave: RingBuffer<number | null>;
  csi: RingBuffer<number[]>;
  /** Bumped on every result; canvases compare it to skip redraws. */
  version: number;
}

export interface LiveState {
  connected: boolean;
  /** ms since the last result, or null. Updated at 2 Hz with the results. */
  result: Result | null;
  status: Status | null;
  alerts: Alert[];
  /** Alerts that resolved while this page was open, newest first, for a calm "all clear" line. */
  cleared: Alert[];
  dismissCleared: (id: string) => void;
  /** When the current presence state started (from /history on first load, then live). */
  presenceSince: PresenceSince | null;
  buffers: LiveBuffers;
  refreshAlerts: () => Promise<void>;
}

const HISTORY_ROW_MS = 5000;

/** Start of the current presence run, from the 5 s history rows (oldest first). */
async function seedPresenceSince(state: PresenceSince["state"], now: number): Promise<PresenceSince> {
  try {
    const { rows } = await getHistory(now - 24 * 3600 * 1000, now, "presence");
    let i = rows.length - 1;
    while (i >= 0 && rows[i].presence === state) i--;
    if (i === rows.length - 1) return { state, since: now, atLeast: false }; // changed just now
    if (i < 0) return { state, since: rows.length ? rows[0].t : null, atLeast: true };
    return { state, since: rows[i].t + HISTORY_ROW_MS, atLeast: false };
  } catch {
    return { state, since: null, atLeast: true };
  }
}

const LiveContext = createContext<LiveState | null>(null);

export function LiveProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [cleared, setCleared] = useState<Alert[]>([]);
  const [presenceSince, setPresenceSince] = useState<PresenceSince | null>(null);
  const lastPresence = useRef<PresenceSince["state"] | null>(null);
  // Once the server reports presence changes itself (Status.presence), history seeding is not needed.
  const serverPresence = useRef(false);
  // A stable mutable object (not React state): canvases read it on rAF, React never re-renders on it.
  const [buffers] = useState<LiveBuffers>(() => ({ wave: new RingBuffer(WAVE_HZ * WAVE_SECONDS), csi: new RingBuffer(CSI_ROWS), version: 0 }));
  const lastBoot = useRef<number | null>(null);
  const lastSource = useRef<Result["source"] | null>(null);

  const refreshAlerts = async () => {
    try {
      const { alerts } = await getAlerts("pending,open,acked");
      // A WebSocket transition may have arrived while this request was in flight: keep whichever is newer.
      const stamp = (a: Alert) => Math.max(a.created_at, a.opened_at ?? 0, a.acked_at ?? 0, a.resolved_at ?? 0, a.escalated_at ?? 0, a.notified_at ?? 0);
      setAlerts((prev) => {
        const byId = new Map(alerts.map((a) => [a.id, a]));
        for (const p of prev) {
          const s = byId.get(p.id);
          if (s ? stamp(p) > stamp(s) : p.state !== "resolved" && p.state !== "dropped") byId.set(p.id, p);
        }
        return [...byId.values()].filter((a) => a.state === "pending" || a.state === "open" || a.state === "acked").sort((a, b) => b.created_at - a.created_at);
      });
    } catch {
      /* server unreachable; the ws state shows it */
    }
  };

  useEffect(() => {
    let ws: WebSocket | null = null;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(wsUrl());
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
        void refreshAlerts();
        getStatus().then(setStatus).catch(() => {});
      };
      ws.onmessage = (ev) => {
        let m: WsMessage;
        try {
          m = JSON.parse(ev.data as string) as WsMessage;
        } catch {
          return; // one broken frame must not stop the dashboard
        }
        if (m.type === "result") {
          // a new board boot or a switch between live and replay: the old signal is not this one
          if ((lastBoot.current !== null && lastBoot.current !== m.boot_id) || (lastSource.current !== null && lastSource.current !== m.source)) {
            buffers.wave.clear();
            buffers.csi.clear();
          }
          lastBoot.current = m.boot_id;
          lastSource.current = m.source;
          if (m.breathing.wave.length) for (const v of m.breathing.wave) buffers.wave.push(v);
          else for (let i = 0; i < WAVE_HZ * TICK_S; i++) buffers.wave.push(null); // keep the time axis true
          for (const row of m.csi) buffers.csi.push(row);
          buffers.version++;
          const ps = m.presence.state;
          if (serverPresence.current) {
            /* Status.presence drives presenceSince */
          } else if (lastPresence.current === null) {
            lastPresence.current = ps;
            void seedPresenceSince(ps, m.ts).then((seed) => setPresenceSince((cur) => (cur && cur.state !== seed.state ? cur : seed)));
          } else if (lastPresence.current !== ps) {
            lastPresence.current = ps;
            setPresenceSince({ state: ps, since: m.ts, atLeast: false });
          }
          setResult(m);
        } else if (m.type === "status") {
          setStatus((prev) => ({ ...m.status, result: prev?.result }));
          if (m.status.presence) {
            serverPresence.current = true;
            const p = m.status.presence;
            setPresenceSince({ state: p.state, since: p.since, atLeast: p.at_least });
          }
        } else if (m.type === "alert") {
          // "All clear" only when the condition really ended, not when the engine or sensor went away.
          const closedBy = String(m.alert.data.closed_by ?? "");
          if (m.alert.state === "resolved" && !/restart|stopped reporting/.test(closedBy)) setCleared((prev) => [m.alert, ...prev.filter((a) => a.id !== m.alert.id)].slice(0, 5));
          setAlerts((prev) => {
            const next = prev.filter((a) => a.id !== m.alert.id);
            if (m.alert.state === "pending" || m.alert.state === "open" || m.alert.state === "acked") next.unshift(m.alert);
            return next.sort((a, b) => b.created_at - a.created_at);
          });
        }
      };
      ws.onclose = () => {
        setConnected(false);
        ws = null;
        if (closed) return;
        const delay = Math.min(5000, 500 * 2 ** attempt++);
        timer = setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismissCleared = (id: string) => setCleared((prev) => prev.filter((a) => a.id !== id));
  const value = useMemo<LiveState>(
    () => ({ connected, result, status, alerts, cleared, dismissCleared, presenceSince, buffers, refreshAlerts }),
    [connected, result, status, alerts, cleared, presenceSince, buffers],
  );
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveState {
  const v = useContext(LiveContext);
  if (!v) throw new Error("useLive must be used inside <LiveProvider>");
  return v;
}

/** Which optional outputs the engine publishes (get_status outputs); all of them when it does not say. */
export function usePublished(): { posture: boolean; count: boolean; activity: boolean } {
  const { status } = useLive();
  const o = status?.engine.status?.outputs;
  return { posture: o?.posture ?? true, count: o?.count ?? true, activity: o?.activity ?? true };
}

/** True when the last result is older than `staleMs`. Re-evaluated on a timer so it flips without new data. */
export function useStale(result: Result | null, staleMs = 3000): boolean {
  const now = useNow();
  return !result || now - result.ts > staleMs;
}

/** Wall clock that re-renders every `everyMs`, for "since" texts and ticking counters. */
export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
