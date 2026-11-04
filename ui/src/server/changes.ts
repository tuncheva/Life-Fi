// State changes as stored events (track FB): presence, posture and people count. The first
// result sets the baseline. Presence is already debounced by the engine; posture and count must
// hold `holdMs` before they count, so a flickering label does not write an event per result.
import type { Result } from "@/lib/contracts.gen";
import type { StoreEvent } from "./store";

type Kind = "presence" | "posture" | "count";
type Value = string | number | null;
const KINDS: Kind[] = ["presence", "posture", "count"];

export class ChangeTracker {
  private readonly shown: Partial<Record<Kind, Value>> = {};
  private readonly pending: Partial<Record<Kind, { value: Value; since: number }>> = {};
  private baseline = false;

  constructor(private readonly holdMs = 10_000) {}

  /** The events this result completes (usually none). `t` is when the new value began. */
  onResult(r: Pick<Result, "ts" | "presence" | "posture" | "count">): StoreEvent[] {
    const cur: Record<Kind, Value> = { presence: r.presence.state, posture: r.posture?.label ?? null, count: r.count?.value ?? null };
    const out: StoreEvent[] = [];
    for (const kind of KINDS) {
      if (!this.baseline) {
        this.shown[kind] = cur[kind];
        continue;
      }
      if (cur[kind] === this.shown[kind]) {
        delete this.pending[kind];
        continue;
      }
      const p = this.pending[kind];
      if (!p || p.value !== cur[kind]) this.pending[kind] = { value: cur[kind], since: r.ts };
      const q = this.pending[kind]!;
      if (r.ts - q.since >= (kind === "presence" ? 0 : this.holdMs)) {
        out.push({ t: q.since, kind, from: this.shown[kind] ?? null, to: q.value });
        this.shown[kind] = q.value;
        delete this.pending[kind];
      }
    }
    this.baseline = true;
    return out;
  }
}
