import { z } from 'zod'
import { getMetricSource } from '@/lib/metrics/registry'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

const bodySchema = z.object({
  source: z.enum([
    'stripe',
    'hubspot',
    'salesforce',
    'google_sheets',
    'google_analytics',
    'postgres',
    'url',
    'slack_assisted',
    'gmail_assisted',
    'manual',
  ]),
  metricKey: z.string().min(1),
  connectionRef: z.string().nullable().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const body = bodySchema.parse(await request.json().catch(() => ({})))
  if (body.source === 'manual') {
    throw new ApiError('Manual metrics have no preview', 400, 'NO_PREVIEW')
  }
  const adapter = getMetricSource(body.source)
  if (!adapter) throw new ApiError('Metric source is unavailable', 400, 'SOURCE_UNAVAILABLE')
  try {
    const reading = await adapter.fetchValue(
      {
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        connectionRef: body.connectionRef ?? null,
        config: body.config,
      },
      body.metricKey,
    )
    return { success: true, value: reading.value, asOf: reading.asOf }
  } catch (error) {
    throw new ApiError(
      error instanceof Error ? error.message : 'Preview failed',
      400,
      'PREVIEW_FAILED',
      error,
    )
  }
})
