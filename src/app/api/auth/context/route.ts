import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const GET = withAuthenticatedApi(async (_request, auth) => ({
  success: true,
  context: {
    userId: auth.dbUser.id,
    organizationId: auth.organizationId,
    role: auth.dbUser.role,
  },
}))
