import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { DEFAULT_AGENT_MODEL } from '@/lib/llm/model-runner'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordUserEvent } from '@/lib/behavior/record-event'
import { agentHttpToolSchema, MAX_AGENT_HTTP_TOOLS } from '@/lib/agents/http-tools'
import { agentOwnerScope, agentReadScope, agentWriteScope, VISIBILITY } from '@/lib/server/visibility'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { serializeAgent } from '@/lib/agents/serialize'
import { indexAgent, removeAgentFromGraph } from '@/lib/rag/indexer'
import { syncAgentConnectors } from '@/lib/connectors/agent-connectors'
import { assertAgentCapacity, assertSpecialistAreaCapacity } from '@/lib/billing/enforce'
import { departmentsForTools } from '@/lib/templates/departments'
import { contributionResourceIds, resolveGoalScope } from '@/lib/server/goal-scope'

/** Best-effort graph-RAG indexing of an agent node (gated on embeddings). */
/**
 * Legacy rows/clients carry `visibility: 'shared'` — a value the access rules
 * never honoured (and the old default), so it never shared anything. Treat it as
 * private: enabling sharing must not retroactively expose every existing agent.
 * Only the explicit org_* roles grant org access.
 */
function normalizeVisibility(value: string): string {
  return value === VISIBILITY.orgViewer || value === VISIBILITY.orgEditor ? value : VISIBILITY.private
}

function indexAgentRow(agent: { id: string; organizationId: string; objective: string; description: string; metadata: unknown; userId?: string | null; visibility?: string }): Promise<void> {
  const metadata = readAgentMetadata(agent.metadata)
  return indexAgent({
    id: agent.id,
    organizationId: agent.organizationId,
    title: metadata.title || agent.description.split('\n')[0] || 'Untitled agent',
    objective: agent.objective,
    description: metadata.description || agent.description,
    // Per-rep scope: a private agent's node is visible only to its owner.
    ownerUserId: agent.userId ?? null,
    // Mirror the access rules exactly: ONLY an explicit org_* share is shared.
    // Legacy 'shared' never granted access, so it must not seed a shared RAG node.
    visibility: normalizeVisibility(agent.visibility ?? '') === VISIBILITY.private ? 'private' : 'shared',
  }).catch(() => undefined)
}

const scheduleSchema = z.object({
  type: z.enum(['manual', 'hourly', 'daily', 'weekly', 'cron', 'once']).default('manual'),
  time: z.string().optional(),
  cron: z.string().optional(),
  timezone: z.string().default('UTC'),
  // YYYY-MM-DD calendar date for a one-time ('once') run, paired with `time`.
  runAt: z.string().optional(),
  isActive: z.boolean().default(false),
})

const agentSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(''),
  instructions: z.string().min(1),
  model: z.string().default(DEFAULT_AGENT_MODEL),
  integrations: z.array(z.string()).default([]),
  specialistArea: z.string().trim().min(1).max(60).optional(),
  requiredIntegrations: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  folder: z.string().trim().max(60).nullish(),
  // Sharing: private (default), or shared with the org as viewer/editor. Legacy
  // rows/clients send 'shared' — a value the access rules never honoured (it was
  // even the old default), so it is accepted and normalized to private rather
  // than retroactively exposing every existing agent to the whole org.
  visibility: z.enum(['private', 'org_viewer', 'org_editor', 'shared']).default('private'),
  icon: z.string().trim().max(8).optional(),
  // Lets this agent delegate to other agents via the run_agent tool (pipelines).
  allowSubagents: z.boolean().optional(),
  // Restrict which agents it may run. Empty/omitted = any visible agent.
  subagentIds: z.array(z.string()).optional(),
  // Lets this agent invoke saved flows as tools (deterministic multi-step work,
  // e.g. HTTP/API enrichment, that belongs in a flow graph).
  allowFlows: z.boolean().optional(),
  // Restrict which flows it may call. Empty/omitted while allowFlows is on = any active flow.
  flowIds: z.array(z.string()).optional(),
  // The outcome this agent ultimately serves — steers every run + self-evaluation.
  goal: z.string().max(2000).nullable().optional(),
  // When true, a question closely matching a past answer is auto-answered from memory.
  autoAnswerFromMemory: z.boolean().optional(),
  // When true, write-plane tool calls (Slack/Email/HTTP/nango deliveries) pause
  // for the user's approval before executing.
  requireApproval: z.boolean().optional(),
  // When true, every run starts with an explicit numbered plan before any tool call.
  alwaysStrategize: z.boolean().optional(),
  maxTurns: z.number().int().min(1).max(64).optional(),
  // Structured output contract: when non-empty, runs must reply with JSON
  // carrying these properties (enforced in execute-agent).
  outputFields: z.array(z.object({ name: z.string().trim().min(1).max(60), type: z.enum(['string', 'number', 'boolean', 'object', 'array']).default('string'), description: z.string().max(300).optional() })).max(20).optional(),
  // User-configured HTTP API endpoints the agent can call as tools; each
  // persists the flow http step's config shape (see lib/agents/http-tools).
  httpTools: z.array(agentHttpToolSchema).max(MAX_AGENT_HTTP_TOOLS).optional(),
  schedule: scheduleSchema.default({ type: 'manual', timezone: 'UTC', isActive: false }),
})

// serializeAgent lives in @/lib/agents/serialize so /api/snapshot returns the
// exact same agent shape as this route.

