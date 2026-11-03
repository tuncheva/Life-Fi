"use client"; // error boundaries are Client Components (Next 16 file convention)
// Shown in place of a page that crashed while rendering. The header, alerts and
// replay banner (layout) stay, so a broken page never hides an open alert.
import { useEffect } from "react";
import Link from "next/link";
import { btn, Icon } from "@/components/ui";

export default function PageError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const digest = error instanceof Error && "digest" in error ? String((error as Error & { digest?: string }).digest ?? "") : "";
  return (
    <div className="mx-auto max-w-md py-10 text-center">
      <span aria-hidden className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-warn-soft text-warn-fg">
        <Icon name="alert" className="h-6 w-6" />
      </span>
      <h1 className="mt-4 text-2xl font-bold tracking-tight">Something went wrong on this page</h1>
      <p className="mt-2 text-muted">The sensor and the alerts keep running. Try again, or go back to the room view.</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <button type="button" onClick={() => retry()} className={btn.primary}>
          Try again
        </button>
        <Link href="/" className={btn.secondary}>
          Open the room view
        </Link>
      </div>
      {digest && <p className="mt-4 font-mono text-xs text-subtle">Error {digest}</p>}
    </div>
  );
}
