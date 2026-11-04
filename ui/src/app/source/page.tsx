"use client";
// Source: live sensor or a recorded replay (plan-v2 §4.7 /source, N24 banner).
// Also a minimal record start/stop; the full labelling flow is on /label.
import { useEffect, useState } from "react";
import Link from "next/link";
import { getRecordings, setSource, startRecording, stopRecording, type RecordingInfo } from "@/lib/api";
import { useLiveSlow } from "@/lib/live";
import { friendlyError, usePin } from "@/lib/pin";
import { Card, Field, Notice, PageHeader, PageSkeleton, Pill, btn, checkLabelCls, inputCls, inputRowCls } from "@/components/ui";

const SPEEDS = [0.5, 1, 2, 4];

type Where = "live" | "play" | "record";

export default function SourcePage() {
  const { status } = useLiveSlow();
  const { withPin } = usePin();
  const source = status?.source;
  const [recordings, setRecordings] = useState<RecordingInfo[]>([]);
  const [recording, setRecording] = useState<string | null>(null);
  const [file, setFile] = useState("");
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(false);
  const [session, setSession] = useState("");
  // Each card shows the result of its own action, right under it.
  const [msg, setMsg] = useState<{ text: string; ok: boolean; where: Where } | null>(null);
  const [listFailed, setListFailed] = useState<string | null>(null);

  const reload = () =>
    getRecordings()
      .then((r) => {
        setRecordings(r.recordings);
        setRecording(r.recording?.session ?? null);
        setListFailed(null);
      })
      .catch((e) => setListFailed(friendlyError(e)));
  useEffect(() => {
    void reload();
  }, [status?.engine.connected]);

  const run = async (where: Where, fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      if ((await withPin(fn)) === undefined) return;
      setMsg({ text: ok, ok: true, where });
      void reload();
    } catch (e) {
      setMsg({ text: friendlyError(e), ok: false, where });
    }
  };
  const note = (where: Where) =>
    msg?.where === where && (
      <Notice tone={msg.ok ? "ok" : "danger"} className="mt-3">
        {msg.text}
      </Notice>
    );

  const replay = source?.mode === "replay";
  const files = recordings.filter((r) => r.file);

  if (!status) return <PageSkeleton title="Source & replay" />;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <PageHeader
        className="mb-0! md:col-span-2"
        title="Source & replay"
        description="Show the live sensor, or play back a recording (for rehearsals, or as the demo fallback). A replay is always marked on every page."
      />

      <Card title="Showing now">
        <div className="flex items-center gap-3">
          <span className="text-3xl font-bold">{replay ? "A recording" : "The live room"}</span>
          {source && (
            <Pill tone={replay ? "replay" : "ok"} dot>
              {replay ? "Replay" : "Live"}
            </Pill>
          )}
        </div>
        {replay && (
          <p className="mt-2 font-mono text-sm text-muted">
            {source?.file} · {source?.speed}×{source?.loop ? " · loop" : ""}
            {source?.state === "stopped" ? " · finished" : ""}
          </p>
        )}
        {source?.state === "error" && (
          <p className="mt-2 text-sm font-medium text-danger" role="alert">
            Can&apos;t read the sensor board: {source.error ?? "unknown error"}. The engine keeps trying; check the USB cable.
          </p>
        )}
        <p className="mt-3 text-sm text-muted">While a replay runs, the purple banner stays on every page and cannot be closed, so nobody mistakes it for the live room.</p>
        {replay && (
          <button onClick={() => void run("live", () => setSource({ mode: "live", file: null, speed: 1, loop: false }), "Back to the live sensor.")} className={`${btn.primary} mt-3`}>
            Back to live
          </button>
        )}
        {note("live")}
      </Card>

      <Card title="Play a recording">
        {files.length > 0 ? (
          <Field label="Recording">
            <select value={file} onChange={(e) => setFile(e.target.value)} className={inputCls}>
              <option value="">Choose a session…</option>
              {files.map((r) => (
                <option key={r.session} value={r.file!}>
                  {r.session} · {(r.bytes / 1e6).toFixed(1)} MB{r.labels ? ` · ${r.labels} labels` : ""}
                </option>
              ))}
            </select>
          </Field>
        ) : listFailed ? (
          <Notice tone="danger">Can&apos;t list the recordings: {listFailed}</Notice>
        ) : (
          <p className="text-sm text-muted">No recordings found yet.</p>
        )}
        <details open={files.length === 0} className="mt-2">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm">Type a path instead</summary>
          <input value={file} onChange={(e) => setFile(e.target.value)} placeholder="data/sessions/s03/s03.csirec" className={`${inputRowCls} font-mono text-xs`} aria-label="Recording path" />
        </details>
        <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
          <div className="flex items-center gap-1" role="radiogroup" aria-label="Speed">
            <span className="mr-1 text-muted">Speed</span>
            {SPEEDS.map((s) => (
              <button key={s} role="radio" aria-checked={speed === s} onClick={() => setSpeed(s)} className={btn.segment(speed === s)}>
                {s}×
              </button>
            ))}
          </div>
          <label className={checkLabelCls}>
            <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} className="h-5 w-5 accent-[var(--primary)]" /> Loop
          </label>
        </div>
        <button disabled={!file} onClick={() => void run("play", () => setSource({ mode: "replay", file, speed, loop }), "Replay started.")} className={`${btn.primary} mt-4`}>
          Start replay
        </button>
        <p className="mt-2 text-xs text-muted">The engine then accepts only frames marked as replay.</p>
        {note("play")}
      </Card>

      <Card title="Quick recording (live only)" className="md:col-span-2">
        <p className="mb-3 text-sm text-muted">
          For labelled training sessions use{" "}
          <Link href="/label" className="font-medium text-link hover:underline">
            Labelling
          </Link>
          . This just records raw data.
        </p>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <input value={session} onChange={(e) => setSession(e.target.value)} placeholder="session id, e.g. s03" disabled={!!recording} className={`${inputRowCls} w-48 font-mono`} aria-label="Session id" />
          {recording ? (
            <button onClick={() => void run("record", () => stopRecording(), `Stopped ${recording}.`)} className={btn.danger}>
              Stop {recording}
            </button>
          ) : (
            <button disabled={!/^[\w-]+$/.test(session) || !source || replay} onClick={() => void run("record", () => startRecording(session, { started_from: "dashboard" }), `Recording ${session}.`)} className={btn.primary}>
              Start recording
            </button>
          )}
          {replay && <span className="text-muted">Switch back to live to record.</span>}
          {session && !/^[\w-]+$/.test(session) && <span className="text-danger">Letters, digits, - and _ only.</span>}
        </div>
        {recordings.length > 0 && (
          <ul className="mt-3 grid gap-1 text-xs text-muted sm:grid-cols-2">
            {recordings.map((r) => (
              <li key={r.session} className="font-mono">
                {r.session} · {r.file ? `${(r.bytes / 1e6).toFixed(1)} MB` : "no .csirec"}
                {r.labels ? ` · ${r.labels} labels` : ""}
              </li>
            ))}
          </ul>
        )}
        {note("record")}
      </Card>
    </div>
  );
}
