import { buildStatus } from "@/server/context";
import { read } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = read((ctx) => buildStatus(ctx, true));
