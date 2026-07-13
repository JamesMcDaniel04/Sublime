/** Evidence-constrained inference over the durable activity ledger. */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { generateStructured, DEFAULT_SUMMARY_MODEL } from '@/lib/llm/model-runner'
import { saveAgentMemory } from '@/lib/memory/agent-memory'
import { writeInference, insightNodeId } from '@/lib/activity/insights'
import { orgIntelligenceAgentId } from '@/lib/intelligence/connection-scan'

export interface ParsedInference {
  slug: string
  kind: 'inferred_pattern' | 'recommendation'
  text: string
  evidenceEventIds: string[]
  basedOnSlugs: string[]
}

const INFERENCE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    inferences: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'stable-kebab-case-identifier' },
          kind: { type: 'string', enum: ['inferred_pattern', 'recommendation'] },
          text: { type: 'string' },
          evidenceEventIds: { type: 'array', items: { type: 'string' } },
          basedOnSlugs: { type: 'array', items: { type: 'string' } },
        },
        required: ['slug', 'kind', 'text'],
      },
    },
  },
  required: ['inferences'],
} as const

export function parseInferences(raw: unknown, validEventIds: Set<string>): ParsedInference[] {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch { return [] }
  }
  if (!raw || typeof raw !== 'object') return []
  const list = (raw as { inferences?: unknown }).inferences
  if (!Array.isArray(list)) return []

  const candidates: ParsedInference[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const { slug, kind, text } = item as Record<string, unknown>
    if (typeof slug !== 'string' || !slug || typeof text !== 'string' || !text) continue
    if (kind !== 'inferred_pattern' && kind !== 'recommendation') continue
    const rawEvidence = (item as { evidenceEventIds?: unknown }).evidenceEventIds
    const evidenceEventIds = (Array.isArray(rawEvidence) ? rawEvidence : [])
      .filter((id): id is string => typeof id === 'string' && validEventIds.has(id))
    const rawBased = (item as { basedOnSlugs?: unknown }).basedOnSlugs
    const basedOnSlugs = (Array.isArray(rawBased) ? rawBased : [])
      .filter((slug): slug is string => typeof slug === 'string')
    candidates.push({ slug, kind, text, evidenceEventIds, basedOnSlugs })
  }

  const patternSlugs = new Set(candidates
    .filter((candidate) => candidate.kind === 'inferred_pattern' && candidate.evidenceEventIds.length > 0)
    .map((candidate) => candidate.slug))
  return candidates.filter((candidate) => {
    if (candidate.kind === 'inferred_pattern') return candidate.evidenceEventIds.length > 0
    candidate.basedOnSlugs = candidate.basedOnSlugs.filter((slug) => patternSlugs.has(slug))
    return candidate.basedOnSlugs.length > 0
  })
}

type Fact = {
  id: string; actorName: string | null; actorRef: string; action: string
  entityType: string; entityName: string | null; entityRef: string; source: string
  occurredAt: Date; previousState: unknown; newState: unknown; outcome: string | null
}

function factLine(event: Fact): string {
  const state = event.previousState != null || event.newState != null
    ? ` [${JSON.stringify(event.previousState)} → ${JSON.stringify(event.newState)}]`
    : ''
  return `${event.id}: ${event.actorName ?? event.actorRef} ${event.action} ${event.entityType} ${event.entityName ?? event.entityRef} (${event.source}, ${event.occurredAt.toISOString().slice(0, 10)})${state}${event.outcome ? ` outcome=${event.outcome}` : ''}`
}

export async function inferActivityPatterns(
  organizationId: string,
  opts: { windowDays?: number; maxEvents?: number } = {},
): Promise<{ patterns: number; recommendations: number } | { skipped: string }> {
  try {
    const since = new Date(Date.now() - (opts.windowDays ?? 30) * 24 * 60 * 60 * 1000)
    const events = await prisma.activityEvent.findMany({
      where: { organizationId, occurredAt: { gte: since } },
      orderBy: { occurredAt: 'desc' },
      take: opts.maxEvents ?? 300,
      select: {
        id: true, actorRef: true, actorName: true, action: true, entityType: true,
        entityRef: true, entityName: true, source: true, occurredAt: true,
        previousState: true, newState: true, outcome: true,
      },
    })
    if (events.length < 10) return { skipped: 'too-few-events' }

    const validIds = new Set(events.map((event) => event.id))
    const system = [
      "You analyze a company's observed cross-tool business activity and infer operational patterns.",
      'Every inferred_pattern MUST cite evidenceEventIds copied EXACTLY from the fact lines.',
      'Never invent event ids. Recommendations cite pattern slugs via basedOnSlugs, never event ids.',
      'Only report patterns supported by repetition, delay, backward movement, or outcome data.',
      'Return at most 5 patterns and 3 recommendations.',
    ].join(' ')
    const user = `Observed facts (id: description):\n${events.map(factLine).join('\n')}`
    const model = process.env.AGENT_REFLECTION_MODEL?.trim() || DEFAULT_SUMMARY_MODEL
    const raw = await generateStructured({
      system, user, schema: INFERENCE_JSON_SCHEMA, schemaName: 'activity_inferences', maxTokens: 2000, model,
    })
    const inferences = parseInferences(raw, validIds)
    if (inferences.length === 0) return { skipped: 'no-inferences' }

    let patterns = 0
    let recommendations = 0
    const agentId = await orgIntelligenceAgentId(organizationId)
    for (const inference of inferences) {
      const ok = await writeInference({
        organizationId,
        kind: inference.kind,
        slug: inference.slug,
        text: inference.text,
        evidenceEventIds: inference.evidenceEventIds,
        basedOnInsightIds: inference.basedOnSlugs.map((slug) => insightNodeId('inferred_pattern', slug)),
      })
      if (!ok) continue
      if (inference.kind === 'inferred_pattern') patterns++
      else recommendations++
      await saveAgentMemory({
        organizationId,
        agentId,
        kind: 'learning',
        title: `${inference.kind === 'recommendation' ? 'Recommendation' : 'Pattern'}: ${inference.text.slice(0, 80)}`,
        content: inference.text,
        sourceRef: `activity-inference:${inference.slug}`,
      })
    }
    return { patterns, recommendations }
  } catch (error) {
    apiLogger.warn('intelligence.inferActivityPatterns failed', {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { skipped: 'error' }
  }
}
