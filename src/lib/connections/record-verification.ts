/**
 * Writing verification state. Separate from the pure derivation so a client
 * component can import the latter without pulling in Prisma.
 *
 * Every writer is best-effort: recording that a credential works must never be
 * the reason a request fails. A lost write degrades to `unverified`, which is
 * honest.
 */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

export async function recordVerification(params: {
  organizationId: string
  connectionId: string
  state: 'verified' | 'failed'
  error?: string | null
}): Promise<void> {
  try {
    const data = {
      state: params.state,
      checkedAt: new Date(),
      // Only a failure carries an error; a pass clears the previous one so a
      // fixed connection doesn't keep showing a stale reason.
      error: params.state === 'failed' ? (params.error ?? null)?.slice(0, 500) ?? null : null,
    }
    await prisma.connectionVerification.upsert({
      where: { organizationId_connectionId: { organizationId: params.organizationId, connectionId: params.connectionId } },
      create: { organizationId: params.organizationId, connectionId: params.connectionId, ...data },
      update: data,
    })
  } catch (error) {
    apiLogger.warn('verification write failed', { connectionId: params.connectionId, error: String(error) })
  }
}

/** Fire-and-forget variant for hot paths (a live run) that must not await it. */
export function recordVerificationAsync(params: {
  organizationId: string
  connectionId: string
  state: 'verified' | 'failed'
  error?: string | null
}): void {
  void recordVerification(params)
}

/** Verification rows for a set of catalog ids, keyed by connection id. */
export async function loadVerifications(
  organizationId: string,
  connectionIds: string[],
): Promise<Map<string, { state: string; checkedAt: Date; error: string | null }>> {
  if (connectionIds.length === 0) return new Map()
  try {
    const rows = await prisma.connectionVerification.findMany({
      where: { organizationId, connectionId: { in: connectionIds } },
      select: { connectionId: true, state: true, checkedAt: true, error: true },
    })
    return new Map(rows.map((row) => [row.connectionId, { state: row.state, checkedAt: row.checkedAt, error: row.error }]))
  } catch {
    // A verification lookup must never break the catalog it decorates.
    return new Map()
  }
}
