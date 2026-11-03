// Helpers shared by the /api/v1 route handlers (contracts/api.md).
import { ConfigError } from "./config";
import type { AppContext } from "./context";
import { EngineError } from "./engine-client";
import { getRuntime } from "./runtime";

export type Body = Record<string, unknown>;

/** Larger write bodies are refused (413); every real request is a few hundred bytes. */
const MAX_BODY = 64 * 1024;

export function fail(code: number, error: string, message: string, headers?: HeadersInit): Response {
  return Response.json({ error, message }, { status: code, headers });
}

export function engineFail(err: unknown): Response {
  if (err instanceof EngineError) {
    const code = err.code === "engine_offline" ? 503 : err.code === "timeout" ? 504 : 409;
    return fail(code, err.code === "refused" ? "conflict" : "engine_offline", err.message);
  }
  throw err;
}

class BadBody extends Error {}
class TooLarge extends Error {}

/** The body as text, read with a byte cap: a chunked request has no Content-Length to check first. */
async function readText(req: Request): Promise<string> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) {
      await reader.cancel().catch(() => {});
      throw new TooLarge("body too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The JSON body, or {} when there is none or it is not an object. A body that is not JSON
 * is a 400, one over 64 KB a 413 (thrown here, answered by read()/write()).
 */
export async function readBody(req: Request): Promise<Body> {
  const text = await readText(req);
  if (!text.trim()) return {};
  let b: unknown;
  try {
    b = JSON.parse(text);
  } catch {
    throw new BadBody("body is not valid JSON");
  }
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Body) : {};
}

/** A finite number in [min, max], else null. */
export function inRange(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;
}

// ---- wrong-PIN limiter ------------------------------------------------------------------

/**
 * One global bucket (a route handler gets a plain Request: no client IP, and Next fills
 * x-forwarded-for only when the client did not send one, so it is not trusted). 5 wrong PINs
 * within 60 s lock writes for 60 s; each further lockout doubles it (cap 1 h). A right PIN
 * outside a lockout resets everything, and so does an hour with no wrong PIN after a lockout.
 *
 * A global bucket lets anyone on the LAN keep everyone locked out, and a fall alert must
 * stay acknowledgeable. Letting a right PIN through a lockout from anyone would make the
 * lockout an oracle (wrong = 429, right = 200: 10 000 guesses in seconds), and any shared
 * budget of PIN checks (a serialised delay) can be filled by the attacker's requests before
 * the caregiver's. So a lockout is skipped only for a *trusted* request: the right PIN plus
 * the lifefi_trust cookie, which a browser gets with its first accepted PIN (an HMAC of
 * the PIN under a random per-install key, 256 bits, not guessable). The attacker never
 * holds one, so they still get 429 whatever they send and can try at most 5 PINs per lockout.
 * Left open: a browser that never gave the right PIN cannot get in during a lockout; the
 * phone's one-time ack token still acknowledges alerts.
 */
export class PinLimiter {
  private fails: number[] = [];
  private lockedUntil = 0;
  private lockouts = 0;
  private lastFail = 0;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly maxFails = 5,
    private readonly windowMs = 60_000,
    private readonly baseLockMs = 60_000,
    private readonly maxLockMs = 3600_000,
    private readonly quietMs = 3600_000,
  ) {}

  /** Seconds left in a lockout, or 0. */
  retryAfter(): number {
    const left = this.lockedUntil - this.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  /**
   * Records one PIN check. While a lockout runs the answer is "locked" whatever the PIN,
   * unless the request is trusted (see above) and the PIN is right.
   */
  check(ok: () => boolean, trusted = false): "ok" | "wrong" | "locked" {
    if (this.retryAfter() > 0) return trusted && ok() ? "ok" : "locked";
    const t = this.now();
    if (this.lockouts > 0 && t - Math.max(this.lastFail, this.lockedUntil) > this.quietMs) this.lockouts = 0;
    if (ok()) {
      this.fails = [];
      this.lockouts = 0;
      return "ok";
    }
    this.fails = this.fails.filter((x) => t - x < this.windowMs);
    this.fails.push(t);
    this.lastFail = t;
    if (this.fails.length >= this.maxFails) {
      this.lockedUntil = t + Math.min(this.baseLockMs * 2 ** this.lockouts, this.maxLockMs);
      this.lockouts++;
      this.fails = [];
    }
    return "wrong";
  }
}

const LIMITER = Symbol.for("lifefi.pinLimiter");
const limiter = ((globalThis as { [LIMITER]?: PinLimiter })[LIMITER] ??= new PinLimiter());

export function pinOk(ctx: AppContext, req: Request): boolean {
  return ctx.settings.checkPin(req.headers.get("x-lifefi-pin") ?? undefined);
}

const TRUST_COOKIE = "lifefi_trust";

function trustCookie(req: Request): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === TRUST_COOKIE) return part.slice(i + 1).trim();
  }
  return undefined;
}

