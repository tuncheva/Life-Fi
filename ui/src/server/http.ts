// Helpers shared by the /api/v1 route handlers (contracts/api.md).
import type { AppContext } from "./context";
import { EngineError } from "./engine-client";
import { getRuntime } from "./runtime";

export type Body = Record<string, unknown>;

export function fail(code: number, error: string, message: string): Response {
  return Response.json({ error, message }, { status: code });
}

export function engineFail(err: unknown): Response {
  if (err instanceof EngineError) {
    const code = err.code === "engine_offline" ? 503 : err.code === "timeout" ? 504 : 409;
    return fail(code, err.code === "refused" ? "conflict" : "engine_offline", err.message);
  }
  throw err;
}

/** The JSON body, or {} when there is none or it is not an object. */
export async function readBody(req: Request): Promise<Body> {
  try {
    const b: unknown = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Body) : {};
  } catch {
    return {};
  }
}

export function pinOk(ctx: AppContext, req: Request): boolean {
  return ctx.settings.checkPin(req.headers.get("x-lifefi-pin") ?? undefined);
}

type Handler<P> = (ctx: AppContext, req: Request, params: P) => Promise<Response | unknown> | Response | unknown;

function respond(r: unknown): Response {
  return r instanceof Response ? r : Response.json(r);
}

/** A read: no PIN. Plain objects are sent as JSON. */
export function read<P = Record<string, never>>(fn: Handler<P>) {
  return async (req: Request, route?: { params: Promise<P> }) => respond(await fn(getRuntime(), req, (await route?.params) as P));
}

/** A write: needs the X-Lifefi-Pin header. */
export function write<P = Record<string, never>>(fn: Handler<P>) {
  return async (req: Request, route?: { params: Promise<P> }) => {
    const ctx = getRuntime();
    if (!pinOk(ctx, req)) return fail(401, "pin", "wrong or missing X-Lifefi-Pin header");
    return respond(await fn(ctx, req, (await route?.params) as P));
  };
}
