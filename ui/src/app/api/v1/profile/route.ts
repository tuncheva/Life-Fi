import type { AppContext } from "@/server/context";
import { fail, read, readBody, write } from "@/server/http";
import { isProfileName } from "@/server/profiles";
import { broadcastStatus } from "@/server/recordings";

export const dynamic = "force-dynamic";

const view = (ctx: AppContext) => ({ active: ctx.settings.value.profile, profiles: ctx.profiles.profiles });

export const GET = read((ctx) => view(ctx));

export const PUT = write(async (ctx, req) => {
  const body = await readBody(req);
  if (!isProfileName(body.active)) return fail(400, "bad_request", "active must be home, school or clinic");
  if (body.active !== ctx.settings.value.profile) {
    ctx.settings.update({ profile: body.active });
    ctx.log.info({ profile: body.active }, "profile changed");
    broadcastStatus(ctx);
  }
  return view(ctx);
});
