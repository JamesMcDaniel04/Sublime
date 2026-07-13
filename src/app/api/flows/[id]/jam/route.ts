import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { prisma } from '@/lib/prisma'
import { notify } from '@/lib/notifications/service'

export const runtime = 'nodejs'

// POST /api/flows/[id]/jam — invite org members to a Flow Jam. Each invitee
// gets an in-app notification + web push deep-linking into the builder, where
// joining is just opening the flow (presence connects automatically).
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId },
    select: { id: true, name: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')

  const { userIds } = z.object({ userIds: z.array(z.string().min(1)).min(1).max(50) }).parse(await request.json())
  // Only active members of THIS org can be invited — a foreign id is dropped.
  const members = await prisma.user.findMany({
    where: { id: { in: userIds }, organizationId: auth.organizationId, isActive: true },
    select: { id: true },
  })
  const inviterName = auth.dbUser.name || auth.dbUser.email || 'A teammate'
  await Promise.all(
    members
      .filter((member) => member.id !== auth.dbUser.id)
      .map((member) =>
        notify({
          organizationId: auth.organizationId,
          userId: member.id,
          type: 'flow.jam',
          level: 'action',
          title: `${inviterName} invited you to jam on "${flow.name}"`,
          body: 'Open the flow to build together in real time.',
          executionId: flow.id, // bell derives flow links from executionId
          link: `/flows/${flow.id}`,
        }),
      ),
  )
  return { success: true, invited: members.length }
})
