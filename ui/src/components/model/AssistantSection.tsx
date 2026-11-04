"use client";
// The assistant (track FB): a summary of the last hours and a chat over the stored events,
// on Insights (compact) and on /assistant (full page with suggested questions). Both show the
// same conversation, kept for this browser tab (sessionStorage). Answers come from the
// configured LLM (Anthropic by default, Gemini as the option).
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { agentChat, agentExplain, agentSummary, getAgentStatus, type AgentStatus, type AgentTurn } from "@/lib/api";
import { friendlyError, usePin } from "@/lib/pin";
import { btn, inputRowCls, Notice } from "../ui";

const KEY = "lifefi.assistant";

export const SUGGESTIONS = [
  "How was the night?",
  "Did anyone get up after midnight?",
  "How has breathing looked today?",
  "Were there any alerts in the last 24 hours, and were they handled?",
  "When was the room last empty?",
];

function readTurns(): AgentTurn[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as AgentTurn[]) : [];
  } catch {
    return [];
  }
}

function writeTurns(t: AgentTurn[]): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(t.slice(-20)));
  } catch {
    /* private mode */
  }
}

export function AssistantBody({ full = false }: { full?: boolean }) {
  const { withPin } = usePin();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [turns, setTurnsState] = useState<AgentTurn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setTurns = (t: AgentTurn[]) => {
    setTurnsState(t);
    writeTurns(t);
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage exists only after hydration
    setTurnsState(readTurns());
    getAgentStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  const ask = async (run: () => Promise<{ text: string }>, shown: AgentTurn[]) => {
    const before = turns;
    setError(null);
    setBusy(true);
    setTurns(shown);
    try {
      const r = await withPin(run);
      // undefined: the PIN prompt was cancelled, so the question was never sent
      setTurns(r ? [...shown, { role: "assistant", text: r.text }] : before);
    } catch (e) {
      setTurns(before);
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const summary = () => ask(() => agentSummary(24), [...turns, { role: "user", text: "Summarize the last 24 hours." }]);
  const askText = (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    const next = [...turns, { role: "user" as const, text: q }];
    // the summary turn is phrased as a question too, so the whole list is valid chat history
    void ask(() => agentChat(next), next);
  };
  const send = (e: FormEvent) => {
    e.preventDefault();
    askText(question);
    setQuestion("");
  };

  if (status && !status.configured)
    return (
      <Notice tone="neutral">
        The assistant is off: set {status.provider === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY"} in ui/.env and restart the dashboard.
      </Notice>
    );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={summary} disabled={busy} className={btn.primary}>
          Summarize the last 24 h
        </button>
        {turns.length > 0 && (
          <button type="button" onClick={() => setTurns([])} disabled={busy} className={btn.secondary}>
            New conversation
          </button>
        )}
        {!full && (
          <Link href="/assistant" className="inline-flex min-h-11 items-center px-2 text-sm font-semibold underline">
            Open the assistant page
          </Link>
        )}
        {status && (
          <span className="text-xs text-subtle">
            {status.provider} · {status.model}
            {status.store === "memory" ? " · history not persisted" : ""}
          </span>
        )}
      </div>
      {full && turns.length === 0 && (
        <div className="flex flex-wrap gap-2" aria-label="Suggested questions">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" onClick={() => askText(s)} disabled={busy} className="min-h-11 rounded-full border border-line px-3 py-1.5 text-sm hover:bg-surface-2 disabled:opacity-40">
              {s}
            </button>
          ))}
        </div>
      )}
      {turns.length > 0 && (
        <ol className={`space-y-2 ${full ? "" : "max-h-96 overflow-y-auto"}`} aria-live="polite">
          {turns.map((t, i) => (
            <li
              key={i}
              className={`rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${t.role === "user" ? "ml-auto w-fit max-w-[85%] bg-surface-2 font-medium" : "max-w-[95%] border border-line"}`}
            >
              {t.text}
            </li>
          ))}
          {busy && <li className="px-3 py-2 text-sm text-muted">Looking at the data…</li>}
        </ol>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      <form onSubmit={send} className="flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about the last hours, e.g. “Did she get up at night?”"
          aria-label="Question for the assistant"
          maxLength={2000}
          className={inputRowCls}
        />
        <button type="submit" disabled={busy || !question.trim()} className={btn.secondary}>
          Ask
        </button>
      </form>
      <p className="text-xs text-subtle">Estimates from Wi-Fi sensing, not medical advice. Only derived readings are sent to the assistant, never names or contact details.</p>
    </div>
  );
}

/** "Explain" on an alert card: the assistant's plain-language reading of what happened. */
export function ExplainAlert({ id }: { id: string }) {
  const { withPin } = usePin();
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await withPin(() => agentExplain(id));
      if (r) setText(r.text);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2">
      {text === null ? (
        <button type="button" onClick={run} disabled={busy} className={btn.secondary}>
          {busy ? "Explaining…" : "Explain this alert"}
        </button>
      ) : (
        <p className="rounded-lg border border-line px-3 py-2 text-sm whitespace-pre-wrap" aria-live="polite">
          {text}
        </p>
      )}
      {error && (
        <Notice tone="danger" className="mt-2">
          {error}
        </Notice>
      )}
    </div>
  );
}
