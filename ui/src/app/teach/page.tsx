"use client";
// Teach spots (plan F): record labelled spot sessions with spoken prompts timed by the
// server, then train the spot model on them and install it only when it is not worse.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { friendlyError } from "@/lib/pin";
import type { SpotsOverview } from "@/lib/teach";
import { TeachRunView, TeachSetup } from "@/components/teach/TeachRecord";
import { TeachTrain } from "@/components/teach/TeachTrain";
import { Notice, PageSkeleton } from "@/components/ui";

export default function TeachPage() {
  const [data, setData] = useState<SpotsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api<SpotsOverview>("/spots")
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(friendlyError(e)));
  }, []);

  const active = data?.teach?.state === "running" || data?.training?.state === "running";
  useEffect(() => {
    refresh();
    // every second while a run or training is on, else enough to keep the checks fresh
    const t = setInterval(refresh, active ? 1000 : 3000);
    return () => clearInterval(t);
  }, [refresh, active]);

  if (!data) return error ? <Notice tone="danger">{error}</Notice> : <PageSkeleton title="Teach spots" />;
  const run = data.teach && (data.teach.state === "running" || data.teach.session !== dismissed) ? data.teach : null;

  return (
    <div className="grid gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Teach spots</h1>
        <p className="text-sm text-muted">Record where people usually are, then train. Needs the board live and a fixed transmitter.</p>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {run ? <TeachRunView run={run} refresh={refresh} onDismiss={() => setDismissed(run.session)} /> : <TeachSetup data={data} refresh={refresh} />}
      {data.teach?.state !== "running" && <TeachTrain data={data} refresh={refresh} />}
    </div>
  );
}
