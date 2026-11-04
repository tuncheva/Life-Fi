// The last 15 minutes of results as lean trend samples, in server memory only
// (docs/overnight/2026-11-04/plans/M-dashboard-model.md §3, D2): GET /api/v1/recent hands
// them to a page that just opened, so the /model charts start filled instead of empty.
// Nothing is written to disk; a restart forgets it. Cleared on a new boot or source,
// the same rule as the client's ring buffers.
import type { Result } from "@/lib/contracts.gen";
import { TREND_CAPACITY, trendSample, type TrendSample } from "@/lib/model";

export class RecentBuffer {
  private buf: TrendSample[] = [];
  private head = 0;
  boot: number | null = null;
  source: Result["source"] | null = null;
  constructor(readonly capacity = TREND_CAPACITY) {}

  add(r: Result): void {
    if (r.boot_id !== this.boot || r.source !== this.source) this.clear();
    this.boot = r.boot_id;
    this.source = r.source;
    const s = trendSample(r);
    if (this.buf.length < this.capacity) this.buf.push(s);
    else {
      this.buf[this.head] = s;
      this.head = (this.head + 1) % this.capacity;
    }
  }

  /** Samples with t >= `fromMs`, oldest first. */
  since(fromMs: number): TrendSample[] {
    const ordered = this.head === 0 ? this.buf : this.buf.slice(this.head).concat(this.buf.slice(0, this.head));
    let i = ordered.length;
    while (i > 0 && ordered[i - 1]!.t >= fromMs) i--;
    return ordered.slice(i);
  }

  get length(): number {
    return this.buf.length;
  }

  clear(): void {
    this.buf = [];
    this.head = 0;
  }
}

const KEY = Symbol.for("lifefi.recent");

/** One buffer per process, shared by route bundles and dev hot reloads (like getRuntime). */
export function recentBuffer(): RecentBuffer {
  const g = globalThis as { [KEY]?: RecentBuffer };
  return (g[KEY] ??= new RecentBuffer());
}

/** `?minutes=`: a whole number 1..15, 15 when missing; null for anything else. */
export function parseMinutes(q: string | null): number | null {
  if (q === null) return 15;
  if (!/^\d+$/.test(q)) return null;
  const m = Number(q);
  return m >= 1 && m <= 15 ? m : null;
}
