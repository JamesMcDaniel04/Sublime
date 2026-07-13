import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { DEFAULT_AGENT_MODEL } from '@/lib/llm/model-runner'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { getSeedByKey, type TemplateAgentSpec } from '@/lib/templates/catalogue'
import { resolveGraphToolConnections, rewriteGraphAgentRefs } from '@/lib/templates/provision-plan'
import { loadFlowToolCatalog } from '@/lib/flows/tool-catalog'
import { normalizeFlowTrigger, triggerFromGraph } from '@/lib/flows/trigger'
import { syncAgentConnectors } from '@/lib/connectors/agent-connectors'
import type { AgentSchedule } from '@/lib/scheduling/due'
import type { FlowGraph } from '@/lib/flows/graph'

const bodySchema = z.object({
  seedKey: z.string().min(1),
  // Omitted by catalogue cards for backwards compatibility. The detail page
  // supplies it so every recipe can be deployed as either a standalone Agent
  // or an orchestrated Flow.
  targetKind: z.enum(['agent', 'flow']).optional(),
})

const MANUAL_SCHEDULE: AgentSchedule = {
  type: 'manual', time: '', cron: '', timezone: 'UTC', isActive: false,
}

function scheduleForSeed(seed: ReturnType<typeof getSeedByKey>): AgentSchedule {
  const schedule = seed?.trigger?.type === 'schedule' ? seed.trigger.schedule : undefined
  return schedule
    ? { ...schedule }
    : { ...MANUAL_SCHEDULE }
}

function combinedAgentSpec(seed: NonNullable<ReturnType<typeof getSeedByKey>>) {
  const embedded = seed.agents ?? []
  const instructions = seed.instructions?.trim() || [
    `Run the ${seed.name} process.`,
    seed.description,
    ...embedded.map((agent) => `${agent.title}: ${agent.instructions}`),
  ].join('\n\n')
  const integrations = Array.from(new Set([
    ...(seed.integrations ?? []),
    ...seed.requiredIntegrations,
    ...seed.recommendedIntegrations,
    ...embedded.flatMap((agent) => agent.integrations),
  ]))
  return {
    title: seed.name,
    description: seed.description,
    instructions,
    model: seed.model,
    integrations,
    requiredIntegrations: seed.requiredIntegrations,
  }
}

// Strip undefined + narrow to plain JSON so Prisma's InputJsonValue accepts the
// zod-inferred trigger/graph shapes (mirrors src/app/api/flows/route.ts).
function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

/** Create one AgentTask mirroring POST /api/agents' create shape (an ACTIVE, runnable agent). */
async function materializeAgent(
  spec: { title: string; instructions: string; model?: string; integrations: string[]; requiredIntegrations?: string[]; description?: string },
  organizationId: string,
  userId: string,
  schedule: AgentSchedule = MANUAL_SCHEDULE,
): Promise<string> {
  // Preserve the catalogue description a user saw on the template card; fall
  // back to the title only when the spec carries none (embedded flow specs).
  const description = spec.description?.trim() || spec.title
  const agent = await prisma.agentTask.create({
    data: {
      type: 'agent',
      agentType: 'CUSTOM',
      priority: 'MEDIUM',
      description,
      objective: spec.instructions,
      context: {},
      schedule,
      status: 'ACTIVE',
      visibility: 'shared',
      organizationId,
      userId,
      metadata: {
        title: spec.title,
        description,
        model: spec.model ?? DEFAULT_AGENT_MODEL,
        integrations: spec.integrations,
        requiredIntegrations: spec.requiredIntegrations ?? [],
        skills: [],
        icon: '',
        allowSubagents: false,
        subagentIds: [],
      },
    },
    select: { id: true },
  })
  return agent.id
}

