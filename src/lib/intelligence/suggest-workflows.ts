/**
 * Behavioral-intelligence workflow suggestions (Task 3).
 *
 * Turns accumulated per-connection usage profiles (Task 1/2's `scanConnection`
 * learnings) into org-specific workflow drafts and improvement proposals for
 * existing flows/agents. Gated on >=3 active tool connections — below that,
 * an org has too little cross-tool context for a suggestion to be more than a
 * guess, so this module does nothing and the UI shows progress copy instead.
 *
 * Safety/behavior invariants:
 *   - Never runs more than once per org per day (organizations.settings.
 *     lastSuggestionSynthesisAt), regardless of which of the two triggers
 *     (post-scan hook, weekly cron tick) fires it.
 *   - Synthesis always sees ALL of the org's usage profiles together, so it
 *     can propose suggestions that span multiple tools.
 *   - Emits at most one notify() per run, and only when it produced
 *     something fresh (no empty-run noise).
 */

import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { generateStructured, DEFAULT_SUMMARY_MODEL } from '@/lib/llm/model-runner'
import { saveAgentMemory } from '@/lib/memory/agent-memory'
import { orgIntelligenceAgentId, NANGO_CONNECTED_STATUS } from '@/lib/intelligence/connection-scan'
import { notify } from '@/lib/notifications/service'
import { buildCopilotGrounding } from '@/lib/flows/copilot-grounding'
import { generateFlowGraph } from '@/lib/flows/copilot-generate'

/** ≤1 synthesis per org per calendar day, regardless of trigger. */
export const SUGGESTION_SYNTHESIS_COOLDOWN_MS = 24 * 60 * 60 * 1000
/** New-workflow suggestions per pass — kept small so drafts stay reviewable. */
export const MAX_NEW_SUGGESTIONS = 3
/** Improvement proposals per pass. */
export const MAX_IMPROVEMENTS = 5
/** A flow-target improvement's target id is carried in AgentMemory.question
 *  (unused by kind:'suggestion' memories otherwise) as this prefix + the id,
 *  so the flow builder page can look its suggestions up without a schema
 *  change. Never rendered — only agent-scoped memories are shown as-is in
 *  the agent config UI, and this marker only ever lives on the hidden
 *  org-shared holder agent's memories. */
export const FLOW_TARGET_MARKER_PREFIX = 'flow:'

export type ConnectionCounts = { klavis: number; nango: number; mcp: number }

/** Pure: the org has enough cross-tool context for suggestions once its
 * active connections across all three planes total >= 3. */
export function meetsSuggestionGate(counts: ConnectionCounts): boolean {
  return counts.klavis + counts.nango + counts.mcp >= 3
}

/** Active connection counts across all three integration planes. */
export async function countActiveConnections(organizationId: string): Promise<ConnectionCounts> {
  const [klavis, nango, mcp] = await Promise.all([
    prisma.mCPAgent.count({ where: { organizationId, isActive: true } }),
    prisma.nangoConnection.count({ where: { organizationId, status: NANGO_CONNECTED_STATUS } }),
    prisma.mcpConnection.count({ where: { organizationId, isActive: true } }),
  ])
  return { klavis, nango, mcp }
}

type NewSuggestion = { title: string; description: string; flowPrompt: string }
type Improvement = { targetType: 'flow' | 'agent'; targetId: string; title: string; rationale: string }

const suggestionsSchema = z.object({
  suggestions: z
    .array(z.object({ title: z.string(), description: z.string(), flowPrompt: z.string() }))
    .default([]),
  improvements: z
    .array(
      z.object({
        targetType: z.enum(['flow', 'agent']),
        targetId: z.string(),
        title: z.string(),
        rationale: z.string(),
      }),
    )
    .default([]),
})

const SUGGESTIONS_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          flowPrompt: { type: 'string' },
        },
        required: ['title', 'description', 'flowPrompt'],
      },
    },
    improvements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          targetType: { type: 'string', enum: ['flow', 'agent'] },
          targetId: { type: 'string' },
          title: { type: 'string' },
          rationale: { type: 'string' },
        },
        required: ['targetType', 'targetId', 'title', 'rationale'],
      },
    },
  },
  required: ['suggestions', 'improvements'],
}

