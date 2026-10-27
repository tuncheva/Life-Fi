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
  wave: RingBuffer<number>;
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

  const refreshAlerts = async () => {
    try {
      const { alerts } = await getAlerts("pending,open,acked");
      setAlerts(alerts);
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
        const m = JSON.parse(ev.data as string) as WsMessage;
        if (m.type === "result") {
          if (lastBoot.current !== null && lastBoot.current !== m.boot_id) {
            buffers.wave.clear();
            buffers.csi.clear();
          }
          lastBoot.current = m.boot_id;
          for (const v of m.breathing.wave) buffers.wave.push(v);
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
          if (m.alert.state === "resolved") setCleared((prev) => [m.alert, ...prev.filter((a) => a.id !== m.alert.id)].slice(0, 5));
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
