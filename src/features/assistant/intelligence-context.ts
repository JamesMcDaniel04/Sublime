/**
 * Behavior-intelligence context for the Home assistant (spec §5.1). Adds
 * GraphRAG retrieval scoped to the user, gate-passing behavior patterns, and
 * the (at most one) open suggestion. Best-effort and bounded: any failure or
 * unconfigured dependency yields '' and the assistant behaves exactly as today.
 */
import { prisma } from '@/lib/prisma'
import { getGraphRagStore } from '@/lib/rag/get-store'
import { retrieveContext, renderContext } from '@/lib/rag/retrieve'
import { listEligiblePatterns, type EligiblePattern } from '@/lib/behavior/eligibility'

const MAX_BLOCK_CHARS = 3000

export function renderIntelligenceBlock(parts: {
  graphContext: string
  patterns: EligiblePattern[]
  openSuggestion: { title: string; evidence: string[] } | null
}): string {
  const sections: string[] = []
  if (parts.graphContext.trim()) {
    sections.push(`## Workspace knowledge (retrieved)\n${parts.graphContext.trim()}`)
  }
  if (parts.patterns.length > 0) {
    const day = (d: Date) => d.toISOString().slice(0, 10)
    sections.push([
      '## Observed usage patterns (evidence-gated — safe to extrapolate from)',
      ...parts.patterns.slice(0, 8).map((p) => `- ${p.summary} (${p.occurrenceCount}x, ${day(p.firstSeenAt)}..${day(p.lastSeenAt)})`),
    ].join('\n'))
  }
  if (parts.openSuggestion) {
    sections.push([
      '## Pending suggestion (mention only if relevant; the user accepts/dismisses it in the UI)',
      `- ${parts.openSuggestion.title}`,
      ...parts.openSuggestion.evidence.slice(0, 3).map((line) => `  - why: ${line}`),
    ].join('\n'))
  }
  if (sections.length === 0) return ''
  return sections.join('\n\n').slice(0, MAX_BLOCK_CHARS)
}

export async function buildAssistantIntelligence(params: {
  organizationId: string
  userId: string
  query: string
}): Promise<string> {
  try {
    const [context, patterns, suggestion] = await Promise.all([
      retrieveContext(getGraphRagStore(), {
        organizationId: params.organizationId,
        viewerUserId: params.userId,
        query: params.query,
        topK: 6,
      }).catch(() => ({ hits: [], related: [] })),
      listEligiblePatterns(params.organizationId, params.userId),
      prisma.userSuggestion.findFirst({
        where: { organizationId: params.organizationId, userId: params.userId, status: 'open' },
        select: { title: true, evidence: true },
      }).catch(() => null),
    ])
    const graphContext = context.hits.length || context.related.length ? renderContext(context) : ''
    return renderIntelligenceBlock({
      graphContext,
      patterns,
      openSuggestion: suggestion
        ? { title: suggestion.title, evidence: Array.isArray(suggestion.evidence) ? (suggestion.evidence as string[]) : [] }
        : null,
    })
  } catch {
    return ''
  }
}
