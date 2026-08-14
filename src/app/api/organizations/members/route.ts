import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { prisma } from '@/lib/prisma'
import { memberDisplayName } from '@/lib/server/member-display'

export const runtime = 'nodejs'

/**
 * GET /api/organizations/members — the people picker.
 *
 * Feeds Flow Jam invites, @-mentions on comments, and human-review assignees.
 * A collaborative product genuinely needs this: you cannot invite a teammate
 * you cannot name.
 *
 * What it does NOT do is hand every member the workspace's address book.
 * EMAIL IS ADMIN-ONLY. A picker needs an id and something to read; the email
 * address is directory data, and returning it here meant any member could
 * enumerate every colleague's address with one unprivileged request. Workspace
 * admins still receive it, because they are the ones who administer people.
 *
 * The full roster — role, activity, pending invitations — lives behind
 * `member:manage` in /api/settings/members and is not available here at all.
 */
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const members = await prisma.user.findMany({
    where: { organizationId: auth.organizationId, isActive: true },
    select: { id: true, name: true, email: true },
    orderBy: { createdAt: 'asc' },
    take: 200,
  })

  return {
    success: true,
    members: members.map((member) => ({
      id: member.id,
      // Fallback for an account with no name set: the email's LOCAL PART, not
      // the address. A picker showing three rows called "Member" is unusable,
      // and the local part is what the person is called at work anyway. If even
      // that is too much for your workspace, change it to 'Member' — the
      // pickers already handle a non-unique label.
      name: memberDisplayName(member),
      // Present only for admins. The pickers render it behind a truthiness
      // check, so a member simply sees the name with nothing missing.
      ...(auth.isAdmin ? { email: member.email } : {}),
      isSelf: member.id === auth.dbUser.id,
    })),
  }
}, { requires: 'member' })
