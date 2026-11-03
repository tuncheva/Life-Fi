import { HISTORY_FIELDS, type HistoryField } from "@/server/history";
import { fail, read } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = read((ctx, req) => {
  const q = new URL(req.url).searchParams;
  const to = q.get("to") ? Number(q.get("to")) : Date.now();
  const from = q.get("from") ? Number(q.get("from")) : to - 24 * 3600 * 1000;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return fail(400, "bad_request", "from/to must be ms since epoch");
  let fields: HistoryField[] | undefined;
  const f = q.get("fields");
  if (f) {
    const list = f.split(",").map((s) => s.trim());
    const bad = list.find((x) => !(HISTORY_FIELDS as readonly string[]).includes(x));
    if (bad) return fail(400, "bad_request", `unknown field '${bad}'`);
    fields = list as HistoryField[];
  }
  return { rows: ctx.history.query(from, to, fields) };
});
