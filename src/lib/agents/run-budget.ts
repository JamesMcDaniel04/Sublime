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
