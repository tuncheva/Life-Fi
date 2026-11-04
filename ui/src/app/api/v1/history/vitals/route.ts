import type { VitalsHistoryReply } from "@/lib/vitals-history";
import { fail, read } from "@/server/http";
import { parseVitalsQuery, summarize } from "@/server/vitals-history";

export const dynamic = "force-dynamic";

/** Breathing, heart and movement over the last 1, 6 or 24 h, per bucket (track H). */
export const GET = read((ctx, req) => {
  const q = parseVitalsQuery(new URL(req.url).searchParams, Date.now());
  if ("error" in q) return fail(400, "bad_request", q.error);
  const { summary, buckets } = summarize(ctx.history.vitalsRows(q.from, q.to), q.bucketMs);
  const stored = ctx.profiles.profiles[ctx.settings.value.profile]?.breathing.store ?? false;
  const reply: VitalsHistoryReply = { from: q.from, to: q.to, bucket_s: q.bucketMs / 1000, stored, summary, buckets };
  return reply;
});
