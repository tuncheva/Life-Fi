"use client";
// Source: live sensor or a recorded replay (plan-v2 §4.7 /source, N24 banner).
// Also a minimal record start/stop until the labelling page exists.
import { useEffect, useState } from "react";
import { ensurePin, getRecordings, setSource, startRecording, stopRecording, type RecordingInfo } from "@/lib/api";
import { useLive } from "@/lib/live";
import { Card } from "@/components/Cards";
import { Chip } from "@/components/TopBar";

const SPEEDS = [0.5, 1, 2, 4];

export default function SourcePage() {
  const { status } = useLive();
  const source = status?.source;
  const [recordings, setRecordings] = useState<RecordingInfo[]>([]);
  const [recording, setRecording] = useState<string | null>(null);
  const [labelCounts, setLabelCounts] = useState<Record<string, number>>({});
  const [file, setFile] = useState("");
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(false);
  const [session, setSession] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const reload = () =>
    getRecordings()
      .then((r) => {
        setRecordings(r.recordings);
        setRecording(r.recording?.session ?? null);
        setLabelCounts(Object.fromEntries(r.recordings.map((x) => [x.session, x.labels])));
      })
      .catch(() => {});
  useEffect(() => {
    void reload();
  }, [status?.engine.connected]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    if (!ensurePin()) return;
    try {
      await fn();
      setMsg(ok);
      void reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Current source">
        <div className="flex items-center gap-3">
          <span className="text-3xl font-bold">{source?.mode === "replay" ? "Replay" : "Live"}</span>
          {source && <Chip tone={source.mode === "replay" ? "warn" : "ok"}>{source.mode}</Chip>}
        </div>
        {source?.mode === "replay" && (
          <div className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
            {source.file} · {source.speed}× {source.loop ? "· loop" : ""}
          </div>
        )}
        <p className="mt-3 text-xs text-zinc-400">While a replay runs, the amber banner stays on every page and cannot be dismissed.</p>
        {source?.mode === "replay" && (
          <button
            onClick={() => void run(() => setSource({ mode: "live", file: null, speed: 1, loop: false }), "Back to the live sensor.")}
            className="mt-3 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white dark:bg-zinc-100 dark:text-black"
          >
            Back to live
          </button>
        )}
      </Card>

      <Card title="Start a replay">
        <label className="block text-sm">
          Recording
          <select
            value={file}
            onChange={(e) => setFile(e.target.value)}
            className="mt-1 block w-full rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="">— pick a session or type a path —</option>
            {recordings
              .filter((r) => r.file)
              .map((r) => (
                <option key={r.session} value={r.file!}>
                  {r.session} · {(r.bytes / 1e6).toFixed(1)} MB {r.labels ? `· ${r.labels} labels` : ""}
                </option>
              ))}
          </select>
          <input
            value={file}
            onChange={(e) => setFile(e.target.value)}
            placeholder="data/sessions/s03/s03.csirec"
            className="mt-1 block w-full rounded border border-zinc-300 bg-white px-2 py-1 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <div className="mt-2 flex items-center gap-3 text-sm">
          <label>
            speed{" "}
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="rounded border border-zinc-300 bg-white px-1 py-0.5 dark:border-zinc-700 dark:bg-zinc-900">
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> loop
          </label>
        </div>
        <button
          disabled={!file}
          onClick={() => void run(() => setSource({ mode: "replay", file, speed, loop }), "Replay started.")}
          className="mt-3 rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-black disabled:opacity-40"
        >
          Start replay
        </button>
        <p className="mt-2 text-xs text-zinc-400">The engine then accepts only frames marked as replay. Starting the replay tool itself lands with the recording pipeline.</p>
      </Card>

      <Card title="Record a session (live only)">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <input
            value={session}
            onChange={(e) => setSession(e.target.value)}
            placeholder="session id, e.g. s03"
            disabled={!!recording}
            className="rounded border border-zinc-300 bg-white px-2 py-1 font-mono dark:border-zinc-700 dark:bg-zinc-900"
          />
          {recording ? (
            <button onClick={() => void run(() => stopRecording(), `Stopped ${recording}.`)} className="rounded-lg bg-red-600 px-4 py-2 font-semibold text-white">
              Stop {recording}
            </button>
          ) : (
            <button
              disabled={!/^[\w-]+$/.test(session) || source?.mode !== "live"}
              onClick={() => void run(() => startRecording(session, { started_from: "dashboard" }), `Recording ${session}.`)}
              className="rounded-lg bg-zinc-900 px-4 py-2 font-semibold text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
            >
              Start recording
            </button>
          )}
        </div>
        {recordings.length > 0 && (
          <ul className="mt-3 text-xs text-zinc-500">
            {recordings.map((r) => (
              <li key={r.session}>
                {r.session} · {r.file ? `${(r.bytes / 1e6).toFixed(1)} MB` : "no .csirec"} {labelCounts[r.session] ? `· ${labelCounts[r.session]} labels` : ""}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {msg && (
        <div className="md:col-span-2 text-sm text-zinc-600 dark:text-zinc-300" role="status">
          {msg}
        </div>
      )}
    </div>
  );
}
