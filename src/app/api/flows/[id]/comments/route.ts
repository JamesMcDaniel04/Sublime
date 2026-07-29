import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { flowReadScope } from '@/lib/server/visibility'
import { notify } from '@/lib/notifications/service'
import { extractMentions } from '@/lib/flows/comment-mentions'

export const runtime = 'nodejs'

/**
 * Flow Jam comments (Spec 3). Anyone who can OPEN the flow can discuss it —
 * commenting rides read access (like Figma), not edit access. Destructive
 * moderation (resolve/delete another person's thread) stays with the flow
 * owner; authors can always resolve/delete their own.
 */

const anchorPointSchema = z.object({
  space: z.enum(['dag', 'stack']),
  x: z.number().finite(),
  y: z.number().finite(),
})

const createSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  anchorNodeId: z.string().min(1).max(200).optional(),
  anchorPoint: anchorPointSchema.optional(),
  parentId: z.string().min(1).optional(),
})

const resolveSchema = z.object({
  id: z.string().min(1),
  resolved: z.boolean(),
})

const deleteSchema = z.object({ id: z.string().min(1) })

function flowIdOf(request: Request): string {
  const id = new URL(request.url).pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  return id
}

async function readableFlow(id: string, organizationId: string, userId: string) {
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId, ...flowReadScope(userId) },
    select: { id: true, name: true, userId: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  return flow
}

type CommentWithAuthor = {
  id: string
  parentId: string | null
  anchorNodeId: string | null
  anchorPoint: unknown
  body: string
  resolvedAt: Date | null
  createdAt: Date
  user: { id: string; name: string | null; email: string | null }
}

function serializeComment(comment: CommentWithAuthor, selfId: string) {
  const point = anchorPointSchema.safeParse(comment.anchorPoint)
  return {
    id: comment.id,
    parentId: comment.parentId,
    anchorNodeId: comment.anchorNodeId,
    anchorPoint: point.success ? point.data : null,
    body: comment.body,
    resolvedAt: comment.resolvedAt?.toISOString() ?? null,
    createdAt: comment.createdAt.toISOString(),
    author: { id: comment.user.id, name: comment.user.name || comment.user.email || 'Teammate' },
    mine: comment.user.id === selfId,
  }
}

const AUTHOR_SELECT = { select: { id: true, name: true, email: true } } as const

