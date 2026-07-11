/**
 * Shared tool-plane loaders + executors.
 *
 * An agent draws tools from four planes — Klavis (managed MCP servers),
 * per-org MCP connections, native built-ins (Granola/Slack/HTTP/Email), and
 * Nango delivery (outbound writes). These loaders were
 * previously inlined in execute-agent's loadTools; they live here so FLOWS get
 * the exact same tool universe (catalog + execution) without duplicating the
 * gating, scoping, caching, or error-degradation behavior.
 *
 * Each loader returns ToolPlaneGroups: one group per "connection" the flow
 * catalog can surface, carrying the live client the runtime executes against.
 * Loaders degrade gracefully — a failing plane/connection yields an empty
 * group (or none), never a thrown error that would abort a run.
 *
 * Secrets never leave this module: groups expose only ids/names/tool schemas
 * plus an opaque client closure; tokens stay inside the underlying clients.
 */

import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { cacheGet, cacheSet } from '@/lib/cache'
import { KlavisClient } from '@/lib/mcp/klavis-client'
import { DELIVERY_TOOLS, nangoConfigured, resolveDeliveryConnection, type DeliveryCapability } from '@/lib/nango/delivery'
import { McpClient, mcpConfigFromConnection } from '@/lib/mcp/mcp-client'
import { ensureFreshConnectionToken, persistRefreshedAuthcodeTokens } from '@/lib/mcp/connection-token'
import { isStrataUrl } from '@/lib/mcp/strata'
import { GranolaToolClient, getGranolaApiKey, granolaTools } from '@/lib/integrations/granola'
import { SlackToolClient, slackTools } from '@/lib/integrations/slack'
import { HttpToolClient, httpTools } from '@/lib/integrations/http'
import { EmailToolClient, emailTools } from '@/lib/integrations/email'
import { BUILTIN_CONNECTORS, fromKlavisAgentType, isSelected, nangoConnector, type ConnectorDescriptor } from '@/lib/connectors/registry'
import { formatFlowToolConnectionId, type FlowToolPlane } from '@/lib/flows/tool-connection-id'

// Minimal interface every plane's execution client satisfies (KlavisClient,
// McpClient, the built-in ToolClients, and adapters).
export interface McpToolClient {
  executeTool(serverUrl: string, name: string, args: Record<string, unknown>): Promise<any>
}

export type ToolBinding = {
  provider: string
  serverUrl: string
  toolName: string
  client: McpToolClient
}

/** A tool as a plane reports it (description already defaulted per plane). */
export type PlaneToolDescriptor = {
  name: string
  description: string
  inputSchema?: unknown
  outputSchema?: unknown
}

/**
 * One "connection" within a plane — a flow-catalog entry plus the live client
 * the runtime executes its tools against. `client` is absent when discovery
 * failed (the group still surfaces as a graceful empty catalog entry).
 */
export type ToolPlaneGroup = {
  /** Flow connection id (see @/lib/flows/tool-connection-id for the scheme). */
  id: string
  plane: FlowToolPlane
  name: string
  /** Runtime binding provider (agent tool naming, audit, approval gating). */
  provider: string
  serverUrl: string
  isWrite: boolean
  client?: McpToolClient
  tools: PlaneToolDescriptor[]
  /**
   * Set when tool discovery FAILED for this connection (token expired, server
   * unreachable, not yet authorized). Distinguishes a real "no actions" from a
   * connection that couldn't be reached, so the builder shows "reconnect"
   * instead of a silent empty list.
   */
  toolsError?: string
}

