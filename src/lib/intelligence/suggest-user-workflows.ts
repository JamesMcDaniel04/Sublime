/**
 * Per-user suggestion synthesis (spec §4). Quietness invariants are hard:
 * one open suggestion per user, weekly cadence via an atomic claim on
 * users.metadata.lastBehaviorSynthesisAt, drafts only, and every suggestion
 * cites eligible patterns (validated against the gate's output, never
 * trusted from the model).
 */
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { generateStructured, DEFAULT_SUMMARY_MODEL } from '@/lib/llm/model-runner'
import { checkMonthlyTokenBudget, recordTokenUsage } from '@/lib/usage/budget'
import { flowCapacityAvailable } from '@/lib/billing/enforce'
import { captureError } from '@/lib/observability/sentry'
import { saveAgentMemory } from '@/lib/memory/agent-memory'
import { notify } from '@/lib/notifications/service'
import { buildCopilotGrounding } from '@/lib/flows/copilot-grounding'
import { generateFlowGraph } from '@/lib/flows/copilot-generate'
import { listEligiblePatterns, type EligiblePattern } from '@/lib/behavior/eligibility'
import { loadCapabilityCatalog } from '@/lib/behavior/infer-user-patterns'
import { suggestionOutcomeLabel } from '@/lib/behavior/outcome-weights'
import { countActiveConnections, loadExistingFlows, loadExistingAgents, meetsSuggestionGate } from './suggest-workflows'

export const USER_SYNTHESIS_COOLDOWN_DAYS = 7

export type UserSuggestionCandidate = {
  kind: 'new_flow' | 'enhancement'
  title: string
  description: string
  flowPrompt?: string
  targetType?: 'flow' | 'agent'
  targetId?: string
  sourcePatternSlugs: string[]
}

const candidateSchema = z.object({
  suggestion: z.object({
    kind: z.enum(['new_flow', 'enhancement']),
    title: z.string().min(1),
    description: z.string().min(1),
    flowPrompt: z.string().optional(),
    targetType: z.enum(['flow', 'agent']).optional(),
    targetId: z.string().optional(),
    sourcePatternSlugs: z.array(z.string()).default([]),
  }).nullable(),
})

export const USER_SUGGESTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    suggestion: {
      type: ['object', 'null'],
      properties: {
        kind: { type: 'string', enum: ['new_flow', 'enhancement'] },
        title: { type: 'string' },
        description: { type: 'string' },
        flowPrompt: { type: 'string' },
        targetType: { type: 'string', enum: ['flow', 'agent'] },
        targetId: { type: 'string' },
        sourcePatternSlugs: { type: 'array', items: { type: 'string' } },
      },
      required: ['kind', 'title', 'description', 'sourcePatternSlugs'],
    },
  },
  required: ['suggestion'],
}

/** Tolerant parse + evidence contract. At most ONE candidate; null on any violation. */
export function parseUserSuggestions(raw: string, validSlugs: Set<string>): UserSuggestionCandidate | null {
  const trimmed = raw.trim()
  const candidates = [trimmed]
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidates.push(fence[1].trim())
  const braces = trimmed.match(/\{[\s\S]*\}/)
  if (braces) candidates.push(braces[0])
  for (const candidate of candidates) {
    try {
      const result = candidateSchema.safeParse(JSON.parse(candidate))
      if (!result.success) continue
      const suggestion = result.data.suggestion
      if (!suggestion) return null
      const slugs = suggestion.sourcePatternSlugs.filter((slug) => validSlugs.has(slug))
      if (slugs.length === 0) return null
      if (suggestion.kind === 'new_flow' && !suggestion.flowPrompt?.trim()) return null
      if (suggestion.kind === 'enhancement' && (!suggestion.targetType || !suggestion.targetId)) return null
      return { ...suggestion, sourcePatternSlugs: slugs }
    } catch {
      /* try next */
    }
  }
  return null
}

