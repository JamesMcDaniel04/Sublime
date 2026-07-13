import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import {
  createAdminClient,
  SupabaseAdminConfigurationError,
} from '@/lib/supabase/admin'
import { invalidateDbUserCache } from '@/lib/supabase/auth-utils'
import { recordAudit } from '@/lib/audit'

const INVITATION_LIFETIME_MS = 7 * 86_400_000

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(['ADMIN', 'USER']).default('USER'),
})

const memberPatchSchema = z
  .object({
    memberId: z.string().min(1),
    role: z.enum(['ADMIN', 'USER']).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((input) => input.role !== undefined || input.isActive !== undefined, {
    message: 'A role or active status change is required',
  })

const invitationPatchSchema = z.object({
  invitationId: z.string().min(1),
  role: z.enum(['ADMIN', 'USER']),
})

function requireAdmin(role: 'ADMIN' | 'USER') {
  if (role !== 'ADMIN') {
    throw new ApiError('Admin access required', 403, 'FORBIDDEN')
  }
}

function adminConfigurationError(
  error: unknown,
  message: string,
  code: string,
): never {
  if (error instanceof SupabaseAdminConfigurationError) {
    throw new ApiError(
      message,
      503,
      code,
      error,
    )
  }
  throw error
}

function inviteRedirectTo(requestUrl: URL): string {
  const configuredOrigin = process.env.NEXT_PUBLIC_APP_URL?.trim()
  try {
    return new URL('/auth/callback', configuredOrigin || requestUrl.origin).toString()
  } catch (error) {
    throw new ApiError(
      'Workspace invitations are not configured. NEXT_PUBLIC_APP_URL must be a valid application URL.',
      503,
      'INVITATIONS_NOT_CONFIGURED',
      error,
    )
  }
}

async function ensureAdminWouldRemain(
  organizationId: string,
  member: { role: 'ADMIN' | 'USER'; isActive: boolean },
  changes: { role?: 'ADMIN' | 'USER'; isActive?: boolean },
) {
  const removesActiveAdmin =
    member.role === 'ADMIN' &&
    member.isActive &&
    (changes.role === 'USER' || changes.isActive === false)
  if (!removesActiveAdmin) return

  const activeAdminCount = await prisma.user.count({
    where: { organizationId, role: 'ADMIN', isActive: true },
  })
  if (activeAdminCount <= 1) {
    throw new ApiError(
      'Promote another active administrator before changing this member',
      409,
      'LAST_ADMIN',
    )
  }
}

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const [members, invitations] = await Promise.all([
    prisma.user.findMany({
      where: { organizationId: auth.organizationId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        lastSeenAt: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.organizationInvitation.findMany({
      where: {
        organizationId: auth.organizationId,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
  ])
  return { success: true, members, invitations }
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  requireAdmin(auth.dbUser.role)
  const input = inviteSchema.parse(await request.json())
  const email = input.email

  const existingMember = await prisma.user.findFirst({
    where: {
      organizationId: auth.organizationId,
      email: { equals: email, mode: 'insensitive' },
    },
  })
  if (existingMember) {
    throw new ApiError('That person is already a member', 409, 'ALREADY_MEMBER')
  }

  // Reuse the latest unaccepted row when resending so repeated clicks do not
  // accumulate multiple simultaneously valid invitations.
  const previous = await prisma.organizationInvitation.findFirst({
    where: { organizationId: auth.organizationId, email, acceptedAt: null },
    orderBy: { createdAt: 'desc' },
  })
  const expiresAt = new Date(Date.now() + INVITATION_LIFETIME_MS)
  const invitation = previous
    ? await prisma.organizationInvitation.update({
        where: { id: previous.id, organizationId: auth.organizationId },
        data: {
          role: input.role,
          invitedById: auth.dbUser.id,
          expiresAt,
          revokedAt: null,
        },
        select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      })
    : await prisma.organizationInvitation.create({
        data: {
          organizationId: auth.organizationId,
          email,
          role: input.role,
          invitedById: auth.dbUser.id,
          expiresAt,
        },
        select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      })

  try {
    const { error } = await createAdminClient().auth.admin.inviteUserByEmail(email, {
      redirectTo: inviteRedirectTo(request.nextUrl),
    })
    if (error) {
      throw new ApiError('Could not send invitation', 502, 'INVITE_FAILED', error)
    }
  } catch (error) {
    // Do not leave a valid database invitation behind when no email was sent.
    if (previous) {
      await prisma.organizationInvitation
        .update({
          where: { id: previous.id, organizationId: auth.organizationId },
          data: {
            role: previous.role,
            invitedById: previous.invitedById,
            expiresAt: previous.expiresAt,
            revokedAt: previous.revokedAt,
          },
        })
        .catch(() => {})
    } else {
      await prisma.organizationInvitation
        .deleteMany({ where: { id: invitation.id, organizationId: auth.organizationId } })
        .catch(() => {})
    }
    if (error instanceof ApiError) throw error
    adminConfigurationError(
      error,
      'Workspace invitations are not configured. Ask an operator to set SUPABASE_SERVICE_ROLE_KEY.',
      'INVITATIONS_NOT_CONFIGURED',
    )
  }

  void recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: previous ? 'organization.invitation.resent' : 'organization.member.invited',
    resourceType: 'invitation',
    resourceId: invitation.id,
    detail: { role: invitation.role },
  })
  return { success: true, invitation, resent: Boolean(previous) }
})

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  requireAdmin(auth.dbUser.role)
  const payload: unknown = await request.json()

  const invitationInput = invitationPatchSchema.safeParse(payload)
  if (invitationInput.success) {
    const invitation = await prisma.organizationInvitation.findFirst({
      where: {
        id: invitationInput.data.invitationId,
        organizationId: auth.organizationId,
        acceptedAt: null,
        revokedAt: null,
      },
    })
    if (!invitation) throw new ApiError('Invitation not found', 404, 'NOT_FOUND')

    const updated = await prisma.organizationInvitation.update({
      where: { id: invitation.id, organizationId: auth.organizationId },
      data: { role: invitationInput.data.role },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
    })
    void recordAudit({
      organizationId: auth.organizationId,
      actorUserId: auth.dbUser.id,
      action: 'organization.invitation.updated',
      resourceType: 'invitation',
      resourceId: invitation.id,
      detail: { role: updated.role },
    })
    return { success: true, invitation: updated }
  }

  const input = memberPatchSchema.parse(payload)
  if (
    input.memberId === auth.dbUser.id &&
    (input.role === 'USER' || input.isActive === false)
  ) {
    throw new ApiError(
      'Use Delete account to remove yourself, and keep your own administrator access active',
      409,
      'SELF_ADMIN_CHANGE',
    )
  }

  const member = await prisma.user.findFirst({
    where: { id: input.memberId, organizationId: auth.organizationId },
  })
  if (!member) throw new ApiError('Member not found', 404, 'NOT_FOUND')
  await ensureAdminWouldRemain(auth.organizationId, member, input)

  const updated = await prisma.user.update({
    where: { id: member.id, organizationId: auth.organizationId },
    data: {
      ...(input.role !== undefined && { role: input.role }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
    },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      lastSeenAt: true,
    },
  })
  invalidateDbUserCache(member.supabaseId)

  if (input.isActive === false) {
    try {
      const { error } = await createAdminClient().auth.admin.signOut(member.supabaseId, 'global')
      if (error) throw new ApiError('Member was suspended, but active sessions could not be revoked', 502, 'SESSION_REVOCATION_FAILED', error)
    } catch (error) {
      if (error instanceof ApiError) throw error
      adminConfigurationError(
        error,
        'Global session revocation is not configured. Ask an operator to set SUPABASE_SERVICE_ROLE_KEY.',
        'SESSION_REVOCATION_NOT_CONFIGURED',
      )
    }
  }

  void recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: 'organization.member.updated',
    resourceType: 'user',
    resourceId: member.id,
    detail: { role: updated.role, isActive: updated.isActive },
  })
  return { success: true, member: updated }
})

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  requireAdmin(auth.dbUser.role)
  const params = request.nextUrl.searchParams
  const invitationId = params.get('invitationId')
  const memberId = params.get('memberId')

  if (invitationId) {
    const result = await prisma.organizationInvitation.updateMany({
      where: {
        id: invitationId,
        organizationId: auth.organizationId,
        acceptedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    })
    if (!result.count) throw new ApiError('Invitation not found', 404, 'NOT_FOUND')
    void recordAudit({
      organizationId: auth.organizationId,
      actorUserId: auth.dbUser.id,
      action: 'organization.invitation.revoked',
      resourceType: 'invitation',
      resourceId: invitationId,
    })
    return { success: true }
  }

  if (!memberId) {
    throw new ApiError('memberId or invitationId is required', 400, 'VALIDATION_ERROR')
  }
  if (memberId === auth.dbUser.id) {
    throw new ApiError('Use Delete account to remove yourself', 409, 'SELF_MEMBER_DELETE')
  }

  const member = await prisma.user.findFirst({
    where: { id: memberId, organizationId: auth.organizationId },
  })
  if (!member) throw new ApiError('Member not found', 404, 'NOT_FOUND')
  await ensureAdminWouldRemain(auth.organizationId, member, { isActive: false })

  let adminClient
  try {
    adminClient = createAdminClient()
  } catch (error) {
    adminConfigurationError(
      error,
      'Member removal is not configured. Ask an operator to set SUPABASE_SERVICE_ROLE_KEY.',
      'MEMBER_REMOVAL_NOT_CONFIGURED',
    )
  }

  // Disable access before touching the identity provider. If an external or
  // database cleanup step fails, the remaining row stays fail-closed.
  await prisma.user.update({
    where: { id: member.id, organizationId: auth.organizationId },
    data: { isActive: false },
  })
  invalidateDbUserCache(member.supabaseId)

  const { error } = await adminClient.auth.admin.deleteUser(member.supabaseId)
  if (error) {
    throw new ApiError(
      'Member access was disabled, but identity cleanup failed',
      502,
      'AUTH_DELETE_FAILED',
      error,
    )
  }
  await prisma.user.delete({
    where: { id: member.id, organizationId: auth.organizationId },
  })

  void recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: 'organization.member.removed',
    resourceType: 'user',
    resourceId: member.id,
  })
  return { success: true }
})
