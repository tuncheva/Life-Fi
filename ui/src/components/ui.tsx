// Small shared building blocks on the design tokens (globals.css). Restyling for
// a new design happens here and in the tokens, not in every page.
import type { ReactNode, SVGProps } from "react";
import type { Tone } from "@/lib/words";

export function Card({ title, children, className = "", actions }: { title?: ReactNode; children: ReactNode; className?: string; actions?: ReactNode }) {
  return (
    <section className={`rounded-card border border-line bg-surface p-4 shadow-sm sm:p-5 ${className}`}>
      {(title || actions) && (
        <div className="mb-3 flex items-center gap-2">
          {title && <h2 className="text-sm font-semibold text-muted">{title}</h2>}
          {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export type PillTone = "ok" | "warn" | "danger" | "neutral" | "present" | "empty" | "uncertain" | "replay";

const PILL: Record<PillTone, string> = {
  ok: "bg-ok-soft text-ok-fg",
  warn: "bg-warn-soft text-warn-fg",
  danger: "bg-danger-soft text-danger-fg",
  neutral: "bg-surface-2 text-muted",
  present: "bg-present-soft text-present-fg",
  empty: "bg-empty-soft text-empty-fg",
  uncertain: "bg-uncertain-soft text-uncertain-fg",
  replay: "bg-replay text-replay-fg",
};

const DOT: Record<PillTone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  neutral: "bg-subtle",
  present: "bg-present",
  empty: "bg-empty",
  uncertain: "bg-uncertain",
  replay: "bg-replay-fg",
};

export function Pill({ children, tone = "neutral", dot = false, title, className = "" }: { children: ReactNode; tone?: PillTone; dot?: boolean; title?: string; className?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${PILL[tone]} ${className}`}>
      {dot && <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${DOT[tone]}`} />}
      {children}
    </span>
  );
}

/** Room tone → token classes, used by the room card, presentation mode and the timeline legend. */
export const TONE_CLASS: Record<Tone, { solid: string; soft: string; text: string; ring: string }> = {
  present: { solid: "bg-present", soft: "bg-present-soft", text: "text-present-fg", ring: "border-t-present" },
  empty: { solid: "bg-empty", soft: "bg-empty-soft", text: "text-empty-fg", ring: "border-t-empty" },
  uncertain: { solid: "bg-uncertain", soft: "bg-uncertain-soft", text: "text-uncertain-fg", ring: "border-t-uncertain" },
  offline: { solid: "bg-offline", soft: "bg-offline-soft", text: "text-offline-fg", ring: "border-t-offline" },
  connecting: { solid: "bg-empty", soft: "bg-surface-2", text: "text-muted", ring: "border-t-line" },
};

export const btn = {
  primary: "inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40",
  secondary: "inline-flex items-center justify-center gap-2 rounded-lg border border-line bg-surface px-4 py-2.5 text-sm font-semibold hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40",
  danger: "inline-flex items-center justify-center gap-2 rounded-lg bg-danger px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40",
  segment: (on: boolean) => `rounded-md px-2.5 py-1 text-xs font-medium ${on ? "bg-fg text-bg" : "text-muted hover:bg-surface-2"}`,
};

export const inputCls = "mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm placeholder:text-subtle";

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex min-w-6 items-center justify-center rounded border border-line bg-surface-2 px-1.5 font-mono text-xs font-semibold text-muted">{children}</kbd>;
}

export function Notice({ tone, children, className = "" }: { tone: "ok" | "warn" | "danger" | "neutral"; children: ReactNode; className?: string }) {
  const cls = { ok: "bg-ok-soft text-ok-fg", warn: "bg-warn-soft text-warn-fg", danger: "bg-danger-soft text-danger-fg", neutral: "bg-surface-2 text-muted" }[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`rounded-lg px-3 py-2 text-sm ${cls} ${className}`}>
      {children}
    </div>
  );
}

// Icons: simple strokes drawn for this project (no icon dependency).
type IconName = "person" | "empty" | "question" | "signal-off" | "alert" | "check" | "bell" | "bell-off" | "chevron" | "wave" | "monitor" | "settings" | "clock" | "bed" | "hourglass";

const PATHS: Record<IconName, ReactNode> = {
  person: (
    <>
      <circle cx="12" cy="6.5" r="3" />
      <path d="M5.5 20.5c.6-4 3.2-6.5 6.5-6.5s5.9 2.5 6.5 6.5" />
    </>
  ),
  empty: (
    <>
      <path d="M4 10.5 12 4l8 6.5V20H4z" />
      <path d="M9.5 20v-5.5h5V20" />
    </>
  ),
  question: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.5v.6" />
      <path d="M12 16.6v.1" />
    </>
  ),
  "signal-off": (
    <>
      <path d="M3 9a13 13 0 0 1 6-3.2M14.5 5.6A13 13 0 0 1 21 9" />
      <path d="M6.5 12.5a8 8 0 0 1 3.2-1.9M14 10.6a8 8 0 0 1 3.5 1.9" />
      <path d="M10 16a3 3 0 0 1 4 0" />
      <path d="M4 4l16 16" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3.5 21.5 20h-19z" />
      <path d="M12 10v4.5" />
      <path d="M12 17.3v.1" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  bell: (
    <>
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </>
  ),
  "bell-off": (
    <>
      <path d="M6 16.5V11a6 6 0 0 1 9.5-4.9M18 11v5.5l1.5 1.5H8" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
      <path d="M4 4l16 16" />
    </>
  ),
  chevron: <path d="m9 5 7 7-7 7" />,
  wave: <path d="M2 12h3l2-5 3 10 3-12 3 12 2-5h4" />,
  monitor: (
    <>
      <rect x="3" y="4.5" width="18" height="12" rx="1.5" />
      <path d="M8.5 20h7M12 16.5V20" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  bed: (
    <>
      <path d="M3 18.5V6M3 14h18v4.5M21 14v-2.5a3 3 0 0 0-3-3h-7V14" />
      <circle cx="7" cy="11" r="1.8" />
    </>
  ),
  hourglass: (
    <>
      <path d="M7 3.5h10M7 20.5h10" />
      <path d="M8 3.5c0 4 8 4.5 8 8.5s-8 4.5-8 8.5M16 3.5c0 4-8 4.5-8 8.5s8 4.5 8 8.5" />
    </>
  ),
};

export function Icon({ name, className = "h-5 w-5", ...rest }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className} {...rest}>
      {PATHS[name]}
    </svg>
  );
}

export const TONE_ICON: Record<Tone, IconName> = { present: "person", empty: "empty", uncertain: "question", offline: "signal-off", connecting: "hourglass" };
