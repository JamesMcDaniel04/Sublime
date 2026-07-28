/**
 * Tier 3 fires precisely when Tier 2 FAILS.
 *
 * If skips correlate with a signal you get a targeting rule and the agent
 * keeps working. If they correlate with nothing, no rule is derivable, and the
 * honest conclusion is not "target better" but "this agent produces more than
 * the team can absorb". Those are opposite remedies, so proposing a cadence
 * change while a rule is also being learned would ask a human to fix something
 * the agent is about to fix itself.
 */

export const CADENCE_SKIP_RATE = 0.6
export const CADENCE_MIN_ITEMS = 10

export type CadenceInput = {
  produced: number
  skipped: number
  /** Rule candidates found for this agent-goal pair this cycle. */
  candidates: number
}

export function shouldProposeCadenceChange(input: CadenceInput): boolean {
  if (input.candidates > 0) return false
  if (input.produced < CADENCE_MIN_ITEMS) return false
  return input.skipped / input.produced >= CADENCE_SKIP_RATE
}
