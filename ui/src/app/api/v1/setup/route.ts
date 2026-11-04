import { setup } from "@/server/health";
import { read } from "@/server/http";

export const dynamic = "force-dynamic";

/** What is left of the first-run setup (engine, board, PIN, calibration, ntfy, LAN). */
export const GET = read((ctx) => Response.json(setup(ctx), { headers: { "Cache-Control": "no-store" } }));
