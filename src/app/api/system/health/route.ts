import { collectHealthDetails } from '@/lib/health/readiness'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

/** Authenticated operator view used by the system settings surface. */
export const GET = withAuthenticatedApi(async () => ({
  success: true,
  ...(await collectHealthDetails()),
}), { requires: 'settings:workspace', rateLimit: { feature: 'system-health', perUser: 12 } })
