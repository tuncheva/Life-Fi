"use client";
// Dashboard building blocks (docs/plan/ui-ux.md §4.3). The room card answers
// "is anyone there, is it OK" in one sentence; breathing and the timeline come
// next; device health, detector values and the raw signal live in a collapsed
// "Sensor details" section for installers and the demo's privacy moment.
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { getAlerts, type Alert, type ProfileName } from "@/lib/api";
import type { Result } from "@/lib/contracts.gen";
import { useLive, useNow, useStale } from "@/lib/live";
import {
  PROFILE_TEXT,
  roomName,
  activityText,
  alertTitle,
  breathingText,
  calibrationText,
  clock,
  duration,
  postureText,
  roomStatus,
  type RoomStatus,
  type Tone,
} from "@/lib/words";
import { BreathingChart } from "./BreathingChart";
import { Card, Icon, Pill, TONE_CLASS, TONE_ICON, btn } from "./ui";

export { Card } from "./ui";

/** The derived room status every view shares. */
export function useRoomStatus(): RoomStatus & { profile: ProfileName } {
  const { connected, status, result, presenceSince } = useLive();
  const stale = useStale(result);
  const now = useNow();
  const profile = status?.server.profile ?? "home";
  return { ...roomStatus({ connected, status, result, stale, presenceSince, profile, now }), profile };
}

function useAlertsToday(): Alert[] {
  const { alerts: live } = useLive();
  const [list, setList] = useState<Alert[]>([]);
  useEffect(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    getAlerts("open,acked,resolved")
      .then((r) => setList(r.alerts.filter((a) => a.created_at >= start.getTime())))
      .catch(() => {});
  }, [live]);
  return list;
}

function Fact({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="min-w-0 px-4 py-3 sm:px-5">
      <dt className="text-xs font-medium text-subtle">{label}</dt>
      <dd className="mt-0.5 truncate text-base font-semibold sm:text-lg">{value}</dd>
      {note && <dd className="text-xs text-muted">{note}</dd>}
    </div>
  );
}

export interface Headline {
  tone: Tone;
  headline: string;
  detail: string | null;
}

/** The big state block, shared by the room card and presentation mode. */
export function StateHeadline({ s, size = "md" }: { s: Headline & { action?: RoomStatus["action"] }; size?: "md" | "xl" }) {
  const t = TONE_CLASS[s.tone];
  const xl = size === "xl";
  return (
    <div className={`flex items-start ${xl ? "gap-6" : "gap-4"}`}>
      <span className={`flex shrink-0 items-center justify-center rounded-2xl ${t.soft} ${t.text} ${xl ? "h-28 w-28 rounded-3xl" : "h-14 w-14 sm:h-16 sm:w-16"}`}>
        <Icon name={TONE_ICON[s.tone]} className={xl ? "h-16 w-16" : "h-8 w-8 sm:h-9 sm:w-9"} />
      </span>
      <div className="min-w-0">
        <h1 aria-live="polite" className={`font-bold leading-tight tracking-tight ${xl ? "text-6xl lg:text-7xl" : "text-[1.75rem] sm:text-4xl"}`}>
          {s.headline}
        </h1>
        {s.detail && <p className={`mt-1 text-muted ${xl ? "text-3xl" : "text-base sm:text-lg"}`}>{s.detail}</p>}
        {s.action && (
          <Link href={s.action.href} className={`${btn.primary} mt-3`}>
            {s.action.label}
          </Link>
        )}
      </div>
    </div>
  );
}

/** Clinic: bed state is what a nurse asks first. Posture is "last change seen". */
function clinicHeadline(s: RoomStatus, alerts: Alert[], posture: Result["posture"], now: number): Headline {
  if (s.blind || s.tone !== "present") return s;
  const label = posture?.label;
  // "since" is the last posture change we saw, not the presence start
  const since = posture && label !== "unknown" ? `since ${clock(posture.since)} · ${duration(now - posture.since)} · last change seen` : s.detail;
  const bedExit = alerts.find((a) => a.type === "bed_exit" && (a.state === "open" || a.state === "acked"));
  if (bedExit) return { tone: "uncertain", headline: "Out of bed", detail: `since ${clock(bedExit.created_at)}` };
  if (label === "lying") return { tone: "present", headline: "In bed", detail: since };
  if (label === "sitting" || label === "standing") return { tone: "present", headline: `Up, ${label}`, detail: since };
  return s;
}

