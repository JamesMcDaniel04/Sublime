import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { flowReadScope, flowOwnerScope, agentReadScope } from '@/lib/server/visibility'
import { flowGraphSchema } from '@/lib/flows/graph'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { toPortableFlow, type PortableExportOptions } from '@/lib/export/portable'
import { toInstructions } from '@/lib/export/instructions'
import { toN8nWorkflow } from '@/lib/export/n8n'
import { toWorkatoRecipe } from '@/lib/export/workato'
import { toPowerAutomateFlow } from '@/lib/export/power-automate'
import { readTriggerSecret, newTriggerSecret, withTriggerSecret } from '@/lib/flows/webhook-secret'
import { decryptSecret, encryptSecret, hashToken } from '@/lib/crypto/secrets'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

const TARGETS = ['portable', 'n8n', 'workato', 'power-automate', 'instructions'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/**
 * POST /api/flows/<id>/export  { target, includeCredentials }
 *
 * Sanitized export (default): read scope — a copy of what the builder already
 * shows, credentials never included. includeCredentials: OWNER ONLY; embeds
 * live trigger secrets (minting one if none is recoverable) and keeps
 * user-typed HTTP credentials, so the response itself is a credential. POST
 * because minting is a side effect.
 */
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const { target, includeCredentials } = z.object({
    target: z.enum(TARGETS).default('portable'),
    includeCredentials: z.boolean().default(false),
  }).parse(await request.json().catch(() => ({})))

  const scope = includeCredentials ? flowOwnerScope(auth.dbUser.id) : flowReadScope(auth.dbUser.id)
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...scope },
    select: { id: true, name: true, description: true, trigger: true, graph: true },
  })
  if (!flow) {
    // Distinguish "can read but not own" from "cannot see at all" honestly.
    if (includeCredentials) {
      const readable = await prisma.flow.findFirst({
        where: { id, organizationId: auth.organizationId, ...flowReadScope(auth.dbUser.id) },
        select: { id: true },
      })
      if (readable) throw new ApiError('Only the flow owner can export with credentials', 403, 'FORBIDDEN')
    }
    throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  }

  const graph = flowGraphSchema.parse(flow.graph)
  // Inline only the agents this graph actually references — and only ones the
  // caller may read, so an export can never widen access to someone else's agent.
  const agentIds = [
    ...new Set(
      graph.nodes
        .filter((node) => node.type === 'agent')
        .map((node) => (node.data as { agentId?: string }).agentId)
        .filter((agentId): agentId is string => Boolean(agentId)),
    ),
  ]
  const rows = agentIds.length
    ? await prisma.agentTask.findMany({
        where: { id: { in: agentIds }, organizationId: auth.organizationId, ...agentReadScope(auth.dbUser.id) },
        select: { id: true, description: true, objective: true, goal: true, metadata: true, userId: true },
      })
    : []
  const agents = rows.map((row) => {
    const metadata = readAgentMetadata(row.metadata)
    return {
      id: row.id,
      title: metadata.title || row.description.split('\n')[0] || 'Untitled agent',
      instructions: row.objective,
      goal: row.goal,
      model: metadata.model,
      integrations: metadata.integrations || [],
    }
  })

  let credentialOptions: PortableExportOptions = {}
  const extraRequirements: string[] = []
  if (includeCredentials) {
    // Flow webhook secret: decrypt if recoverable; mint if the flow has a
    // webhook trigger but no recoverable secret. A pre-encryption secret is
    // REPLACED — the export states that the old one is now invalid.
    const trigger = (isRecord(flow.trigger) ? flow.trigger : {}) as Record<string, unknown>
    let triggerSecret = readTriggerSecret(trigger)
    const hasWebhook = trigger.type === 'webhook' || typeof trigger.webhookSecretHash === 'string'
    if (!triggerSecret && hasWebhook) {
      const hadLegacySecret = typeof trigger.webhookSecretHash === 'string'
      triggerSecret = newTriggerSecret()
      await prisma.flow.update({
        where: { id: flow.id, organizationId: auth.organizationId },
        data: { trigger: withTriggerSecret(trigger, triggerSecret) },
      })
      if (hadLegacySecret) {
        extraRequirements.push('A new webhook trigger secret was minted for this export — the previous secret no longer works.')
      }
    }

    // Agent trigger secrets: decrypt (or accept legacy plaintext); mint ONLY
    // for agents the caller owns — rotating someone else's agent secret from
    // an export would break their integrations.
    const agentTriggerSecrets: Record<string, string> = {}
    for (const row of rows) {
      const metadata = (isRecord(row.metadata) ? row.metadata : {}) as Record<string, unknown>
      let secret: string | null = null
      if (typeof metadata.triggerSecretEnc === 'string') {
        try { secret = decryptSecret(metadata.triggerSecretEnc) } catch { secret = null }
      }
      if (!secret && typeof metadata.triggerSecret === 'string') secret = metadata.triggerSecret // legacy plaintext
      if (!secret && row.userId === auth.dbUser.id) {
        secret = newTriggerSecret()
        await prisma.agentTask.update({
          where: { id: row.id, organizationId: auth.organizationId },
          data: { metadata: { ...metadata, triggerSecretHash: hashToken(secret), triggerSecretEnc: encryptSecret(secret) } },
        })
        if (typeof metadata.triggerSecretHash === 'string') {
          extraRequirements.push(`A new trigger secret was minted for agent "${readAgentMetadata(row.metadata).title || 'agent'}" — its previous secret no longer works.`)
        }
      }
      if (secret) agentTriggerSecrets[row.id] = secret
    }
    credentialOptions = { includeCredentials: true, ...(triggerSecret ? { triggerSecret } : {}), agentTriggerSecrets }
  }

  const portable = toPortableFlow(
    { name: flow.name, description: flow.description, trigger: flow.trigger, graph },
    agents,
    new Date().toISOString(),
    credentialOptions,
  )
  portable.requirements.push(...extraRequirements)
  const slug = (flow.name || 'workflow').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workflow'

  if (target === 'instructions') {
    return new NextResponse(toInstructions(portable), {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${slug}-instructions.md"`,
      },
    })
  }
  // Each target converts the SAME portable doc — sanitization (or the owner's
  // explicit credential opt-in) can never be skipped by adding a new target.
  // The deployment origin makes agent steps export as RUNNABLE HTTP calls to
  // their live trigger endpoints.
  const triggerBaseUrl = request.nextUrl.origin
  const BY_TARGET = {
    n8n: { body: () => toN8nWorkflow(portable, { triggerBaseUrl }), suffix: '.n8n' },
    workato: { body: () => toWorkatoRecipe(portable, { triggerBaseUrl }), suffix: '.workato' },
    'power-automate': { body: () => toPowerAutomateFlow(portable, { triggerBaseUrl }), suffix: '.power-automate' },
    portable: { body: () => portable, suffix: '.sublime' },
  } as const
  const chosen = BY_TARGET[target as keyof typeof BY_TARGET] ?? BY_TARGET.portable
  return new NextResponse(JSON.stringify(chosen.body(), null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${slug}${chosen.suffix}.json"`,
    },
  })
})
