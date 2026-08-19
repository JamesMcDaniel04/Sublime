import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentReadScope, agentWriteScope } from '@/lib/server/visibility'
import { ROLE_LABEL_MAX_CHARS, normalizeRoleLabel } from '@/lib/agents/role-label'
import { serializeWorker } from '@/lib/agents/worker-serialize'

/** Same cap as the snapshot roster. */
const MAX_WORKERS = 300

// Mirrors the roleLabel field in /api/agents/route.ts — kept as a local copy so
// lib/agents/role-label.ts stays zod-free and out of the client bundle.
const roleLabelField = z
  .string()
  .trim()
  .max(60)
  .refine((value) => value === '' || normalizeRoleLabel(value) !== null, {
    message: `Role must be one or two words, ${ROLE_LABEL_MAX_CHARS} characters max`,
  })
  .transform((value) => (value === '' ? null : normalizeRoleLabel(value)))
  .nullish()

/**
 * Load the agents a user may MOVE, failing loudly on any they may not.
 *
 * Putting an agent under a worker changes that agent, so it takes agent write
 * access — worker membership must never become a side door around the agent
 * sharing rules.
 */
async function assertMovableAgents(agentIds: string[], organizationId: string, userId: string) {
  if (agentIds.length === 0) return
  const writable = await prisma.agentTask.findMany({
    where: { id: { in: agentIds }, organizationId, ...agentWriteScope(userId) },
    select: { id: true },
  })
  if (writable.length !== new Set(agentIds).size) {
    throw new ApiError('You can only move agents you are allowed to edit', 403, 'FORBIDDEN')
  }
}

/**
 * The roster's workers: one avatar and role per worker, with the agents that
 * work under it.
 *
 * A worker is listed when the viewer can see at least one of its agents, or
 * when they created it — so a worker you just made is visible while still
 * empty, but one whose agents are all private to someone else stays hidden.
 */
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const workers = await prisma.agentWorker.findMany({
    where: { organizationId: auth.organizationId },
    orderBy: { updatedAt: 'desc' },
    take: MAX_WORKERS,
  })
  if (workers.length === 0) return { success: true, workers: [] }

  const members = await prisma.agentTask.findMany({
    where: {
      organizationId: auth.organizationId,
      status: { not: 'DELETED' },
      agentType: { not: 'SYSTEM' },
      workerId: { in: workers.map((worker) => worker.id) },
      ...agentReadScope(auth.dbUser.id),
    },
    select: { id: true, workerId: true },
  })
  const byWorker = new Map<string, string[]>()
  for (const member of members) {
    if (!member.workerId) continue
    byWorker.set(member.workerId, [...(byWorker.get(member.workerId) ?? []), member.id])
  }

  return {
    success: true,
    workers: workers
      .filter((worker) => byWorker.has(worker.id) || worker.userId === auth.dbUser.id)
      .map((worker) => serializeWorker(worker, byWorker.get(worker.id) ?? [])),
  }
}, { requires: 'member' })

/** Hire a worker: an identity, optionally with agents moved under it at once. */
export const POST = withAuthenticatedApi(async (request, auth) => {
  const body = z.object({
    name: z.string().trim().min(1).max(60),
    avatarSeed: z.string().trim().max(64).optional(),
    roleLabel: roleLabelField,
    agentIds: z.array(z.string().min(1)).max(50).default([]),
  }).parse(await request.json())

  await assertMovableAgents(body.agentIds, auth.organizationId, auth.dbUser.id)

  const worker = await prisma.agentWorker.create({
    data: {
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      name: body.name,
      avatarSeed: body.avatarSeed || null,
      roleLabel: body.roleLabel ?? null,
    },
  })
  if (body.agentIds.length > 0) {
    await prisma.agentTask.updateMany({
      where: { id: { in: body.agentIds }, organizationId: auth.organizationId },
      data: { workerId: worker.id },
    })
  }
  return { success: true, worker: serializeWorker(worker, body.agentIds) }
}, { requires: 'member' })

/** Rename, re-skin, relabel, or change which agents work under this worker. */
export const PUT = withAuthenticatedApi(async (request, auth) => {
  const body = z.object({
    id: z.string().min(1),
    name: z.string().trim().min(1).max(60).optional(),
    avatarSeed: z.string().trim().max(64).nullish(),
    roleLabel: roleLabelField,
    addAgentIds: z.array(z.string().min(1)).max(50).optional(),
    removeAgentIds: z.array(z.string().min(1)).max(50).optional(),
  }).parse(await request.json())

  const existing = await prisma.agentWorker.findFirst({
    where: { id: body.id, organizationId: auth.organizationId },
  })
  if (!existing) throw new ApiError('Worker not found', 404, 'NOT_FOUND')

  await assertMovableAgents(
    [...(body.addAgentIds ?? []), ...(body.removeAgentIds ?? [])],
    auth.organizationId,
    auth.dbUser.id,
  )

  const worker = await prisma.agentWorker.update({
    where: { id: body.id, organizationId: auth.organizationId },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.avatarSeed !== undefined && { avatarSeed: body.avatarSeed || null }),
      ...(body.roleLabel !== undefined && { roleLabel: body.roleLabel ?? null }),
    },
  })

  if (body.addAgentIds?.length) {
    await prisma.agentTask.updateMany({
      where: { id: { in: body.addAgentIds }, organizationId: auth.organizationId },
      data: { workerId: worker.id },
    })
  }
  if (body.removeAgentIds?.length) {
    // Scoped to THIS worker so a stale client cannot detach an agent that has
    // since moved under a different one.
    await prisma.agentTask.updateMany({
      where: { id: { in: body.removeAgentIds }, organizationId: auth.organizationId, workerId: worker.id },
      data: { workerId: null },
    })
  }

  const members = await prisma.agentTask.findMany({
    where: {
      organizationId: auth.organizationId,
      workerId: worker.id,
      status: { not: 'DELETED' },
      ...agentReadScope(auth.dbUser.id),
    },
    select: { id: true },
  })
  return { success: true, worker: serializeWorker(worker, members.map((member) => member.id)) }
}, { requires: 'member' })

/**
 * Remove the identity, never the work: the FK is ON DELETE SET NULL, so the
 * agents that worked under this worker survive and return to the roster as
 * standalone tiles with their run history intact.
 */
export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { id } = z.object({ id: z.string().min(1) }).parse(await request.json())
  const deleted = await prisma.agentWorker.deleteMany({
    where: { id, organizationId: auth.organizationId },
  })
  if (deleted.count === 0) throw new ApiError('Worker not found', 404, 'NOT_FOUND')
  return { success: true }
}, { requires: 'member' })
