/**
 * Per-run token budget, shared across a whole sub-agent tree.
 *
 * The budget is ONE mutable object created by the top-level run and passed by
 * reference into every inline sub-run (run_agent recursion), so children spend
 * from the parent's allowance instead of each minting a fresh cap — previously
 * depth × fan-out could multiply the per-run cap ~240×.
 */

export type RunBudget = { cap: number; spent: number }

const DEFAULT_RUN_TOKEN_CAP = 2_000_000

/**
 * Build a run's budget from AGENT_MAX_RUN_TOKENS. Unset/garbage → the 2M
 * backstop; an explicit 0 keeps the documented unlimited opt-out. `priorSpent`
 * seeds the counter on crash-resume from the execution row's persisted totals.
 */
export function createRunBudget(envCap: string | number | undefined, priorSpent = 0): RunBudget {
  const parsed = envCap === undefined || envCap === '' ? NaN : Number(envCap)
  const cap = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RUN_TOKEN_CAP
  return { cap, spent: Math.max(0, priorSpent) }
}

/** Charge tokens against the budget; true when the cap is now reached. */
export function chargeRunBudget(budget: RunBudget, tokens: number): boolean {
  if (Number.isFinite(tokens) && tokens > 0) budget.spent += tokens
  return budget.cap > 0 && budget.spent >= budget.cap
}

/** True when the cap is already spent, so the next call should not be made. */
export function runBudgetExhausted(budget: RunBudget): boolean {
  return budget.cap > 0 && budget.spent >= budget.cap
}

/**
 * Rough token count for LLM calls that return only text (the flow inline-agent
 * and router paths call helpers that don't surface provider usage). ~4 chars
 * per token is the standard approximation; this feeds a runaway backstop, not
 * billing, so approximate is the right precision.
 */
export function estimateTokens(...parts: Array<string | undefined | null>): number {
  const chars = parts.reduce((sum, part) => sum + (part?.length ?? 0), 0)
  return Math.ceil(chars / 4)
}

/** The error a run fails with when its token cap is spent. */
export function runBudgetExceededMessage(budget: RunBudget): string {
  return `This run hit its token budget (${budget.cap.toLocaleString()} tokens) and was stopped before making another model call.`
}
