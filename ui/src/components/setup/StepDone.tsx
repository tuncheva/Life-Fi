// Steps 5 (spots, a link card) and 6 (done: summary and the way to the room view).
import Link from "next/link";
import { btn, Icon, Notice } from "@/components/ui";
import { SERVER_EXTRA, STEPS, writeLocalSetup, type SetupResponse, type StepId } from "@/lib/setup";

export function StepSpots({ onNext }: { onNext: () => void }) {
  return (
    <>
      <p className="text-base">
        To have the dashboard say &ldquo;probably at the desk&rdquo;, teach it the spots: a guided recording with spoken prompts, then training, on one page. Record 3 sessions with a fixed transmitter.
      </p>
      <Notice tone="neutral" className="mt-3">
        Experimental. A spot is only shown once the trained model is reliable enough.
      </Notice>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link href="/teach" className={btn.primary}>
          Teach spots
        </Link>
        <Link href="/label" className={btn.secondary}>
          Open Labelling
        </Link>
        <button type="button" onClick={onNext} className={btn.secondary}>
          Skip for now
        </button>
      </div>
    </>
  );
}

export function StepDone({ done, setup }: { done: Set<StepId>; setup: SetupResponse | null }) {
  const extras = (setup?.steps ?? []).filter((s) => s.id && s.id in SERVER_EXTRA && s.done === false);
  return (
    <>
      <ul className="space-y-1">
        {STEPS.filter((s) => s.id !== "done").map((s) => (
          <li key={s.id} className="flex items-center gap-2 text-sm">
            <Icon name={done.has(s.id) ? "check" : "chevron"} className={`h-4 w-4 shrink-0 ${done.has(s.id) ? "text-ok" : "text-subtle"}`} />
            <span className={done.has(s.id) ? "" : "text-muted"}>
              {s.title}
              {!done.has(s.id) && (s.optional ? " (skipped)" : " (not done yet)")}
            </span>
          </li>
        ))}
      </ul>
      {extras.length > 0 && (
        <div className="mt-4">
          <p className="text-sm font-semibold">Still worth doing</p>
          <ul className="mt-1 space-y-1">
            {extras.map((s) => {
              const x = SERVER_EXTRA[s.id as string];
              return (
                <li key={s.id} className="text-sm text-muted">
                  {x.todo}{" "}
                  {x.href && (
                    <Link href={x.href} className="font-medium text-fg underline">
                      Open Settings
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="mt-4">
        <Link href="/" onClick={writeLocalSetup} className={btn.primary}>
          Open the room view
        </Link>
      </div>
    </>
  );
}
