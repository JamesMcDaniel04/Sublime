import { orgImpact } from '@/lib/goals/impact'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

export const GET = withAuthenticatedApi(async (_request, auth) => ({
  success: true,
  impact: await orgImpact(auth.organizationId, auth.dbUser.id),
}))
