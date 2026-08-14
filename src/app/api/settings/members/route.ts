import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { createAdminClient } from '@/lib/supabase/admin'
import { recordAudit } from '@/lib/audit'
import { assertSeatCapacity } from '@/lib/billing/enforce'
import { assertNotLastAdmin } from '@/lib/server/last-admin'

const inviteSchema = z.object({ email: z.string().email(), role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER') })

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const [members, invitations] = await Promise.all([
    prisma.user.findMany({ where: { organizationId: auth.organizationId }, select: { id: true, email: true, name: true, role: true, isActive: true, lastSeenAt: true, createdAt: true }, orderBy: { createdAt: 'asc' } }),
    prisma.organizationInvitation.findMany({ where: { organizationId: auth.organizationId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } }),
  ])
  return {
    success: true,
    // The stored role is what we show. It used to be re-derived from createdAt
    // here, which meant the list could display ADMIN for a row the database
    // called MEMBER — see 20260812010000_backfill_legacy_admin_role.
    members,
    invitations,
  }
  // ADMIN ONLY. This returns the workspace's people directory: every member's
  // email, role, isActive, createdAt and lastSeenAt, plus every pending
  // invitation. `lastSeenAt` is activity surveillance and the invitation list
  // says who is being hired — neither is a member's business.
  //
  // It was 'member' because the Members settings tab renders for everyone. The
  // tab now hides for non-admins AND this refuses them, because hiding a tab
  // is presentation, not authorization — the same reasoning already written
  // against the Insights tab in settings/page.tsx.
  //
  // Pickers that legitimately need to name a colleague use
  // /api/organizations/members, which returns ids and display names only.
}, { requires: 'member:manage' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const input = inviteSchema.parse(await request.json()); const email = input.email.trim().toLowerCase()
  if (await prisma.user.findFirst({ where: { organizationId: auth.organizationId, email } })) throw new ApiError('That person is already a member', 409, 'ALREADY_MEMBER')
  await assertSeatCapacity(auth.organizationId)
  const invitation = await prisma.organizationInvitation.create({ data: { organizationId: auth.organizationId, email, role: input.role, invitedById: auth.dbUser.id, expiresAt: new Date(Date.now() + 7 * 86_400_000) } })
  const redirectTo = `${process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || request.nextUrl.origin}/auth/callback`
  const { error } = await createAdminClient().auth.admin.inviteUserByEmail(email, { redirectTo })
  if (error) { await prisma.organizationInvitation.delete({ where: { id: invitation.id, organizationId: auth.organizationId } }); throw new ApiError('Could not send invitation', 502, 'INVITE_FAILED', error) }
  void recordAudit({ organizationId: auth.organizationId, actorUserId: auth.dbUser.id, action: 'organization.member.invited', resourceType: 'invitation', resourceId: invitation.id })
  return { success: true, invitation }
}, { requires: 'member:manage' })

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const input = z.object({ userId: z.string(), role: z.enum(['ADMIN', 'MEMBER']).optional(), isActive: z.boolean().optional() }).parse(await request.json())
  if (input.userId === auth.dbUser.id && (input.role === 'MEMBER' || input.isActive === false)) throw new ApiError('You cannot remove your own administrator access', 409, 'SELF_ADMIN_CHANGE')
  const member = await prisma.user.findFirst({ where: { id: input.userId, organizationId: auth.organizationId } })
  if (!member) throw new ApiError('Member not found', 404, 'NOT_FOUND')
  // Demoting or suspending someone must not leave the workspace with no admin.
  // Checked against stored roles, not the caller's context: a legacy platform
  // user acts as ADMIN in memory while their row says MEMBER, so the
  // self-demotion guard above does not by itself keep the count above zero.
  if (input.role === 'MEMBER' || input.isActive === false) {
    await assertNotLastAdmin(auth.organizationId, member.id)
  }
  // Reactivation consumes a seat exactly like a new invite — without this
  // check, deactivate/reactivate cycles walk past the plan's seat cap.
  if (input.isActive === true && !member.isActive) await assertSeatCapacity(auth.organizationId)
  await prisma.user.update({ where: { id: member.id, organizationId: auth.organizationId }, data: { ...(input.role && { role: input.role }), ...(input.isActive !== undefined && { isActive: input.isActive }) } })
  // One row per FACT that changed, not one per request. "Made someone an
  // admin" and "suspended someone" are different questions during an incident,
  // and the old single organization.member.updated action could not tell a
  // reviewer which had happened — or, for a request carrying both, that both
  // had. Emitted only for real transitions, so re-sending an unchanged value
  // does not pad the log with no-ops.
  const changes: Array<{ action: string; detail: Record<string, unknown> }> = []
  if (input.role && input.role !== member.role) {
    changes.push({ action: 'organization.member.role_changed', detail: { from: member.role, to: input.role } })
  }
  if (input.isActive !== undefined && input.isActive !== member.isActive) {
    changes.push({
      action: input.isActive ? 'organization.member.reactivated' : 'organization.member.deactivated',
      detail: {},
    })
  }
  for (const change of changes) {
    void recordAudit({
      organizationId: auth.organizationId,
      actorUserId: auth.dbUser.id,
      action: change.action,
      resourceType: 'user',
      resourceId: member.id,
      detail: change.detail,
    })
  }
  // Session teardown comes AFTER the audit write on purpose. The row above
  // records a change that has already been committed, and signOut reaches an
  // external service that can fail — auditing behind it meant an unreachable
  // Supabase produced a member who was deactivated in the database with
  // nothing in the log to say so.
  //
  // Drop the per-instance auth cache immediately too: without it a demoted or
  // deactivated member keeps their OLD role/active flag on warm instances for
  // the cache TTL (mirrors the org-delete route's pattern).
  const { invalidateDbUserCache } = await import('@/lib/supabase/auth-utils')
  invalidateDbUserCache(member.supabaseId)
  if (input.isActive === false) await createAdminClient().auth.admin.signOut(member.supabaseId, 'global')
  return { success: true }
}, { requires: 'member:manage' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const id = new URL(request.url).searchParams.get('invitationId')
  if (!id) throw new ApiError('invitationId is required')
  const result = await prisma.organizationInvitation.updateMany({ where: { id, organizationId: auth.organizationId, acceptedAt: null }, data: { revokedAt: new Date() } })
  if (!result.count) throw new ApiError('Invitation not found', 404, 'NOT_FOUND')
  // The counterpart to organization.member.invited above. Logging the grant
  // but not the withdrawal leaves a reviewer reading an audit trail where
  // everyone who was ever invited still appears to be on their way in.
  void recordAudit({ organizationId: auth.organizationId, actorUserId: auth.dbUser.id, action: 'organization.member.invite_revoked', resourceType: 'invitation', resourceId: id })
  return { success: true }
}, { requires: 'member:manage' })
