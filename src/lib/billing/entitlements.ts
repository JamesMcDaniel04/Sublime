import { Plan } from '@/generated/prisma/client'

// Existing workspaces were promised unrestricted internal/test access when
// paid-from-day-one launched. The durable marker is grandfatheredAt, while
// this cutoff is an intentional fallback for environments where the row
// backfill was not applied (or was applied after users first hit the app).
// New workspaces created after this instant still require payment immediately.
export const GRANDFATHERED_WORKSPACE_CUTOFF = new Date('2026-07-19T20:31:00.000Z')

export type EntitlementOrganization = {
  plan: Plan
  createdAt: Date
  grandfatheredAt?: Date | null
}

export type LegacyPlatformUser = {
  createdAt: Date
}

/** Existing test identities are super admins; later invitees are not. */
export function isLegacyPlatformUser(user: LegacyPlatformUser | null | undefined): boolean {
  return Boolean(user && user.createdAt.getTime() <= GRANDFATHERED_WORKSPACE_CUTOFF.getTime())
}

export function isGrandfatheredOrganization(
  organization: EntitlementOrganization | null | undefined,
): boolean {
  if (!organization) return false
  return Boolean(
    organization.grandfatheredAt
      || organization.createdAt.getTime() <= GRANDFATHERED_WORKSPACE_CUTOFF.getTime(),
  )
}

export function entitlementPlanFor(
  organization: EntitlementOrganization | null | undefined,
): Plan {
  if (!organization) return Plan.TRIAL
  return isGrandfatheredOrganization(organization) ? Plan.ENTERPRISE : organization.plan
}
