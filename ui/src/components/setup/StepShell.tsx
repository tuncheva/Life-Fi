// One step of the vertical setup stepper: number or tick, title, and the body
// when it is the open step. Done steps stay collapsed with a tick; any step can
// be reopened by its title.
import type { ReactNode } from "react";
import { Icon } from "@/components/ui";
import type { CheckState } from "@/lib/setup";

export function StepShell({
  n,
  id,
  title,
  done,
  open,
  optional,
  summary,
  onOpen,
  children,
}: {
  n: number;
  id: string;
  title: string;
  done: boolean;
  open: boolean;
  optional?: boolean;
  /** One line shown under a collapsed step. */
  summary?: string | null;
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <li id={`step-${id}`} className="relative scroll-mt-28 pb-2 pl-12 last:pb-0">
      {/* the rail between the circles */}
      <span aria-hidden className="absolute bottom-0 left-[1.0625rem] top-10 w-px bg-line" />
      <span
        aria-hidden
        className={`absolute left-0 top-1 flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold ${done ? "bg-ok-soft text-ok-fg" : open ? "bg-fg text-bg" : "border border-line bg-surface text-muted"}`}
      >
        {done ? <Icon name="check" className="h-5 w-5" /> : n}
      </span>
      <h2>
        <button
          type="button"
          onClick={onOpen}
          aria-expanded={open}
          aria-controls={`step-${id}-body`}
          className="flex min-h-11 w-full flex-wrap items-center gap-x-2 rounded-lg py-1 text-left"
        >
          <span className={`text-lg font-semibold ${open ? "" : "text-muted"}`}>{title}</span>
          {optional && <span className="text-sm text-subtle">optional</span>}
          {done && <span className="sr-only">(done)</span>}
        </button>
      </h2>
      {!open && summary && <p className="text-sm text-muted">{summary}</p>}
      {open && (
        <div id={`step-${id}-body`} className="mt-2 rounded-card border border-line bg-surface p-4 shadow-sm sm:p-5">
          {children}
        </div>
      )}
    </li>
  );
}

const CHECK_ICON: Record<CheckState, { cls: string; label: string }> = {
  ok: { cls: "bg-ok-soft text-ok-fg", label: "OK" },
  warn: { cls: "bg-warn-soft text-warn-fg", label: "Warning" },
  fail: { cls: "bg-danger-soft text-danger-fg", label: "Problem" },
  wait: { cls: "bg-surface-2 text-muted", label: "Waiting" },
};

/** One line of a live check list. */
export function CheckRow({ state, label, detail }: { state: CheckState; label: string; detail: string | null }) {
  const icon = CHECK_ICON[state];
  return (
    <li className="flex items-start gap-3 py-1.5">
      <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${icon.cls}`} title={icon.label}>
        {state === "ok" ? <Icon name="check" className="h-4 w-4" /> : state === "wait" ? <Icon name="hourglass" className="h-3.5 w-3.5" /> : <Icon name="alert" className="h-3.5 w-3.5" />}
        <span className="sr-only">{icon.label}:</span>
      </span>
      <div className="min-w-0">
        <span className={`font-medium ${state === "wait" ? "text-muted" : ""}`}>{label}</span>
        {detail && <p className="text-sm text-muted">{detail}</p>}
      </div>
    </li>
  );
}
