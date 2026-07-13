import { z } from 'zod'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { prisma } from '@/lib/prisma'
import { recordAudit } from '@/lib/audit'
import { createAdminClient, SupabaseAdminConfigurationError } from '@/lib/supabase/admin'
import { ApiError } from '@/lib/server/api-handler'
import { teardownOrganization } from '@/lib/org-teardown'

const updateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((timezone) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
        return true
      } catch {
        return false
      }
    }, 'Use a valid IANA timezone such as America/Denver'),
  imageUrl: z.string().url().max(2048).nullable().optional(),
})

export const GET = withAuthenticatedApi(async (_request, auth) => ({
  success: true,
  profile: {
    id: auth.dbUser.id,
    name: auth.dbUser.name,
    email: auth.dbUser.email,
    imageUrl: auth.dbUser.imageUrl,
    timezone: auth.dbUser.timezone,
    role: auth.dbUser.role,
  },
}))

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const input = updateSchema.parse(await request.json())
  const user = await prisma.user.update({
    where: { id: auth.dbUser.id, organizationId: auth.organizationId },
    data: input,
    select: { id: true, name: true, email: true, imageUrl: true, timezone: true, role: true },
  })
  void recordAudit({ organizationId: auth.organizationId, actorUserId: auth.dbUser.id, action: 'user.profile.updated', resourceType: 'user', resourceId: auth.dbUser.id })
  return { success: true, profile: user }
})

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const input = z.object({ confirmation: z.literal('DELETE') }).parse(await request.json())
  void input
  const [memberCount, adminCount] = await Promise.all([
    prisma.user.count({ where: { organizationId: auth.organizationId, isActive: true } }),
    prisma.user.count({ where: { organizationId: auth.organizationId, isActive: true, role: 'ADMIN' } }),
  ])
  if (memberCount > 1 && auth.dbUser.role === 'ADMIN' && adminCount <= 1) {
    throw new ApiError('Promote another administrator before deleting your account', 409, 'LAST_ADMIN')
  }

  let adminClient
  try {
    adminClient = createAdminClient()
  } catch (error) {
    if (error instanceof SupabaseAdminConfigurationError) {
      throw new ApiError(
        'Account deletion is not configured. Ask an operator to set SUPABASE_SERVICE_ROLE_KEY.',
        503,
        'ACCOUNT_DELETION_NOT_CONFIGURED',
        error,
      )
    }
    throw error
  }

  // Remove the identity first. If database cleanup then fails, the remaining
  // app data is inaccessible and can be safely retried by an operator; doing
  // this in the opposite order could let a still-valid identity re-provision.
  const { error } = await adminClient.auth.admin.deleteUser(auth.user.id)
  if (error) {
    throw new ApiError('Identity provider cleanup failed; no account data was removed', 502, 'AUTH_DELETE_FAILED', error)
  }
  if (memberCount === 1) await teardownOrganization(auth.organizationId)
  else await prisma.user.delete({ where: { id: auth.dbUser.id, organizationId: auth.organizationId } })
  return { success: true }
})
