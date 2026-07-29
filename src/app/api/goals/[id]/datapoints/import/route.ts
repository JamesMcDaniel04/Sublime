import { prisma } from '@/lib/prisma'
import { parseDatapointCsv } from '@/lib/goals/csv-import'
import { evaluateAndPersistGoal } from '@/lib/goals/refresh'
import { recordUserEvent } from '@/lib/behavior/record-event'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

const goalIdFrom = (pathname: string) =>
  decodeURIComponent(pathname.split('/').at(-3) ?? '')

// POST /api/goals/[id]/datapoints/import — bulk-import historical readings
// from a CSV body (`date,value` rows, header optional). Rows land with
// origin 'backfill'; malformed lines are reported by number and never abort
// the valid remainder; one re-evaluation runs at the end.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const goalId = goalIdFrom(request.nextUrl.pathname)
  const goal = await prisma.goal.findFirst({
    where: {
      id: goalId,
      organizationId: auth.organizationId,
      OR: [{ ownerUserId: null }, { ownerUserId: auth.dbUser.id }],
    },
    include: { metrics: { where: { role: 'primary' }, take: 1, select: { id: true } } },
  })
  if (!goal) throw new ApiError('Goal not found', 404, 'GOAL_NOT_FOUND')
  const metric = goal.metrics[0]
  if (!metric) throw new ApiError('Goal metric not found', 409, 'METRIC_NOT_FOUND')

  const text = await request.text()
  if (!text.trim()) throw new ApiError('Paste or upload a CSV with date,value rows.', 400, 'EMPTY_CSV')
  if (text.length > 2_000_000) throw new ApiError('CSV exceeds the 2 MB limit.', 400, 'CSV_TOO_LARGE')

  const { rows, skipped } = parseDatapointCsv(text)
  if (rows.length === 0) {
    throw new ApiError(
      skipped[0] ? `No importable rows — line ${skipped[0].line}: ${skipped[0].reason}` : 'No importable rows.',
      400,
      'NO_ROWS',
    )
  }

  for (const row of rows) {
    await prisma.metricDatapoint.upsert({
      where: {
        goalMetricId_bucketKey: { goalMetricId: metric.id, bucketKey: row.bucketKey },
        organizationId: auth.organizationId,
      },
      create: {
        organizationId: auth.organizationId,
        goalMetricId: metric.id,
        value: row.value,
        capturedAt: row.capturedAt,
        bucketKey: row.bucketKey,
        origin: 'backfill',
      },
      update: { value: row.value, capturedAt: row.capturedAt, origin: 'backfill' },
    })
  }
  await evaluateAndPersistGoal(goalId, auth.organizationId)
  await recordUserEvent({
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    kind: 'goal_datapoints_imported',
    resourceType: 'goal',
    resourceId: goalId,
    context: { imported: rows.length, skipped: skipped.length },
  })
  return { success: true, imported: rows.length, skipped }
}, { requires: 'member' })