const day = (date: Date) => date.toISOString().slice(0, 10)

const UNUSED_CAPABILITY_PROVIDERS = 8
const UNUSED_CAPABILITIES_PER_PROVIDER = 5

/**
 * "Unused capabilities" prompt block (cross-tool spec §5): deterministic,
 * names only. Scoped to providers the user has actually touched — dormant
 * tools are the gap miner's job, and listing every capability of every
 * untouched tool would drown the prompt. Pure so the rendering is testable.
 */
export function renderUnusedCapabilities(
  capabilitiesByProvider: ReadonlyMap<string, string[]>,
  calledByProvider: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const lines: string[] = []
  for (const provider of [...calledByProvider.keys()].sort().slice(0, UNUSED_CAPABILITY_PROVIDERS)) {
    const catalog = capabilitiesByProvider.get(provider)
    if (!catalog?.length) continue
    const called = calledByProvider.get(provider) ?? new Set<string>()
    const unused = [...new Set(catalog)].filter((name) => !called.has(name)).sort().slice(0, UNUSED_CAPABILITIES_PER_PROVIDER)
    if (unused.length === 0) continue
    lines.push(`- ${provider}: ${unused.join(', ')}`)
  }
  return lines
}

/** The user's called tool names per provider from their tool_call ledger. Never throws. */
async function loadCalledCapabilities(organizationId: string, userId: string): Promise<Map<string, Set<string>>> {
  try {
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    const events = await prisma.userEvent.findMany({
      where: { organizationId, userId, kind: 'tool_call', occurredAt: { gte: since } },
      select: { resourceId: true, context: true },
      take: 500,
    })
    const called = new Map<string, Set<string>>()
    for (const event of events) {
      if (!event.resourceId) continue
      const names = (event.context as { toolNames?: unknown } | null)?.toolNames
      const set = called.get(event.resourceId) ?? new Set<string>()
      if (Array.isArray(names)) for (const name of names) if (typeof name === 'string') set.add(name)
      called.set(event.resourceId, set)
    }
    return called
  } catch {
    return new Map()
  }
}

/**
 * "why this exists" lines (spec §4) — a SELF-CONTAINED human-readable snapshot.
 * Deliberately no raw event ids: the ledger ages out at 180 days while this
 * snapshot lives on the suggestion forever, so ids would rot into dangling
 * references. Machine-verifiable evidence stays on the pattern rows (recomputed
 * from live events every inference run) and in the graph's evidence edges.
 */
export function renderPatternEvidence(patterns: EligiblePattern[]): string[] {
  return patterns.map((pattern) =>
    `${pattern.summary} — observed ${pattern.occurrenceCount} times between ${day(pattern.firstSeenAt)} and ${day(pattern.lastSeenAt)}, most recently ${day(pattern.lastSeenAt)}`,
  )
}

// Outcome labeling moved to behavior (phase 4) so the eligibility gate can
// consume it without an intelligence → behavior → intelligence cycle;
// re-exported here for existing callers and tests.
export { suggestionOutcomeLabel, ADOPTION_WINDOW_MS, type SuggestionFeedbackRow } from '@/lib/behavior/outcome-weights'

export type UserSynthesisResult =
  | { skipped: 'below-gate' | 'pending-suggestion' | 'no-eligible-patterns' | 'budget-exceeded' | 'throttled' | 'no-suggestion' | 'generation-failed' | 'flow-capacity' | 'error' }
  | { created: true; suggestionId: string; kind: 'new_flow' | 'enhancement' }

export type UserSynthesisOverrides = {
  generate?: typeof generateStructured
  generateGraph?: typeof generateFlowGraph
  now?: () => Date
}

