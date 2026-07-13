import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { getActivitySource } from '@/lib/activity/registry'
import { startActivityBackfill } from '@/lib/activity/backfill'

const startSchema = z.object({
  source: z.string().min(1),
  connectionRef: z.string().min(1),
  window: z.enum(['90d', '1y', 'all']),
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = startSchema.parse(await request.json())
  if (!getActivitySource(data.source)?.capabilities.backfill) {
    throw new ApiError(`source ${data.source} does not support backfill`, 400, 'UNSUPPORTED_ACTIVITY_SOURCE')
  }
  const result = await startActivityBackfill({ organizationId: auth.organizationId, ...data })
  return Response.json({ success: true, ...result }, { status: 202 })
})

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const backfills = await prisma.activityBackfill.findMany({
    where: { organizationId: auth.organizationId },
    select: {
      id: true,
      source: true,
      connectionRef: true,
      window: true,
      status: true,
      eventsIngested: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: 'desc' },
  })
  return { success: true, backfills }
})