// Provisions a seed template (Task Catalogue) into real, org-scoped rows. The
// seed is always read server-side via getSeedByKey — a client-supplied graph
// is never trusted. Flows are always created DRAFT; the caller reviews and
// activates from the flow editor, this endpoint never auto-runs anything.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const { seedKey, targetKind } = bodySchema.parse(await request.json())
  const seed = getSeedByKey(seedKey)
  if (!seed) throw new ApiError('Template not found', 404, 'SEED_NOT_FOUND')

  const organizationId = auth.organizationId
  const userId = auth.dbUser.id

  const desiredKind = targetKind ?? seed.kind
  const schedule = scheduleForSeed(seed)

  if (desiredKind === 'agent') {
    const spec = combinedAgentSpec(seed)
    const agentId = await materializeAgent(
      spec,
      organizationId,
      userId,
      schedule,
    )
    await syncAgentConnectors(agentId, organizationId, spec.integrations)
    return { success: true, kind: 'agent' as const, agentId }
  }

  // targetKind === 'flow': preserve an authored orchestration graph when one
  // exists. Agent recipes become trigger -> agent flows, retaining the same
  // instructions, connected tools, and recommended schedule.
  const specs: TemplateAgentSpec[] = seed.kind === 'flow'
    ? seed.agents ?? []
    : [{ ref: 'template-agent', ...combinedAgentSpec(seed) }]
  const refToId: Record<string, string> = {}
  const created: Array<{ id: string; integrations: string[] }> = []
  try {
    for (const spec of specs) {
      const id = await materializeAgent({ ...spec, requiredIntegrations: seed.requiredIntegrations }, organizationId, userId, MANUAL_SCHEDULE)
      refToId[spec.ref] = id
      created.push({ id, integrations: spec.integrations })
    }

    const baseGraph: FlowGraph = seed.kind === 'flow' && seed.flowGraph
      ? seed.flowGraph
      : {
          nodes: [
            { id: 'trigger', type: 'trigger', data: { trigger: seed.trigger ?? { type: 'manual' } } },
            {
              id: 'run-agent',
              type: 'agent',
              data: {
                agentId: 'template-agent',
                label: seed.name,
                input: '{{trigger.input}}',
              },
            },
          ],
          edges: [{ id: 'trigger-run-agent', source: 'trigger', target: 'run-agent' }],
        }
    const withAgents = rewriteGraphAgentRefs(baseGraph, refToId)
    const toolCatalog = await loadFlowToolCatalog(organizationId, { userId, takeTools: 200 })
    const graph = resolveGraphToolConnections(withAgents, toolCatalog)
    const trigger = seed.trigger ? normalizeFlowTrigger(seed.trigger) : triggerFromGraph(graph)

    const flow = await prisma.flow.create({
      data: {
        name: seed.name,
        description: seed.description,
        status: 'DRAFT',
        visibility: 'shared',
        trigger: jsonValue(trigger),
        graph: jsonValue(graph),
        metadata: jsonValue({ seededFrom: seed.seedKey, provisionedAs: 'flow' }),
        organizationId,
        userId,
      },
      select: { id: true },
    })

    // Project connector bindings for each materialized agent. Best-effort and
    // post-create, mirroring the agents route's own sync call.
    await Promise.all(
      created.map((a) => syncAgentConnectors(a.id, organizationId, a.integrations).catch(() => undefined)),
    )

    return { success: true, kind: 'flow' as const, flowId: flow.id }
  } catch (error) {
    // Best-effort cleanup: a ref/materialization mismatch (rewriteGraphAgentRefs
    // throwing) or a failed flow create shouldn't leave orphaned agent rows
    // behind. Not transactional — if this cleanup itself fails, the orphans
    // are harmless CUSTOM agents scoped to the caller's own org.
    if (created.length) {
      await prisma.agentTask
        .updateMany({ where: { id: { in: created.map((a) => a.id) }, organizationId }, data: { status: 'DELETED' } })
        .catch(() => undefined)
    }
    if (error instanceof ApiError) throw error
    throw new ApiError('Failed to provision template', 500, 'PROVISION_FAILED', error)
  }
})