/**
 * Gives a request whose PIN was accepted the trust cookie (PinLimiter), unless it already
 * holds the current one. Call it after the handler ran, so a PIN change hands out the new one.
 */
export function withTrust(ctx: AppContext, req: Request, res: Response): Response {
  const token = ctx.settings.trustToken();
  if (trustCookie(req) === token) return res;
  const cookie = `${TRUST_COOKIE}=${token}; Path=/api/v1; Max-Age=31536000; HttpOnly; SameSite=Strict`;
  try {
    res.headers.append("set-cookie", cookie);
    return res;
  } catch {
    // immutable headers (a Response passed through from fetch): copy it
    const copy = new Response(res.body, res);
    copy.headers.append("set-cookie", cookie);
    return copy;
  }
}

/** The PIN check every write (and the dashboard's alert ack) goes through: null when allowed. */
export function pinGate(ctx: AppContext, req: Request, lim: PinLimiter = limiter): Response | null {
  const r = lim.check(() => pinOk(ctx, req), ctx.settings.checkTrust(trustCookie(req)));
  if (r === "ok") return null;
  if (r === "locked") {
    const s = lim.retryAfter();
    return fail(429, "rate_limited", `too many wrong PINs, try again in ${s} s`, { "Retry-After": String(s) });
  }
  return fail(401, "pin", "wrong or missing X-Lifefi-Pin header");
}

// ---- handlers ---------------------------------------------------------------------------

type Handler<P> = (ctx: AppContext, req: Request, params: P) => Promise<Response | unknown> | Response | unknown;

function respond(r: unknown): Response {
  return r instanceof Response ? r : Response.json(r);
}

/** Turns anything a handler throws into the contract's error JSON (never a stack trace). */
function crashed(err: unknown, req: Request, ctx: AppContext | null): Response {
  if (err instanceof ConfigError) return fail(500, "config", err.message);
  if (err instanceof BadBody) return fail(400, "bad_request", err.message);
  if (err instanceof TooLarge) return fail(413, "bad_request", err.message);
  if (err instanceof EngineError) return engineFail(err);
  const line = { err: (err as Error)?.stack ?? String(err), path: new URL(req.url).pathname };
  if (ctx) ctx.log.error(line, "request failed");
  else console.error("[lifefi] request failed", line);
  return fail(500, "internal", "unexpected server error");
}

type Options = { runtime?: () => AppContext; limiter?: PinLimiter };

/** A read: no PIN. Plain objects are sent as JSON. */
export function read<P = Record<string, never>>(fn: Handler<P>, opt: Options = {}) {
  return async (req: Request, route?: { params: Promise<P> }) => {
    let ctx: AppContext | null = null;
    try {
      ctx = (opt.runtime ?? getRuntime)();
      return respond(await fn(ctx, req, (await route?.params) as P));
    } catch (err) {
      return crashed(err, req, ctx);
    }
  };
}

/** A write: needs the X-Lifefi-Pin header. */
export function write<P = Record<string, never>>(fn: Handler<P>, opt: Options = {}) {
  return async (req: Request, route?: { params: Promise<P> }) => {
    let ctx: AppContext | null = null;
    try {
      ctx = (opt.runtime ?? getRuntime)();
      if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return fail(413, "bad_request", "body too large");
      const denied = pinGate(ctx, req, opt.limiter);
      if (denied) return denied;
      return withTrust(ctx, req, respond(await fn(ctx, req, (await route?.params) as P)));
    } catch (err) {
      return crashed(err, req, ctx);
    }
  };
}