export function toolName(provider: string, name: string) {
  return `${provider}_${name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
}

/** Shared connection visibility: org-shared rows plus the acting user's own. */
export function mcpConnectionScope(organizationId: string, userId?: string) {
  return userId
    ? { organizationId, isActive: true, OR: [{ userId: null }, { userId }] }
    : { organizationId, isActive: true }
}

// MCP tool lists are near-static, but discovery re-ran (initialize + tools/list
// round-trips) on EVERY run. Cache the discovery per server URL so a warm run
// skips the network entirely; busted on connection create/update.
const TOOL_DISCOVERY_TTL_MS = 10 * 60 * 1000
// Keyed by org too: MCP servers can gate tools/list by identity, so one org's
// discovery must not pin another's tool set on a shared serverUrl.
export const toolDiscoveryCacheKey = (organizationId: string, serverUrl: string) => `mcptools:${organizationId}:${serverUrl}`
export async function cachedToolDiscovery<T>(organizationId: string, serverUrl: string, fetchTools: () => Promise<T[]>): Promise<T[]> {
  const key = toolDiscoveryCacheKey(organizationId, serverUrl)
  const hit = await cacheGet<T[]>(key)
  if (hit && hit.length > 0) return hit
  const fresh = await fetchTools()
  // Never cache an empty result — a transient empty/errored discovery must not
  // pin "no tools" for the whole TTL and silently disable the integration.
  if (fresh.length > 0) await cacheSet(key, fresh, TOOL_DISCOVERY_TTL_MS)
  return fresh
}

const EMPTY_SCHEMA = { type: 'object', properties: {} }

// ── Klavis-managed MCP servers ────────────────────────────────────────────────

/**
 * Klavis-provisioned MCP servers for this org. `agentTypes` restricts to the
 * given (uppercased) provider types — the agent path passes its selected
 * providers; the flow catalog omits it to surface every active server.
 */
export async function loadKlavisPlaneGroups(
  organizationId: string,
  options: { agentTypes?: string[] } = {},
): Promise<ToolPlaneGroup[]> {
  if (!process.env.KLAVIS_API_KEY) return []
  if (options.agentTypes && options.agentTypes.length === 0) return []
  const client = new KlavisClient({ apiKey: process.env.KLAVIS_API_KEY, platformName: 'sublime' })
  const agents = await prisma.mCPAgent.findMany({
    where: {
      organizationId,
      isActive: true,
      ...(options.agentTypes ? { agentType: { in: options.agentTypes } } : {}),
    },
  })

  // Discover all Klavis providers in parallel (cached per server URL); a
  // failing discovery for one provider degrades to empty, never aborts the
  // run. Order stays deterministic regardless of which discovery resolved first.
  return Promise.all(agents.map(async (agent): Promise<ToolPlaneGroup> => {
    const provider = String(agent.agentType).toLowerCase()
    const group: ToolPlaneGroup = {
      id: formatFlowToolConnectionId('klavis', agent.id),
      plane: 'klavis',
      name: fromKlavisAgentType(String(agent.agentType)).label,
      provider,
      serverUrl: agent.mcpServerUrl,
      isWrite: false,
      client,
      tools: [],
    }
    try {
      const available = await cachedToolDiscovery<{ name: string; description?: string; inputSchema?: unknown }>(
        organizationId,
        agent.mcpServerUrl,
        () => client.getServerTools(agent.mcpServerUrl),
      )
      group.tools = available.map((tool) => ({
        name: tool.name,
        description: tool.description || `${tool.name} via ${provider}`,
        inputSchema: tool.inputSchema || EMPTY_SCHEMA,
      }))
    } catch (error) {
      apiLogger.warn('loadTools: Klavis tool discovery failed, skipping provider', {
        provider, organizationId, error: error instanceof Error ? error.message : String(error),
      })
    }
    return group
  }))
}

// ── Per-org MCP connections (all active connections, any authType) ────────────

export const mcpConnectionSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

/**
 * Per-org custom MCP connections. `includeStrata` gates Klavis Strata servers
 * (opt-in per agent — its ~90 meta-tools would otherwise all be live at once);
 * the flow catalog includes them so stored graphs keep validating. A failing/
 * unreachable server degrades to an empty group, never aborts.
 */
export async function loadMcpConnectionPlaneGroups(
  organizationId: string,
  ownerUserId?: string | null,
  options: { connectionIds?: string[]; take?: number; includeStrata?: boolean } = {},
): Promise<ToolPlaneGroup[]> {
  const connections = (await prisma.mcpConnection.findMany({
    where: {
      ...mcpConnectionScope(organizationId, ownerUserId ?? undefined),
      ...(options.connectionIds?.length ? { id: { in: options.connectionIds } } : {}),
    },
    ...(options.take ? { take: options.take } : {}),
  })).filter((conn) => (options.includeStrata ?? true) || !isStrataUrl(conn.serverUrl))

  // Discover all org MCP connections in parallel (cached per server URL); token
  // refresh + client build happen per-connection, discovery is cached. Failures
  // degrade to an empty group and are logged.
  return Promise.all(connections.map(async (conn): Promise<ToolPlaneGroup> => {
    const slug = mcpConnectionSlug(conn.name)
    const group: ToolPlaneGroup = {
      id: conn.id, // raw row id — backward compat with stored graphs
      plane: 'mcp',
      name: conn.name,
      provider: slug,
      serverUrl: conn.serverUrl,
      isWrite: false,
      tools: [],
    }
    try {
      const fresh = await ensureFreshConnectionToken(conn)
      const config = mcpConfigFromConnection(fresh)
      // For authcode connections, let a mid-run token refresh persist the
      // rotated tokens back to this row so the next run reuses them.
      if (config.flow === 'authcode') {
        const connectionId = fresh.id
        const baseAuthConfig = fresh.authConfig as Record<string, unknown>
        const fallbackRefresh = config.refreshToken ?? ''
        config.persistTokens = async (tokens) => {
          await persistRefreshedAuthcodeTokens(connectionId, baseAuthConfig, tokens, fallbackRefresh)
        }
      }
      const client = new McpClient(config)
      const available = await cachedToolDiscovery(organizationId, fresh.serverUrl, () => client.getServerTools(fresh.serverUrl))
      group.name = fresh.name
      group.serverUrl = fresh.serverUrl
      group.client = client
      group.tools = available.map((tool) => ({
        name: tool.name,
        description: tool.description || `${tool.name} via ${fresh.name}`,
        inputSchema: tool.inputSchema || EMPTY_SCHEMA,
        outputSchema: (tool as { outputSchema?: unknown }).outputSchema,
      }))
    } catch (error) {
      apiLogger.warn('loadTools: org MCP connection tool discovery failed, skipping', {
        connectionId: conn.id, connectionName: conn.name, serverUrl: conn.serverUrl,
        organizationId, error: error instanceof Error ? error.message : String(error),
      })
      group.toolsError = "Couldn't load this connection's actions — reconnect it and try again."
    }
    return group
  }))
}

// ── Native built-ins (Granola / Slack / HTTP / Email) ─────────────────────────

/**
 * Built-in integration planes. When `providers` is given (the agent path),
 * each plane additionally requires a matching selection; the flow catalog
 * omits it and gates purely on availability. A failure in one plane's setup
 * never blocks the others.
 */
export async function loadNativePlaneGroups(
  organizationId: string,
  options: { providers?: string[] } = {},
): Promise<ToolPlaneGroup[]> {
  const selected = (descriptor: ConnectorDescriptor) =>
    options.providers ? isSelected(descriptor, options.providers) : true
  const groups: ToolPlaneGroup[] = []
  const group = (
    descriptor: ConnectorDescriptor,
    serverUrl: string,
    client: McpToolClient,
    defs: { name: string; description: string; inputSchema: Record<string, unknown> }[],
  ): ToolPlaneGroup => ({
    id: formatFlowToolConnectionId('native', descriptor.providerId),
    plane: 'native',
    name: descriptor.label,
    provider: descriptor.providerId,
    serverUrl,
    isWrite: descriptor.isWrite,
    client,
    tools: defs.map((def) => ({ name: def.name, description: def.description, inputSchema: def.inputSchema })),
  })

  // Granola REST API — gated on a per-org key (saved key, then env fallback).
  const granolaConn = BUILTIN_CONNECTORS.find((c) => c.providerId === 'granola')!
  if (selected(granolaConn)) {
    try {
      const granolaKey = await getGranolaApiKey(organizationId)
      if (granolaKey) {
        groups.push(group(granolaConn, 'https://public-api.granola.ai/v1', new GranolaToolClient(granolaKey.apiKey), granolaTools()))
      }
    } catch (error) {
      apiLogger.warn('loadTools: Granola tool setup failed, skipping provider', {
        provider: 'granola',
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Slack REST API — gated on SLACK_BOT_TOKEN.
  const slackConn = BUILTIN_CONNECTORS.find((c) => c.kind === 'builtin' && c.providerId === 'slack')!
  if (slackConn.available() && selected(slackConn)) {
    try {
      groups.push(group(slackConn, 'https://slack.com/api', new SlackToolClient(), slackTools()))
    } catch (error) {
      apiLogger.warn('loadTools: Slack tool setup failed, skipping provider', {
        provider: 'slack',
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // HTTP API — always available (no credentials); SSRF-guarded in the client.
  const httpConn = BUILTIN_CONNECTORS.find((c) => c.kind === 'builtin' && c.providerId === 'http')!
  if (selected(httpConn)) {
    groups.push(group(httpConn, '', new HttpToolClient(), httpTools()))
  }

  // Email via Resend REST API — gated on RESEND_API_KEY.
  const emailConn = BUILTIN_CONNECTORS.find((c) => c.providerId === 'email')!
  if (emailConn.available() && selected(emailConn)) {
    try {
      groups.push(group(emailConn, 'https://api.resend.com', new EmailToolClient(), emailTools()))
    } catch (error) {
      apiLogger.warn('loadTools: Email tool setup failed, skipping provider', {
        provider: 'email',
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return groups
}

// ── Nango delivery (outbound writes as the acting user) ───────────────────────

/**
 * Nango delivery planes (Slack/Gmail/Salesforce writes as the acting user),
 * one group per capability with a resolvable connection. When `providers` is
 * given (the agent path) a capability additionally requires a matching
 * selection. These are WRITE planes — execution goes through the approval gate.
 */
export async function loadNangoPlaneGroups(
  organizationId: string,
  ownerUserId?: string | null,
  options: { providers?: string[] } = {},
): Promise<ToolPlaneGroup[]> {
  if (!nangoConfigured()) return []
  const groups: ToolPlaneGroup[] = []
  for (const spec of DELIVERY_TOOLS) {
    const connector = nangoConnector(spec.capability)
    if (!connector) continue
    if (options.providers && !isSelected(connector, options.providers)) continue
    try {
      const connection = await resolveDeliveryConnection(organizationId, spec.capability, ownerUserId)
      if (!connection) continue
      const deliveryClient: McpToolClient = {
        executeTool: (_serverUrl, _toolName, args) => spec.run(connection, args),
      }
      groups.push({
        id: formatFlowToolConnectionId('nango', spec.capability),
        plane: 'nango',
        name: connector.label,
        provider: connector.providerId,
        serverUrl: 'nango',
        isWrite: connector.isWrite,
        client: deliveryClient,
        tools: [{ name: spec.name, description: spec.description, inputSchema: spec.inputSchema }],
      })
    } catch (error) {
      apiLogger.warn('loadTools: Nango delivery setup failed, skipping capability', {
        capability: spec.capability,
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return groups
}

// ── Flow tool-step execution ──────────────────────────────────────────────────

export type FlowToolExecutor = {
  /** Runtime provider id (approval gating via capabilityFromProvider, audit). */
  provider: string
  isWrite: boolean
  execute: (toolName: string, args: Record<string, unknown>) => Promise<unknown>
}

/**
 * Resolve the executor for a flow tool step from its parsed connection id.
 * Mirrors how the agent runtime binds each plane's calls; throws a
 * user-actionable error when the referenced connection no longer resolves.
 */
export async function resolveFlowToolExecutor(params: {
  organizationId: string
  userId: string
  plane: FlowToolPlane
  ref: string
  toolName: string
}): Promise<FlowToolExecutor> {
  const { organizationId, userId, plane, ref } = params

  if (plane === 'mcp') {
    const conn = await prisma.mcpConnection.findFirst({
      where: { id: ref, organizationId, isActive: true },
    })
    if (!conn) throw new Error('The selected connection no longer exists — pick another in the step config.')
    const fresh = await ensureFreshConnectionToken(conn)
    const client = new McpClient(mcpConfigFromConnection(fresh))
    return {
      provider: mcpConnectionSlug(fresh.name),
      isWrite: false,
      execute: (name, args) => client.executeTool(fresh.serverUrl, name, args),
    }
  }

  if (plane === 'klavis') {
    if (!process.env.KLAVIS_API_KEY) throw new Error('Klavis is not configured for this workspace.')
    const agent = await prisma.mCPAgent.findFirst({ where: { id: ref, organizationId, isActive: true } })
    if (!agent) throw new Error('The selected Klavis connection no longer exists — pick another in the step config.')
    const client = new KlavisClient({ apiKey: process.env.KLAVIS_API_KEY, platformName: 'sublime' })
    return {
      provider: String(agent.agentType).toLowerCase(),
      isWrite: false,
      execute: (name, args) => client.executeTool(agent.mcpServerUrl, name, args),
    }
  }

  if (plane === 'native') {
    if (ref === 'granola') {
      const granolaKey = await getGranolaApiKey(organizationId)
      if (!granolaKey) throw new Error('Granola is not configured for this workspace.')
      const client = new GranolaToolClient(granolaKey.apiKey)
      return { provider: 'granola', isWrite: false, execute: (name, args) => client.executeTool('', name, args) }
    }
    if (ref === 'slack' || ref === 'email' || ref === 'http') {
      const descriptor = BUILTIN_CONNECTORS.find((c) => c.kind === 'builtin' && c.providerId === ref)!
      if (!descriptor.available()) throw new Error(`${descriptor.label} is not configured for this workspace.`)
      const client: McpToolClient =
        ref === 'slack' ? new SlackToolClient() : ref === 'email' ? new EmailToolClient() : new HttpToolClient()
      return { provider: ref, isWrite: descriptor.isWrite, execute: (name, args) => client.executeTool('', name, args) }
    }
    throw new Error(`Unknown built-in integration "${ref}" — pick another in the step config.`)
  }

  // nango — outbound delivery as the acting user (write plane; approval-gated).
  if (!nangoConfigured()) throw new Error('Delivery integrations are not configured for this workspace.')
  const spec = DELIVERY_TOOLS.find((tool) => tool.capability === (ref as DeliveryCapability))
  if (!spec) throw new Error(`Unknown delivery capability "${ref}" — pick another in the step config.`)
  const connection = await resolveDeliveryConnection(organizationId, spec.capability, userId)
  if (!connection) throw new Error(`No connected ${spec.capability} account is available — connect one in Integrations.`)
  return {
    provider: `nango:${spec.capability}`,
    isWrite: true,
    execute: (name, args) => {
      if (name !== spec.name) throw new Error(`Tool "${name}" is not available on this connection.`)
      return spec.run(connection, args)
    },
  }
}
