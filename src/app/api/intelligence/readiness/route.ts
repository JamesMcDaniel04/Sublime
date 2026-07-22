import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { prisma } from '@/lib/prisma'
import {
  MIN_USAGE_EVENTS_FOR_SUGGESTIONS,
  countActiveConnections,
  countRecentUsageEvents,
  meetsSuggestionGate,
  meetsUsageEvidenceGate,
} from '@/lib/intelligence/suggest-workflows'
import { LEARNING_PERIOD_DAYS, listEligiblePatterns } from '@/lib/behavior/eligibility'

export const runtime = 'nodejs'

const DAY_MS = 24 * 60 * 60 * 1000

// The intelligence pipeline's learning gates, made visible so the "why am I
// seeing no suggestions?" state is explainable instead of a silent wall:
//  - org gates: connections (>= 3 tools) and captured usage (>= N events);
//  - personal gate: the per-user learning period + whether any behavior
//    pattern has cleared the eligibility gate yet. A user past the org gates
//    but with no eligible pattern used to read "ready" and still get nothing;
//    this surfaces exactly which stage they're at.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const [counts, usageEvents, firstEvent, eligible, openSuggestion] = await Promise.all([
    countActiveConnections(auth.organizationId),
    countRecentUsageEvents(auth.organizationId),
    prisma.userEvent.findFirst({
      where: { organizationId: auth.organizationId, userId: auth.dbUser.id },
      orderBy: { occurredAt: 'asc' },
      select: { occurredAt: true },
    }),
    listEligiblePatterns(auth.organizationId, auth.dbUser.id),
    prisma.userSuggestion.findFirst({
      where: { organizationId: auth.organizationId, userId: auth.dbUser.id, status: 'open' },
      select: { id: true },
    }),
  ])
  const totalConnections = counts.nango + counts.mcp
  const connectionsReady = meetsSuggestionGate(counts)
  const usageReady = meetsUsageEvidenceGate(usageEvents)

  const daysSinceFirst = firstEvent ? (Date.now() - firstEvent.occurredAt.getTime()) / DAY_MS : null
  const learningDaysLeft = daysSinceFirst === null
    ? LEARNING_PERIOD_DAYS
    : Math.max(0, Math.ceil(LEARNING_PERIOD_DAYS - daysSinceFirst))

  return {
    success: true,
    readiness: {
      connections: {
        total: totalConnections,
        needed: connectionsReady ? 0 : Math.max(0, 3 - totalConnections),
        ready: connectionsReady,
      },
      usage: {
        events: usageEvents,
        needed: usageReady ? 0 : Math.max(0, MIN_USAGE_EVENTS_FOR_SUGGESTIONS - usageEvents),
        ready: usageReady,
      },
      // Personal learning state (only meaningful once the org gates are met).
      personal: {
        hasActivity: firstEvent !== null,
        learningDaysLeft,
        inLearningPeriod: learningDaysLeft > 0,
        eligiblePatterns: eligible.length,
        openSuggestion: openSuggestion !== null,
      },
      ready: connectionsReady && usageReady,
    },
  }
})
