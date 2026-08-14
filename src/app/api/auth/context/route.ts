import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const GET = withAuthenticatedApi(async (_request, auth) => ({
  success: true,
  context: {
    userId: auth.dbUser.id,
    organizationId: auth.organizationId,
    role: auth.dbUser.role,
  },
}), {
  requires: 'member',
  // Session-bootstrap routes are what an authenticated attacker loops to probe
  // or to make the Supabase Auth round-trip repeatedly on our behalf. Generous
  // enough for normal navigation, bounded enough to stop a script.
  rateLimit: { feature: 'auth-context', perUser: 120 },
})
