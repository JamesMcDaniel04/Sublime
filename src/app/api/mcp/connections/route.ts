import { z } from 'zod'
import {
  createServersForTenant,
  getConnectionStatuses,
  removeServerConnection,
} from '@/lib/mcp/server-provisioning'
import { PROVIDERS, PROVIDER_CAPABILITIES, type MCPProvider } from '@/lib/mcp/provider-capabilities'
import { KlavisError } from '@/lib/mcp/klavis-client'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

const providerSchema = z.enum(PROVIDERS as [MCPProvider, ...MCPProvider[]])

const KLAVIS_ERROR_STATUS: Record<KlavisError['code'], number> = {
  limit_reached: 409,
  invalid_request: 400,
  unauthorized: 502,
  transient: 503,
  unknown: 502,
}

function asApiError(error: unknown): never {
  if (error instanceof KlavisError) {
    throw new ApiError(error.message, KLAVIS_ERROR_STATUS[error.code], `KLAVIS_${error.code.toUpperCase()}`)
  }
  throw error
}

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const statuses = await getConnectionStatuses(auth.organizationId, auth.dbUser.id)
  const byProvider = new Map(statuses.map((status) => [status.provider, status]))
  const connections = PROVIDERS.map((provider) => {
    const status = byProvider.get(provider)
    const capability = PROVIDER_CAPABILITIES[provider]
    return {
      provider,
      status: status?.status || 'not_connected',
      oauthUrl: status?.oauthUrl,
      toolCount: status?.toolCount,
      capabilities: capability,
      // Prefer the live tool list (real descriptions from the server); fall back
      // to the curated catalog so cards always explain what each tool does.
      tools: status?.tools?.length ? status.tools : capability.tools,
    }
  })
  return { success: true, connections }
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  if (auth.dbUser.role !== 'ADMIN') throw new ApiError('Admin access required', 403, 'FORBIDDEN')
  if (!process.env.KLAVIS_API_KEY) throw new ApiError('KLAVIS_API_KEY is not configured', 503, 'KLAVIS_UNAVAILABLE')
  const { providers } = z.object({ providers: z.array(providerSchema).min(1) }).parse(await request.json())
  try {
    const results = await createServersForTenant(
      `tenant_${auth.organizationId}`,
      auth.dbUser.id,
      auth.organizationId,
      providers,
    )
    return { success: results.every((result) => result.status !== 'error'), results }
  } catch (error) {
    asApiError(error)
  }
})

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  if (auth.dbUser.role !== 'ADMIN') throw new ApiError('Admin access required', 403, 'FORBIDDEN')
  const provider = providerSchema.parse(request.nextUrl.searchParams.get('provider'))
  await removeServerConnection(auth.organizationId, provider, auth.dbUser.id)
  return { success: true }
})
