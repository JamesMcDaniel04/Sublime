import { z } from 'zod'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { prisma } from '@/lib/prisma'
import { recordAudit } from '@/lib/audit'
import { createAdminClient } from '@/lib/supabase/admin'
import { invalidateDbUserCache } from '@/lib/supabase/auth-utils'
import { ApiError } from '@/lib/server/api-handler'
import { teardownOrganization } from '@/lib/org-teardown'

const updateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  // Avatars are stored inline as small data URLs (same approach as the org
  // logo, which allows 300k) — 2048 chars couldn't fit any real image and
  // forced the client to compress avatars into mush.
  imageUrl: z.string().url().max(300_000).nullable().optional(),
})

export const GET = withAuthenticatedApi(async (_request, auth) => ({
  success: true,
  profile: {
    name: auth.dbUser.name,
    email: auth.dbUser.email,
    imageUrl: auth.dbUser.imageUrl,
    role: auth.dbUser.role,
  },
}))

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const input = updateSchema.parse(await request.json())
  const user = await prisma.user.update({
    where: { id: auth.dbUser.id, organizationId: auth.organizationId },
    data: input,
    select: { name: true, email: true, imageUrl: true, role: true },
  })
  void recordAudit({ organizationId: auth.organizationId, actorUserId: auth.dbUser.id, action: 'user.profile.updated', resourceType: 'user', resourceId: auth.dbUser.id })
  return { success: true, profile: { ...user, role: auth.dbUser.role } }
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
  if (memberCount === 1) await teardownOrganization(auth.organizationId)
  else await prisma.user.delete({ where: { id: auth.dbUser.id, organizationId: auth.organizationId } })
  // Bust the auth-path cache before the identity-provider call: even if that
  // cleanup fails, no request may keep resolving to the deleted row.
  invalidateDbUserCache(auth.user.id)
  const { error } = await createAdminClient().auth.admin.deleteUser(auth.user.id)
  if (error) throw new ApiError('Account data was removed, but the identity provider cleanup failed', 502, 'AUTH_DELETE_FAILED', error)
  return { success: true }
})
