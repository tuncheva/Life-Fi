import { read } from "@/server/http";
import { readPositionFiles } from "@/server/position-files";

export const dynamic = "force-dynamic";

/** The saved distance fit and the spot model summary (either may be null). */
export const GET = read(() => Response.json(readPositionFiles(), { headers: { "Cache-Control": "no-store" } }));
