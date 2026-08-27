/**
 * Shared classification of `AgentExecution.status` values for the cancel /
 * delete run actions. Kept as pure functions (no Prisma) so both the API
 * route and the execute-agent loop agree on what "cancellable" and
 * "terminal" mean without duplicating the string lists.
 */

/** A run the user can ask to stop: actively looping, or paused waiting on them. */
const CANCELLABLE_STATUSES = new Set(['running', 'waiting_for_input', 'waiting_for_external'])

/** Paused states with no live turn loop to notice a 'cancelling' flag — these
 *  finalize to 'cancelled' immediately instead of waiting for the loop. */
// waiting_for_external: parked on an external agent's callback — no live loop either.
const WAITING_STATUSES = new Set(['waiting_for_input', 'waiting_for_external'])

/** Finished runs, safe to delete outright (no in-flight work references them). */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

export function isCancellableRunStatus(status: string): boolean {
  return CANCELLABLE_STATUSES.has(status)
}

export function isWaitingRunStatus(status: string): boolean {
  return WAITING_STATUSES.has(status)
}

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status)
}
