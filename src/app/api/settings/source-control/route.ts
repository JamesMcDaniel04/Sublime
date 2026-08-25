import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordAudit } from '@/lib/audit'
import { encryptSecret, decryptSecret } from '@/lib/crypto/secrets'
import { pushPlan, pullPlan, type LocalFlow } from '@/lib/source-control/sync-plan'
import { verifyRepo, listFlowFiles, applyPush, type RepoBinding } from '@/lib/source-control/github'
import type { Prisma } from '@/generated/prisma/client'

/**
 * Git-backed flows.
 *
 * Admin-only: binding a workspace to a repository decides where its automation
 * definitions are published, and pulling can rewrite every flow in it.
 *
 * Every mutating direction is preview-then-apply. `plan` says exactly what
 * would change and writes nothing; `push`/`pull` do the work. A sync that
 * applies changes nobody saw is worse than no sync at all — the reason to put
 * flows in a repository is that somebody reviews the change.
 */

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('connect'),
    repo: z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/, 'Use owner/repository.'),
    branch: z.string().trim().min(1).max(200).default('main'),
    token: z.string().trim().min(1).max(500),
  }),
  z.object({ action: z.literal('disconnect') }),
  z.object({ action: z.literal('plan'), direction: z.enum(['push', 'pull']) }),
  z.object({ action: z.literal('push'), message: z.string().trim().max(200).optional() }),
  z.object({ action: z.literal('pull') }),
])

interface StoredBinding {
  repo: string
  branch: string
  tokenEnc: string
}

function storedBinding(settings: unknown): StoredBinding | null {
  const raw = settings && typeof settings === 'object' ? (settings as Record<string, unknown>) : {}
  const sc = raw.sourceControl && typeof raw.sourceControl === 'object' ? (raw.sourceControl as Record<string, unknown>) : null
  if (!sc || typeof sc.repo !== 'string' || typeof sc.tokenEnc !== 'string') return null
  return { repo: sc.repo, branch: typeof sc.branch === 'string' ? sc.branch : 'main', tokenEnc: sc.tokenEnc }
}

async function writeSourceControl(organizationId: string, settings: unknown, value: StoredBinding | null) {
  const raw = settings && typeof settings === 'object' ? { ...(settings as Record<string, unknown>) } : {}
  if (value) raw.sourceControl = value
  else delete raw.sourceControl
  await prisma.organization.update({
    where: { id: organizationId },
    data: { settings: raw as Prisma.InputJsonValue },
  })
}

/** The stored binding with its token decrypted, ready to use. */
function usableBinding(stored: StoredBinding | null): RepoBinding {
  if (!stored) throw new ApiError('No repository is connected.', 409, 'NOT_CONNECTED')
  return { repo: stored.repo, branch: stored.branch, token: decryptSecret(stored.tokenEnc) }
}

