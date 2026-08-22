/**
 * Resource guards (docs/design.md §9): modest fixed defaults, each
 * overridable via a `MATH_GRAPHER_*` env var so a heavy user can raise
 * them without a release. Exceeding a limit is a structured error thrown
 * from the session layer (and surfaced as a tool error by the MCP
 * surface), never a crash.
 */

export interface SessionLimits {
  /** Max concurrently-open sessions per server process. */
  maxSessions: number;
  /** Max cells (free + computed) in one session. */
  maxCells: number;
  /** Wall-clock budget for the recompute cascade one tool call may trigger, in ms. */
  evalBudgetMs: number;
  /** Max serialized size of one set_cell value or define spec, in bytes. */
  maxPayloadBytes: number;
}

export const DEFAULT_LIMITS: SessionLimits = {
  maxSessions: 16,
  maxCells: 512,
  evalBudgetMs: 250,
  maxPayloadBytes: 256 * 1024,
};

/** A positive integer from `env[name]`, or `fallback` when unset/invalid -- a garbage override falls back rather than crashing or silently disabling the guard. */
function intFromEnv(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function limitsFromEnv(env: Record<string, string | undefined> = process.env): SessionLimits {
  return {
    maxSessions: intFromEnv(env, "MATH_GRAPHER_MAX_SESSIONS", DEFAULT_LIMITS.maxSessions),
    maxCells: intFromEnv(env, "MATH_GRAPHER_MAX_CELLS", DEFAULT_LIMITS.maxCells),
    evalBudgetMs: intFromEnv(env, "MATH_GRAPHER_EVAL_BUDGET_MS", DEFAULT_LIMITS.evalBudgetMs),
    maxPayloadBytes: intFromEnv(env, "MATH_GRAPHER_MAX_PAYLOAD_BYTES", DEFAULT_LIMITS.maxPayloadBytes),
  };
}
