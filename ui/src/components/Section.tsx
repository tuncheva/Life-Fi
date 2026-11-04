"use client";
// One collapsible section (docs/overnight/2026-11-04/plans/M-dashboard-model.md §6): a header
// button with aria-expanded / aria-controls (only while the body exists; the <section> is the
// one named region), open state remembered per browser and section,
// and the body mounted only while open, so closed sections run no chart loops and load no
// three.js. A live one-line `summary` sits in the header so a closed section still says
// something; it is aria-hidden there (a 2 Hz button name would be noisy for screen readers).
// `#<id>` in the address opens the section and scrolls to it. Reads no live context itself.
import { useEffect, useId, useState, type ReactNode } from "react";
import { readSectionOpen, safeStorage, writeSectionOpen } from "@/lib/model";
import { Icon } from "./ui";

export function Section({
  id,
  title,
  subtitle,
  summary,
  defaultOpen = false,
  className = "",
  children,
}: {
  id: string;
  title: ReactNode;
  subtitle?: ReactNode;
  summary?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const uid = useId().replace(/[^a-zA-Z0-9-]/g, "");
  const hId = `${id}-h-${uid}`;
  const bodyId = `${id}-b-${uid}`;

  useEffect(() => {
    const deep = typeof location !== "undefined" && location.hash === `#${id}`;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage and the hash exist only after hydration
    setOpen(deep || readSectionOpen(safeStorage(), id, defaultOpen));
    if (deep) requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
  }, [id, defaultOpen]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    writeSectionOpen(safeStorage(), id, next);
  };

  return (
    <section id={id} aria-labelledby={hId} className={`min-w-0 rounded-card border border-line bg-surface shadow-sm ${className}`}>
      <h2 className="m-0">
        <button
          type="button"
          id={hId}
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          onClick={toggle}
          className="flex min-h-11 w-full items-center gap-3 rounded-card px-4 py-3 text-left sm:px-5"
        >
          <Icon name="chevron" aria-hidden className={`h-4 w-4 shrink-0 text-muted motion-safe:transition-transform ${open ? "rotate-90" : ""}`} />
          <span className="shrink-0 font-semibold">{title}</span>
          {subtitle && <span className="hidden truncate text-sm text-muted sm:inline">{subtitle}</span>}
          {summary && (
            <span aria-hidden="true" className="ml-auto min-w-0 truncate text-right text-sm text-muted tabular-nums">
              {summary}
            </span>
          )}
        </button>
      </h2>
      {open && (
        <div id={bodyId} className="border-t border-line p-4 sm:p-5">
          {children}
        </div>
      )}
    </section>
  );
}
