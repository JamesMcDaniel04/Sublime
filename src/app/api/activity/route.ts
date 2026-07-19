import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { capabilitiesForPlan } from '@/lib/billing/capabilities'

export const dynamic = 'force-dynamic'

const querySchema = z.object({
  source: z.string().max(40).optional(),
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

// Workspace activity history: the normalized cross-tool event ledger
// (Slack/Salesforce/GitHub/... via webhooks and backfills), newest first.
// Team plans and above.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const capabilities = capabilitiesForPlan(auth.dbUser.organization?.plan ?? 'TRIAL')
  if (!capabilities.activityHistory) {
    throw new ApiError('Activity history is available on Team plans and above.', 403, 'PLAN_LIMIT')
  }

  const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams))
  const events = await prisma.activityEvent.findMany({
    where: {
      organizationId: auth.organizationId,
      ...(query.source ? { source: query.source } : {}),
    },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    take: query.limit,
    select: {
      id: true,
      source: true,
      actorName: true,
      action: true,
      entityType: true,
      entityName: true,
      outcome: true,
      occurredAt: true,
      ingestKind: true,
    },
  })

  return {
    success: true,
    events,
    nextCursor: events.length === query.limit ? events[events.length - 1].id : null,
  }
})
