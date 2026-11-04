// Unknown address. Same frame as every page (layout), so alerts stay visible.
import Link from "next/link";
import { btn, Icon } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md py-10 text-center">
      <span aria-hidden className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-muted">
        <Icon name="question" className="h-6 w-6" />
      </span>
      <h1 className="mt-4 text-2xl font-bold tracking-tight">This page does not exist</h1>
      <p className="mt-2 text-muted">The link may be old. Everything Life-Fi shows starts at the room view.</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Link href="/" className={btn.primary}>
          Open the room view
        </Link>
        <Link href="/setup" className={btn.secondary}>
          Set up this room
        </Link>
      </div>
    </div>
  );
}
