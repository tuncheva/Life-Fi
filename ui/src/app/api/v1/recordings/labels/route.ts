import { fail, read } from "@/server/http";
import { readLabels } from "@/server/recordings";

export const dynamic = "force-dynamic";

export const GET = read((ctx, req) => {
  const s = new URL(req.url).searchParams.get("session") ?? ctx.state.recording?.session;
  if (!s || !/^[\w-]+$/.test(s)) return fail(400, "bad_request", "session is required");
  return { session: s, labels: readLabels(s), open_segment: ctx.state.recording?.session === s ? ctx.state.recording.open_segment : null };
});
