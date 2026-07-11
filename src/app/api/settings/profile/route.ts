import { z } from 'zod'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { prisma } from '@/lib/prisma'
import { recordAudit } from '@/lib/audit'

const updateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  timezone: z.string().trim().min(1).max(100),
  imageUrl: z.string().url().max(2048).nullable().optional(),
})

export const GET = withAuthenticatedApi(async (_request, auth) => ({
  success: true,
  profile: {
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
    select: { name: true, email: true, imageUrl: true, timezone: true, role: true },
  })
  void recordAudit({ organizationId: auth.organizationId, actorUserId: auth.dbUser.id, action: 'user.profile.updated', resourceType: 'user', resourceId: auth.dbUser.id })
  return { success: true, profile: user }
})
