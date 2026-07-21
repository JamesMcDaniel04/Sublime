import { withAuthenticatedApi } from '@/lib/server/api-handler'
import {
  MIN_USAGE_EVENTS_FOR_SUGGESTIONS,
  countActiveConnections,
  countRecentUsageEvents,
  meetsSuggestionGate,
  meetsUsageEvidenceGate,
} from '@/lib/intelligence/suggest-workflows'

export const runtime = 'nodejs'

// The intelligence pipeline's two learning gates, made visible so onboarding
// can pull users toward them instead of the gates being a silent wall:
// 1. connections — suggestions need >= 3 connected tools for cross-tool context;
// 2. usage — recommendations wait for real captured usage, never fire on
//    connections alone.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const [counts, usageEvents] = await Promise.all([
    countActiveConnections(auth.organizationId),
    countRecentUsageEvents(auth.organizationId),
  ])
  const totalConnections = counts.nango + counts.mcp
  const connectionsReady = meetsSuggestionGate(counts)
  const usageReady = meetsUsageEvidenceGate(usageEvents)
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
      ready: connectionsReady && usageReady,
    },
  }
})
