/**
 * Entitlement resolver — the gate's decision function.
 *
 * Current signal (documented, real): a workspace is entitled to Den
 * Studio when it has at least one ACTIVE People.ai connection carrying SalesAI
 * context (membership id). People.ai grants those tokens only to users with
 * Sales AI permissions, and revoked licenses stop refreshing.
 *
 * Seam: if People.ai exposes a dedicated entitlement API later, swap the
 * inside of `resolveEntitlement` — callers only see { entitled, tier, status }.
 * Results are cached on Organization with a TTL so the check is cheap on the
 * hot path (requireAuthContext).
 */

import { prisma } from '@/lib/prisma'

export const ENTITLEMENT_TTL_MS = 15 * 60 * 1000 // 15 minutes

export type EntitlementStatus = 'entitled' | 'unentitled' | 'unknown'

export interface EntitlementResult {
  entitled: boolean
  tier: string | null
  status: EntitlementStatus
}

/**
 * Native Sales AI mode: the platform is exclusively for People.ai Sales AI
 * customers, so when an org-level service credential is configured, every
 * workspace is assumed entitled and Sales AI works out of the box — no per-user
 * People.ai connection required. Per-user connections remain an optional,
 * higher-fidelity upgrade (rep-scoped reads/actions).
 */
export function salesAiNativeMode(): boolean {
  return Boolean(process.env.PEOPLE_AI_SERVICE_CLIENT_ID && process.env.PEOPLE_AI_SERVICE_CLIENT_SECRET)
}

interface ConnectionShape {
  status: string
  membershipId: string | null
  teamId: string | null
}

/** Pure decision over the org's connections — unit-testable. */
export function evaluateEntitlement(input: {
  peopleAiTeamId: string | null
  connections: ConnectionShape[]
}): EntitlementResult {
  const active = input.connections.filter(
    (connection) => connection.status === 'active' && Boolean(connection.membershipId),
  )
  if (active.length > 0) {
    return { entitled: true, tier: 'sales_ai', status: 'entitled' }
  }
  return { entitled: false, tier: null, status: 'unentitled' }
}

export function entitlementFresh(
  org: { entitlementStatus: string; entitlementCheckedAt: Date | null },
  now: number = Date.now(),
): boolean {
  if (org.entitlementStatus === 'unknown') return false
  if (!org.entitlementCheckedAt) return false
  return now - org.entitlementCheckedAt.getTime() < ENTITLEMENT_TTL_MS
}

/**
 * Resolve (with cache) the org's entitlement. Reads the cached snapshot when
 * fresh; otherwise re-evaluates from connections and persists the snapshot.
 */
export async function resolveEntitlement(organizationId: string): Promise<EntitlementResult> {
  // Native mode short-circuits: with a service credential, Sales AI is a native
  // platform capability and every workspace is entitled without a connection.
  if (salesAiNativeMode()) {
    return { entitled: true, tier: 'sales_ai', status: 'entitled' }
  }

  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: {
      id: true,
      peopleAiTeamId: true,
      entitlementTier: true,
      entitlementStatus: true,
      entitlementCheckedAt: true,
    },
  })
  if (!org) return { entitled: false, tier: null, status: 'unentitled' }

  if (entitlementFresh(org)) {
    return {
      entitled: org.entitlementStatus === 'entitled',
      tier: org.entitlementTier,
      status: org.entitlementStatus as EntitlementStatus,
    }
  }

  const connections = await prisma.peopleAiConnection.findMany({
    where: { organizationId },
    select: { status: true, membershipId: true, teamId: true },
  })

  const result = evaluateEntitlement({ peopleAiTeamId: org.peopleAiTeamId, connections })

  await prisma.organization.update({
    where: { id: organizationId },
    data: {
      entitlementStatus: result.status,
      entitlementTier: result.tier,
      entitlementCheckedAt: new Date(),
    },
  })

  return result
}

/** Force re-evaluation (e.g. after a connection is added/revoked). */
export async function revalidateEntitlement(organizationId: string): Promise<EntitlementResult> {
  await prisma.organization.update({
    where: { id: organizationId },
    data: { entitlementCheckedAt: null, entitlementStatus: 'unknown' },
  })
  return resolveEntitlement(organizationId)
}
