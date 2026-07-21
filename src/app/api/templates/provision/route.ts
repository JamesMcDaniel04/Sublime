import { z } from 'zod'
import { prisma, systemPrisma } from '@/lib/prisma'
import { DEFAULT_AGENT_MODEL } from '@/lib/llm/model-runner'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { deliveryForSeed, getSeedByKey, instructionsForSeed, type SeedTemplate, type TemplateAgentSpec } from '@/lib/templates/catalogue'
import { missingRequiredProviders, resolveGraphToolConnections, rewriteGraphAgentRefs } from '@/lib/templates/provision-plan'
import { validateSlackDeliveryChannel } from '@/lib/templates/validate-delivery'
import { loadFlowToolCatalog } from '@/lib/flows/tool-catalog'
import { normalizeFlowTrigger, triggerFromGraph } from '@/lib/flows/trigger'
import { activateFlow } from '@/lib/flows/activate'
import { syncAgentConnectors } from '@/lib/connectors/agent-connectors'
import { recordUserEvent } from '@/lib/behavior/record-event'
import type { AgentSchedule } from '@/lib/scheduling/due'
import type { FlowGraph } from '@/lib/flows/graph'
import { withTemplateOutputStandard } from '@/lib/templates/output-standard'
import { assertAgentCapacity, assertFlowCapacity, assertSpecialistAreaCapacity } from '@/lib/billing/enforce'
import { DEPARTMENTS, departmentsForTools, type Department } from '@/lib/templates/departments'

const bodySchema = z
  .object({
    // Exactly one source: a built-in seed, or a community/DB-authored template.
    // Both are re-read server-side — a client-supplied graph is never trusted.
    seedKey: z.string().min(1).optional(),
    templateId: z.string().min(1).optional(),
    // Omitted by catalogue cards for backwards compatibility. The detail page
    // supplies it so every recipe can be deployed as either a standalone Agent
    // or an orchestrated Flow.
    targetKind: z.enum(['agent', 'flow']).optional(),
    // 1-click deploy: publish + activate the flow in the same call. Only
    // honored when the graph validates; otherwise the flow degrades to DRAFT
    // and the response says so.
    activate: z.boolean().default(false),
    // Deploy-time delivery override (Slack channel / email recipient) for
    // recipes whose default graph carries a delivery step.
    delivery: z.object({ channel: z.string().trim().max(120).optional(), email: z.string().email().optional() }).optional(),
    // Multi-account workspaces: pin a provider slug to a specific connection
    // id instead of the deterministic default.
    connectionOverrides: z.record(z.string(), z.string()).default({}),
  })
  .refine((body) => Boolean(body.seedKey) !== Boolean(body.templateId), {
    message: 'Provide exactly one of seedKey or templateId',
  })

const MANUAL_SCHEDULE: AgentSchedule = {
  type: 'manual', time: '', cron: '', timezone: 'UTC', isActive: false,
}

function scheduleForSeed(seed: SeedTemplate | undefined): AgentSchedule {
  const schedule = seed?.trigger?.type === 'schedule' ? seed.trigger.schedule : undefined
  return schedule
    ? { ...schedule }
    : { ...MANUAL_SCHEDULE }
}

