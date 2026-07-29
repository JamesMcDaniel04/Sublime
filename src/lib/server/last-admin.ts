/**
 * "A workspace must always keep at least one active ADMIN."
 *
 * An org with zero admins can never manage billing, invite anyone, or recover
 * ownership — an unrecoverable state reachable by one careless click, so it is
 * checked on every path that could cause it: role change, deactivation, member
 * removal, and self-deletion.
 *
 * The check runs against DATABASE truth rather than the request's auth context,
 * and that distinction is load-bearing. auth-utils.ts normalizes legacy platform
 * users to role 'ADMIN' in memory while their stored row still says 'MEMBER',
 * so an in-memory count can disagree with the persisted one. A legacy user
 * demoting the org's only stored admin would pass an auth-context check and
 * still leave the workspace with no admin anybody could restore.
 */

import { prisma } from '@/lib/prisma'
import { ApiError } from './api-handler'

export class LastAdminError extends ApiError {
  constructor(message: string) {
    super(message, 409, 'LAST_ADMIN')
  }
}

/**
 * Count of active admins the org would have AFTER the described change.
 *
 * `losingAdminUserId` is the user about to stop being an active admin (demoted,
 * suspended, or deleted). Passing someone who is not currently an active admin
 * is harmless — they simply don't reduce the count.
 */
async function remainingAdminCount(organizationId: string, losingAdminUserId: string): Promise<number> {
  return prisma.user.count({
    where: { organizationId, isActive: true, role: 'ADMIN', id: { not: losingAdminUserId } },
  })
}

/**
 * Throws when `losingAdminUserId` is the workspace's last active admin.
 *
 * A workspace whose only member is leaving entirely is NOT blocked — there is
 * nothing left to administer, and the caller tears the organization down
 * instead. That case is signalled by `allowWhenSoleMember`.
 */
export async function assertNotLastAdmin(
  organizationId: string,
  losingAdminUserId: string,
  options: { allowWhenSoleMember?: boolean; message?: string } = {},
): Promise<void> {
  if (await remainingAdminCount(organizationId, losingAdminUserId) > 0) return

  if (options.allowWhenSoleMember) {
    const activeMembers = await prisma.user.count({ where: { organizationId, isActive: true } })
    if (activeMembers <= 1) return
  }

  throw new LastAdminError(
    options.message ?? 'Promote another administrator first — a workspace must always have one.',
  )
}
