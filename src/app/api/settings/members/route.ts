import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { createAdminClient } from '@/lib/supabase/admin'
import { recordAudit } from '@/lib/audit'

const inviteSchema = z.object({ email: z.string().email(), role: z.enum(['ADMIN', 'USER']).default('USER') })

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const [members, invitations] = await Promise.all([
    prisma.user.findMany({ where: { organizationId: auth.organizationId }, select: { id: true, email: true, name: true, role: true, isActive: true, lastSeenAt: true }, orderBy: { createdAt: 'asc' } }),
    prisma.organizationInvitation.findMany({ where: { organizationId: auth.organizationId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } }),
  ])
  return { success: true, members, invitations }
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  if (auth.dbUser.role !== 'ADMIN') throw new ApiError('Admin access required', 403, 'FORBIDDEN')
  const input = inviteSchema.parse(await request.json()); const email = input.email.trim().toLowerCase()
  if (await prisma.user.findFirst({ where: { organizationId: auth.organizationId, email } })) throw new ApiError('That person is already a member', 409, 'ALREADY_MEMBER')
  const invitation = await prisma.organizationInvitation.create({ data: { organizationId: auth.organizationId, email, role: input.role, invitedById: auth.dbUser.id, expiresAt: new Date(Date.now() + 7 * 86_400_000) } })
  const redirectTo = `${process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || request.nextUrl.origin}/auth/callback`
  const { error } = await createAdminClient().auth.admin.inviteUserByEmail(email, { redirectTo })
  if (error) { await prisma.organizationInvitation.delete({ where: { id: invitation.id, organizationId: auth.organizationId } }); throw new ApiError('Could not send invitation', 502, 'INVITE_FAILED', error) }
  void recordAudit({ organizationId: auth.organizationId, actorUserId: auth.dbUser.id, action: 'organization.member.invited', resourceType: 'invitation', resourceId: invitation.id })
  return { success: true, invitation }
})

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  if (auth.dbUser.role !== 'ADMIN') throw new ApiError('Admin access required', 403, 'FORBIDDEN')
  const input = z.object({ userId: z.string(), role: z.enum(['ADMIN', 'USER']).optional(), isActive: z.boolean().optional() }).parse(await request.json())
  if (input.userId === auth.dbUser.id && (input.role === 'USER' || input.isActive === false)) throw new ApiError('You cannot remove your own administrator access', 409, 'SELF_ADMIN_CHANGE')
  const member = await prisma.user.findFirst({ where: { id: input.userId, organizationId: auth.organizationId } })
  if (!member) throw new ApiError('Member not found', 404, 'NOT_FOUND')
  await prisma.user.update({ where: { id: member.id, organizationId: auth.organizationId }, data: { ...(input.role && { role: input.role }), ...(input.isActive !== undefined && { isActive: input.isActive }) } })
  // Drop the per-instance auth cache immediately — without this, a demoted or
  // deactivated member keeps their OLD role/active flag on warm instances for
  // the cache TTL (mirrors the org-delete route's pattern).
  const { invalidateDbUserCache } = await import('@/lib/supabase/auth-utils')
  invalidateDbUserCache(member.supabaseId)
  if (input.isActive === false) await createAdminClient().auth.admin.signOut(member.supabaseId, 'global')
  void recordAudit({ organizationId: auth.organizationId, actorUserId: auth.dbUser.id, action: 'organization.member.updated', resourceType: 'user', resourceId: member.id })
  return { success: true }
})

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  if (auth.dbUser.role !== 'ADMIN') throw new ApiError('Admin access required', 403, 'FORBIDDEN')
  const id = new URL(request.url).searchParams.get('invitationId')
  if (!id) throw new ApiError('invitationId is required')
  const result = await prisma.organizationInvitation.updateMany({ where: { id, organizationId: auth.organizationId, acceptedAt: null }, data: { revokedAt: new Date() } })
  if (!result.count) throw new ApiError('Invitation not found', 404, 'NOT_FOUND')
  return { success: true }
})
