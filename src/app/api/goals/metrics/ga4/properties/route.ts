/**
 * GA4 properties the goal wizard can bind a metric to.
 *
 * Authorization is the proxy's, not a separate check: googleProxy resolves the
 * token by (organizationId, connectionId), so a ref belonging to another
 * workspace simply fails to resolve. Same boundary the metric preview route
 * relies on.
 */
import { googleProxy } from '@/lib/google/proxy'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { parseAccountSummaries, type Ga4Property } from '@/lib/metrics/ga4-properties'
import { refId } from '@/lib/metrics/types'

export const runtime = 'nodejs'

export const GET = withAuthenticatedApi(async (request, auth) => {
  const connectionRef = request.nextUrl.searchParams.get('connectionRef')
  const connectionId = refId(connectionRef, 'google')
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
