import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { flowReadScope, flowWriteScope } from '@/lib/server/visibility'
import { serializeFlow } from '@/lib/flows/serialize'

function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

// GET /api/flows/[id]/versions — list published snapshots (no graph payload),
// or ?version=N for a single snapshot with its graph (view overlay).
// POST /api/flows/[id]/versions — { version, action: 'restore' } copies that
// snapshot's graph into the flow's draft. id is the segment before "versions".
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')

  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...flowReadScope(auth.dbUser.id) },
    select: { id: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')

  const versionParam = request.nextUrl.searchParams.get('version')
  if (versionParam != null) {
    const version = z.coerce.number().int().positive().parse(versionParam)
    const row = await prisma.flowVersion.findFirst({
      where: { flowId: id, organizationId: auth.organizationId, version },
    })
    if (!row) throw new ApiError('Version not found', 404, 'NOT_FOUND')
    return { success: true, version: row }
  }

  const versions = await prisma.flowVersion.findMany({
    where: { flowId: id, organizationId: auth.organizationId },
    orderBy: { version: 'desc' },
    take: 50,
    select: { id: true, version: true, note: true, publishedAt: true, publishedBy: true },
  })
  return { success: true, versions }
}, { requires: 'member' })

const restoreSchema = z.object({ version: z.number().int().positive(), action: z.literal('restore') })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')

  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...flowWriteScope(auth.dbUser.id) },
    select: { id: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')

  const { version } = restoreSchema.parse(await request.json())
  const row = await prisma.flowVersion.findFirst({
    where: { flowId: id, organizationId: auth.organizationId, version },
  })
  if (!row) throw new ApiError('Version not found', 404, 'NOT_FOUND')

  const updated = await prisma.flow.update({ where: { id, organizationId: auth.organizationId }, data: { graph: jsonValue(row.graph) } })
  return { success: true, flow: serializeFlow(updated) }
}, { requires: 'member' })

// PATCH /api/flows/[id]/versions — { version, note } edits a snapshot's note.
// Write scope (owner / collaborator / org_editor), same as publishing.
const noteSchema = z.object({ version: z.number().int().positive(), note: z.string().trim().max(200) })

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')

  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...flowWriteScope(auth.dbUser.id) },
    select: { id: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')

  const { version, note } = noteSchema.parse(await request.json())
  const result = await prisma.flowVersion.updateMany({
    where: { flowId: id, organizationId: auth.organizationId, version },
    data: { note: note || null },
  })
  if (!result.count) throw new ApiError('Version not found', 404, 'NOT_FOUND')
  return { success: true }
}, { requires: 'member' })

// DELETE /api/flows/[id]/versions?version=N — remove a snapshot from history.
// Owner-only: deleting history is destructive and cannot be undone. The
// snapshot is a copy (the flow's published graph is stored on the flow row),
// so removing any version never breaks the live published flow.
export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')

  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, userId: auth.dbUser.id },
    select: { id: true },
  })
  if (!flow) throw new ApiError('Only the flow owner can delete version history', 403, 'FORBIDDEN')

  const version = z.coerce.number().int().positive().parse(request.nextUrl.searchParams.get('version'))
  const result = await prisma.flowVersion.deleteMany({
    where: { flowId: id, organizationId: auth.organizationId, version },
  })
  if (!result.count) throw new ApiError('Version not found', 404, 'NOT_FOUND')
  return { success: true }
}, { requires: 'member' })
