/**
 * Optimistic-concurrency guard for flow saves. The builder sends the
 * `updatedAt` it loaded (or last saved); a mismatch means another client (a
 * second tab, another org member) saved in between — the PUT is rejected with
 * 409 instead of silently clobbering their changes. Callers that don't send
 * `baseUpdatedAt` (legacy) keep last-write-wins behavior.
 */
export function hasSaveConflict(existingUpdatedAt: Date, baseUpdatedAt: string | undefined): boolean {
  if (baseUpdatedAt === undefined) return false
  const base = new Date(baseUpdatedAt)
  // Fail closed: an unparseable base must never be allowed to clobber.
  if (Number.isNaN(base.getTime())) return true
  return base.getTime() !== existingUpdatedAt.getTime()
}
