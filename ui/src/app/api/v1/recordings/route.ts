import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { read } from "@/server/http";
import { labelsPath, MARK_EVENTS, readLabels, SEGMENT_LABELS, sessionsDir } from "@/server/recordings";

export const dynamic = "force-dynamic";

/** Recorded sessions under data/sessions/<id>/, for the replay picker and the labelling page. */
export const GET = read((ctx) => {
  const dir = sessionsDir();
  const recordings = !existsSync(dir)
    ? []
    : readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          const file = join(dir, d.name, `${d.name}.csirec`);
          const has = existsSync(file);
          return { session: d.name, file: has ? file : null, bytes: has ? statSync(file).size : 0, labels: existsSync(labelsPath(d.name)) ? readLabels(d.name).length : 0 };
        })
        .sort((a, b) => a.session.localeCompare(b.session));
  return { recordings, recording: ctx.state.recording, vocabulary: { segments: SEGMENT_LABELS, marks: MARK_EVENTS } };
});
