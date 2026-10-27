"use client";
// Home page tiles: state, motion, breathing (bpm + wave), device health.
import { useEffect, useRef } from "react";
import { useLive } from "@/lib/live";
import { Chip } from "./TopBar";

export function Card({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 ${className}`}>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h2>
      {children}
    </section>
  );
}

function since(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function StateCard() {
  const { result, status } = useLive();
  const assumption = status?.server.profile === "school" ? "multiple people normal" : status?.server.profile === "clinic" ? "single patient" : "single occupant";
  if (!result) return <Card title="State">—</Card>;
  const p = result.presence;
  const label = p.state === "present" ? "Present" : p.state === "empty" ? "Empty" : "Uncertain";
  const tone = p.state === "present" ? "ok" : p.state === "empty" ? "neutral" : "warn";
  return (
    <Card title="State">
      <div className="flex items-baseline gap-3">
        <span className="text-3xl font-bold">{label}</span>
        <Chip tone={tone}>{p.state}</Chip>
      </div>
      <div className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
        {result.posture ? (
          <>
            {result.posture.label} · since {since(result.posture.since)}
            <span className="ml-1 text-xs text-zinc-400">(last known, {result.posture.src})</span>
          </>
        ) : (
          <span className="text-zinc-400">no posture</span>
        )}
      </div>
      <div className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
        {result.count ? (
          <>
            people: {result.count.value === 2 ? "several" : "1"} <span className="text-xs text-zinc-400">(p {result.count.p.map((x) => x.toFixed(2)).join(" / ")})</span>
          </>
        ) : (
          <span className="text-zinc-400">count model not loaded</span>
        )}
      </div>
      <div className="mt-3 text-xs text-zinc-400">Assumes {assumption}. Assistive notification, not a medical device.</div>
    </Card>
  );
}

export function MotionCard() {
  const { result } = useLive();
  const m = result?.motion ?? 0;
  const pct = Math.round(Math.min(1, m) * 100);
  return (
    <Card title="Motion">
      <div className="text-3xl font-bold tabular-nums">{m.toFixed(2)}</div>
      <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div className={`h-full transition-[width] duration-300 ${pct > 60 ? "bg-red-500" : pct > 20 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${pct}%` }} />
      </div>
      {result && (
        <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-zinc-500">
          <span>S {result.presence.S.toFixed(2)}</span>
          <span>B {result.presence.B.toFixed(2)}</span>
          <span>M {result.presence.M.toFixed(2)}</span>
        </div>
      )}
    </Card>
  );
}

export function BreathingCard() {
  const { result, status, buffers } = useLive();
  const canvas = useRef<HTMLCanvasElement>(null);
  const show = status?.server.profile !== "school";

  useEffect(() => {
    if (!show) return;
    let raf = 0;
    let drawn = -1;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = canvas.current;
      if (!c || drawn === buffers.version) return;
      drawn = buffers.version;
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (c.width !== w * dpr || c.height !== h * dpr) {
        c.width = w * dpr;
        c.height = h * dpr;
      }
      const g = c.getContext("2d")!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const data = buffers.wave.toArray();
      const n = buffers.wave.capacity;
      g.strokeStyle = "#a1a1aa";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, h / 2);
      g.lineTo(w, h / 2);
      g.stroke();
      if (data.length < 2) return;
      g.strokeStyle = "#0ea5e9";
      g.lineWidth = 2;
      g.beginPath();
      const offset = n - data.length;
      data.forEach((v, i) => {
        const x = ((offset + i) / (n - 1)) * w;
        const y = h / 2 - Math.max(-1, Math.min(1, v / 0.3)) * (h / 2 - 4);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.stroke();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [buffers, show]);

  if (!show) {
    return (
      <Card title="Breathing">
        <div className="text-sm text-zinc-500">Not shown or stored in the School profile.</div>
      </Card>
    );
  }
  const b = result?.breathing;
  return (
    <Card title="Breathing">
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-bold tabular-nums">{b?.valid && b.bpm !== null ? b.bpm.toFixed(0) : "—"}</span>
        <span className="text-sm text-zinc-500">bpm</span>
        {b && (
          <Chip tone={b.valid ? "ok" : "neutral"}>
            {b.valid ? `confidence ${(b.confidence * 100).toFixed(0)} %` : "no valid reading"}
          </Chip>
        )}
      </div>
      <canvas ref={canvas} className="mt-2 h-24 w-full" aria-label="breathing waveform, last 30 seconds" />
    </Card>
  );
}

export function HealthCard() {
  const { result, status } = useLive();
  const d = status?.device ?? null;
  const h = result?.health;
  const rows: [string, string, "ok" | "warn" | "bad" | "neutral"][] = [
    ["engine", status?.engine.connected ? "connected" : "disconnected", status?.engine.connected ? "ok" : "bad"],
    ["CSI rate", h ? `${h.rate_hz.toFixed(0)} Hz` : "—", !h ? "neutral" : h.rate_hz >= 80 ? "ok" : h.rate_hz >= 50 ? "warn" : "bad"],
    ["loss", h ? `${(h.loss_udp * 100).toFixed(1)} % udp · ${(h.loss_air * 100).toFixed(1)} % air` : "—", !h ? "neutral" : h.loss_udp < 0.05 ? "ok" : "warn"],
    ["RSSI", d ? `${d.rssi_dbm} dBm` : "—", !d ? "neutral" : d.rssi_dbm > -65 ? "ok" : d.rssi_dbm > -75 ? "warn" : "bad"],
    ["device uptime", d ? fmtUptime(d.uptime_s) : "—", "neutral"],
    ["source", result?.source ?? status?.source.mode ?? "—", result?.source === "replay" ? "warn" : "neutral"],
    ["config", result ? `${result.config_hash} · pipeline v${result.pipeline_version}` : "—", "neutral"],
  ];
  if (status?.server.sensor_offline) rows.unshift(["watchdog", status.server.sensor_offline, "bad"]);
  return (
    <Card title="Device health">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        {rows.map(([k, v, tone]) => (
          <div key={k} className="contents">
            <dt className="text-zinc-500">{k}</dt>
            <dd>
              <Chip tone={tone}>{v}</Chip>
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function fmtUptime(s: number): string {
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} d`;
}

export function CsiHeatmap() {
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
      const W = 52;
      const H = buffers.csi.capacity;
      if (c.width !== W || c.height !== H) {
        c.width = W;
        c.height = H;
      }
      const g = c.getContext("2d")!;
      const img = g.createImageData(W, H);
      // map dB to colour around the per-frame median, ±4 dB
      for (let y = 0; y < H; y++) {
        const row = rows[y - (H - rows.length)];
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          if (!row) {
            img.data[i + 3] = 0;
            continue;
          }
          const v = row[x] ?? -42;
          const t = Math.max(0, Math.min(1, (v + 46) / 8));
          img.data[i] = Math.round(20 + 235 * t);
          img.data[i + 1] = Math.round(60 + 120 * (1 - Math.abs(t - 0.5) * 2));
          img.data[i + 2] = Math.round(240 - 220 * t);
          img.data[i + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [buffers]);
  return (
    <Card title="Raw signal (CSI amplitude, 52 subcarriers × last 30 s)">
      <canvas ref={canvas} className="h-40 w-full rounded bg-zinc-100 [image-rendering:pixelated] dark:bg-zinc-800" aria-label="CSI heatmap" />
      <p className="mt-2 text-xs text-zinc-400">This is everything the sensor sees: no camera, no microphone, no image.</p>
    </Card>
  );
}
