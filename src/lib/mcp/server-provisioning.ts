import { prisma } from '@/lib/prisma'
import { cacheGet, cacheSet, cacheDelete } from '@/lib/cache'
import { KlavisClient, type KlavisServer } from './klavis-client'
import { PROVIDERS, PROVIDER_CAPABILITIES, type MCPProvider } from './provider-capabilities'

export type ConnectionStatus = 'pending_auth' | 'active' | 'error' | 'not_connected'

// getConnectionStatuses hits the Klavis API live (status + tool list per
// connection) — measured ~2.4s cold. It's re-run on every integrations page
// load, so cache the assembled result per (org,user). A long TTL is safe:
// the status only changes on connect/disconnect, which bust this key.
const MCP_STATUS_TTL_MS = 10 * 60 * 1000
const mcpStatusKey = (organizationId: string, userId: string) => `mcpstatus:${organizationId}:${userId}`
export async function bustConnectionStatuses(organizationId: string, userId: string): Promise<void> {
  await cacheDelete(mcpStatusKey(organizationId, userId))
}

export type ServerCreationResult = {
  provider: MCPProvider
  instanceId: string
  serverUrl?: string
  oauthUrl?: string
  status: Exclude<ConnectionStatus, 'not_connected'>
}

function client() {
  if (!process.env.KLAVIS_API_KEY) throw new Error('KLAVIS_API_KEY is not configured')
  return new KlavisClient({ apiKey: process.env.KLAVIS_API_KEY, platformName: 'sublime' })
}

function connectionStatus(server: KlavisServer): Exclude<ConnectionStatus, 'not_connected'> {
  // Active when authenticated, OR when the server needs no per-user auth at all.
  // Some providers (e.g. Snowflake credentials, Strata-routed Intercom) return
  // no oauthUrl and authNeeded=false because they authenticate at the Klavis
  // ACCOUNT level, not per user — so they're usable as soon as the account
  // authorizes them. (If the account hasn't, the tools/list probe upstream in
  // getConnectionStatuses fails and the status resolves to 'error' instead.)
  return server.isAuthenticated || !server.authNeeded ? 'active' : 'pending_auth'
}

export type McpToolInfo = { name: string; description?: string }

async function saveConnection(
  provider: MCPProvider,
  userId: string,
  organizationId: string,
  server: KlavisServer,
  tools?: McpToolInfo[],
) {
  const status = connectionStatus(server)
  const existing = await prisma.mCPAgent.findFirst({
    where: { userId, organizationId, agentType: provider.toUpperCase() },
  })
  const configuration = { provider, verbs: PROVIDER_CAPABILITIES[provider].verbs }
  const existingMetadata = (existing?.metadata as Record<string, any> | null) || {}
  const metadata = {
    instanceId: server.instanceId,
    oauthUrl: server.oauthUrl ?? null,
    status,
    // Cache the live tool list (name + description) for the capability cards.
    // Preserve a previously cached list when this save didn't fetch one.
    tools: tools ?? (Array.isArray(existingMetadata.tools) ? existingMetadata.tools : undefined),
  }

  if (existing) {
    return prisma.mCPAgent.update({
      where: { id: existing.id, organizationId },
      data: {
        ...(server.serverUrl ? { mcpServerUrl: server.serverUrl } : {}),
        isActive: status === 'active',
        configuration,
        metadata,
      },
    })
  }

  return prisma.mCPAgent.create({
    data: {
      mcpServerUrl: server.serverUrl ?? '',
      isActive: status === 'active',
      configuration,
      metadata,
      userId,
      organizationId,
      name: `${provider}_agent`,
      agentType: provider.toUpperCase(),
      description: PROVIDER_CAPABILITIES[provider].description,
    },
  })
}

export async function createServersForTenant(
  _tenantId: string,
  userId: string,
  organizationId: string,
  selectedProviders: MCPProvider[] = [...PROVIDERS],
): Promise<ServerCreationResult[]> {
  const klavis = client()
  const results: ServerCreationResult[] = []

  for (const provider of selectedProviders) {
    // Idempotent connect: reuse the existing Klavis instance for this provider
    // instead of creating a new one each click (the free tier caps instances).
    const existing = await prisma.mCPAgent.findFirst({
      where: { userId, organizationId, agentType: provider.toUpperCase() },
    })
    const existingInstanceId = (existing?.metadata as Record<string, any> | null)?.instanceId as string | undefined

    let server: KlavisServer | null = null
    if (existingInstanceId) {
      try {
        server = await klavis.getServerStatus(existingInstanceId)
        server.serverUrl = server.serverUrl ?? existing?.mcpServerUrl
      } catch {
        server = null // instance no longer exists on Klavis — recreate below
      }
    }
    if (!server) {
      server = await klavis.createServerInstance(provider, `${organizationId}:${userId}`)
    }

    await saveConnection(provider, userId, organizationId, server)
    results.push({
      provider,
      instanceId: server.instanceId,
      serverUrl: server.serverUrl,
      oauthUrl: server.oauthUrl,
      status: connectionStatus(server),
    })
  }

  await bustConnectionStatuses(organizationId, userId)
  return results
}