async function localFlows(organizationId: string): Promise<LocalFlow[]> {
  return prisma.flow.findMany({
    where: { organizationId },
    select: { id: true, name: true, description: true, trigger: true, graph: true },
    orderBy: { id: 'asc' },
  })
}

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const organization = await prisma.organization.findFirstOrThrow({
    where: { id: auth.organizationId },
    select: { settings: true },
  })
  const stored = storedBinding(organization.settings)
  return {
    success: true,
    connected: stored !== null,
    // The token is never returned, in any form. There is no reveal endpoint.
    repo: stored?.repo ?? null,
    branch: stored?.branch ?? null,
  }
}, { requires: 'settings:workspace' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const body = bodySchema.parse(await request.json())
  const organization = await prisma.organization.findFirstOrThrow({
    where: { id: auth.organizationId },
    select: { settings: true },
  })
  const stored = storedBinding(organization.settings)

  if (body.action === 'connect') {
    // Verified BEFORE storing: a binding that does not work should fail here,
    // where someone is watching, rather than at the first push.
    const check = await verifyRepo({ repo: body.repo, branch: body.branch, token: body.token })
    if (!check.ok) throw new ApiError(check.error ?? 'The repository could not be reached.', 400, 'REPO_UNREACHABLE')

    await writeSourceControl(auth.organizationId, organization.settings, {
      repo: body.repo,
      branch: body.branch,
      tokenEnc: encryptSecret(body.token),
    })
    await recordAudit({
      organizationId: auth.organizationId, actorUserId: auth.dbUser.id,
      action: 'source_control.connected', resourceType: 'organization', resourceId: auth.organizationId,
      detail: { repo: body.repo, branch: body.branch },
    })
    return { success: true, repo: body.repo, branch: body.branch }
  }

  if (body.action === 'disconnect') {
    await writeSourceControl(auth.organizationId, organization.settings, null)
    await recordAudit({
      organizationId: auth.organizationId, actorUserId: auth.dbUser.id,
      action: 'source_control.disconnected', resourceType: 'organization', resourceId: auth.organizationId,
    })
    return { success: true }
  }

  const binding = usableBinding(stored)
  const [flows, remote] = await Promise.all([localFlows(auth.organizationId), listFlowFiles(binding)])

  if (body.action === 'plan') {
    return body.direction === 'push'
      ? { success: true, direction: 'push', changes: pushPlan(flows, remote) }
      : { success: true, direction: 'pull', changes: pullPlan(flows, remote) }
  }

  if (body.action === 'push') {
    const changes = pushPlan(flows, remote)
    if (changes.length === 0) return { success: true, applied: 0, changes: [] }

    const result = await applyPush(binding, changes, body.message?.trim() || `Sync flows from Sublime`)
    await recordAudit({
      organizationId: auth.organizationId, actorUserId: auth.dbUser.id,
      action: 'source_control.pushed', resourceType: 'organization', resourceId: auth.organizationId,
      detail: { repo: binding.repo, branch: binding.branch, changes: changes.map((c) => `${c.action} ${c.path}`) },
    })
    return { success: true, applied: result.applied, changes }
  }

  // pull
  const changes = pullPlan(flows, remote)
  for (const change of changes) {
    const incoming = change.flow as { name?: string; description?: string; trigger?: unknown; graph?: unknown } | null
    if (!incoming) continue

    if (change.action === 'create') {
      await prisma.flow.create({
        data: {
          id: change.flowId,
          organizationId: auth.organizationId,
          userId: auth.dbUser.id,
          name: incoming.name ?? 'Untitled',
          description: incoming.description ?? '',
          trigger: (incoming.trigger ?? { type: 'manual' }) as Prisma.InputJsonValue,
          graph: (incoming.graph ?? { nodes: [], edges: [] }) as Prisma.InputJsonValue,
          // Pulled flows arrive as DRAFTS. A repository is not a deploy
          // channel: publishing is a separate, deliberate act, and a pull that
          // silently activated flows would let a merged PR start running
          // automation in production with nobody deciding to.
          status: 'DRAFT',
        },
      })
      continue
    }

    await prisma.flow.updateMany({
      where: { id: change.flowId, organizationId: auth.organizationId },
      data: {
        name: incoming.name ?? undefined,
        description: incoming.description ?? undefined,
        trigger: (incoming.trigger ?? undefined) as Prisma.InputJsonValue,
        // The DRAFT graph only. publishedGraph is what runs, and rewriting it
        // from a pull would change production without anyone publishing.
        graph: (incoming.graph ?? undefined) as Prisma.InputJsonValue,
      },
    })
  }

  if (changes.length > 0) {
    await recordAudit({
      organizationId: auth.organizationId, actorUserId: auth.dbUser.id,
      action: 'source_control.pulled', resourceType: 'organization', resourceId: auth.organizationId,
      detail: { repo: binding.repo, branch: binding.branch, changes: changes.map((c) => `${c.action} ${c.flowId}`) },
    })
  }

  return {
    success: true,
    applied: changes.length,
    changes,
    note: changes.length > 0
      ? 'Pulled flows are drafts. Publish them for the changes to affect scheduled and triggered runs.'
      : undefined,
  }
}, { requires: 'settings:workspace' })
