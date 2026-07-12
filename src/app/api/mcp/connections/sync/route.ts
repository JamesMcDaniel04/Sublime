import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { KlavisClient } from '@/lib/mcp/klavis-client'
import { PROVIDERS, PROVIDER_CAPABILITIES, type MCPProvider } from '@/lib/mcp/provider-capabilities'
import { createServersForTenant } from '@/lib/mcp/server-provisioning'

/**
 * Import only connections Klavis says are already authenticated for this app
 * user. Klavis remains the source of truth; the local MCPAgent rows are the
 * executable mirrors needed by the agent runtime.
 */
export const POST = withAuthenticatedApi(async (_request, auth) => {
  const apiKey = process.env.KLAVIS_API_KEY
  if (!apiKey) throw new ApiError('KLAVIS_API_KEY is not configured', 503, 'KLAVIS_UNAVAILABLE')

  const client = new KlavisClient({ apiKey, platformName: 'sublime' })
  const klavisUserId = process.env.KLAVIS_AUTH_USER_ID?.trim() || `${auth.organizationId}:${auth.dbUser.id}`
  const checks = await Promise.all(
    PROVIDERS.map(async (provider) => ({
      provider,
      authorized: await client.isUserAuthorized(klavisUserId, PROVIDER_CAPABILITIES[provider].klavisName),
    })),
  )
  const authorized = checks.filter((check) => check.authorized).map((check) => check.provider as MCPProvider)
  if (authorized.length) {
    await createServersForTenant(`tenant_${auth.organizationId}`, auth.dbUser.id, auth.organizationId, authorized, klavisUserId)
  }
  return { success: true, authorized }
})
