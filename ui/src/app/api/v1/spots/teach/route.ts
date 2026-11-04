import { read, readBody, write } from "@/server/http";
import { startTeach, teachState } from "@/server/teach";

export const dynamic = "force-dynamic";

/** Polled every second while a run is active (contracts/api.md, Spots). */
export const GET = read(() => teachState().run?.view() ?? null);

export const POST = write(async (ctx, req) => startTeach(ctx, await readBody(req)));