/** Tolerant parse: strip fences, find the object, validate. Null on garbage. */
export function parseSuggestions(raw: string): { suggestions: NewSuggestion[]; improvements: Improvement[] } | null {
  const trimmed = raw.trim()
  const candidates = [trimmed]
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidates.push(fence[1].trim())
  const braces = trimmed.match(/\{[\s\S]*\}/)
  if (braces) candidates.push(braces[0])
  for (const candidate of candidates) {
    try {
      const result = suggestionsSchema.safeParse(JSON.parse(candidate))
      if (result.success) return result.data
    } catch {
      /* try next */
    }
  }
  return null
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

type FlowSummary = { id: string; name: string; description: string; triggerType: string; recentRunStatuses: string[] }
type AgentSummary = { id: string; title: string; objective: string; recentRunHeadlines: string[] }

async function loadExistingFlows(organizationId: string): Promise<FlowSummary[]> {
  const flows = await prisma.flow.findMany({
    where: { organizationId },
    orderBy: { updatedAt: 'desc' },
    take: 20,
    include: { runs: { orderBy: { startedAt: 'desc' }, take: 3, select: { status: true } } },
  })
  return flows.map((flow) => {
    const trigger = flow.trigger as { type?: string } | null
    return {
      id: flow.id,
      name: flow.name,
      description: flow.description,
      triggerType: trigger?.type ?? 'manual',
      recentRunStatuses: flow.runs.map((run) => run.status),
    }
  })
}

async function loadExistingAgents(organizationId: string): Promise<AgentSummary[]> {
  const agents = await prisma.agentTask.findMany({
    where: { organizationId, status: 'ACTIVE', agentType: { not: 'SYSTEM' } },
    orderBy: { updatedAt: 'desc' },
    take: 20,
    select: { id: true, description: true, objective: true, metadata: true },
  })
  if (agents.length === 0) return []
  const executions = await prisma.agentExecution.findMany({
    where: { organizationId, agentTaskId: { in: agents.map((a) => a.id) } },
    orderBy: { startedAt: 'desc' },
    take: 60,
    select: { agentTaskId: true, status: true, error: true },
  })
  const byAgent = new Map<string, string[]>()
  for (const execution of executions) {
    if (!execution.agentTaskId) continue
    const list = byAgent.get(execution.agentTaskId) ?? []
    if (list.length < 3) {
      list.push(execution.status === 'failed' ? `failed${execution.error ? `: ${truncate(execution.error, 80)}` : ''}` : execution.status)
      byAgent.set(execution.agentTaskId, list)
    }
  }
  return agents.map((agent) => {
    const metadata = agent.metadata && typeof agent.metadata === 'object' && !Array.isArray(agent.metadata) ? (agent.metadata as Record<string, unknown>) : {}
    return {
      id: agent.id,
      title: (typeof metadata.title === 'string' && metadata.title) || agent.description,
      objective: agent.objective,
      recentRunHeadlines: byAgent.get(agent.id) ?? [],
    }
  })
}

function buildSynthesisPrompt(params: {
  profiles: { title: string; content: string }[]
  flows: FlowSummary[]
  agents: AgentSummary[]
}): { system: string; user: string } {
  const { profiles, flows, agents } = params
  return {
    system: [
      'You are the workflow-suggestion engine for an org that has connected several business tools to an automation platform.',
      "You are given usage profiles distilled from ALL of the org's connected tools together. Find REPETITIVE tasks and use cases: recurring cadences, repeated entity patterns, and process mentions that show up more than once — those are the automation signal. Ignore one-off or purely exploratory usage.",
      'Propose up to 3 new workflow suggestions. Prefer suggestions that span at least two different tools (e.g. "GitHub issues -> Slack digest") — cross-tool automations are the whole point of having multiple profiles to compare. Each suggestion needs a short title, a one-sentence description of the value, and a flowPrompt: an instruction detailed enough for a flow-builder AI to generate a runnable graph from it alone.',
      'Also review the existing flows and agents listed below against the same usage profiles, and propose up to 5 concrete improvements: a schedule that matches an observed cadence, a trigger filter that matches an observed pattern, converting a manual flow to scheduled, splitting an overloaded agent, etc. Each improvement needs targetType (flow or agent), the EXACT targetId from the list below (never invent one), a short title, and a one-sentence rationale grounded in the usage profiles or run history.',
      'Only propose an improvement when the existing flows/agents list below is non-empty and you have a concrete, evidenced change to suggest — otherwise leave improvements empty. Never fabricate a targetId.',
    ].join(' '),
    user: [
      'Usage profiles (from connected tools):',
      ...profiles.map((p) => `### ${p.title}\n${truncate(p.content, 600)}`),
      '',
      'Existing flows:',
      flows.length
        ? flows.map((f) => `- id:${f.id} "${f.name}" (trigger:${f.triggerType}) — ${truncate(f.description, 200) || 'no description'} — recent runs: ${f.recentRunStatuses.join(', ') || 'none'}`).join('\n')
        : '- None yet',
      '',
      'Existing agents:',
      agents.length
        ? agents.map((a) => `- id:${a.id} "${a.title}" — objective: ${truncate(a.objective, 200)} — recent runs: ${a.recentRunHeadlines.join(', ') || 'none'}`).join('\n')
        : '- None yet',
    ].join('\n'),
  }
}

/** Best-effort: read the org's suggestion-synthesis cooldown timestamp. */
function lastSynthesisAt(settings: unknown): Date | null {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null
  const value = (settings as Record<string, unknown>).lastSuggestionSynthesisAt
  if (typeof value !== 'string') return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** Merge-write the cooldown timestamp without clobbering unrelated settings keys. */
async function claimSynthesisSlot(organizationId: string, existingSettings: unknown, now: Date): Promise<void> {
  const base = existingSettings && typeof existingSettings === 'object' && !Array.isArray(existingSettings) ? (existingSettings as Record<string, unknown>) : {}
  await prisma.organization.update({
    where: { id: organizationId },
    data: { settings: { ...base, lastSuggestionSynthesisAt: now.toISOString() } },
  })
}

export type SynthesisResult =
  | { skipped: 'below-gate' | 'throttled' | 'no-profiles' | 'error' }
  | { synthesized: true; newFlows: number; improvements: number }

/**
 * Run one pass of workflow-suggestion synthesis for an org. Never throws —
 * degrades to `{ skipped: reason }` on any gate/guard/failure.
 */
export async function synthesizeWorkflowSuggestions(organizationId: string): Promise<SynthesisResult> {
  try {
    const [org, counts] = await Promise.all([
      prisma.organization.findUnique({ where: { id: organizationId }, select: { settings: true } }),
      countActiveConnections(organizationId),
    ])
    if (!meetsSuggestionGate(counts)) return { skipped: 'below-gate' }

    const now = new Date()
    const last = lastSynthesisAt(org?.settings)
    if (last && now.getTime() - last.getTime() < SUGGESTION_SYNTHESIS_COOLDOWN_MS) return { skipped: 'throttled' }

    // Claim the slot before doing any LLM work so a concurrent trigger
    // (post-scan hook racing the weekly cron tick) can't double-run.
    await claimSynthesisSlot(organizationId, org?.settings, now)

    const agentId = await orgIntelligenceAgentId(organizationId)
    const memories = await prisma.agentMemory.findMany({
      where: { organizationId, agentId, kind: 'learning', status: 'open' },
      orderBy: { createdAt: 'desc' },
      take: 60,
      select: { title: true, content: true },
    })
    if (memories.length === 0) return { skipped: 'no-profiles' }

    const [flows, agents] = await Promise.all([loadExistingFlows(organizationId), loadExistingAgents(organizationId)])
    const { system, user } = buildSynthesisPrompt({ profiles: memories, flows, agents })

    const model = process.env.AGENT_REFLECTION_MODEL?.trim() || DEFAULT_SUMMARY_MODEL
    const raw = await generateStructured({ system, user, schema: SUGGESTIONS_JSON_SCHEMA, schemaName: 'workflow_suggestions', maxTokens: 2000, model })
    const parsed = parseSuggestions(raw)
    if (!parsed) return { skipped: 'error' }

    const validFlowIds = new Set(flows.map((f) => f.id))
    const validAgentIds = new Set(agents.map((a) => a.id))

    let newFlowCount = 0
    let improvementCount = 0

    const suggestions = parsed.suggestions.slice(0, MAX_NEW_SUGGESTIONS)
    if (suggestions.length > 0) {
      // Resolve a user to attribute the draft's grounding/generation to — the
      // org's oldest active member, same convention as cron dispatch's
      // unowned-agent fallback.
      const owner = await prisma.user.findFirst({ where: { organizationId, isActive: true }, orderBy: { createdAt: 'asc' } })
      for (const suggestion of suggestions) {
        const saved = await saveAgentMemory({
          organizationId,
          agentId,
          kind: 'suggestion',
          title: suggestion.title,
          content: suggestion.description,
        })
        if (!saved || saved.deduped) continue
        if (!owner) continue
        try {
          const { roster, toolCatalog, contextBlock, graphRules } = await buildCopilotGrounding(organizationId, owner.id)
          const genUser = [`Build a flow that: ${suggestion.flowPrompt}`, '', contextBlock].join('\n')
          const { graph } = await generateFlowGraph({ system: graphRules, user: genUser, roster, toolCatalog })
          await prisma.flow.create({
            data: {
              name: suggestion.title.slice(0, 200),
              description: suggestion.description,
              organizationId,
              userId: owner.id,
              status: 'DRAFT',
              graph: JSON.parse(JSON.stringify(graph)),
              metadata: { suggested: true, sourceMemoryId: saved.id },
            },
          })
          newFlowCount += 1
        } catch (error) {
          apiLogger.warn('synthesizeWorkflowSuggestions: draft flow generation failed', {
            organizationId,
            title: suggestion.title,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }

    for (const improvement of parsed.improvements.slice(0, MAX_IMPROVEMENTS)) {
      if (improvement.targetType === 'flow' && !validFlowIds.has(improvement.targetId)) continue
      if (improvement.targetType === 'agent' && !validAgentIds.has(improvement.targetId)) continue

      const saved =
        improvement.targetType === 'agent'
          ? await saveAgentMemory({
              organizationId,
              agentId: improvement.targetId,
              kind: 'suggestion',
              title: improvement.title,
              content: improvement.rationale,
            })
          : await saveAgentMemory({
              organizationId,
              agentId,
              kind: 'suggestion',
              title: improvement.title,
              content: improvement.rationale,
              question: `${FLOW_TARGET_MARKER_PREFIX}${improvement.targetId}`,
            })
      if (saved && !saved.deduped) improvementCount += 1
    }

    if (newFlowCount === 0 && improvementCount === 0) return { synthesized: true, newFlows: 0, improvements: 0 }

    const parts: string[] = []
    if (newFlowCount > 0) parts.push(`${newFlowCount} new flow draft${newFlowCount === 1 ? '' : 's'}`)
    if (improvementCount > 0) parts.push(`${improvementCount} improvement${improvementCount === 1 ? '' : 's'}`)
    await notify({
      organizationId,
      type: 'intelligence.suggestions',
      title: 'Sublime found something',
      body: `Suggested ${parts.join(' and ')} based on how your team uses its connected tools.`,
      link: '/flows',
    })

    return { synthesized: true, newFlows: newFlowCount, improvements: improvementCount }
  } catch (error) {
    apiLogger.warn('synthesizeWorkflowSuggestions failed', {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { skipped: 'error' }
  }
}
