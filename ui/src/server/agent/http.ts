// Maps agent errors to the contract's error JSON.
import { fail } from "../http";
import { AgentError } from "./agent";

const STATUS = { not_configured: 503, busy: 409, not_found: 404, failed: 502 } as const;

export function agentFail(err: unknown): Response {
  if (err instanceof AgentError) return fail(err.code === "failed" && err.message === "no question" ? 400 : STATUS[err.code], `agent_${err.code}`, err.message);
  throw err;
}