export const GET = withAuthenticatedApi(async (request, auth) => {
  const flow = await readableFlow(flowIdOf(request), auth.organizationId, auth.dbUser.id)
  const comments = await prisma.flowComment.findMany({
    where: { flowId: flow.id, organizationId: auth.organizationId },
    orderBy: { createdAt: 'asc' },
    take: 500,
    include: { user: AUTHOR_SELECT },
  })
  return {
    success: true,
    comments: comments.map((comment) => serializeComment(comment, auth.dbUser.id)),
    canModerate: flow.userId === auth.dbUser.id,
  }
}, { requires: 'member' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const flow = await readableFlow(flowIdOf(request), auth.organizationId, auth.dbUser.id)
  const input = createSchema.parse(await request.json())

  // Replies always attach to the thread's ROOT (threads are one level deep)
  // and inherit its anchor, so a reply can't drift to a different node.
  let rootId: string | null = null
  if (input.parentId) {
    const parent = await prisma.flowComment.findFirst({
      where: { id: input.parentId, flowId: flow.id },
      select: { id: true, parentId: true },
    })
    if (!parent) throw new ApiError('Thread not found', 404, 'NOT_FOUND')
    rootId = parent.parentId ?? parent.id
  }

  // A root comment carries at most ONE anchor: a node beats a free point.
  // Replies inherit the root's anchor, so they carry neither.
  const anchorNodeId = rootId ? null : input.anchorNodeId ?? null
  const anchorPoint = rootId || anchorNodeId ? null : input.anchorPoint ?? null
  const comment = await prisma.flowComment.create({
    data: {
      flowId: flow.id,
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      parentId: rootId,
      anchorNodeId,
      ...(anchorPoint ? { anchorPoint } : {}),
      body: input.body,
    },
    include: { user: AUTHOR_SELECT },
  })

  // @mentions resolve against the canonical member list — parsed server-side
  // so a hand-typed "@Full Name" mentions someone even without autocomplete.
  const mentioned = new Set<string>()
  if (input.body.includes('@')) {
    const members = await prisma.user.findMany({
      where: { organizationId: auth.organizationId, isActive: true, name: { not: null } },
      select: { id: true, name: true },
    })
    for (const userId of extractMentions(input.body, members.map((member) => ({ id: member.id, name: member.name ?? '' })))) {
      mentioned.add(userId)
    }
  }
  mentioned.delete(auth.dbUser.id)

  // Offline delivery: mentioned teammates get the specific "mentioned you"
  // notification; the flow owner and thread participants get the generic one
  // (never both). People with the flow open get the fast path via the jam
  // channel broadcast instead.
  const participants = new Set<string>()
  if (flow.userId) participants.add(flow.userId)
  if (rootId) {
    const thread = await prisma.flowComment.findMany({
      where: { flowId: flow.id, OR: [{ id: rootId }, { parentId: rootId }] },
      select: { userId: true },
    })
    for (const row of thread) participants.add(row.userId)
  }
  participants.delete(auth.dbUser.id)
  for (const userId of mentioned) participants.delete(userId)

  const authorName = auth.dbUser.name || auth.dbUser.email || 'A teammate'
  await Promise.all([
    ...[...mentioned].map((userId) => notify({
      organizationId: auth.organizationId,
      userId,
      type: 'flow.jam.mention',
      level: 'action',
      title: `${authorName} mentioned you on “${flow.name}”`,
      body: input.body.slice(0, 140),
      executionId: flow.id,
      link: `/flows/${flow.id}`,
    })),
    ...[...participants].map((userId) => notify({
      organizationId: auth.organizationId,
      userId,
      type: 'flow.jam.comment',
      level: 'info',
      title: `${authorName} commented on “${flow.name}”`,
      body: input.body.slice(0, 140),
      executionId: flow.id,
      link: `/flows/${flow.id}`,
    })),
  ])

  return { success: true, comment: serializeComment(comment, auth.dbUser.id) }
}, { requires: 'member' })

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const flow = await readableFlow(flowIdOf(request), auth.organizationId, auth.dbUser.id)
  const input = resolveSchema.parse(await request.json())
  const comment = await prisma.flowComment.findFirst({
    where: { id: input.id, flowId: flow.id },
    select: { id: true, userId: true, parentId: true },
  })
  if (!comment) throw new ApiError('Comment not found', 404, 'NOT_FOUND')
  if (comment.parentId) throw new ApiError('Only a thread’s root comment can be resolved', 400, 'INVALID_TARGET')
  if (comment.userId !== auth.dbUser.id && flow.userId !== auth.dbUser.id) {
    throw new ApiError('Only the thread author or the flow owner can resolve it', 403, 'FORBIDDEN')
  }
  await prisma.flowComment.update({
    where: { id: comment.id },
    data: { resolvedAt: input.resolved ? new Date() : null },
  })
  return { success: true }
}, { requires: 'member' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const flow = await readableFlow(flowIdOf(request), auth.organizationId, auth.dbUser.id)
  const input = deleteSchema.parse(await request.json())
  const comment = await prisma.flowComment.findFirst({
    where: { id: input.id, flowId: flow.id },
    select: { id: true, userId: true },
  })
  if (!comment) throw new ApiError('Comment not found', 404, 'NOT_FOUND')
  if (comment.userId !== auth.dbUser.id && flow.userId !== auth.dbUser.id) {
    throw new ApiError('Only the comment author or the flow owner can delete it', 403, 'FORBIDDEN')
  }
  // Deleting a root cascades its replies via the parentId FK.
  await prisma.flowComment.delete({ where: { id: comment.id } })
  return { success: true }
}, { requires: 'member' })
