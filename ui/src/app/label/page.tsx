"use client";
// Labelling page (plan-v2 §8, §10.1): start a session, press segment and mark
// buttons while people act, everything lands in labels.jsonl with host µs.
// Keyboard: digits start segments, letters add marks, Esc / 0 ends a segment.
import { useCallback, useEffect, useRef, useState } from "react";
import { addMark, endSegment, ensurePin, getLabels, setPin, startRecording, startSegment, stopRecording, type LabelLine } from "@/lib/api";
import { useLive } from "@/lib/live";
import { Card } from "@/components/Cards";
import { Chip } from "@/components/TopBar";

const SEGMENTS: { label: string; key: string }[] = [
  { label: "empty", key: "1" },
  { label: "standing", key: "2" },
  { label: "sitting", key: "3" },
  { label: "lying", key: "4" },
  { label: "walking", key: "5" },
  { label: "normal_activity", key: "6" },
  { label: "in_bed", key: "7" },
  { label: "bed_empty", key: "8" },
  { label: "breath_hold", key: "9" },
];
const MARKS: { event: string; key: string; danger?: boolean }[] = [
  { event: "sit_down", key: "s" },
  { event: "stand_up", key: "t" },
  { event: "lie_down", key: "l" },
  { event: "get_up", key: "g" },
  { event: "fall", key: "f", danger: true },
  { event: "bed_exit", key: "b" },
  { event: "breath_hold_start", key: "h" },
  { event: "breath_hold_end", key: "j" },
];
const inputCls = "mt-1 block w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900";
const btnCls = "rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black";

