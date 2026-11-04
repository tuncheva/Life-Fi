import { readBody, write } from "@/server/http";
import { startTraining } from "@/server/teach";

export const dynamic = "force-dynamic";

/** 202: the job runs on; GET /api/v1/spots shows it. */
export const POST = write(async (ctx, req) => startTraining(ctx, await readBody(req)));
