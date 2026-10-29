"use client";
// Labelling page (plan-v2 §8, §10.1): start a session, press segment and mark
// buttons while people act, everything lands in labels.jsonl with host µs.
// Keyboard: digits start segments, letters add marks, Esc / 0 ends a segment.
// Installers watch the subject, not the screen: big targets, key hints, and a
// large "last press" confirmation (docs/plan/ui-ux.md §4.10).
import { useCallback, useEffect, useRef, useState } from "react";
import { addMark, endSegment, getLabels, startRecording, startSegment, stopRecording, type LabelLine } from "@/lib/api";
import { useLive, useNow } from "@/lib/live";
import { friendlyError, usePin } from "@/lib/pin";
import { clock } from "@/lib/words";
import { Card, Kbd, Notice, Pill, btn, inputCls } from "@/components/ui";

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

const bigBtn = "flex min-h-16 items-center gap-3 rounded-xl border px-4 py-3 text-left text-base font-semibold transition-colors active:scale-[0.98] motion-reduce:active:scale-100";

function fmtUs(us: number): string {
  return clock(us / 1000, true);
}

export default function LabelPage() {
  const { status } = useLive();
  const { withPin } = usePin();
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
  const [last, setLast] = useState<{ text: string; at: number } | null>(null);
  const [hardNeg, setHardNeg] = useState<string | null>(null);
  const now = useNow(500);

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
    try {
      if ((await withPin(fn)) === undefined) return;
      setLast({ text: done, at: Date.now() });
    } catch (e) {
      setMsg(friendlyError(e));
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
      `Recording ${session}`,
    );
  const onStop = () => {
    if (window.confirm(`Stop recording ${rec?.session}? An open segment is ended first.`)) void run(() => stopRecording(), "Stopped");
  };
  const onSegment = (label: string) => run(() => startSegment(label, count, subject, spot), `Segment: ${label}`);
  const onEnd = () => run(() => endSegment(), "Segment ended");
  const onMark = (event: string) => run(() => addMark(event, subject), `Mark: ${event}`);
  const onHardNegative = () => setHardNeg("");
  const submitHardNegative = () => {
    const what = hardNeg?.trim().replace(/\s+/g, "_");
    setHardNeg(null);
    if (what) void onMark(`hard_negative_${what}`);
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
    const validId = /^[\w-]+$/.test(session);
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <h1 className="text-2xl font-bold tracking-tight">Labelling</h1>
          <p className="text-sm text-muted">Record a training session and mark what people do while they do it.</p>
        </div>
        <Card title="Start a labelled session">
          {!live && <Notice tone="warn" className="mb-3">Recording works on the live sensor only. Switch the source back to live first.</Notice>}
          {status && !status.engine.connected && <Notice tone="danger" className="mb-3">The sensor software is not running, so nothing can be recorded.</Notice>}
          <label className="block text-sm font-medium">
            Session id
            <input value={session} onChange={(e) => setSession(e.target.value)} placeholder="s03" className={`${inputCls} font-mono`} />
          </label>
          {session && !validId && <p className="mt-1 text-sm text-danger">Letters, digits, - and _ only.</p>}
          <label className="mt-3 block text-sm font-medium">
            Room
            <input value={room} onChange={(e) => setRoom(e.target.value)} placeholder="R2 (bedroom, 4 × 5 m)" className={inputCls} />
          </label>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="text-sm font-medium">
              Link distance (m)
              <input type="number" step="0.1" value={distance} onChange={(e) => setDistance(e.target.value)} className={inputCls} />
            </label>
            <label className="text-sm font-medium">
              Sensor height (m)
              <input type="number" step="0.1" value={height} onChange={(e) => setHeight(e.target.value)} className={inputCls} />
            </label>
          </div>
          <label className="mt-3 block text-sm font-medium">
            Subjects <span className="font-normal text-subtle">(pseudonyms, comma separated)</span>
            <input value={subjects} onChange={(e) => setSubjects(e.target.value)} placeholder="P01, P03" className={`${inputCls} font-mono`} />
          </label>
          <label className="mt-3 block text-sm font-medium">
            Notes
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="router channel 6, door closed" className={inputCls} />
          </label>
          <button onClick={() => void onStart()} disabled={!validId || !live || !status?.engine.connected} className={`${btn.primary} mt-4 px-6 py-3 text-base`}>
            Start recording
          </button>
          {msg && <Notice tone="danger" className="mt-3">{msg}</Notice>}
        </Card>
        <Card title="How a session goes (plan-v2 §10.1)">
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted">
            <li>2 min of empty room at the start (segment <code>empty</code>), 3 min at the end.</li>
            <li>Static states at 2–3 spots, 2–3 min each: standing, sitting, lying.</li>
            <li>Transitions, 20 reps each: press the mark at the moment of the move.</li>
            <li>Walking 5 min, falls onto a thick mat, hard negatives (sit down hard, drop a bag).</li>
            <li>Photograph the placement. Pseudonyms only; the name list stays on paper.</li>
          </ol>
          <p className="mt-3 text-xs text-subtle">Marks are snapped to the motion peak within ±1.5 s later, so press as close to the movement as you can and don&apos;t worry about the exact instant.</p>
        </Card>
      </div>
    );
  }

  const elapsed = Math.max(0, Math.floor((now - rec.started_us / 1000) / 1000));
  const open = rec.open_segment;
  const openFor = open ? Math.max(0, Math.floor((now - open.t_start_us / 1000) / 1000)) : 0;
  const fresh = last && now - last.at < 2500;

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <section className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-4 shadow-sm md:col-span-3">
        <span className="flex items-center gap-2">
          <span aria-hidden className="h-3 w-3 rounded-full bg-danger motion-safe:animate-pulse" />
          <span className="font-mono text-2xl font-bold">{rec.session}</span>
        </span>
        <Pill tone="danger">
          recording {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
        </Pill>
        <Pill tone="neutral">{rec.labels} labels</Pill>
        <div aria-live="polite" className={`min-w-48 flex-1 rounded-lg px-3 py-2 text-lg font-semibold transition-colors ${fresh ? "bg-ok-soft text-ok-fg" : "bg-surface-2 text-muted"}`}>
          {last ? `${fresh ? "✓ " : "Last: "}${last.text}` : "Press a button or key; it is confirmed here."}
        </div>
        <button onClick={onStop} className={btn.danger}>
          Stop session
        </button>
        {msg && <Notice tone="danger" className="w-full">{msg}</Notice>}
      </section>

      <Card title="Segments: what is going on now (digit keys)" className="md:col-span-2">
        <div className={`mb-4 rounded-lg px-3 py-2 text-sm ${open ? "bg-warn-soft text-warn-fg" : "bg-surface-2 text-muted"}`}>
          {open ? (
            <>
              <span className="font-semibold">Open: {open.label}</span> for {openFor} s · count {open.count === 2 ? "2+" : 1}
              {open.subject ? ` · ${open.subject}` : ""}
              {open.spot ? ` · spot ${open.spot}` : ""}
            </>
          ) : (
            "No open segment. Starting one ends the previous one; segments never overlap."
          )}
        </div>
        <div className="mb-4 flex flex-wrap items-end gap-3 text-sm">
          <label className="font-medium">
            People
            <select value={count} onChange={(e) => setCount(Number(e.target.value))} className={`${inputCls} w-20`}>
              <option value={1}>1</option>
              <option value={2}>2+</option>
            </select>
          </label>
          <label className="font-medium">
            Subject
            <input value={subject} onChange={(e) => setSubject(e.target.value)} className={`${inputCls} w-24 font-mono`} />
          </label>
          <label className="font-medium">
            Spot
            <input value={spot} onChange={(e) => setSpot(e.target.value)} className={`${inputCls} w-16`} />
          </label>
          <label className="font-medium">
            Paced bpm
            <input value={paced} onChange={(e) => setPaced(e.target.value)} className={`${inputCls} w-16`} />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {SEGMENTS.map((s) => (
            <button
              key={s.label}
              onClick={() => void onSegment(s.label)}
              aria-pressed={open?.label === s.label}
              className={`${bigBtn} ${open?.label === s.label ? "border-warn bg-warn-soft text-warn-fg" : "border-line hover:bg-surface-2"}`}
            >
              <Kbd>{s.key}</Kbd>
              {s.label}
            </button>
          ))}
          <button onClick={() => void onSegment(`paced_breathing_${paced}`)} className={`${bigBtn} border-line hover:bg-surface-2`}>
            <Kbd>·</Kbd>
            paced_breathing_{paced}
          </button>
          <button onClick={() => void onEnd()} disabled={!open} className={`${bigBtn} border-line hover:bg-surface-2 disabled:opacity-40`}>
            <Kbd>0</Kbd>
            end segment
          </button>
        </div>
      </Card>

      <Card title="Marks: a moment (letter keys)">
        <div className="grid grid-cols-2 gap-2">
          {MARKS.map((m) => (
            <button key={m.event} onClick={() => void onMark(m.event)} className={`${bigBtn} ${m.danger ? "border-danger text-danger hover:bg-danger-soft" : "border-line hover:bg-surface-2"}`}>
              <Kbd>{m.key}</Kbd>
              <span className="text-sm">{m.event}</span>
            </button>
          ))}
          {hardNeg === null ? (
            <button onClick={onHardNegative} className={`${bigBtn} col-span-2 border-line hover:bg-surface-2`}>
              <Kbd>n</Kbd>
              <span className="text-sm">hard negative…</span>
            </button>
          ) : (
            <form
              className="col-span-2 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                submitHardNegative();
              }}
            >
              <input
                autoFocus
                value={hardNeg}
                onChange={(e) => setHardNeg(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setHardNeg(null)}
                placeholder="what happened? e.g. sit_hard"
                aria-label="Hard negative: what happened"
                className={`${inputCls} mt-0 flex-1`}
              />
              <button type="submit" className={btn.primary}>
                Add
              </button>
            </form>
          )}
        </div>
      </Card>

      <Card title={`labels.jsonl (${labels.length})`} className="md:col-span-3">
        {labels.length === 0 ? (
          <div className="text-sm text-muted">Nothing yet.</div>
        ) : (
          <ul className="max-h-72 divide-y divide-line overflow-y-auto font-mono text-xs">
            {[...labels].reverse().map((l, i) => (
              <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
                {l.kind === "segment" ? (
                  <>
                    <Pill tone="neutral">segment</Pill>
                    <span>
                      {fmtUs(l.t_start_us)} → {fmtUs(l.t_end_us)} ({Math.round((l.t_end_us - l.t_start_us) / 1e6)} s)
                    </span>
                    <span className="font-semibold">{l.label}</span>
                    <span className="text-muted">
                      count {l.count}
                      {l.subject ? ` · ${l.subject}` : ""}
                      {l.spot ? ` · spot ${l.spot}` : ""}
                    </span>
                  </>
                ) : (
                  <>
                    <Pill tone={l.event === "fall" ? "danger" : "warn"}>mark</Pill>
                    <span>{fmtUs(l.t_press_us)}</span>
                    <span className="font-semibold">{l.event}</span>
                    <span className="text-muted">{l.subject ?? ""}</span>
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