function fmtUs(us: number): string {
  return new Date(us / 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function LabelPage() {
  const { status } = useLive();
  const rec = status?.recording ?? null;
  const live = status?.source.mode === "live";

  // session form
  const [session, setSession] = useState("");
  const [room, setRoom] = useState("");
  const [distance, setDistance] = useState("4");
  const [height, setHeight] = useState("1.1");
  const [subjects, setSubjects] = useState("P01");
  const [notes, setNotes] = useState("");

  // labelling state
  const [count, setCount] = useState(1);
  const [subject, setSubject] = useState("P01");
  const [spot, setSpot] = useState("A");
  const [paced, setPaced] = useState("15");
  const [labels, setLabels] = useState<LabelLine[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const reloadLabels = useCallback(() => {
    if (!rec) return;
    getLabels(rec.session)
      .then((r) => setLabels(r.labels))
      .catch(() => {});
  }, [rec]);
  useEffect(() => {
    reloadLabels();
  }, [reloadLabels, rec?.labels]);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setMsg(null);
    if (!ensurePin()) return;
    try {
      await fn();
      setFlash(done);
      setTimeout(() => setFlash(null), 900);
    } catch (e) {
      const err = e as { status?: number; message: string };
      if (err.status === 401) setPin("");
      setMsg(err.message);
    }
  };

  const onStart = () =>
    run(
      () =>
        startRecording(session, {
          room,
          placement: { distance_m: Number(distance), height_m: Number(height) },
          subjects: subjects.split(",").map((s) => s.trim()).filter(Boolean),
          notes,
        }),
      `recording ${session}`,
    );
  const onStop = () => run(() => stopRecording(), "stopped");
  const onSegment = (label: string) => run(() => startSegment(label, count, subject, spot), `segment ${label}`);
  const onEnd = () => run(() => endSegment(), "segment ended");
  const onMark = (event: string) => run(() => addMark(event, subject), `mark ${event}`);
  const onHardNegative = () => {
    const what = window.prompt("Hard negative: what happened? (e.g. sit_hard, drop_bag, quick_lie_down)");
    if (what) void onMark(`hard_negative_${what.trim().replace(/\s+/g, "_")}`);
  };

  // keyboard shortcuts while recording, not while typing in a field
  const handlers = useRef({ onSegment, onEnd, onMark, onHardNegative });
  useEffect(() => {
    handlers.current = { onSegment, onEnd, onMark, onHardNegative };
  });
  useEffect(() => {
    if (!rec) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const seg = SEGMENTS.find((s) => s.key === e.key);
      const mark = MARKS.find((m) => m.key === e.key);
      if (seg) void handlers.current.onSegment(seg.label);
      else if (mark) void handlers.current.onMark(mark.event);
      else if (e.key === "0" || e.key === "Escape") void handlers.current.onEnd();
      else if (e.key === "n") handlers.current.onHardNegative();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rec]);

  if (!rec) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Start a labelled session">
          {!live && <p className="mb-2 text-sm text-amber-600">Recording is live only. Switch the source back to live first.</p>}
          <label className="block text-sm">
            Session id
            <input value={session} onChange={(e) => setSession(e.target.value)} placeholder="s03" className={`${inputCls} font-mono`} />
          </label>
          <label className="mt-2 block text-sm">
            Room
            <input value={room} onChange={(e) => setRoom(e.target.value)} placeholder="R2 (bedroom, 4 × 5 m)" className={inputCls} />
          </label>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="text-sm">
              Link distance (m)
              <input type="number" step="0.1" value={distance} onChange={(e) => setDistance(e.target.value)} className={inputCls} />
            </label>
            <label className="text-sm">
              Sensor height (m)
              <input type="number" step="0.1" value={height} onChange={(e) => setHeight(e.target.value)} className={inputCls} />
            </label>
          </div>
          <label className="mt-2 block text-sm">
            Subjects (pseudonyms, comma separated)
            <input value={subjects} onChange={(e) => setSubjects(e.target.value)} placeholder="P01, P03" className={`${inputCls} font-mono`} />
          </label>
          <label className="mt-2 block text-sm">
            Notes
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="router channel 6, door closed" className={inputCls} />
          </label>
          <button onClick={() => void onStart()} disabled={!/^[\w-]+$/.test(session) || !live || !status?.engine.connected} className={`${btnCls} mt-3`}>
            Start recording
          </button>
          {msg && <p className="mt-2 text-sm text-red-600">{msg}</p>}
        </Card>
        <Card title="How a session goes (plan-v2 §10.1)">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-300">
            <li>2 min of empty room at the start (segment <code>empty</code>), 3 min at the end.</li>
            <li>Static states at 2–3 spots, 2–3 min each: standing, sitting, lying.</li>
            <li>Transitions, 20 reps each: press the mark at the moment of the move.</li>
            <li>Walking 5 min, falls onto a thick mat, hard negatives (sit down hard, drop a bag).</li>
            <li>Photograph the placement. Pseudonyms only; the name list stays on paper.</li>
          </ol>
          <p className="mt-3 text-xs text-zinc-400">Marks are snapped to the motion peak within ±1.5 s later, so press as close to the movement as you can and don&apos;t worry about the exact instant.</p>
        </Card>
      </div>
    );
  }

  const elapsed = Math.max(0, Math.floor((now - rec.started_us / 1000) / 1000));
  const open = rec.open_segment;
  const openFor = open ? Math.max(0, Math.floor((now - open.t_start_us / 1000) / 1000)) : 0;

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card title="Session" className="md:col-span-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-2xl font-bold">{rec.session}</span>
          <Chip tone="bad">● recording {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}</Chip>
          <Chip tone="neutral">{rec.labels} labels</Chip>
          {open ? (
            <Chip tone="warn">
              segment {open.label} · {openFor}s · count {open.count}
              {open.subject ? ` · ${open.subject}` : ""}
              {open.spot ? ` · spot ${open.spot}` : ""}
            </Chip>
          ) : (
            <Chip tone="neutral">no open segment</Chip>
          )}
          {flash && <Chip tone="ok">{flash}</Chip>}
          <button onClick={() => void onStop()} className="ml-auto rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white">
            Stop session
          </button>
        </div>
        {msg && <p className="mt-2 text-sm text-red-600">{msg}</p>}
      </Card>

      <Card title="Segments (digits)" className="md:col-span-2">
        <div className="mb-3 flex flex-wrap items-end gap-3 text-sm">
          <label>
            count
            <select value={count} onChange={(e) => setCount(Number(e.target.value))} className={`${inputCls} w-20`}>
              <option value={1}>1</option>
              <option value={2}>2+</option>
            </select>
          </label>
          <label>
            subject
            <input value={subject} onChange={(e) => setSubject(e.target.value)} className={`${inputCls} w-24 font-mono`} />
          </label>
          <label>
            spot
            <input value={spot} onChange={(e) => setSpot(e.target.value)} className={`${inputCls} w-16`} />
          </label>
          <label>
            paced bpm
            <input value={paced} onChange={(e) => setPaced(e.target.value)} className={`${inputCls} w-16`} />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {SEGMENTS.map((s) => (
            <button
              key={s.label}
              onClick={() => void onSegment(s.label)}
              className={`rounded-lg border px-3 py-3 text-left text-sm font-semibold ${open?.label === s.label ? "border-amber-500 bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100" : "border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"}`}
            >
              <kbd className="mr-2 rounded bg-zinc-200 px-1.5 font-mono text-xs text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">{s.key}</kbd>
              {s.label}
            </button>
          ))}
          <button
            onClick={() => void onSegment(`paced_breathing_${paced}`)}
            className="rounded-lg border border-zinc-300 px-3 py-3 text-left text-sm font-semibold hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            paced_breathing_{paced}
          </button>
          <button onClick={() => void onEnd()} disabled={!open} className="rounded-lg border border-zinc-300 px-3 py-3 text-left text-sm font-semibold hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800">
            <kbd className="mr-2 rounded bg-zinc-200 px-1.5 font-mono text-xs text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">0</kbd>
            end segment
          </button>
        </div>
        <p className="mt-2 text-xs text-zinc-400">Starting a segment ends the open one. Segments never overlap.</p>
      </Card>

      <Card title="Marks (letters)">
        <div className="grid grid-cols-2 gap-2">
          {MARKS.map((m) => (
            <button
              key={m.event}
              onClick={() => void onMark(m.event)}
              className={`rounded-lg border px-3 py-3 text-left text-sm font-semibold ${m.danger ? "border-red-400 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30" : "border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"}`}
            >
              <kbd className="mr-2 rounded bg-zinc-200 px-1.5 font-mono text-xs text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">{m.key}</kbd>
              {m.event}
            </button>
          ))}
          <button onClick={onHardNegative} className="col-span-2 rounded-lg border border-zinc-300 px-3 py-3 text-left text-sm font-semibold hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
            <kbd className="mr-2 rounded bg-zinc-200 px-1.5 font-mono text-xs text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">n</kbd>
            hard_negative_…
          </button>
        </div>
      </Card>

      <Card title={`labels.jsonl (${labels.length})`} className="md:col-span-3">
        {labels.length === 0 ? (
          <div className="text-sm text-zinc-500">Nothing yet.</div>
        ) : (
          <ul className="max-h-72 divide-y divide-zinc-200 overflow-y-auto font-mono text-xs dark:divide-zinc-800">
            {[...labels].reverse().map((l, i) => (
              <li key={i} className="flex gap-3 py-1">
                {l.kind === "segment" ? (
                  <>
                    <Chip tone="neutral">segment</Chip>
                    <span>
                      {fmtUs(l.t_start_us)} → {fmtUs(l.t_end_us)} ({Math.round((l.t_end_us - l.t_start_us) / 1e6)} s)
                    </span>
                    <span className="font-semibold">{l.label}</span>
                    <span className="text-zinc-500">
                      count {l.count}
                      {l.subject ? ` · ${l.subject}` : ""}
                      {l.spot ? ` · spot ${l.spot}` : ""}
                    </span>
                  </>
                ) : (
                  <>
                    <Chip tone={l.event === "fall" ? "bad" : "warn"}>mark</Chip>
                    <span>{fmtUs(l.t_press_us)}</span>
                    <span className="font-semibold">{l.event}</span>
                    <span className="text-zinc-500">{l.subject ?? ""}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
