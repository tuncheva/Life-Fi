"use client";
// /teach "Sessions and training": pick sessions, train (leave-one-session-out), and see the
// honest cross-session score next to chance and the bar the engine needs (plan F, R4).
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { friendlyError, usePin } from "@/lib/pin";
import { pct, verdict, type ModelSummary, type SpotsOverview } from "@/lib/teach";
import { Card, Notice, Pill, btn } from "@/components/ui";

function when(ms: number | null): string {
  return ms === null ? "unknown time" : new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

const TX: Record<string, string> = { fixed: "fixed", phone: "phone hotspot", unknown: "unknown (old)" };

/** Score, chance and bar on one line, then the plain-words verdict (never a score without chance). */
export function ModelScore({ m, title }: { m: ModelSummary; title: string }) {
  const v = verdict(m);
  return (
    <div className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">{title}</p>
        <Pill tone={v.tone === "ok" ? "ok" : v.tone === "danger" ? "danger" : v.tone === "warn" ? "warn" : "neutral"}>{v.title}</Pill>
      </div>
      <p className="mt-2 text-base">
        {m.loso_bal_acc === null ? (
          <>Across sessions: not measured</>
        ) : (
          <>
            Across sessions: <span className="font-semibold tabular-nums">{pct(m.loso_bal_acc)}</span>{" "}
            <span className="text-muted">
              (chance {pct(m.chance)}, needs {pct(m.bar)} to be used)
            </span>
          </>
        )}
      </p>
      {m.loso_by_session && m.sessions.length === m.loso_by_session.length && (
        <ul className="mt-1 text-sm text-muted">
          {m.loso_by_session.map((v2, i) => (
            <li key={m.sessions[i]}>
              Tested on {m.sessions[i]} (left out of training): <span className="tabular-nums">{pct(v2)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-sm">
        {v.text}
        {v.transmitterLink && (
          <>
            {" "}
            <Link href="/setup?step=transmitter" className="font-semibold underline">
              Set up a fixed transmitter
            </Link>
          </>
        )}
      </p>
      <details className="mt-2 text-sm text-muted">
        <summary className="cursor-pointer">Details</summary>
        <p className="mt-1">Spots: {m.labels.join(", ")}</p>
        <p>Trained {when(m.trained_at)} on {m.sessions.length} session(s).</p>
        {m.holdout_accuracy !== null && <p>Within the training split: {pct(m.holdout_accuracy)} (chosen on the same split, optimistic).</p>}
      </details>
    </div>
  );
}

export function TeachTrain({ data, refresh }: { data: SpotsOverview; refresh: () => void }) {
  const { withPin } = usePin();
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const training = data.training;
  const busy = training?.state === "running";
  const teaching = data.teach?.state === "running";

  // default: usable sessions recorded with a fixed transmitter
  const chosen = picked ?? new Set(data.sessions.filter((s) => s.ok && s.transmitter === "fixed").map((s) => s.id));
  const fixedCount = data.sessions.filter((s) => s.ok && s.transmitter === "fixed").length;
  const phoneChosen = data.sessions.some((s) => chosen.has(s.id) && s.transmitter !== "fixed");

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  const run = async (path: string, body: unknown) => {
    setError(null);
    try {
      await withPin(() => api(path, { method: "POST", body: JSON.stringify(body), pin: true }));
    } catch (e) {
      setError(friendlyError(e));
    }
    refresh();
  };

  return (
    <Card title="Sessions and training">
      {data.sessions.length === 0 ? (
        <p className="text-sm text-muted">No spot sessions yet. Record one above.</p>
      ) : (
        <ul className="divide-y divide-line">
          {data.sessions.map((s) => (
            <li key={s.id} className="flex items-start gap-3 py-2">
              <input
                type="checkbox"
                className="mt-1 h-5 w-5 shrink-0"
                aria-label={`Use session ${s.id}`}
                disabled={!s.ok || busy}
                checked={s.ok && chosen.has(s.id)}
                onChange={() => toggle(s.id)}
              />
              <div className="min-w-0 text-sm">
                <p className="font-medium">{when(s.started_ms)}</p>
                <p className="break-words text-muted">
                  {s.id} · transmitter {TX[s.transmitter]}
                  {s.duration_s !== null && ` · ${Math.round(s.duration_s / 60)} min`}
                  {s.rate_hz !== null && ` · ${Math.round(s.rate_hz)} readings/s`}
                </p>
                {s.problem && <p className="text-danger">{s.problem}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-sm text-muted">
        {fixedCount} of 3 recommended sessions with the fixed transmitter.
        {fixedCount < 3 && " Record another one later (a different time of day) for a fairer score."}
      </p>
      {phoneChosen && (
        <Notice tone="warn" className="mt-2">
          Includes phone-hotspot sessions: their signal moves between visits.
        </Notice>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className={btn.primary} disabled={chosen.size < 2 || busy || teaching} onClick={() => run("/spots/train", { sessions: [...chosen] })}>
          {busy ? `Training… ${Math.max(0, Math.round((now - training!.started_ms) / 1000))} s` : "Train"}
        </button>
        {chosen.size < 2 && <span className="text-sm text-muted">Training needs at least 2 sessions: the score is measured on a session the model never saw.</span>}
      </div>
      {error && (
        <Notice tone="danger" className="mt-3">
          {error}
        </Notice>
      )}

      {training?.state === "failed" && (
        <Notice tone="danger" className="mt-3">
          Training failed: <span className="whitespace-pre-wrap font-mono text-xs">{training.error}</span>
        </Notice>
      )}
      {training?.state === "done" && training.result && (
        <div className="mt-4 space-y-2">
          {training.result.candidate && <ModelScore m={training.result.candidate} title="New model" />}
          <Notice tone={training.result.promoted ? "ok" : "neutral"}>
            {training.result.promoted
              ? `Installed. The previous model is kept as a backup. ${training.result.engine_reloaded ? "The engine is using it now." : "The engine will load it on its next start."}`
              : `${training.result.reason[0].toUpperCase()}${training.result.reason.slice(1)}.`}
          </Notice>
        </div>
      )}

      <div className="mt-4 space-y-2">
        {data.model ? <ModelScore m={data.model} title="Current model" /> : <p className="text-sm text-muted">No spot model installed.</p>}
        {data.previous && (
          <button type="button" className={btn.secondary} disabled={busy} onClick={() => run("/spots/restore", {})}>
            Restore previous model
          </button>
        )}
      </div>
    </Card>
  );
}