export async function synthesizeUserSuggestions(
  organizationId: string,
  userId: string,
  overrides: UserSynthesisOverrides = {},
): Promise<UserSynthesisResult> {
  const generate = overrides.generate ?? generateStructured
  const generateGraph = overrides.generateGraph ?? generateFlowGraph
  const now = overrides.now ? overrides.now() : new Date()
  try {
    // Connection gate (same bar as the org pipeline): the platform must not
    // recommend anything until the workspace has connected enough tools for
    // suggestions to be grounded in real cross-tool usage.
    if (!meetsSuggestionGate(await countActiveConnections(organizationId))) return { skipped: 'below-gate' }

    // Quietness guard 1: one un-actioned suggestion at a time.
    const open = await prisma.userSuggestion.findFirst({ where: { organizationId, userId, status: 'open' }, select: { id: true } })
    if (open) return { skipped: 'pending-suggestion' }

    // Evidence guard: only gate-passing patterns exist downstream of here.
    const patterns = await listEligiblePatterns(organizationId, userId)
    if (patterns.length === 0) return { skipped: 'no-eligible-patterns' }

    // Cost discipline (parity with the org-level pipeline): background
    // intelligence must never push an org past its monthly token ceiling —
    // an over-budget org simply skips synthesis until the month rolls over.
    const budget = await checkMonthlyTokenBudget(organizationId, userId)
    if (budget.over) return { skipped: 'budget-exceeded' }

    // Quietness guard 2: atomic weekly claim on users.metadata (mirrors
    // claimSynthesisSlotAtomic in suggest-workflows.ts; users.id is TEXT).
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { metadata: true } })
    const previous = readClaim(user?.metadata)
    const nowIso = now.toISOString()
    const affected = await prisma.$executeRaw`
      UPDATE users
      SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{lastBehaviorSynthesisAt}', to_jsonb(${nowIso}::text))
      WHERE id = ${userId}
        AND (
          COALESCE(metadata->>'lastBehaviorSynthesisAt', '') = ''
          OR (metadata->>'lastBehaviorSynthesisAt')::timestamptz < (${nowIso}::timestamptz - interval '7 days')
        )
    `
    if (affected === 0) return { skipped: 'throttled' }

    try {
      const [flows, agents, unusedCapabilityLines, feedbackRows] = await Promise.all([
        loadExistingFlows(organizationId),
        loadExistingAgents(organizationId),
        // Cross-tool spec §5: deterministic unused-capability block. Both
        // loaders degrade to empty on failure — the block simply disappears.
        Promise.all([loadCapabilityCatalog(organizationId, userId), loadCalledCapabilities(organizationId, userId)])
          .then(([catalog, called]) => renderUnusedCapabilities(catalog, called))
          .catch(() => [] as string[]),
        prisma.userSuggestion.findMany({
          where: { organizationId, userId, status: { in: ['accepted', 'dismissed'] } },
          orderBy: { updatedAt: 'desc' }, take: 20,
          select: { title: true, status: true, kind: true, flowId: true, updatedAt: true },
        }),
      ])
      // Outcome enrichment: check what became of accepted draft flows so the
      // model learns from adoption, not just the accept click.
      const acceptedFlowIds = feedbackRows
        .filter((row) => row.status === 'accepted' && row.kind === 'new_flow' && row.flowId)
        .map((row) => row.flowId as string)
      const outcomeFlows = acceptedFlowIds.length
        ? await prisma.flow.findMany({
            where: { id: { in: acceptedFlowIds }, organizationId },
            select: { id: true, status: true, publishedGraph: true },
          })
        : []
      const flowById = new Map(outcomeFlows.map((flow) => [flow.id, flow]))
      const feedback = feedbackRows.map((row) => ({
        title: row.title,
        outcome: suggestionOutcomeLabel(row, row.flowId ? flowById.get(row.flowId) ?? null : null, now),
      }))
      const system = [
        'You are the personal automation-suggestion engine for ONE user of a workflow platform. You are given behavior patterns OBSERVED from their real usage (counts and dates are facts, computed — not guesses).',
        'Propose AT MOST ONE suggestion — the single highest-value one — or null if nothing is clearly worth their attention. Be conservative: a mediocre suggestion costs trust.',
        'kind "new_flow": a new automation replacing a repeated manual routine; include flowPrompt detailed enough for a flow-builder AI. kind "enhancement": a concrete improvement to one EXISTING flow/agent from the lists (exact targetId; never invent one).',
        'sourcePatternSlugs MUST cite the exact slugs of the observed patterns that justify the suggestion. Do not repeat previously dismissed ideas.',
        'You may connect an observed pattern to an unused capability of a connected tool (listed below) — but the suggestion must still be justified by, and cite, observed pattern slugs. Never suggest from the capability list alone.',
        'peer_practice patterns describe org-shared automations that ALREADY EXIST: prefer suggesting the user adopt or adapt that existing flow (kind "enhancement" targeting it, or "new_flow" for a personal variant) over inventing something new. Never mention who owns it.',
        'archetype_gap patterns are anonymized platform-wide aggregates ("N other organizations with your tools automate X"). Suggest conservatively from them and never imply knowledge of any specific organization.',
        'commitment patterns come from the user\'s own meeting notes: they repeatedly committed to the same follow-through after a recurring meeting. Suggest a flow that automates that follow-through (draft the email/update/task), triggered after the meeting — reference the meeting series by name but never quote note contents.',
        'Feedback outcomes are what ACTUALLY happened: "accepted-and-adopted" is the strongest positive signal; "accepted-but-never-published" and "accepted-then-deleted" mean the idea sounded good but was not worth acting on — treat those nearly as negatively as dismissed.',
      ].join(' ')
      const userPrompt = [
        'Observed behavior patterns (slug | summary | count | first..last):',
        ...patterns.map((p) => `- ${p.slug} | ${p.summary} | ${p.occurrenceCount}x | ${day(p.firstSeenAt)}..${day(p.lastSeenAt)}`),
        '',
        'Existing flows:',
        flows.length ? flows.map((f) => `- id:${f.id} "${f.name}" (trigger:${f.triggerType})`).join('\n') : '- None',
        '',
        'Existing agents:',
        agents.length ? agents.map((a) => `- id:${a.id} "${a.title}"`).join('\n') : '- None',
        '',
        'Prior suggestion feedback (outcome: title):',
        feedback.length ? feedback.map((f) => `- ${f.outcome}: ${f.title}`).join('\n') : '- None yet',
        '',
        'Unused capabilities of connected tools (provider: capability names, computed from the catalog vs. actual usage):',
        unusedCapabilityLines.length ? unusedCapabilityLines.join('\n') : '- None',
      ].join('\n')

      const model = process.env.AGENT_REFLECTION_MODEL?.trim() || DEFAULT_SUMMARY_MODEL
      const raw = await generate({ system, user: userPrompt, schema: USER_SUGGESTION_JSON_SCHEMA, schemaName: 'user_suggestion', maxTokens: 1500, model })
      // Rough metering (~chars/4, same convention as the assistant): the
      // structured runner returns no usage numbers.
      void recordTokenUsage(organizationId, Math.ceil((system.length + userPrompt.length + raw.length) / 4)).catch(() => undefined)
      const candidate = parseUserSuggestions(raw, new Set(patterns.map((p) => p.slug)))
      if (!candidate) {
        await releaseClaim(userId, previous)
        return { skipped: 'no-suggestion' }
      }
      const cited = patterns.filter((p) => candidate.sourcePatternSlugs.includes(p.slug))
      const evidence = renderPatternEvidence(cited)

      if (candidate.kind === 'new_flow') {
        const { roster, toolCatalog, contextBlock, graphRules } = await buildCopilotGrounding(organizationId, userId)
        const { graph, validation } = await generateGraph({
          system: graphRules,
          user: [`Build a flow that: ${candidate.flowPrompt}`, '', contextBlock].join('\n'),
          roster, toolCatalog,
        })
        if (!validation.ok) {
          await releaseClaim(userId, previous)
          return { skipped: 'generation-failed' }
        }
        // Same rule as org-level suggestion drafts: background work skips at
        // plan capacity instead of consuming the user's remaining slots.
        if (!(await flowCapacityAvailable(organizationId))) {
          await releaseClaim(userId, previous)
          return { skipped: 'flow-capacity' }
        }
        const flow = await prisma.flow.create({
          data: {
            name: candidate.title.slice(0, 200), description: candidate.description,
            organizationId, userId, status: 'DRAFT', visibility: 'private',
            graph: JSON.parse(JSON.stringify(graph)),
            metadata: { suggested: true, suggestedForUserId: userId, sourcePatternSlugs: candidate.sourcePatternSlugs },
          },
        })
        const suggestion = await prisma.userSuggestion.create({
          data: {
            organizationId, userId, kind: 'new_flow', title: candidate.title, description: candidate.description,
            flowId: flow.id, sourcePatternSlugs: candidate.sourcePatternSlugs, evidence,
          },
        })
        // User-scoped 'action' notification: the bell badges it, web push fires,
        // and opening it shows the approve/deny detail dialog.
        await notify({ organizationId, userId, type: 'intelligence.user-suggestion', level: 'action', title: 'Sublime noticed a routine', body: candidate.title, link: '/dashboard' })
        return { created: true, suggestionId: suggestion.id, kind: 'new_flow' }
      }

      // enhancement: target must exist in THIS org (never trust the model)
      const validTarget =
        candidate.targetType === 'flow'
          ? flows.some((f) => f.id === candidate.targetId)
          : agents.some((a) => a.id === candidate.targetId)
      if (!validTarget) {
        await releaseClaim(userId, previous)
        return { skipped: 'no-suggestion' }
      }
      const suggestion = await prisma.userSuggestion.create({
        data: {
          organizationId, userId, kind: 'enhancement', title: candidate.title, description: candidate.description,
          targetType: candidate.targetType, targetId: candidate.targetId,
          sourcePatternSlugs: candidate.sourcePatternSlugs, evidence,
        },
      })
      if (candidate.targetType === 'agent' && candidate.targetId) {
        await saveAgentMemory({ organizationId, agentId: candidate.targetId, kind: 'suggestion', title: candidate.title, content: candidate.description })
      }
      await notify({ organizationId, userId, type: 'intelligence.user-suggestion', level: 'action', title: 'Sublime noticed a routine', body: candidate.title, link: '/dashboard' })
      return { created: true, suggestionId: suggestion.id, kind: 'enhancement' }
    } catch (error) {
      await releaseClaim(userId, previous)
      throw error
    }
  } catch (error) {
    apiLogger.warn('synthesizeUserSuggestions failed', { organizationId, userId, error: error instanceof Error ? error.message : String(error) })
    captureError(error, { scope: 'behavior.synthesis', organizationId })
    return { skipped: 'error' }
  }
}

function readClaim(metadata: unknown): Date | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const value = (metadata as Record<string, unknown>).lastBehaviorSynthesisAt
  if (typeof value !== 'string') return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

async function releaseClaim(userId: string, previous: Date | null): Promise<void> {
  try {
    if (previous) {
      const iso = previous.toISOString()
      await prisma.$executeRaw`UPDATE users SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{lastBehaviorSynthesisAt}', to_jsonb(${iso}::text)) WHERE id = ${userId}`
    } else {
      await prisma.$executeRaw`UPDATE users SET metadata = COALESCE(metadata, '{}'::jsonb) - 'lastBehaviorSynthesisAt' WHERE id = ${userId}`
    }
  } catch (error) {
    apiLogger.warn('synthesizeUserSuggestions: claim release failed', { userId, error: error instanceof Error ? error.message : String(error) })
  }
}