export const GET = withAuthenticatedApi(async (request, auth) => {
  const scope = await resolveGoalScope(auth, request.nextUrl.searchParams.get('goal'))
  const wantUnlinked = request.nextUrl.searchParams.get('unlinked') === '1'

  // AND, not a merged object: agentReadScope carries an OR, and two OR keys
  // collide in one object. AND-ing is also what makes the lens a NARROWING —
  // the read scope stays authoritative and the contribution filter can only
  // remove rows from it.
  const readScope = agentReadScope(auth.dbUser.id)
  const linkedIds = scope.kind === 'goal'
    ? await contributionResourceIds(auth.organizationId, scope.goal.id, 'agent')
    : null
  const idFilter = linkedIds
    ? [{ id: wantUnlinked ? { notIn: linkedIds } : { in: linkedIds } }]
    : []

  const baseWhere = {
    organizationId: auth.organizationId,
    status: { not: 'DELETED' },
    // org-intelligence holder (see lib/intelligence) is infrastructure, never a listed agent
    agentType: { not: 'SYSTEM' },
  }

  const [agents, unlinkedCount] = await Promise.all([
    prisma.agentTask.findMany({
      where: { ...baseWhere, AND: [readScope, ...idFilter] },
      orderBy: { updatedAt: 'desc' },
      // Bounded: this list is polled by the sidebar + dashboard; an org with a
      // runaway number of agents must not turn every poll into a full scan.
      take: 300,
    }),
    // Counted with the SAME read scope, so the number can never reveal the
    // existence of work the actor could not otherwise see.
    linkedIds
      ? prisma.agentTask.count({
          where: { ...baseWhere, AND: [readScope, { id: { notIn: linkedIds } }] },
        })
      : Promise.resolve(0),
  ])

  // `isOwner` mirrors the flows route: only the owner may change sharing.
  return {
    success: true,
    agents: agents.map((agent) => ({ ...serializeAgent(agent), isOwner: agent.userId === auth.dbUser.id })),
    unlinkedCount,
  }
}, { requires: 'member' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = agentSchema.parse(await request.json())
  const specialistArea = data.specialistArea || departmentsForTools(data.integrations)[0]
  await assertAgentCapacity(auth.organizationId)
  await assertSpecialistAreaCapacity(auth.organizationId, specialistArea)
  const agent = await prisma.agentTask.create({
    data: {
      agentType: 'CUSTOM',
      description: data.description || data.title,
      objective: data.instructions,
      schedule: data.schedule,
      status: 'ACTIVE',
      folder: data.folder || null,
      visibility: normalizeVisibility(data.visibility),
      goal: data.goal?.trim() ? data.goal.trim() : null,
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      metadata: {
        title: data.title,
        description: data.description,
        model: data.model,
        integrations: data.integrations,
        specialistArea,
        requiredIntegrations: data.requiredIntegrations,
        skills: data.skills,
        icon: data.icon || '',
        allowSubagents: data.allowSubagents === true,
        subagentIds: data.subagentIds ?? [],
        allowFlows: data.allowFlows === true,
        flowIds: data.flowIds ?? [],
        autoAnswerFromMemory: data.autoAnswerFromMemory !== false,
        // Deny-by-default for NEW agents (`!== false`, not `=== true`).
        //
        // approval.ts already gates two things unconditionally: Postgres writes,
        // and non-GET http.request — "an exfiltration primitive for
        // prompt-injected instructions", in its own words. Every OTHER write
        // plane (Slack, email, all nango:* delivery) was gated only if the
        // author opted in, so a default agent could be steered by injected
        // content into mailing or DMing its retrieved context somewhere.
        // Sending is an exfiltration channel too.
        //
        // Scoped to creation on purpose: existing agents keep whatever they
        // have. Flipping them would move live automations to
        // waiting_for_input with no warning, which is a migration decision an
        // operator makes, not a default.
        requireApproval: data.requireApproval !== false,
        alwaysStrategize: data.alwaysStrategize === true,
        maxTurns: data.maxTurns ?? 16,
        ...(data.outputFields?.length ? { outputFields: data.outputFields, responseFormat: 'structured' } : {}),
        ...(data.httpTools?.length ? { httpTools: data.httpTools } : {}),
      },
    },
  })
  // Project the selection into typed connector bindings (await: a fresh agent
  // has no rows yet, so the very next run must see them, not the fallback).
  await syncAgentConnectors(agent.id, auth.organizationId, auth.dbUser.id, data.integrations)
  void indexAgentRow(agent)
  await recordUserEvent({
    organizationId: auth.organizationId, userId: auth.dbUser.id,
    kind: 'agent_created', resourceType: 'agent', resourceId: agent.id,
    context: { name: data.title || agent.description },
  })
  return { success: true, agent: { ...serializeAgent(agent), isOwner: agent.userId === auth.dbUser.id } }
}, { requires: 'member', rateLimit: { feature: 'agent-create', perUser: 12 } })

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const body = z.object({ id: z.string().min(1) }).merge(agentSchema.partial()).parse(await request.json())
  const existing = await prisma.agentTask.findFirst({
    where: { id: body.id, organizationId: auth.organizationId, ...agentWriteScope(auth.dbUser.id) },
  })
  if (!existing) throw new ApiError('Agent not found', 404, 'NOT_FOUND')
  // Editing is open to org_editors; changing WHO can see it is the owner's call
  // alone — otherwise an editor could re-share someone else's agent.
  const sharingChanged = body.visibility !== undefined && normalizeVisibility(body.visibility) !== existing.visibility
  if (sharingChanged && existing.userId !== auth.dbUser.id) {
    throw new ApiError('Only the agent owner can change who it is shared with', 403, 'FORBIDDEN')
  }
  const metadata = existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata) ? existing.metadata : {}
  const existingMetadata = readAgentMetadata(existing.metadata)
  const specialistArea = body.specialistArea
    || (body.integrations ? departmentsForTools(body.integrations)[0] : existingMetadata.specialistArea || departmentsForTools(existingMetadata.integrations ?? [])[0])
  if (body.specialistArea !== undefined || body.integrations !== undefined) {
    await assertSpecialistAreaCapacity(auth.organizationId, specialistArea, existing.id)
  }
  const agent = await prisma.agentTask.update({
    where: { id: body.id, organizationId: auth.organizationId },
    data: {
      ...(body.description !== undefined && { description: body.description || body.title || existing.description }),
      ...(body.instructions !== undefined && { objective: body.instructions }),
      ...(body.schedule !== undefined && { schedule: body.schedule }),
      ...(body.folder !== undefined && { folder: body.folder || null }),
      ...(body.visibility !== undefined && { visibility: normalizeVisibility(body.visibility) }),
      ...(body.goal !== undefined && { goal: body.goal?.trim() ? body.goal.trim() : null }),
      metadata: {
        ...metadata,
        ...(body.title !== undefined && { title: body.title }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.model !== undefined && { model: body.model }),
        ...(body.integrations !== undefined && { integrations: body.integrations }),
        ...((body.specialistArea !== undefined || body.integrations !== undefined) && { specialistArea }),
        ...(body.requiredIntegrations !== undefined && { requiredIntegrations: body.requiredIntegrations }),
        ...(body.skills !== undefined && { skills: body.skills }),
        ...(body.icon !== undefined && { icon: body.icon }),
        ...(body.allowSubagents !== undefined && { allowSubagents: body.allowSubagents }),
        ...(body.subagentIds !== undefined && { subagentIds: body.subagentIds }),
        ...(body.allowFlows !== undefined && { allowFlows: body.allowFlows }),
        ...(body.flowIds !== undefined && { flowIds: body.flowIds }),
        ...(body.autoAnswerFromMemory !== undefined && { autoAnswerFromMemory: body.autoAnswerFromMemory }),
        ...(body.requireApproval !== undefined && { requireApproval: body.requireApproval }),
        ...(body.alwaysStrategize !== undefined && { alwaysStrategize: body.alwaysStrategize }),
        ...(body.maxTurns !== undefined && { maxTurns: body.maxTurns }),
        // Explicit empty array removes every configured endpoint.
        ...(body.httpTools !== undefined && { httpTools: body.httpTools }),
        // Non-empty fields switch the run contract to structured; an explicit
        // empty array clears it back to plain text.
        ...(body.outputFields !== undefined && {
          outputFields: body.outputFields.length ? body.outputFields : undefined,
          responseFormat: body.outputFields.length ? 'structured' : undefined,
        }),
        // A saved NON-EMPTY goal supersedes any prior AI-suggested one; saving
        // other fields with the goal still blank keeps the proposal visible.
        ...(typeof body.goal === 'string' && body.goal.trim() ? { suggestedGoal: undefined } : {}),
      },
    },
  })
  // Re-sync typed connector bindings when the selection changed. Await so a
  // run enqueued right after the edit reads the updated bindings.
  if (body.integrations !== undefined) {
    await syncAgentConnectors(agent.id, auth.organizationId, auth.dbUser.id, body.integrations)
  }
  void indexAgentRow(agent)
  await recordUserEvent({
    organizationId: auth.organizationId, userId: auth.dbUser.id,
    kind: 'agent_edited', resourceType: 'agent', resourceId: agent.id,
    context: { name: (agent.metadata as { title?: string } | null)?.title || agent.description },
  })
  return { success: true, agent: { ...serializeAgent(agent), isOwner: agent.userId === auth.dbUser.id } }
}, { requires: 'member' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { id } = z.object({ id: z.string().min(1) }).parse(await request.json())
  const result = await prisma.agentTask.updateMany({
    // Owner only — sharing an agent never grants anyone the right to destroy it.
    where: { id, organizationId: auth.organizationId, ...agentOwnerScope(auth.dbUser.id) },
    data: { status: 'DELETED' },
  })
  if (!result.count) throw new ApiError('Agent not found', 404, 'NOT_FOUND')
  // Purge the agent + its run nodes from the graph so deleted content can't
  // resurface in retrieval. Fire-and-forget; best-effort.
  void removeAgentFromGraph(auth.organizationId, id).catch(() => undefined)
  return { success: true }
}, { requires: 'member' })
