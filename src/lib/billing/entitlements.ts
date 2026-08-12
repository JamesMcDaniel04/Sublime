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

// isLegacyPlatformUser used to live here: it read a user's createdAt against the
// cutoff and every caller treated the result as "this person is an ADMIN". The
// grant is now a written-down role (20260812010000_backfill_legacy_admin_role),
// so authorization never derives from a timestamp again. The cutoff below still
// governs BILLING, which is what it was always meant for.

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
