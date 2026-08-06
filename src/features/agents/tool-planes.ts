/**
 * Shared tool-plane loaders + executors.
 *
 * An agent draws tools from three planes — per-org MCP connections, native
 * built-ins (Granola/Slack/HTTP/Email), and Nango delivery (outbound writes).
 * These loaders were
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
import { recordVerificationAsync } from '@/lib/connections/record-verification'
import { DELIVERY_TOOLS, deliverySpecByName, nangoConfigured, resolveDeliveryConnection, type DeliveryCapability } from '@/lib/nango/delivery'
import { googleOAuthConfigured } from '@/lib/google/oauth'
import { isGoogleNativeProvider, proxyForConnection } from '@/lib/google/proxy'
import { listActionTools, runNangoAction } from '@/lib/nango/actions'
import { McpClient, mcpConfigFromConnection } from '@/lib/mcp/mcp-client'
import { ensureFreshConnectionToken, persistRefreshedAuthcodeTokens } from '@/lib/mcp/connection-token'
import { mcpCredentialPlan } from '@/lib/mcp/connection-credential'
import { GranolaToolClient, getGranolaApiKey, granolaTools } from '@/lib/integrations/granola'
import { SlackToolClient, slackTools } from '@/lib/integrations/slack'
import { decryptSecretJson } from '@/lib/slack/connections'
import { HttpToolClient, httpTools } from '@/lib/integrations/http'
import { EmailToolClient, emailTools } from '@/lib/integrations/email'
import { GoalsToolClient, goalsTools } from '@/lib/integrations/goals'
import { PostgresToolClient, postgresTools } from '@/lib/postgres/tools'
import { resolvePostgresConnection } from '@/lib/postgres/connections'
import {
  prismaGoalsPort,
  resolveLinkedGoalIds,
  type GoalResource,
} from '@/lib/integrations/goals-port'
import { BUILTIN_CONNECTORS, isSelected, nangoConnector, type ConnectorDescriptor } from '@/lib/connectors/registry'
import { formatFlowToolConnectionId, type FlowToolPlane } from '@/lib/flows/tool-connection-id'
import { flowGraphSchema } from '@/lib/flows/graph'
import { inputParamsFromGraph, flowInputJsonSchema, flowToolSlug } from '@/lib/flows/flow-tool'
import { flowReadScope } from '@/lib/server/visibility'

// Minimal interface every plane's execution client satisfies (McpClient,
// the built-in ToolClients, and adapters).
export interface McpToolClient {
  executeTool(serverUrl: string, name: string, args: Record<string, unknown>): Promise<any>
}

export type ToolBinding = {
  provider: string
  serverUrl: string
  toolName: string
  client: McpToolClient
  /** Per-tool approval override (agent HTTP endpoints with requireApproval). */
  requireApproval?: boolean
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
  /** Runtime binding provider (agent tool naming, audit). */
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

