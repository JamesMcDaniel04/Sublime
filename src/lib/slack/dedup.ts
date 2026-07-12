/**
 * Slack ingress dedup — atomic, DB-backed.
 *
 * The old dedup was `if (await cacheGet(key)) return duplicate; await
 * cacheSet(key, 1, TTL)` — a check-then-set race (two simultaneous Slack
 * retries can both miss the GET and both dispatch) and, without Redis
 * configured, per-instance only (cross-instance double-dispatch). Here the
 * `@@unique([bindingId, dedupId])` constraint on SlackProcessedEvent IS the
 * dedup: the insert either succeeds (first time) or hits the unique
 * violation (duplicate) — decided atomically by the database, global across
 * every instance, no cache needed.
 *
 * systemPrisma: SlackProcessedEvent carries no organizationId (bindingId is
 * the tenant selector already, resolved by the ingress route before this is
 * called) — a session-less ingress-support table, not an org-scoped model.
 */
import { Prisma } from '@prisma/client'
import { systemPrisma } from '@/lib/prisma'

const DEFAULT_PRUNE_AGE_MS = 60 * 60 * 1000 // 1h — well past any Slack retry window.

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

/**
 * Atomically claim (bindingId, dedupId). Returns true the first time (the
 * caller should dispatch), false if it's already been claimed (duplicate —
 * drop it). Never throws on the expected race; any other error propagates.
 */
export async function claimSlackEvent(bindingId: string, dedupId: string): Promise<boolean> {
  try {
    await systemPrisma.slackProcessedEvent.create({ data: { bindingId, dedupId } })
    return true
  } catch (error) {
    if (isUniqueViolation(error)) return false
    throw error
  }
}

/**
 * Release a claim so a FAILED dispatch is recoverable — Slack's retry of the
 * same event_id/trigger_id will re-claim and re-run it instead of being
 * permanently swallowed as a duplicate. Best-effort: a release failure just
 * means the retry gets deduped away, which is the pre-existing behavior.
 */
export async function releaseSlackEvent(bindingId: string, dedupId: string): Promise<void> {
  await systemPrisma.slackProcessedEvent.deleteMany({ where: { bindingId, dedupId } }).catch(() => {})
}

/**
 * Best-effort cron sweep: drop claims older than `olderThanMs` (default 1h —
 * comfortably past any Slack retry window) so the table doesn't grow
 * unbounded. Returns the deleted count; never throws.
 */
export async function pruneSlackProcessedEvents(olderThanMs = DEFAULT_PRUNE_AGE_MS): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - olderThanMs)
    const { count } = await systemPrisma.slackProcessedEvent.deleteMany({ where: { createdAt: { lt: cutoff } } })
    return count
  } catch {
    return 0
  }
}
