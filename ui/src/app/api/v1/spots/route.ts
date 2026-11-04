import { read } from "@/server/http";
import { spotsOverview } from "@/server/teach";

export const dynamic = "force-dynamic";

export const GET = read((ctx) => spotsOverview(ctx));
