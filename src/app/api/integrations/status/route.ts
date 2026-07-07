import { getIntegrationStatus } from '@/features/integrations/status'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuthenticatedApi(async (_request, auth) => {
  return getIntegrationStatus(auth.dbUser.id, auth.organizationId)
})
