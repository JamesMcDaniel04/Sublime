import { z } from 'zod'
import { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentWriteScope } from '@/lib/server/visibility'
import { snapshotAgentConfig, agentConfigForRun, AGENT_CONFIG_FIELDS } from '@/lib/agents/publish'
import { recordUserEvent } from '@/lib/behavior/record-event'

export const runtime = 'nodejs'

const bodySchema = z
  .object({
    revert: z.boolean().default(false),
    unpublish: z.boolean().default(false),
  })
  .refine((body) => !(body.revert && body.unpublish), {
    message: 'Choose one of revert or unpublish',
  })

/**
 * POST /api/agents/[id]/publish — the agent lifecycle endpoint.
 *
 * Mirrors the flow one deliberately, including its verbs, so the two
 * lifecycles read alike:
 *
 *   default     — publish the draft: snapshot the live config, bump version
 *   { revert }  — throw the draft away and restore it from the published copy
 *   { unpublish } — drop back to live-on-save (publishedConfig = NULL)
 *
 * `unpublish` restores today's behaviour rather than disabling the agent —
 * status is a separate axis on purpose, so retracting a publish never takes a
 * working agent offline.
 */
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Agent id is required')
  const { revert, unpublish } = bodySchema.parse(await request.json().catch(() => ({})))

  const existing = await prisma.agentTask.findFirst({
    where: { id, organizationId: auth.organizationId, ...agentWriteScope(auth.dbUser.id) },
  })
  if (!existing) throw new ApiError('Agent not found', 404, 'NOT_FOUND')

  if (unpublish) {
    const agent = await prisma.agentTask.update({
      where: { id: existing.id, organizationId: auth.organizationId },
      // Prisma.DbNull, not undefined and not null: `undefined` means "leave
      // this field alone" in a Prisma update (so unpublish silently did
      // nothing), and a bare `null` on a Json column writes JSON null rather
      // than SQL NULL — which would then read back as a truthy object and
      // keep the agent looking published.
      //
      // Deliberately does NOT touch status: retracting a publish must not take
      // a working agent offline.
      data: { publishedConfig: Prisma.DbNull, publishedAt: null },
    })
    return { success: true as const, published: false, version: agent.version }
  }

  if (revert) {
    if (!existing.publishedConfig) {
      throw new ApiError('This agent has never been published, so there is nothing to revert to', 400, 'NOT_PUBLISHED')
    }
    // Restore each config field from the snapshot. Written field by field
    // rather than as a blob so a snapshot predating a field leaves that
    // field's live value alone instead of clearing it.
    const restored = agentConfigForRun(existing)
    const agent = await prisma.agentTask.update({
      where: { id: existing.id, organizationId: auth.organizationId },
      data: Object.fromEntries(
        AGENT_CONFIG_FIELDS.filter((field) => restored[field] !== undefined).map((field) => [field, restored[field]]),
      ) as never,
    })
    return { success: true as const, reverted: true, version: agent.version }
  }

  const agent = await prisma.agentTask.update({
    where: { id: existing.id, organizationId: auth.organizationId },
    data: {
      publishedConfig: snapshotAgentConfig(existing) as never,
      publishedAt: new Date(),
      version: { increment: 1 },
    },
  })

  await recordUserEvent({
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    kind: 'agent_published',
    resourceType: 'agent',
    resourceId: agent.id,
    context: { version: agent.version },
  }).catch(() => undefined)

  return { success: true as const, published: true, version: agent.version, publishedAt: agent.publishedAt }
}, { requires: 'member' })
