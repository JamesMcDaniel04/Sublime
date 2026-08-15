import { z } from 'zod'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { prisma } from '@/lib/prisma'
import { recordAudit } from '@/lib/audit'
import { createAdminClient } from '@/lib/supabase/admin'
import { invalidateDbUserCache } from '@/lib/supabase/auth-utils'
import { ApiError } from '@/lib/server/api-handler'
import { teardownOrganization } from '@/lib/org-teardown'
import { assertNotLastAdmin } from '@/lib/server/last-admin'
import { inlineImageDataUrl } from '@/lib/security/inline-image'

const updateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  // Avatars are stored inline as small data URLs (same approach as the org
  // logo, which allows 300k) — 2048 chars couldn't fit any real image and
  // forced the client to compress avatars into mush.
  // Was z.string().url(), which accepts `javascript:` (a valid URL) and any
  // external host. The workspace logo was already locked to an inline data
  // URL; this is the same control, now shared so the two cannot drift.
  imageUrl: inlineImageDataUrl(300_000).nullable().optional(),
})

export const GET = withAuthenticatedApi(async (_request, auth) => ({
  success: true,
  profile: {
    name: auth.dbUser.name,
    email: auth.dbUser.email,
    imageUrl: auth.dbUser.imageUrl,
    role: auth.dbUser.role,
  },
}), { requires: 'member' })

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const input = updateSchema.parse(await request.json())
  const user = await prisma.user.update({
    where: { id: auth.dbUser.id, organizationId: auth.organizationId },
    data: input,
    select: { name: true, email: true, imageUrl: true, role: true },
  })
  // Bust the per-instance auth cache: GET /api/settings/profile and
  // /api/bootstrap serve name/imageUrl straight from it, so without this the
  // saved profile visibly reverted to the old values for up to 60s after a
  // successful save ("my settings didn't save").
  invalidateDbUserCache(auth.user.id)
  void recordAudit({ organizationId: auth.organizationId, actorUserId: auth.dbUser.id, action: 'user.profile.updated', resourceType: 'user', resourceId: auth.dbUser.id })
  return { success: true, profile: { ...user, role: auth.dbUser.role } }
}, { requires: 'member' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const input = z.object({ confirmation: z.literal('DELETE') }).parse(await request.json())
  void input
  const memberCount = await prisma.user.count({ where: { organizationId: auth.organizationId, isActive: true } })
  // Sole member leaving takes the whole workspace with them, so there is
  // nothing left to administer — allowWhenSoleMember covers that. Otherwise
  // the last admin must promote a successor first.
  await assertNotLastAdmin(auth.organizationId, auth.dbUser.id, {
    allowWhenSoleMember: true,
    message: 'Promote another administrator before deleting your account',
  })
  if (memberCount === 1) await teardownOrganization(auth.organizationId, { actorUserId: auth.dbUser.id })
  else await prisma.user.delete({ where: { id: auth.dbUser.id, organizationId: auth.organizationId } })
  // Bust the auth-path cache before the identity-provider call: even if that
  // cleanup fails, no request may keep resolving to the deleted row.
  invalidateDbUserCache(auth.user.id)
  const { error } = await createAdminClient().auth.admin.deleteUser(auth.user.id)
  if (error) throw new ApiError('Account data was removed, but the identity provider cleanup failed', 502, 'AUTH_DELETE_FAILED', error)
  return { success: true }
}, { requires: 'member' })
