/**
 * Per-flow log of recently applied collaboration mutation ids, stored as a
 * JSONB string array on `Flow`. Purpose: idempotent patch delivery — a client
 * that times out and retries a POST must not double-apply its patch or
 * double-report conflicts. Bounded so the column can never grow unbounded.
 */
export const MUTATION_LOG_LIMIT = 50

function asLog(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

export function hasAppliedMutation(log: unknown, mutationId: string): boolean {
  return asLog(log).includes(mutationId)
}

export function appendMutation(log: unknown, mutationId: string): string[] {
  const next = [...asLog(log), mutationId]
  return next.slice(Math.max(0, next.length - MUTATION_LOG_LIMIT))
}
