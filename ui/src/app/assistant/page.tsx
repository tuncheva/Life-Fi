"use client";
// The assistant on its own page (track FB): the same conversation as the Insights section,
// with more room and suggested questions. Past answers are listed on /events.
import Link from "next/link";
import { AssistantBody } from "@/components/model/AssistantSection";
import { PageHeader } from "@/components/ui";

export default function AssistantPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Assistant"
        description={
          <>
            Ask about the last hours in plain language. It reads the stored readings, changes and alerts; past answers are kept under{" "}
            <Link href="/events" className="font-semibold underline">
              Events
            </Link>
            .
          </>
        }
      />
      <div className="rounded-card border border-line bg-surface p-4 shadow-sm">
        <AssistantBody full />
      </div>
    </div>
  );
}