export type ConnectionStatusInfo = {
  provider: MCPProvider
  status: ConnectionStatus
  oauthUrl?: string
  toolCount?: number
  tools?: McpToolInfo[]
}

export async function getConnectionStatuses(
  organizationId: string,
  userId: string,
): Promise<ConnectionStatusInfo[]> {
  const cacheKey = mcpStatusKey(organizationId, userId)
  const cached = await cacheGet<ConnectionStatusInfo[]>(cacheKey)
  if (cached) return cached

  const connections = await prisma.mCPAgent.findMany({
    where: { organizationId, userId },
    orderBy: { updatedAt: 'desc' },
  })
  const klavis = process.env.KLAVIS_API_KEY ? client() : null

  // Resolve every connection's live status/tools concurrently (was sequential —
  // N connections × up to 2 Klavis round-trips each, serialized on every load).
  const resolved = await Promise.all(
    connections.map(async (connection): Promise<ConnectionStatusInfo | null> => {
      const provider = connection.agentType.toLowerCase() as MCPProvider
      if (!PROVIDERS.includes(provider)) return null
      const metadata = (connection.metadata as Record<string, any> | null) || {}
      let status = (metadata.status || (connection.isActive ? 'active' : 'pending_auth')) as ConnectionStatus
      let oauthUrl = metadata.oauthUrl as string | undefined
      let toolCount: number | undefined
      // Start from any previously cached tool list so the card still has detail
      // when Klavis is momentarily unreachable.
      let tools: McpToolInfo[] | undefined = Array.isArray(metadata.tools) ? metadata.tools : undefined

      if (klavis && metadata.instanceId) {
        try {
          const server = await klavis.getServerStatus(metadata.instanceId)
          status = connectionStatus(server)
          oauthUrl = server.oauthUrl
          // The GET response omits serverUrl; reuse the one stored at create time.
          if (status === 'active' && connection.mcpServerUrl) {
            const fetched = (await klavis.getServerTools(connection.mcpServerUrl)) as McpToolInfo[]
            tools = fetched.map((tool) => ({ name: tool.name, description: tool.description }))
            toolCount = tools.length
          }
          await saveConnection(provider, userId, organizationId, {
            ...server,
            serverUrl: server.serverUrl ?? connection.mcpServerUrl,
          }, tools)
        } catch {
          status = 'error'
        }
      }

      if (tools && toolCount === undefined) toolCount = tools.length
      return { provider, status, oauthUrl, toolCount, tools }
    }),
  )

  const byProvider = new Map<string, ConnectionStatusInfo>()
  for (const info of resolved) if (info) byProvider.set(info.provider, info)
  const result = PROVIDERS.map((provider) => byProvider.get(provider) || { provider, status: 'not_connected' as const })

  // Don't pin a transient Klavis outage: only cache a clean (no-error) result.
  // Adaptive TTL: while any connection is mid-OAuth (pending_auth), its flip to
  // active happens on Klavis's side (no API of ours is hit), so keep the cache
  // short; a stable result holds for the full TTL. Errors are never cached.
  const hasPending = result.some((r) => r.status === 'pending_auth')
  if (!result.some((r) => r.status === 'error')) {
    await cacheSet(cacheKey, result, hasPending ? 30_000 : MCP_STATUS_TTL_MS)
  }
  return result
}

export async function removeServerConnection(organizationId: string, provider: MCPProvider, userId: string) {
  const connection = await prisma.mCPAgent.findFirst({
    where: { organizationId, userId, agentType: provider.toUpperCase() },
  })
  if (!connection) return
  const metadata = (connection.metadata as Record<string, any> | null) || {}

  if (process.env.KLAVIS_API_KEY && metadata.instanceId) {
    await client().deleteServerInstance(metadata.instanceId)
  }
  await prisma.mCPAgent.delete({ where: { id: connection.id } })
  await bustConnectionStatuses(organizationId, userId)
}
