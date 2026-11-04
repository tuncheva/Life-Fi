import { write } from "@/server/http";
import { stopTeach } from "@/server/teach";

export const dynamic = "force-dynamic";

export const POST = write(() => stopTeach());