export function RoomCard({ afterHours }: { afterHours?: { from: string; to: string; now: boolean } | null }) {
  const { result, status, alerts } = useLive();
  const s = useRoomStatus();
  const today = useAlertsToday();
  const profile = s.profile;
  const now = useNow();
  const head = profile === "clinic" ? clinicHeadline(s, alerts, result?.posture ?? null, now) : s;
  const t = TONE_CLASS[head.tone];
  const cal = calibrationText(result?.calibration ?? status?.engine.status?.calibration ?? null);
  const showFacts = !s.blind && result && result.presence.state !== "empty";
  const posture = result ? postureText(result.posture) : null;
  const breathing = result ? breathingText(result) : null;
  const last = today[0];

  let schoolNote: ReactNode = null;
  if (profile === "school" && afterHours?.now && result && !s.blind) {
    schoolNote =
      result.presence.state === "present" ? (
        <Pill tone="warn">In use after hours ({afterHours.from}–{afterHours.to})</Pill>
      ) : result.presence.state === "empty" ? (
        <Pill tone="ok">Empty, as expected after hours</Pill>
      ) : null;
  }

  // An open alert outranks the calm state colour: the card must not look "all fine" under a red banner.
  const openAlert = alerts.find((a) => a.state === "open");
  const ackedAlert = alerts.find((a) => a.state === "acked");
  const urgent = openAlert && openAlert.level !== "low";
  const ring = urgent ? (openAlert.level === "high" ? "border-t-alert-high" : "border-t-alert-medium") : openAlert || ackedAlert ? "border-t-warn" : t.ring;

  return (
    <section className={`overflow-hidden rounded-card border border-line border-t-4 bg-surface shadow-sm ${ring}`} aria-label={`${roomName(status)} status`}>
      {(urgent || ackedAlert) && (
        <div className={`flex items-center gap-2 px-4 py-2 text-sm font-semibold sm:px-5 ${urgent ? "bg-danger-soft text-danger-fg" : "bg-warn-soft text-warn-fg"}`}>
          <Icon name="alert" className="h-4 w-4 shrink-0" />
          {urgent ? `${alertTitle(openAlert.type)}: not acknowledged yet` : `${alertTitle(ackedAlert!.type)}: ${ackedAlert!.acked_by ?? "someone"} is on it`}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pt-4 text-sm text-muted sm:px-5">
        <span className="font-semibold text-fg">{roomName(status)}</span>
        <span>· {PROFILE_TEXT[profile].title}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {s.blind ? (
            <span className="font-medium text-danger">Not watching</span>
          ) : (status?.source.mode ?? result?.source) === "replay" ? (
            <span className="font-medium text-replay">Recording, not the live room</span>
          ) : (
            <>
              <span aria-hidden className="h-2 w-2 rounded-full bg-ok" />
              Sensor working{cal.tone === "ok" ? "" : ` · ${cal.text.toLowerCase()}`}
            </>
          )}
        </span>
      </div>
      <div className="px-4 py-4 sm:px-5 sm:py-5">
        <StateHeadline s={head} />
        {schoolNote && <div className="mt-3">{schoolNote}</div>}
      </div>

      {showFacts && result && (
        <dl className="grid grid-cols-2 divide-line border-t border-line sm:grid-cols-3 sm:divide-x">
          {profile !== "school" && posture && <Fact label="Position" value={posture.text} note={posture.since ? `${posture.since} · last change seen` : "waits for the first move"} />}
          <Fact label="Activity" value={activityText(result.motion)} />
          {profile !== "school" && breathing ? (
            <Fact label="Breathing" value={breathing.value ? `${breathing.value} / min` : "—"} note={breathing.value ? "about, per minute" : breathing.text} />
          ) : (
            <Fact label="People" value={result.count ? (result.count.value === 2 ? "Several" : "One") : "—"} note={result.count ? "rough estimate" : "not estimated"} />
          )}
        </dl>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-surface-2/60 px-4 py-3 text-sm sm:px-5">
        <Link href="/alerts/" className="font-medium hover:underline">
          {today.length === 0 ? "No alerts today" : `${today.length} alert${today.length > 1 ? "s" : ""} today · last: ${alertTitle(last.type).toLowerCase()} ${clock(last.created_at)}`} →
        </Link>
        <span className="text-xs text-muted sm:ml-auto">{PROFILE_TEXT[profile].assumption}</span>
      </div>
    </section>
  );
}

export function BreathingCard() {
  const { result, buffers } = useLive();
  const s = useRoomStatus();
  const [seconds, setSeconds] = useState(30);
  const b = result && !s.blind ? breathingText(result) : null;
  const valid = !!result?.breathing.valid && !s.blind;
  return (
    <Card
      title="Breathing"
      actions={
        <div className="flex rounded-lg bg-surface-2 p-0.5" role="group" aria-label="Time window">
          {[30, 300].map((sec) => (
            <button key={sec} onClick={() => setSeconds(sec)} aria-pressed={seconds === sec} className={btn.segment(seconds === sec)}>
              {sec === 30 ? "30 s" : "5 min"}
            </button>
          ))}
        </div>
      }
    >
      <div className="flex items-baseline gap-2">
        <span className="text-4xl font-bold tabular-nums">{b?.value ?? "—"}</span>
        <span className="text-sm text-muted">{b ? b.text : s.tone === "offline" ? "Not available while the room can't be seen" : s.blind && s.tone === "uncertain" ? "Starting up" : "Waiting for a reading"}</span>
      </div>
      <div className={`mt-3 transition-opacity ${valid ? "" : "opacity-40"}`}>
        <BreathingChart buffers={buffers} seconds={seconds} />
      </div>
      <p className="mt-2 text-xs text-muted">Chest movement picked up from the Wi-Fi signal. Only for one still person near the sensor. Not a medical measurement.</p>
    </Card>
  );
}

/** Collapsible technical section, remembered per browser. */
export function SensorDetails({ children }: { children: ReactNode }) {
  const KEY = "lifefi.details";
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    try {
      if (ref.current && localStorage.getItem(KEY) === "1") ref.current.open = true;
    } catch {
      /* private mode */
    }
  }, []);
  return (
    <details
      ref={ref}
      onToggle={(e) => {
        try {
          localStorage.setItem(KEY, (e.currentTarget as HTMLDetailsElement).open ? "1" : "0");
        } catch {
          /* private mode */
        }
      }}
      className="group rounded-card border border-line bg-surface shadow-sm lg:col-span-3"
    >
      <summary className="flex items-center gap-3 px-4 py-3 sm:px-5">
        <Icon name="chevron" className="chev h-4 w-4 text-muted transition-transform" />
        <span className="font-semibold">Sensor details</span>
        <span className="text-sm text-muted">for installers: signal health, detector values and the raw signal</span>
      </summary>
      <div className="grid gap-4 border-t border-line p-4 sm:p-5 md:grid-cols-2 lg:grid-cols-3">{children}</div>
    </details>
  );
}

function Row({ k, v, tone, hint }: { k: string; v: string; tone: "ok" | "warn" | "danger" | "neutral"; hint?: string }) {
  return (
    <div className="contents">
      <dt className="text-muted" title={hint}>
        {k}
      </dt>
      <dd>
        <Pill tone={tone}>{v}</Pill>
      </dd>
    </div>
  );
}

export function HealthCard() {
  const { result, status } = useLive();
  const d = status?.device ?? null;
  const h = result?.health;
  const cal = result?.calibration;
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">Signal health</h3>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-sm">
        {status?.server.sensor_offline && <Row k="Watchdog" v={status.server.sensor_offline} tone="danger" />}
        <Row k="Engine" v={status?.engine.connected ? "connected" : "disconnected"} tone={status?.engine.connected ? "ok" : "danger"} />
        <Row k="CSI rate" hint="Wi-Fi measurements per second; ≥ 80 Hz is good" v={h ? `${h.rate_hz.toFixed(0)} Hz` : "—"} tone={!h ? "neutral" : h.rate_hz >= 80 ? "ok" : h.rate_hz >= 50 ? "warn" : "danger"} />
        <Row k="Loss" v={h ? `${(h.loss_udp * 100).toFixed(1)} % udp · ${(h.loss_air * 100).toFixed(1)} % air` : "—"} tone={!h ? "neutral" : h.loss_udp < 0.05 ? "ok" : "warn"} />
        <Row k="RSSI" hint="Wi-Fi strength at the sensor" v={d ? `${d.rssi_dbm} dBm` : "—"} tone={!d ? "neutral" : d.rssi_dbm > -65 ? "ok" : d.rssi_dbm > -75 ? "warn" : "danger"} />
        <Row k="Device uptime" v={d ? fmtUptime(d.uptime_s) : "—"} tone="neutral" />
        <Row k="Warm-up" v={h?.warmup ? "yes" : "no"} tone={h?.warmup ? "warn" : "neutral"} />
        <Row k="Calibration" v={cal ? `${cal.state}${cal.id ? ` · ${cal.id}` : ""}` : "—"} tone={cal?.state === "ok" ? "ok" : "warn"} />
        <Row k="Source" v={result?.source ?? status?.source.mode ?? "—"} tone={result?.source === "replay" ? "warn" : "neutral"} />
        <Row k="Config" v={result ? `${result.config_hash} · pipeline v${result.pipeline_version}` : "—"} tone="neutral" />
      </dl>
    </div>
  );
}

export function DetectorCard() {
  const { result } = useLive();
  const m = result?.motion ?? 0;
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">Detector values</h3>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold tabular-nums">{m.toFixed(2)}</span>
        <span className="text-sm text-muted">motion · {activityText(m).toLowerCase()}</span>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-2">
        <div className="h-full bg-chart-activity transition-[width] duration-300" style={{ width: `${Math.round(Math.min(1, m) * 100)}%` }} />
      </div>
      {result && (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="font-mono text-muted">S</dt>
          <dd>
            {result.presence.S.toFixed(2)} <span className="text-xs text-muted">static change vs. empty room</span>
          </dd>
          <dt className="font-mono text-muted">B</dt>
          <dd>
            {result.presence.B.toFixed(2)} <span className="text-xs text-muted">breathing-band energy</span>
          </dd>
          <dt className="font-mono text-muted">M</dt>
          <dd>
            {result.presence.M.toFixed(2)} <span className="text-xs text-muted">motion energy</span>
          </dd>
          <dt className="text-muted">state</dt>
          <dd className="font-mono">{result.presence.state}</dd>
          <dt className="text-muted">posture</dt>
          <dd className="font-mono">{result.posture ? `${result.posture.label} (${result.posture.src}) since ${clock(result.posture.since, true)}` : "null"}</dd>
          <dt className="text-muted">count</dt>
          <dd className="font-mono">{result.count ? `${result.count.value === 2 ? "2+" : "1"} · p ${result.count.p.map((x) => x.toFixed(2)).join(" / ")}` : "model not loaded"}</dd>
          <dt className="text-muted">breathing</dt>
          <dd className="font-mono">
            {result.breathing.bpm?.toFixed(1) ?? "—"} bpm · conf {(result.breathing.confidence * 100).toFixed(0)} % · {result.breathing.valid ? "valid" : "invalid"}
          </dd>
        </dl>
      )}
    </div>
  );
}

