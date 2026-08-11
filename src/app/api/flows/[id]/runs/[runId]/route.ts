import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { flowReadScope, flowRunVisibilityScope } from '@/lib/server/visibility'

// DELETE /api/flows/[id]/runs/[runId] — remove a run (and, via cascade, its
// steps) from history. Only settled runs are deletable: a running/waiting run
// still has an executor (or a pending reply) attached to it, and deleting the
// row out from under either would strand them. Scope mirrors run visibility —
// you can delete the runs you can see: your own, plus ownerless legacy runs
// when you own the flow.
const DELETABLE_STATUSES = new Set(['succeeded', 'failed', 'stopped'])

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const parts = request.nextUrl.pathname.split('/')
  const flowId = parts.at(-3)
  const runId = parts.at(-1)
  if (!flowId || !runId) throw new ApiError('Flow and run ids are required')

  const flow = await prisma.flow.findFirst({
    where: { id: flowId, organizationId: auth.organizationId, ...flowReadScope(auth.dbUser.id) },
    select: { id: true, userId: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')

  const run = await prisma.flowRun.findFirst({
    where: { id: runId, flowId, organizationId: auth.organizationId, ...flowRunVisibilityScope(auth.dbUser.id, flow.userId) },
    select: { id: true, status: true },
  })
  if (!run) throw new ApiError('Run not found', 404, 'NOT_FOUND')
  if (!DELETABLE_STATUSES.has(run.status)) {
    throw new ApiError('Only finished runs can be deleted — stop or resume this run first.', 409, 'RUN_NOT_SETTLED')
  }

  await prisma.flowRun.delete({ where: { id: run.id, organizationId: auth.organizationId } })
  return { success: true }
}, { requires: 'member' })

// PATCH /api/flows/[id]/runs/[runId] { action: 'stop' } — stop a live run.
//
// A `waiting` run has NO executor attached (it's parked on a reply or a wake
// timer), so it settles to `stopped` immediately and its waiting steps are
// terminalized. A `running` run has a live executor: the row flips to
// `stopping` and the interpreter honors it cooperatively at the next node
// boundary (in-flight work finishes — nothing is killed mid-write). If the
// executor died, the stuck-run reaper sweeps `stopping` rows too.
const patchSchema = z.object({ action: z.literal('stop') })

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  patchSchema.parse(await request.json())
  const parts = request.nextUrl.pathname.split('/')
  const flowId = parts.at(-3)
  const runId = parts.at(-1)
  if (!flowId || !runId) throw new ApiError('Flow and run ids are required')

  const flow = await prisma.flow.findFirst({
    where: { id: flowId, organizationId: auth.organizationId, ...flowReadScope(auth.dbUser.id) },
    select: { id: true, userId: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')

  const run = await prisma.flowRun.findFirst({
    where: { id: runId, flowId, organizationId: auth.organizationId, ...flowRunVisibilityScope(auth.dbUser.id, flow.userId) },
    select: { id: true, status: true },
  })
  if (!run) throw new ApiError('Run not found', 404, 'NOT_FOUND')

  if (run.status === 'waiting') {
    // Status-guarded so a concurrent resume wins cleanly instead of being
    // stomped: the resume path claims waiting→running with the same guard.
    const updated = await prisma.flowRun.updateMany({
      where: { id: run.id, organizationId: auth.organizationId, status: 'waiting' },
      data: { status: 'stopped', finishedAt: new Date(), wakeAt: null },
    })
    if (updated.count === 0) throw new ApiError('The run resumed before it could be stopped.', 409, 'RUN_MOVED')
    await prisma.flowRunStep.updateMany({
      where: { flowRunId: run.id, status: 'waiting' },
      data: { status: 'stopped', finishedAt: new Date() },
    })
    return { success: true, status: 'stopped' }
  }

  if (run.status === 'queued' || run.status === 'claimed') {
    const updated = await prisma.flowRun.updateMany({
      where: { id: run.id, organizationId: auth.organizationId, status: { in: ['queued', 'claimed'] } },
      data: { status: 'stopped', finishedAt: new Date(), workerId: null, leaseExpiresAt: null },
    })
    if (updated.count === 0) throw new ApiError('The run started before it could be stopped.', 409, 'RUN_MOVED')
    await prisma.flowDispatchOutbox.updateMany({
      where: { flowRunId: run.id, organizationId: auth.organizationId, status: { in: ['pending', 'publishing', 'published', 'failed'] } },
      data: { status: 'consumed', consumedAt: new Date(), lastError: 'Stopped before execution' },
    })
    return { success: true, status: 'stopped' }
  }

  if (run.status === 'running' || run.status === 'stopping') {
    const updated = await prisma.flowRun.updateMany({
      where: { id: run.id, organizationId: auth.organizationId, status: { in: ['running', 'stopping'] } },
      data: { status: 'stopping' },
    })
    if (updated.count === 0) throw new ApiError('The run settled before it could be stopped.', 409, 'RUN_MOVED')
    return { success: true, status: 'stopping' }
  }

  throw new ApiError('Only running or waiting runs can be stopped.', 409, 'RUN_SETTLED')
}, { requires: 'member' })
