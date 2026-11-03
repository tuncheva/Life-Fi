import { write } from "@/server/http";
import { restoreModel } from "@/server/teach";

export const dynamic = "force-dynamic";

export const POST = write((ctx) => restoreModel(ctx));
