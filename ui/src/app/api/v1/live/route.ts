// Live stream (contracts/api.md): Server-Sent Events, one JSON message per event —
// `status` on connect and on changes, every engine `result`, and `alert` transitions.
import { buildStatus } from "@/server/context";
import { read } from "@/server/http";

export const dynamic = "force-dynamic";

// read() only guards building the Response (config error, crash → error JSON); the stream itself runs on.
export const GET = read((ctx) => {
  const hello: unknown[] = [{ type: "status", status: buildStatus(ctx, false) }];
  if (ctx.state.latest) hello.push(ctx.state.latest);
  return new Response(ctx.hub.stream(hello), {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});
