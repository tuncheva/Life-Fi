"use client";
// Settings, read-only (track FB): where events are stored and which assistant answers.
// Both are set in ui/.env (see ui/.env.example); keys are never sent to the browser.
import { useEffect, useState } from "react";
import { getAgentStatus, type AgentStatus } from "@/lib/api";
import { Card, Notice, Pill, Skeleton } from "./ui";

export function DataAssistantCard({ className = "" }: { className?: string }) {
  const [s, setS] = useState<AgentStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    getAgentStatus()
      .then(setS)
      .catch(() => setFailed(true));
  }, []);

  return (
    <Card title="Data and assistant" className={className}>
      {failed && <Notice tone="danger">Can&apos;t read the configuration from the Life-Fi box.</Notice>}
      {!s && !failed && (
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2].map((k) => (
            <Skeleton key={k} className="h-5 w-full" />
          ))}
        </div>
      )}
      {s && (
        <>
          <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-muted">Event store</dt>
            <dd className="flex flex-wrap items-center gap-2">
              {s.store === "firestore" ? <Pill tone="ok">Firebase Firestore</Pill> : <Pill tone="warn">Memory only</Pill>}
              {s.firebase?.emulator && <Pill tone="neutral">emulator</Pill>}
            </dd>
            {s.firebase && (
              <>
                <dt className="text-muted">Project</dt>
                <dd className="font-mono text-xs">{s.firebase.project}</dd>
                <dt className="text-muted">Collections</dt>
                <dd className="font-mono text-xs">{["history", "alerts", "alert_log", "events"].map((c) => s.firebase!.prefix + c).join(", ")}</dd>
              </>
            )}
            <dt className="text-muted">Assistant</dt>
            <dd className="flex flex-wrap items-center gap-2">
              {s.configured ? <Pill tone="ok">On</Pill> : <Pill tone="neutral">Off, no API key</Pill>}
              <span>
                {s.provider === "anthropic" ? "Anthropic" : "Google Gemini"} · <span className="font-mono text-xs">{s.model}</span>
              </span>
            </dd>
          </dl>
          {s.store === "memory" && (
            <Notice tone="warn" className="mt-3">
              History, alerts and events are lost when the dashboard restarts. Set FIREBASE_PROJECT_ID and the service-account keys in ui/.env to keep them.
            </Notice>
          )}
          <p className="mt-3 text-xs text-subtle">Set in ui/.env on the Life-Fi box (LLM_PROVIDER, the model and API keys, FIREBASE_*); restart the dashboard after a change. Keys are never shown here.</p>
        </>
      )}
    </Card>
  );
}