/** Credential visibility: platform-managed org rows plus the acting user's own. */
export function mcpConnectionScope(organizationId: string, userId?: string) {
  return userId
    ? { organizationId, isActive: true, OR: [{ userId }, { userId: null, provider: { not: null } }] }
    : { organizationId, isActive: true, userId: null, provider: { not: null } }
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

// ── Per-org MCP connections (all active connections, any authType) ────────────

export const mcpConnectionSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

/**
 * Per-org custom MCP connections. A failing/unreachable server degrades to an
 * empty group, never aborts.
 */
export async function loadMcpConnectionPlaneGroups(
  organizationId: string,
  ownerUserId?: string | null,
  options: { connectionIds?: string[]; take?: number } = {},
): Promise<ToolPlaneGroup[]> {
  const connections = await prisma.mcpConnection.findMany({
    where: {
      ...mcpConnectionScope(organizationId, ownerUserId ?? undefined),
      ...(options.connectionIds?.length ? { id: { in: options.connectionIds } } : {}),
    },
    ...(options.take ? { take: options.take } : {}),
  })

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
      // ownerUserId must reach credentialScope: without it a connection whose
      // authConfig points at a PERSONAL vault credential resolves to the
      // actor-required sentinel and fails closed, so the agent path could not
      // use a credential the flow path (which does pass userId) resolves fine.
      config.credentialPlan = await mcpCredentialPlan(fresh, {
        organizationId,
        ...(ownerUserId ? { userId: ownerUserId } : {}),
      })
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
      // Discovery failing IS a credential fact (expired token, unreachable
      // server, never authorized) — record it so every picker can show this
      // connection as broken rather than merely unproven.
      recordVerificationAsync({ organizationId, connectionId: group.id, state: 'failed', error: group.toolsError })
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
  options: { providers?: string[]; resource?: GoalResource } = {},
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

  // Slack REST API — prefer the org's verified Slack bot connection. The env
  // token remains a backwards-compatible fallback for older deployments.
  const slackConn = BUILTIN_CONNECTORS.find((c) => c.kind === 'builtin' && c.providerId === 'slack')!
  if (selected(slackConn)) {
    try {
      const binding = await prisma.slackWorkspaceConnection.findFirst({
        where: { organizationId, status: 'active' },
        orderBy: { createdAt: 'asc' },
      })
      if (binding) {
        const slackGroup = group(
          slackConn,
          'https://slack.com/api',
          new SlackToolClient(decryptSecretJson(binding.botToken)),
          slackTools(),
        )
        slackGroup.name = `Slack — ${binding.teamName ?? binding.teamId}`
        groups.push(slackGroup)
      } else if (slackConn.available()) {
        groups.push(group(slackConn, 'https://slack.com/api', new SlackToolClient(), slackTools()))
      }
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

  // Sublime Goals — read/write on the goals THIS resource is linked to.
  // Absent (not empty) when nothing is linked, so an unlinked agent never sees
  // the tools. Authorization is decided here and baked into the client: it is
  // constructed with the resolved id set and has no query reaching past it.
  const goalsConn = BUILTIN_CONNECTORS.find((c) => c.providerId === 'sublime-goals')!
  if (selected(goalsConn) && options.resource) {
    try {
      const goalIds = await resolveLinkedGoalIds(organizationId, options.resource)
      if (goalIds.length) {
        groups.push(
          group(
            goalsConn,
            'sublime://goals',
            new GoalsToolClient(goalIds, prismaGoalsPort(organizationId, options.resource)),
            goalsTools(),
          ),
        )
      }
    } catch (error) {
      apiLogger.warn('loadTools: Goals tool setup failed, skipping provider', {
        provider: 'sublime-goals',
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return groups
}

// ── Native Postgres (one group per connected database) ───────────────────────

/**
 * Postgres planes: one group per database the org has connected.
 *
 * Unlike every other plane, the group count is data-driven rather than fixed,
 * so the agent path only builds groups for databases whose name the agent
 * actually selected. That matters because the agent loop caps total discovered
 * tools — three databases × four tools would otherwise crowd out other planes
 * for an agent that only needed one of them.
 *
 * Read tools are always present. The write tool is added only when the
 * connection's `allowWrites` column is true, and it carries its own provider
 * (`postgres:write`) so audit classification and the mandatory approval gate
 * both resolve it without inspecting tool names.
 */
export async function loadPostgresPlaneGroups(
  organizationId: string,
  options: { providers?: string[] } = {},
): Promise<ToolPlaneGroup[]> {
  const descriptor = BUILTIN_CONNECTORS.find((c) => c.providerId === 'postgres')!
  const writeDescriptor = BUILTIN_CONNECTORS.find((c) => c.providerId === 'postgres:write')!

  let rows: { id: string; name: string }[]
  try {
    rows = await prisma.postgresConnection.findMany({
      where: { organizationId, status: { not: 'error' } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    })
  } catch (error) {
    apiLogger.warn('loadTools: Postgres connection lookup failed, skipping plane', {
      provider: 'postgres',
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }

  // Agent path: a database is attached when the agent's selection names the
  // plane generically ("PostgreSQL", "database") or names that database.
  const wanted = options.providers
    ? rows.filter(
        (row) =>
          isSelected(descriptor, options.providers!) ||
          options.providers!.some((selection) => selection.toLowerCase() === row.name.toLowerCase()),
      )
    : rows

  const groups: ToolPlaneGroup[] = []
  for (const row of wanted) {
    try {
      const connection = await resolvePostgresConnection(organizationId, row.id)
      const tools = postgresTools(connection.allowWrites)
      groups.push({
        id: formatFlowToolConnectionId('postgres', row.id),
        plane: 'postgres',
        name: `PostgreSQL — ${row.name}`,
        provider: connection.allowWrites ? writeDescriptor.providerId : descriptor.providerId,
        serverUrl: '',
        isWrite: connection.allowWrites,
        client: new PostgresToolClient(connection),
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      })
    } catch (error) {
      // A single unreadable connection (rotated secret, cleared config) must
      // not remove the org's other databases from the catalog.
      apiLogger.warn('loadTools: Postgres connection unavailable, skipping', {
        provider: 'postgres',
        organizationId,
        connectionId: row.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return groups
}

// ── Nango delivery (outbound writes as the acting user) ───────────────────────

/**
 * Nango delivery planes, one group per capability with a resolvable
 * connection. When `providers` is given (the agent path) a capability
 * additionally requires a matching selection. These are WRITE planes.
 *
 * Tool surface per capability: the integration's DEPLOYED Nango actions when
 * any exist (dashboard "Functions" — typed inputs, provider-maintained), else
 * the static DELIVERY_TOOLS specs as fallback. Action tool names are
 * `<capability>_<action>` (post-message → slack_post_message), so the
 * flagship names stay stable across both paths.
 */
export async function loadNangoPlaneGroups(
  organizationId: string,
  ownerUserId?: string | null,
  options: { providers?: string[] } = {},
): Promise<ToolPlaneGroup[]> {
  if (!nangoConfigured() && !googleOAuthConfigured()) return []
  const groups: ToolPlaneGroup[] = []
  const capabilities = [...new Set(DELIVERY_TOOLS.map((spec) => spec.capability))]
  for (const capability of capabilities) {
    const connector = nangoConnector(capability)
    if (!connector) continue
    if (options.providers && !isSelected(connector, options.providers)) continue
    try {
      const connection = await resolveDeliveryConnection(organizationId, capability, ownerUserId)
      if (!connection) continue

      // Deployed actions are a Nango-environment feature; native Google
      // connections always use the static specs (executed via googleProxy).
      const actionTools = isGoogleNativeProvider(connection.provider) || !nangoConfigured()
        ? []
        : await listActionTools(connection.providerConfigKey, capability)
      const specs = DELIVERY_TOOLS.filter((spec) => spec.capability === capability)

      let client: McpToolClient
      let tools: ToolPlaneGroup['tools']
      if (actionTools.length) {
        const actionByToolName = new Map(actionTools.map((action) => [action.toolName, action.actionName]))
        client = {
          executeTool: (_serverUrl, toolName, args) => {
            const actionName = actionByToolName.get(toolName)
            if (!actionName) throw new Error(`Unknown ${connector.label} tool: ${toolName}`)
            return runNangoAction(connection, actionName, args)
          },
        }
        tools = actionTools.map((action) => ({
          name: action.toolName,
          description: action.description,
          inputSchema: action.inputSchema,
        }))
      } else {
        const specByName = new Map(specs.map((spec) => [spec.name, spec]))
        client = {
          executeTool: (_serverUrl, toolName, args) => {
            const spec = specByName.get(toolName)
            if (!spec) throw new Error(`Unknown ${connector.label} tool: ${toolName}`)
            return spec.run(connection, args, proxyForConnection(connection))
          },
        }
        tools = specs.map((spec) => ({ name: spec.name, description: spec.description, inputSchema: spec.inputSchema }))
      }

      groups.push({
        id: formatFlowToolConnectionId('nango', capability),
        plane: 'nango',
        name: connector.label,
        provider: connector.providerId,
        serverUrl: 'nango',
        isWrite: connector.isWrite,
        client,
        tools,
      })
    } catch (error) {
      apiLogger.warn('loadTools: Nango delivery setup failed, skipping capability', {
        capability,
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return groups
}

// ── Flow tool plane (workflows-as-tools) ──────────────────────────────────────

/**
 * Flows as a tool plane. Each qualifying flow becomes one ToolPlaneGroup whose
 * inputSchema is the flow's input-node params and whose client dispatches the
 * flow and returns its output-node object. Dispatch is a DYNAMIC import to
 * break the execute-flow -> tool-planes cycle. Only surfaces when a userId is
 * available (dispatch runs as that user).
 *
 * Authorization is the OWNER'S read scope: the agent can call exactly the
 * published flows its owner can open. (The old metadata.agentCallable gate was
 * never writable from the product — its settings UI was never built — so
 * "All flows" always resolved to zero; the per-agent allowFlows toggle plus
 * its optional flowIds list is the real opt-in.)
 */
// A flow called as an agent tool holds the agent's turn open while it runs, so
// it must be bounded here — unlike flow TOOL STEPS, whose per-node
// flowActionTimeoutMs already bounds them. The child keeps running server-side
// past the deadline; the agent just stops waiting.
const FLOW_TOOL_TIMEOUT_MS = Number(process.env.AGENT_FLOW_TOOL_TIMEOUT_MS) || 5 * 60_000

function flowToolDeadline<T>(promise: Promise<T>, flowName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`The "${flowName}" flow did not finish within ${Math.round(FLOW_TOOL_TIMEOUT_MS / 1000)}s — it may still complete in the background. Check its run history before retrying.`)),
      FLOW_TOOL_TIMEOUT_MS,
    )
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) },
    )
  })
}

export async function loadFlowPlaneGroups(
  organizationId: string,
  userId: string,
  options: { flowIds?: string[]; depth?: number } = {},
): Promise<ToolPlaneGroup[]> {
  const flows = await prisma.flow.findMany({
    where: {
      organizationId,
      status: 'ACTIVE',
      ...flowReadScope(userId),
      ...(options.flowIds?.length ? { id: { in: options.flowIds } } : {}),
    },
    take: 100,
  })
  const groups: ToolPlaneGroup[] = []
  // Tool names must be unique — two flows whose names slug identically would
  // otherwise both become `flow_<slug>` and one would silently overwrite the
  // other in execute-agent's bindings Map. Disambiguate collisions with a
  // short, stable flow-id suffix (the first flow keeps the clean slug).
  const usedSlugs = new Set<string>()
  for (const flow of flows) {
    const parsed = flowGraphSchema.safeParse(flow.publishedGraph ?? flow.graph)
    if (!parsed.success) continue
    const params = inputParamsFromGraph(parsed.data)
    const description = flow.description?.trim() || `Run the "${flow.name}" flow and return its output.`
    const client: McpToolClient = {
      executeTool: async (_serverUrl, _name, args) => {
        // runFlowExecution DIRECTLY, never dispatchFlowExecution: dispatch
        // enqueues under EXECUTION_MODE=queue (the production default), which
        // made every agent flow-tool call throw "requires inline execution
        // mode" in prod. The agent itself already runs on the worker there, so
        // a synchronous child flow is safe — exactly how subflow nodes run.
        // subflowDepth carries the agent's sub-agent depth so an
        // agent -> flow -> agent -> flow... cycle shares ONE counter instead of
        // resetting it every hop (see the matching depth hand-off in
        // execute-flow's agent-node adapter).
        const { runFlowExecution, terminalizeAbandonedChildRun } = await import('@/features/flows/execute-flow')
        const res = await flowToolDeadline(
          runFlowExecution({
            flowId: flow.id,
            organizationId,
            userId,
            input: (args && typeof args === 'object' ? args : {}) as Record<string, unknown>,
            usePublished: flow.publishedGraph != null,
            trigger: { type: 'signal', via: 'flow-tool' },
            subflowDepth: (options.depth ?? 0) + 1,
          }),
          flow.name,
        )
        // Agent-callable flows are synchronous-only: THROW on every non-success
        // outcome so execute-agent records a failed tool call (a returned value —
        // even null — is mis-recorded as success and the real error is lost).
        if (res.status === 'failed') {
          throw new Error(res.error ?? 'The flow failed.')
        }
        if (res.status === 'waiting') {
          await terminalizeAbandonedChildRun(organizationId, res.flowRunId)
          throw new Error("The flow paused for human input, which agent-callable flows don't support — inline the interaction or split the flow.")
        }
        return res.output ?? null
      },
    }
    let toolSlug = flowToolSlug(flow.name)
    if (usedSlugs.has(toolSlug)) toolSlug = `${toolSlug}_${flow.id.slice(0, 6)}`.slice(0, 60)
    usedSlugs.add(toolSlug)
    groups.push({
      id: formatFlowToolConnectionId('flow', flow.id),
      plane: 'flow',
      name: flow.name,
      provider: 'flow',
      serverUrl: '',
      isWrite: false,
      client,
      tools: [{ name: toolSlug, description, inputSchema: flowInputJsonSchema(params) }],
    })
  }
  return groups
}

// ── Flow tool-step execution ──────────────────────────────────────────────────

export type FlowToolExecutor = {
  /** Runtime provider id (audit classification). */
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
  /** The running flow. Required to reach the goals plane, which scopes itself
   *  to the goals this resource is linked to. */
  resource?: GoalResource
  /** The calling flow run's subflowDepth — threaded into a flow-plane child so
   *  flow->flow chains through tool steps share the recursion counter. */
  subflowDepth?: number
}): Promise<FlowToolExecutor> {
  const { organizationId, userId, plane, ref, resource, subflowDepth } = params

  if (plane === 'mcp') {
    // `template:` is a provisioning placeholder, not a plane — the parser
    // classifies unknown prefixes as raw MCP ids, so an unbound placeholder
    // would otherwise surface as a baffling "connection no longer exists".
    if (ref.startsWith('template:')) {
      throw new Error(
        `This step still holds the template placeholder "${ref}" — it was never bound to a real connection. Re-provision the template, or pick a connection in the step config.`,
      )
    }
    // Same visibility rule as the catalog (mcpConnectionScope): org-shared
    // rows plus the acting user's OWN personal connections. Node config is
    // client-editable JSON, so resolving by bare id would let a hand-edited
    // connectionId execute with another member's personal credential.
    const conn = await prisma.mcpConnection.findFirst({
      where: { id: ref, ...mcpConnectionScope(organizationId, userId) },
    })
    if (!conn) throw new Error('The selected connection no longer exists or is not yours to use — pick another in the step config.')
    const fresh = await ensureFreshConnectionToken(conn)
    const client = new McpClient({
      ...mcpConfigFromConnection(fresh),
      credentialPlan: await mcpCredentialPlan(fresh, { organizationId, userId }),
    })
    return {
      provider: mcpConnectionSlug(fresh.name),
      isWrite: false,
      execute: (name, args) => client.executeTool(fresh.serverUrl, name, args),
    }
  }

  if (plane === 'native') {
    if (ref === 'granola') {
      const granolaKey = await getGranolaApiKey(organizationId)
      if (!granolaKey) throw new Error('Granola is not configured for this workspace.')
      const client = new GranolaToolClient(granolaKey.apiKey)
      return { provider: 'granola', isWrite: false, execute: (name, args) => client.executeTool('', name, args) }
    }
    if (ref === 'slack') {
      const binding = await prisma.slackWorkspaceConnection.findFirst({
        where: { organizationId, status: 'active' },
        orderBy: { createdAt: 'asc' },
      })
      if (binding) {
        const client = new SlackToolClient(decryptSecretJson(binding.botToken))
        return { provider: 'slack', isWrite: true, execute: (name, args) => client.executeTool('', name, args) }
      }
      const descriptor = BUILTIN_CONNECTORS.find((c) => c.kind === 'builtin' && c.providerId === ref)!
      if (!descriptor.available()) throw new Error('Slack is not configured for this workspace.')
      const client = new SlackToolClient()
      return { provider: 'slack', isWrite: descriptor.isWrite, execute: (name, args) => client.executeTool('', name, args) }
    }
    if (ref === 'email' || ref === 'http') {
      const descriptor = BUILTIN_CONNECTORS.find((c) => c.kind === 'builtin' && c.providerId === ref)!
      if (!descriptor.available()) throw new Error(`${descriptor.label} is not configured for this workspace.`)
      const client: McpToolClient = ref === 'email' ? new EmailToolClient() : new HttpToolClient()
      return { provider: ref, isWrite: descriptor.isWrite, execute: (name, args) => client.executeTool('', name, args) }
    }
    if (ref === 'sublime-goals') {
      // Authorization is decided here and baked into the client, exactly as on
      // the agent path: it is constructed with the resolved id set and has no
      // query reaching past it.
      if (!resource) {
        throw new Error(
          'Goal tools need to know which flow is running. This step was resolved without a flow resource — re-run the flow rather than calling the executor directly.',
        )
      }
      const goalIds = await resolveLinkedGoalIds(organizationId, resource)
      if (!goalIds.length) {
        throw new Error(
          'This flow is not linked to any goal, so it has no goal to read or record work against. Add it to a goal from that goal\'s page first.',
        )
      }
      const descriptor = BUILTIN_CONNECTORS.find(
        (c) => c.kind === 'builtin' && c.providerId === 'sublime-goals',
      )!
      const client = new GoalsToolClient(goalIds, prismaGoalsPort(organizationId, resource))
      return {
        provider: 'sublime-goals',
        isWrite: descriptor.isWrite,
        execute: (name, args) => client.executeTool('sublime://goals', name, args),
      }
    }
    throw new Error(`Unknown built-in integration "${ref}" — pick another in the step config.`)
  }

  if (plane === 'postgres') {
    // Flow SQL is authored by a human in the builder (node.config.args), not
    // generated by a model, so there is no approval pause here — the human
    // approved it when they saved the step. The connection's allowWrites
    // column and the statement policy still gate every call.
    const connection = await resolvePostgresConnection(organizationId, ref)
    const client = new PostgresToolClient(connection)
    return {
      provider: connection.allowWrites ? 'postgres:write' : 'postgres',
      isWrite: connection.allowWrites,
      execute: (name, args) => client.executeTool('', name, args),
    }
  }

  if (plane === 'flow') {
    // status: 'ACTIVE' mirrors loadFlowPlaneGroups + every sibling plane —
    // a DRAFT/DISABLED flow must not be executable as a tool.
    const flow = await prisma.flow.findFirst({ where: { id: ref, organizationId, status: 'ACTIVE' } })
    if (!flow) throw new Error('The selected flow no longer exists — pick another in the step config.')
    return {
      provider: 'flow',
      isWrite: false,
      execute: async (_name, args) => {
        // Direct run, not dispatch — dispatch enqueues in queue mode and made
        // this path throw in production (see loadFlowPlaneGroups). The caller's
        // subflowDepth carries over so tool-step chains cannot reset the
        // recursion counter. flowActionTimeoutMs already bounds this call.
        const { runFlowExecution, terminalizeAbandonedChildRun } = await import('@/features/flows/execute-flow')
        const res = await runFlowExecution({
          flowId: flow.id, organizationId, userId,
          input: args, usePublished: flow.publishedGraph != null, trigger: { type: 'signal', via: 'flow-tool' },
          subflowDepth: (subflowDepth ?? 0) + 1,
        })
        // Synchronous-only: throw on every non-success outcome (see loadFlowPlaneGroups).
        if (res.status === 'failed') throw new Error(res.error ?? 'The flow failed.')
        if (res.status === 'waiting') {
          await terminalizeAbandonedChildRun(organizationId, res.flowRunId)
          throw new Error("The flow paused for human input, which agent-callable flows don't support — inline the interaction or split the flow.")
        }
        return res.output ?? null
      },
    }
  }

  // nango — outbound delivery as the acting user (write plane). Native Google
  // connections ride the same plane, so gate on either transport.
  if (!nangoConfigured() && !googleOAuthConfigured()) throw new Error('Delivery integrations are not configured for this workspace.')
  const capability = ref as DeliveryCapability
  if (!DELIVERY_TOOLS.some((tool) => tool.capability === capability)) throw new Error(`Unknown delivery capability "${ref}" — pick another in the step config.`)
  const connection = await resolveDeliveryConnection(organizationId, capability, userId)
  if (!connection) throw new Error(`No connected ${capability} account is available — connect one in Integrations.`)
  return {
    provider: `nango:${capability}`,
    isWrite: true,
    execute: (name, args) => {
      // Capabilities may expose several tools (sheets/drive/calendar) —
      // dispatch by tool name within the capability.
      const spec = deliverySpecByName(capability, name)
      if (!spec) throw new Error(`Tool "${name}" is not available on this connection.`)
      return spec.run(connection, args, proxyForConnection(connection))
    },
  }
}