function combinedAgentSpec(seed: SeedTemplate) {
  const embedded = seed.agents ?? []
  const instructions = instructionsForSeed(seed)
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

type MaterializeSpec = {
  title: string
  instructions: string
  model?: string
  integrations: string[]
  requiredIntegrations?: string[]
  description?: string
  /** Extra agent metadata (skills, goal, output fields…) carried by
   *  DB-authored templates; seeds leave it empty. */
  extraMetadata?: Record<string, unknown>
}

/** Create one AgentTask mirroring POST /api/agents' create shape (an ACTIVE, runnable agent). */
async function materializeAgent(
  spec: MaterializeSpec,
  organizationId: string,
  userId: string,
  schedule: AgentSchedule = MANUAL_SCHEDULE,
  specialistArea = departmentsForTools(spec.integrations)[0],
): Promise<string> {
  await assertAgentCapacity(organizationId)
  await assertSpecialistAreaCapacity(organizationId, specialistArea)
  // Preserve the catalogue description a user saw on the template card; fall
  // back to the title only when the spec carries none (embedded flow specs).
  const description = spec.description?.trim() || spec.title
  const agent = await prisma.agentTask.create({
    data: {
      agentType: 'CUSTOM',
      description,
      objective: withTemplateOutputStandard(spec.instructions),
      schedule,
      status: 'ACTIVE',
      visibility: 'private',
      organizationId,
      userId,
      metadata: {
        title: spec.title,
        description,
        model: spec.model ?? DEFAULT_AGENT_MODEL,
        integrations: spec.integrations,
        specialistArea,
        requiredIntegrations: spec.requiredIntegrations ?? [],
        skills: [],
        icon: '',
        allowSubagents: false,
        subagentIds: [],
        autoAnswerFromMemory: true,
        ...(spec.extraMetadata ?? {}),
      },
    },
    select: { id: true },
  })
  return agent.id
}

type DbTemplateRecipe = {
  seedKey: undefined
  templateId: string
  name: string
  description: string
  departments: Department[]
  requiredIntegrations: string[]
  kind: 'agent' | 'flow'
  spec: MaterializeSpec
  schedule: AgentSchedule
  trigger: { type: 'manual' } | { type: 'schedule'; schedule: AgentSchedule }
}

/**
 * Load a community/DB-authored template into the same trusted, server-side
 * shape seeds use. Community templates are a public library (readable by any
 * workspace); auto-generated templates encode org-private process intelligence
 * and never resolve cross-org.
 */
async function loadDbTemplateRecipe(templateId: string, organizationId: string): Promise<DbTemplateRecipe> {
  // systemPrisma: community templates are cross-org readable by design — same
  // exemption as GET /api/agent-templates.
  const row = await systemPrisma.agentTemplate.findFirst({ where: { id: templateId, isActive: true } })
  const config = (row?.configuration && typeof row.configuration === 'object' ? row.configuration : {}) as Record<string, unknown>
  if (!row || (config.autoGenerated === true && row.organizationId !== organizationId)) {
    throw new ApiError('Template not found', 404, 'TEMPLATE_NOT_FOUND')
  }
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : [])
  const instructions = typeof config.instructions === 'string' && config.instructions.trim()
    ? config.instructions
    : row.description || row.name
  const rawSchedule = config.schedule && typeof config.schedule === 'object' ? config.schedule as Partial<AgentSchedule> : null
  const schedule: AgentSchedule = rawSchedule && rawSchedule.type && rawSchedule.type !== 'manual'
    ? {
        type: rawSchedule.type, time: rawSchedule.time ?? '', cron: rawSchedule.cron ?? '',
        timezone: rawSchedule.timezone ?? 'UTC', isActive: rawSchedule.isActive !== false,
      }
    : { ...MANUAL_SCHEDULE }
  const integrations = strings(config.integrations)
  return {
    seedKey: undefined,
    templateId: row.id,
    name: row.name,
    description: row.description || '',
    departments: strings(config.departments).filter((d): d is Department => (DEPARTMENTS as readonly string[]).includes(d)),
    requiredIntegrations: strings(config.requiredIntegrations),
    kind: config.kind === 'flow' ? 'flow' : 'agent',
    schedule,
    trigger: schedule.type === 'manual' ? { type: 'manual' } : { type: 'schedule', schedule },
    spec: {
      title: row.name,
      description: row.description || '',
      instructions,
      model: typeof config.model === 'string' ? config.model : undefined,
      integrations,
      requiredIntegrations: strings(config.requiredIntegrations),
      extraMetadata: {
        skills: strings(config.skills),
        ...(typeof config.icon === 'string' ? { icon: config.icon } : {}),
        ...(typeof config.goal === 'string' && config.goal ? { goal: config.goal } : {}),
        ...(config.allowSubagents === true ? { allowSubagents: true } : {}),
        ...(Array.isArray(config.subagentIds) ? { subagentIds: config.subagentIds } : {}),
        ...(config.autoAnswerFromMemory === false ? { autoAnswerFromMemory: false } : {}),
        ...(config.alwaysStrategize === true ? { alwaysStrategize: true } : {}),
        ...(typeof config.maxTurns === 'number' ? { maxTurns: config.maxTurns } : {}),
        ...(Array.isArray(config.outputFields) ? { outputFields: config.outputFields } : {}),
        provisionedFromTemplateId: row.id,
      },
    },
  }
}

