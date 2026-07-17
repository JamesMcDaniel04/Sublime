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
import { saveAgentMemory } from '@/lib/memory/agent-memory'
import { notify } from '@/lib/notifications/service'
import { buildCopilotGrounding } from '@/lib/flows/copilot-grounding'
import { generateFlowGraph } from '@/lib/flows/copilot-generate'
import { listEligiblePatterns, type EligiblePattern } from '@/lib/behavior/eligibility'
import { loadExistingFlows, loadExistingAgents } from './suggest-workflows'

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

/** "why this exists" lines — dated, citing the specific events (spec §4). */
export function renderPatternEvidence(patterns: EligiblePattern[]): string[] {
  return patterns.map((pattern) =>
    `${pattern.summary} — ${pattern.occurrenceCount} times between ${day(pattern.firstSeenAt)} and ${day(pattern.lastSeenAt)} (events: ${pattern.evidence.slice(0, 5).join(', ')})`,
  )
}

export type UserSynthesisResult =
  | { skipped: 'pending-suggestion' | 'no-eligible-patterns' | 'throttled' | 'no-suggestion' | 'generation-failed' | 'error' }
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
    // Quietness guard 1: one un-actioned suggestion at a time.
    const open = await prisma.userSuggestion.findFirst({ where: { organizationId, userId, status: 'open' }, select: { id: true } })
    if (open) return { skipped: 'pending-suggestion' }

    // Evidence guard: only gate-passing patterns exist downstream of here.
    const patterns = await listEligiblePatterns(organizationId, userId)
    if (patterns.length === 0) return { skipped: 'no-eligible-patterns' }

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
      const [flows, agents, feedback] = await Promise.all([
        loadExistingFlows(organizationId),
        loadExistingAgents(organizationId),
        prisma.userSuggestion.findMany({
          where: { organizationId, userId, status: { in: ['accepted', 'dismissed'] } },
          orderBy: { updatedAt: 'desc' }, take: 20, select: { title: true, status: true },
        }),
      ])
      const system = [
        'You are the personal automation-suggestion engine for ONE user of a workflow platform. You are given behavior patterns OBSERVED from their real usage (counts and dates are facts, computed — not guesses).',
        'Propose AT MOST ONE suggestion — the single highest-value one — or null if nothing is clearly worth their attention. Be conservative: a mediocre suggestion costs trust.',
        'kind "new_flow": a new automation replacing a repeated manual routine; include flowPrompt detailed enough for a flow-builder AI. kind "enhancement": a concrete improvement to one EXISTING flow/agent from the lists (exact targetId; never invent one).',
        'sourcePatternSlugs MUST cite the exact slugs of the observed patterns that justify the suggestion. Do not repeat previously dismissed ideas.',
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
        'Prior suggestion feedback:',
        feedback.length ? feedback.map((f) => `- ${f.status}: ${f.title}`).join('\n') : '- None yet',
      ].join('\n')

      const model = process.env.AGENT_REFLECTION_MODEL?.trim() || DEFAULT_SUMMARY_MODEL
      const raw = await generate({ system, user: userPrompt, schema: USER_SUGGESTION_JSON_SCHEMA, schemaName: 'user_suggestion', maxTokens: 1500, model })
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
        await notify({ organizationId, type: 'intelligence.user-suggestion', title: 'Sublime noticed a routine', body: candidate.title, link: '/dashboard' })
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
      await notify({ organizationId, type: 'intelligence.user-suggestion', title: 'Sublime noticed a routine', body: candidate.title, link: '/dashboard' })
      return { created: true, suggestionId: suggestion.id, kind: 'enhancement' }
    } catch (error) {
      await releaseClaim(userId, previous)
      throw error
    }
  } catch (error) {
    apiLogger.warn('synthesizeUserSuggestions failed', { organizationId, userId, error: error instanceof Error ? error.message : String(error) })
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
