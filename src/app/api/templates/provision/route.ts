import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { DEFAULT_AGENT_MODEL } from '@/lib/llm/model-runner'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { getSeedByKey, type TemplateAgentSpec } from '@/lib/templates/catalogue'
import { rewriteGraphAgentRefs } from '@/lib/templates/provision-plan'
import { normalizeFlowTrigger, triggerFromGraph } from '@/lib/flows/trigger'
import { syncAgentConnectors } from '@/lib/connectors/agent-connectors'

const bodySchema = z.object({ seedKey: z.string().min(1) })

// Strip undefined + narrow to plain JSON so Prisma's InputJsonValue accepts the
// zod-inferred trigger/graph shapes (mirrors src/app/api/flows/route.ts).
function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

/** Create one AgentTask mirroring POST /api/agents' create shape (an ACTIVE, runnable agent). */
async function materializeAgent(
  spec: { title: string; instructions: string; model?: string; integrations: string[]; description?: string },
  organizationId: string,
  userId: string,
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
      schedule: { type: 'manual', timezone: 'UTC', isActive: false },
      status: 'ACTIVE',
      visibility: 'private',
      organizationId,
      userId,
      metadata: {
        title: spec.title,
        description,
        model: spec.model ?? DEFAULT_AGENT_MODEL,
        integrations: spec.integrations,
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
  const { seedKey } = bodySchema.parse(await request.json())
  const seed = getSeedByKey(seedKey)
  if (!seed) throw new ApiError('Template not found', 404, 'SEED_NOT_FOUND')

  const organizationId = auth.organizationId
  const userId = auth.dbUser.id

  if (seed.kind === 'agent') {
    const integrations = seed.integrations ?? []
    const agentId = await materializeAgent(
      { title: seed.name, instructions: seed.instructions ?? seed.description, model: seed.model, integrations, description: seed.description },
      organizationId,
      userId,
    )
    await syncAgentConnectors(agentId, organizationId, integrations)
    return { success: true, kind: 'agent' as const, agentId }
  }

  // kind === 'flow': materialize the embedded agents, rewrite the graph's
  // agent-ref placeholders to real ids, then create the flow itself.
  const specs: TemplateAgentSpec[] = seed.agents ?? []
  const refToId: Record<string, string> = {}
  const created: Array<{ id: string; integrations: string[] }> = []
  try {
    for (const spec of specs) {
      const id = await materializeAgent(spec, organizationId, userId)
      refToId[spec.ref] = id
      created.push({ id, integrations: spec.integrations })
    }

    if (!seed.flowGraph) throw new ApiError('Template is missing its flow graph', 500, 'SEED_INVALID')
    const graph = rewriteGraphAgentRefs(seed.flowGraph, refToId)
    const trigger = seed.trigger ? normalizeFlowTrigger(seed.trigger) : triggerFromGraph(graph)

    const flow = await prisma.flow.create({
      data: {
        name: seed.name,
        description: seed.description,
        status: 'DRAFT',
        visibility: 'private',
        trigger: jsonValue(trigger),
        graph: jsonValue(graph),
        metadata: jsonValue({ seededFrom: seed.seedKey }),
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
