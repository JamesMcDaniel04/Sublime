import { z } from 'zod'
import { after } from 'next/server'
import {
  createServersForTenant,
  bustConnectionStatuses,
  getConnectionStatuses,
  removeServerConnection,
} from '@/lib/mcp/server-provisioning'
import { PROVIDERS, PROVIDER_CAPABILITIES, type MCPProvider } from '@/lib/mcp/provider-capabilities'
import { KlavisError } from '@/lib/mcp/klavis-client'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { prisma } from '@/lib/prisma'
import { scanConnection } from '@/lib/intelligence/connection-scan'
import { fromKlavisAgentType } from '@/lib/connectors/registry'
import { KlavisClient } from '@/lib/mcp/klavis-client'

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

export const GET = withAuthenticatedApi(async (request, auth) => {
  const apiKey = process.env.KLAVIS_API_KEY
  if (!apiKey) throw new ApiError('KLAVIS_API_KEY is not configured', 503, 'KLAVIS_UNAVAILABLE')
  if (request.nextUrl.searchParams.get('fresh') === '1') {
    await bustConnectionStatuses(auth.organizationId, auth.dbUser.id)
  }
  let catalog
  try {
    catalog = await new KlavisClient({ apiKey, platformName: 'sublime' }).listServerCatalog()
  } catch (error) {
    asApiError(error)
  }
  const liveNames = new Set(catalog!.map((server) => server.name.toLowerCase()))
  const statuses = await getConnectionStatuses(auth.organizationId, auth.dbUser.id)
  const byProvider = new Map(statuses.map((status) => [status.provider, status]))
  const connections = PROVIDERS.filter((provider) => {
    const status = byProvider.get(provider)
    return status?.status === 'active' && liveNames.has(PROVIDER_CAPABILITIES[provider].klavisName.toLowerCase())
  }).map((provider) => {
    const status = byProvider.get(provider)
    const capability = PROVIDER_CAPABILITIES[provider]
    const catalogEntry = catalog!.find((server) => server.name.toLowerCase() === capability.klavisName.toLowerCase())
    return {
      provider,
      id: status?.id,
      status: status?.status || 'not_connected',
      oauthUrl: status?.oauthUrl,
      toolCount: status?.toolCount ?? catalogEntry?.toolCount,
      capabilities: { ...capability, description: catalogEntry?.description || capability.description },
      // Prefer the live tool list (real descriptions from the server); fall back
      // to the curated catalog so cards always explain what each tool does.
      tools: status?.tools?.length ? status.tools : capability.tools,
    }
  })
  return { success: true, gateway: { provider: 'klavis', connected: true, providerCount: catalog!.length }, connections }
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

    // Fire-and-forget usage scans for providers that connected cleanly AND
    // were genuinely created by this call — `createServersForTenant` is
    // idempotent (it reuses an existing mCPAgent row on repeat connects), so
    // scanning on `created` avoids re-firing (and duplicating learnings +
    // notifications) on every idempotent reconnect of an already-connected
    // provider.
    // `after` (Next 15) keeps this running past the response on serverless —
    // a bare `void` promise can be killed at response end there.
    const organizationId = auth.organizationId
    const userId = auth.dbUser.id
    after(() =>
      Promise.all(
        results
          .filter((result) => result.status !== 'error' && result.created)
          .map(async (result) => {
            const agent = await prisma.mCPAgent.findFirst({
              where: { userId, organizationId, agentType: result.provider.toUpperCase() },
              select: { id: true },
            })
            if (!agent) return
            await scanConnection({
              organizationId,
              userId,
              plane: 'klavis',
              connectionRef: agent.id,
              connectionName: fromKlavisAgentType(result.provider).label,
            })
          }),
      ).catch(() => undefined),
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