// Provisions a template (built-in seed or community/DB row) into real,
// org-scoped rows. The recipe is always re-read server-side — a client-
// supplied graph is never trusted. Missing REQUIRED integrations fail up
// front with a structured 409 (nothing is created); with `activate: true`
// a valid flow goes live in the same call.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const { seedKey, templateId, targetKind, activate, delivery: deliveryOverride, connectionOverrides } =
    bodySchema.parse(await request.json())

  const organizationId = auth.organizationId
  const userId = auth.dbUser.id

  const seed = seedKey ? getSeedByKey(seedKey) : undefined
  if (seedKey && !seed) throw new ApiError('Template not found', 404, 'SEED_NOT_FOUND')
  const dbRecipe = templateId ? await loadDbTemplateRecipe(templateId, organizationId) : undefined

  const requiredIntegrations = seed ? seed.requiredIntegrations : dbRecipe!.requiredIntegrations
  const desiredKind = targetKind ?? (seed ? seed.kind : dbRecipe!.kind)
  const schedule = seed ? scheduleForSeed(seed) : dbRecipe!.schedule

  // Pre-flight: every REQUIRED provider must have a satisfying connection in
  // the same catalog the binding pass uses — so a passing pre-flight cannot
  // 500 later, and a failing one creates nothing. Recommended integrations
  // stay non-blocking.
  const toolCatalog = await loadFlowToolCatalog(organizationId, { userId, takeTools: 200 })
  const missing = missingRequiredProviders(requiredIntegrations, toolCatalog)
  if (missing.length > 0) {
    throw new ApiError(
      `Connect ${missing.join(', ')} before deploying this template`,
      409,
      'MISSING_INTEGRATIONS',
    )
  }

  const recordTemplateUsed = (resourceType: 'agent' | 'flow', resourceId: string, extra: Record<string, unknown> = {}) =>
    recordUserEvent({
      organizationId, userId,
      kind: 'template_used', resourceType, resourceId,
      context: { seedKey: seedKey ?? null, templateId: templateId ?? null, targetKind: desiredKind, ...extra },
    })

  if (desiredKind === 'agent') {
    const spec = seed ? combinedAgentSpec(seed) : dbRecipe!.spec
    const departments = seed ? seed.departments : dbRecipe!.departments
    const specialistArea = departments?.[0] || departmentsForTools(spec.integrations)[0]
    const agentId = await materializeAgent(
      spec,
      organizationId,
      userId,
      schedule,
      specialistArea,
    )
    await syncAgentConnectors(agentId, organizationId, userId, spec.integrations)
    recordTemplateUsed('agent', agentId)
    return { success: true, kind: 'agent' as const, agentId }
  }

  // targetKind === 'flow': preserve an authored orchestration graph when one
  // exists. Agent recipes become trigger -> agent flows, retaining the same
  // instructions, connected tools, and recommended schedule.
  const name = seed ? seed.name : dbRecipe!.name
  const description = seed ? seed.description : dbRecipe!.description
  const specs: TemplateAgentSpec[] = seed && seed.kind === 'flow'
    ? seed.agents ?? []
    : [{ ref: 'template-agent', ...(seed ? combinedAgentSpec(seed) : dbRecipe!.spec) }]
  const refToId: Record<string, string> = {}
  const created: Array<{ id: string; integrations: string[] }> = []
  try {
    await assertFlowCapacity(organizationId)
    const departments = seed ? seed.departments : dbRecipe!.departments
    const firstSpec = specs[0]
    const specialistArea = departments?.[0] || departmentsForTools(firstSpec?.integrations ?? [])[0]
    await assertSpecialistAreaCapacity(organizationId, specialistArea)
    for (const spec of specs) {
      const id = await materializeAgent({ ...spec, requiredIntegrations }, organizationId, userId, MANUAL_SCHEDULE, specialistArea)
      refToId[spec.ref] = id
      created.push({ id, integrations: spec.integrations })
    }

    const templateTrigger = seed ? seed.trigger : dbRecipe!.trigger
    const delivery = seed ? deliveryForSeed(seed) : null
    // Deploy-time destination: the caller's override wins over the seed's
    // department default, and the choice is recorded on the flow's metadata.
    const slackChannel = deliveryOverride?.channel?.trim() || (delivery?.kind === 'slack' ? delivery.destination : '')
    const emailTo = deliveryOverride?.email || '{{trigger.input.requesterEmail}}'
    const baseGraph: FlowGraph = seed && seed.kind === 'flow' && seed.flowGraph
      ? seed.flowGraph
      : {
          nodes: [
            { id: 'trigger', type: 'trigger', data: { trigger: templateTrigger ?? { type: 'manual' } } },
            {
              id: 'run-agent',
              type: 'agent',
              data: {
                agentId: 'template-agent',
                label: name,
                input: '{{trigger.input}}',
              },
            },
            ...(delivery
              ? [delivery.kind === 'slack'
                  ? {
                      id: 'deliver-output', type: 'tool' as const,
                      data: { label: `Deliver to ${slackChannel}`, connectionId: 'native:slack', toolName: 'post_message', args: JSON.stringify({ channel: slackChannel, text: '{{step.run-agent.output}}' }) },
                    }
                  : {
                      id: 'deliver-output', type: 'tool' as const,
                      data: { label: 'Email finished artifact', connectionId: 'nango:gmail', toolName: 'gmail_send_email', args: JSON.stringify({ to: emailTo, subject: `${name} — completed`, body: '{{step.run-agent.output}}' }) },
                    }]
              : []),
          ],
          edges: [
            { id: 'trigger-run-agent', source: 'trigger', target: 'run-agent' },
            ...(delivery ? [{ id: 'run-agent-deliver-output', source: 'run-agent', target: 'deliver-output' }] : []),
          ],
        }
    const withAgents = rewriteGraphAgentRefs(baseGraph, refToId)
    const { graph, bindings } = resolveGraphToolConnections(withAgents, toolCatalog, connectionOverrides)
    const trigger = templateTrigger ? normalizeFlowTrigger(templateTrigger) : triggerFromGraph(graph)

    // Delivery-target sanity: a deploy that would post to a non-existent
    // channel gets a warning (recorded + returned), never a silent failure
    // days later. Best-effort — validation unavailability never blocks.
    const deliveryCheck = delivery?.kind === 'slack' && slackChannel
      ? await validateSlackDeliveryChannel(organizationId, slackChannel)
      : { ok: true as const }

    const graphJson = jsonValue(graph)
    const triggerJson = jsonValue(trigger)
    const flow = await prisma.flow.create({
      data: {
        name,
        description,
        status: 'DRAFT',
        visibility: 'private',
        trigger: triggerJson,
        graph: graphJson,
        metadata: jsonValue({
          seededFrom: seedKey ?? null,
          provisionedFromTemplateId: templateId ?? null,
          provisionedAs: 'flow',
          resolvedConnections: bindings,
          ...(delivery ? { delivery: { kind: delivery.kind, destination: delivery.kind === 'slack' ? slackChannel : emailTo } } : {}),
          ...(deliveryCheck.warning ? { deliveryWarning: deliveryCheck.warning } : {}),
        }),
        organizationId,
        userId,
      },
      select: { id: true },
    })

    // 1-click activation: only a graph that passes the SAME validation the
    // editor's publish route runs goes live; anything else stays DRAFT with
    // the reason surfaced to the caller.
    const activation = activate
      ? await activateFlow(flow.id, organizationId, userId)
      : { activated: false as const, reason: 'not requested' }
    const activated = activation.activated

    // Project connector bindings for each materialized agent. Best-effort and
    // post-create, mirroring the agents route's own sync call.
    await Promise.all(
      created.map((a) => syncAgentConnectors(a.id, organizationId, userId, a.integrations).catch(() => undefined)),
    )
    recordTemplateUsed('flow', flow.id, { activated })

    return {
      success: true,
      kind: 'flow' as const,
      flowId: flow.id,
      activated,
      ...(activate && !activation.activated ? { activationError: activation.reason } : {}),
      ...(deliveryCheck.warning ? { deliveryWarning: deliveryCheck.warning } : {}),
    }
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
