import { listMetricSourceOptions } from '@/lib/metrics/available-sources'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

export const GET = withAuthenticatedApi(async (_request, auth) => ({
  success: true,
  sources: await listMetricSourceOptions(auth),
}))
