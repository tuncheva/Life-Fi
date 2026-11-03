// First-run setup. The wizard reads `?step=` (useSearchParams), so it sits in a
// Suspense boundary: the static shell prerenders, the wizard renders on the client.
import { Suspense } from "react";
import { SetupWizard } from "@/components/setup/SetupWizard";

export default function SetupPage() {
  return (
    <Suspense fallback={<SetupSkeleton />}>
      <SetupWizard />
    </Suspense>
  );
}

function SetupSkeleton() {
  return (
    <div className="mx-auto max-w-2xl" aria-busy="true" aria-label="Loading setup">
      <div className="h-8 w-56 animate-pulse rounded-lg bg-surface-2" />
      <div className="mt-6 space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-12 animate-pulse rounded-card bg-surface-2" />
        ))}
      </div>
    </div>
  );
}