function fmtUptime(s: number): string {
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} d`;
}

// Perceptual ramp (viridis-like) for the heatmap: readable in both themes and on projectors.
const RAMP: [number, number, number][] = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
];
function ramp(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  const f = x - i;
  const a = RAMP[i];
  const b = RAMP[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** The raw CSI amplitudes: "this is everything the sensor sees". */
export function CsiCanvas({ className = "h-40" }: { className?: string }) {
  const { buffers } = useLive();
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    let drawn = -1;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = canvas.current;
      if (!c || drawn === buffers.version) return;
      drawn = buffers.version;
      const rows = buffers.csi.toArray();
      // time runs left → right (newest at the right), subcarriers bottom → top
      const W = buffers.csi.capacity;
      const H = 52;
      if (c.width !== W || c.height !== H) {
        c.width = W;
        c.height = H;
      }
      const g = c.getContext("2d")!;
      const img = g.createImageData(W, H);
      const off = W - rows.length;
      for (let x = 0; x < W; x++) {
        const row = rows[x - off];
        for (let y = 0; y < H; y++) {
          const i = (y * W + x) * 4;
          if (!row) {
            img.data[i + 3] = 0;
            continue;
          }
          const [r, gg, b] = ramp(((row[H - 1 - y] ?? -42) + 46) / 8);
          img.data[i] = r;
          img.data[i + 1] = gg;
          img.data[i + 2] = b;
          img.data[i + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [buffers]);
  return (
    <canvas
      ref={canvas}
      role="img"
      aria-label="Raw Wi-Fi signal: 52 frequency bands over the last 30 seconds. No image of the room or the person."
      className={`w-full rounded-lg bg-surface-2 [image-rendering:pixelated] ${className}`}
    />
  );
}

export function CsiHeatmap() {
  return (
    <div className="md:col-span-2 lg:col-span-1">
      <h3 className="mb-2 text-sm font-semibold">What the sensor sees</h3>
      <CsiCanvas />
      <div className="mt-1 flex justify-between text-xs text-subtle">
        <span>30 s ago</span>
        <span>52 Wi-Fi frequency bands × time</span>
        <span>now</span>
      </div>
      <p className="mt-2 text-sm text-muted">This is everything Life-Fi gets: how strongly each Wi-Fi frequency arrives. No camera, no microphone, no image.</p>
    </div>
  );
}

