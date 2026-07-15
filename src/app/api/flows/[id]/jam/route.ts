import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { prisma } from '@/lib/prisma'
import { notify } from '@/lib/notifications/service'

export const runtime = 'nodejs'

const accessSchema = z.object({
  userIds: z.array(z.string().min(1)).max(200).transform((ids) => [...new Set(ids)]),
})

async function ownedFlow(id: string, organizationId: string, userId: string) {
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId, userId },
    select: { id: true, name: true },
  })
  if (!flow) throw new ApiError('Only the flow owner can manage Jam access', 403, 'FORBIDDEN')
  return flow
}

function flowId(request: Request): string {
  const id = new URL(request.url).pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  return id
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = flowId(request)
  await ownedFlow(id, auth.organizationId, auth.dbUser.id)
  const collaborators = await prisma.flowCollaborator.findMany({
    where: { flowId: id, organizationId: auth.organizationId },
    select: { userId: true },
  })
  return { success: true, userIds: collaborators.map((entry) => entry.userId) }
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = flowId(request)
  const flow = await ownedFlow(id, auth.organizationId, auth.dbUser.id)
  const input = accessSchema.parse(await request.json())
  const requestedIds = input.userIds.filter((userId) => userId !== auth.dbUser.id)

  const members = requestedIds.length
    ? await prisma.user.findMany({
        where: {
          id: { in: requestedIds },
          organizationId: auth.organizationId,
          isActive: true,
        },
        select: { id: true },
      })
    : []
  if (members.length !== requestedIds.length) {
    throw new ApiError('One or more collaborators are not active workspace members', 400, 'INVALID_COLLABORATOR')
  }

  const existing = await prisma.flowCollaborator.findMany({
    where: { flowId: id, organizationId: auth.organizationId },
    select: { userId: true },
  })
  const existingIds = new Set(existing.map((entry) => entry.userId))
  const addedIds = requestedIds.filter((userId) => !existingIds.has(userId))

  await prisma.$transaction([
    prisma.flowCollaborator.deleteMany({
      where: {
        flowId: id,
        organizationId: auth.organizationId,
        ...(requestedIds.length ? { userId: { notIn: requestedIds } } : {}),
      },
    }),
    prisma.flowCollaborator.createMany({
      data: requestedIds.map((userId) => ({
        flowId: id,
        organizationId: auth.organizationId,
        userId,
        invitedById: auth.dbUser.id,
      })),
      skipDuplicates: true,
    }),
    prisma.flow.updateMany({
      where: { id, organizationId: auth.organizationId, userId: auth.dbUser.id },
      data: { collaborationAccessRevision: { increment: 1 } },
    }),
  ])

  await Promise.all(addedIds.map((userId) => notify({
    organizationId: auth.organizationId,
    userId,
    type: 'flow.jam.invite',
    level: 'action',
    title: `${auth.dbUser.name || auth.dbUser.email || 'A teammate'} invited you to a Flow Jam`,
    body: `Build “${flow.name}” together in real time.`,
    // The in-app row deep-links off executionId (flow notifications overload it
    // to carry the flow id); `link` only drives the web-push URL. Set both so
    // clicking the notification — in-app or push — lands in the live jam.
    executionId: flow.id,
    link: `/flows/${flow.id}`,
  })))

  return {
    success: true,
    invited: addedIds.length,
    collaborators: requestedIds.length,
    userIds: requestedIds,
  }
})
