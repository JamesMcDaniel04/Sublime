import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import {
  countActiveConnections,
  countRecentUsageEvents,
  meetsSuggestionGate,
  meetsUsageEvidenceGate,
} from '@/lib/intelligence/suggest-workflows'

export const runtime = 'nodejs'

const WINDOW_DAYS = 90

// Admin-only "is the platform learning?" rollup for this org: gate states,
// suggestion funnel (open/accepted/dismissed + adopted), pattern inventory,
// and time-to-value markers. Org-scoped — never a cross-org view.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const organizationId = auth.organizationId
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000)

  const [counts, usageEvents, suggestions, openPatterns, firstEvent, lastEvent] = await Promise.all([
    countActiveConnections(organizationId),
    countRecentUsageEvents(organizationId),
    prisma.userSuggestion.findMany({
      where: { organizationId, createdAt: { gte: since } },
      select: { status: true, kind: true, flowId: true },
    }),
    prisma.userPattern.count({ where: { organizationId, status: 'open' } }),
    prisma.userEvent.findFirst({ where: { organizationId }, orderBy: { occurredAt: 'asc' }, select: { occurredAt: true } }),
    prisma.userEvent.findFirst({ where: { organizationId }, orderBy: { occurredAt: 'desc' }, select: { occurredAt: true } }),
  ])

  const byStatus = { open: 0, accepted: 0, dismissed: 0 }
  for (const suggestion of suggestions) {
    if (suggestion.status in byStatus) byStatus[suggestion.status as keyof typeof byStatus] += 1
  }
  const actioned = byStatus.accepted + byStatus.dismissed

  // Adoption: accepted new-flow suggestions whose draft is now a live flow.
  const acceptedFlowIds = suggestions
    .filter((s) => s.status === 'accepted' && s.kind === 'new_flow' && s.flowId)
    .map((s) => s.flowId as string)
  const adopted = acceptedFlowIds.length
    ? await prisma.flow.count({ where: { id: { in: acceptedFlowIds }, organizationId, status: 'ACTIVE' } })
    : 0

  return {
    success: true,
    health: {
      windowDays: WINDOW_DAYS,
      gates: {
        connections: { total: counts.nango + counts.mcp, ready: meetsSuggestionGate(counts) },
        usage: { events: usageEvents, ready: meetsUsageEvidenceGate(usageEvents) },
      },
      suggestions: {
        ...byStatus,
        acceptRate: actioned > 0 ? byStatus.accepted / actioned : null,
        adopted,
      },
      patterns: { open: openPatterns },
      activity: {
        firstEventAt: firstEvent?.occurredAt ?? null,
        lastEventAt: lastEvent?.occurredAt ?? null,
      },
    },
  }
}, { requires: 'insights:workspace' })
