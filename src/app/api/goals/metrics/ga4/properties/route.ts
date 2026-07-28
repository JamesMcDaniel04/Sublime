/**
 * GA4 properties the goal wizard can bind a metric to.
 *
 * Authorization is the proxy's, not a separate check: googleProxy resolves the
 * token by (organizationId, connectionId), so a ref belonging to another
 * workspace simply fails to resolve. Same boundary the metric preview route
 * relies on.
 */
import { googleProxy } from '@/lib/google/proxy'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { parseAccountSummaries, type Ga4Property } from '@/lib/metrics/ga4-properties'

export const runtime = 'nodejs'

const GOOGLE_PLANE = 'google:'

export const GET = withAuthenticatedApi(async (request, auth) => {
  const connectionRef = request.nextUrl.searchParams.get('connectionRef') ?? ''
  // Validated here rather than via refId(), which throws a plain Error and so
  // would surface a caller's missing query param as a logged 500.
  if (!connectionRef.startsWith(GOOGLE_PLANE) || connectionRef.length <= GOOGLE_PLANE.length) {
    throw new ApiError(
      'Pass the Google Analytics connection as connectionRef=google:<id>.',
      400,
      'INVALID_CONNECTION_REF',
    )
  }
  const connectionId = connectionRef.slice(GOOGLE_PLANE.length)
  const proxy = googleProxy({ organizationId: auth.organizationId, connectionId })
  try {
    const { data } = await proxy({
      method: 'GET',
      endpoint: '/v1beta/accountSummaries',
      connectionId,
      providerConfigKey: 'google-analytics',
    })
    return { success: true, properties: parseAccountSummaries(data) }
  } catch {
    // The wizard falls back to a manual id input on an empty list, so a failed
    // probe must not block goal creation.
    return { success: true, properties: [] as Ga4Property[] }
  }
})
