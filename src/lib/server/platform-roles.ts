/**
 * The platform tier — the access axis that spans workspaces.
 *
 * Every other axis in this codebase is scoped to one organization: tenant-guard
 * picks the org, visibility picks rows inside it, and UserRole says what an
 * ADMIN may do *to their own workspace*. None of them can express "may read
 * every tenant", which is what running the platform requires.
 *
 * It is a SECOND axis rather than a third UserRole value on purpose. Adding
 * `SUPER_ADMIN` to the enum would mean every `role === 'ADMIN'` check in the
 * codebase silently stops matching the most privileged accounts, and every
 * org-scoped query would have to learn about a role that is not org-scoped at
 * all. Keeping the axes separate means existing checks keep their exact meaning.
 *
 * The tier is granted by the union of TWO facts — the person AND the workspace
 * they are in:
 *
 *   users.platformRole === 'operator'   AND   organizations.kind === 'internal'
 *
 * The org half is what makes the grant safe to leave in place. Someone who
 * moves to a customer workspace loses platform rights immediately, with no flag
 * anyone has to remember to clear, and a customer workspace can never hold an
 * operator even if a row is written wrongly.
 */

/** Values `users.platformRole` may hold. Null means no platform standing. */
export const PLATFORM_ROLES = ['staff', 'operator'] as const
export type PlatformRole = (typeof PLATFORM_ROLES)[number]

/** Values `organizations.kind` may hold. */
export const ORG_KINDS = ['internal', 'partner', 'customer'] as const
export type OrgKind = (typeof ORG_KINDS)[number]

/**
 * Org kinds whose members may hold the operator tier.
 *
 * Internal only, and separate from any future review/moderation tier on
 * purpose. One permission that means both "may review shared content" (which
 * partners could reasonably do) and "may read every user's personal details"
 * gets granted for the first reason and exploited for the second. When a
 * moderation tier is added it gets its own constant and its own wider set —
 * it does not widen this one.
 */
const OPERATING_ORG_KINDS: readonly string[] = ['internal'] as const

export function isPlatformRole(value: unknown): value is PlatformRole {
  return value === 'staff' || value === 'operator'
}

export function isOrgKind(value: unknown): value is OrgKind {
  return value === 'internal' || value === 'partner' || value === 'customer'
}

/**
 * Whether this person, in this workspace, holds the operator tier.
 *
 * `staff` deliberately grants nothing. It marks an employee account for
 * reporting and for exempting internal usage from customer metrics; making it
 * a rights-bearing value would mean every employee could read every tenant.
 */
export function isPlatformOperator(
  platformRole: string | null | undefined,
  orgKind: string | null | undefined,
): boolean {
  return platformRole === 'operator' && OPERATING_ORG_KINDS.includes(orgKind ?? '')
}
