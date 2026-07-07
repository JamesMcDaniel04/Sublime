import type { Job } from 'bullmq'
import { createHash } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { createQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { inlineExecution } from '@/lib/queue/execution-mode'
import { apiLogger } from '@/lib/logger'
import { KlavisClient } from '@/lib/mcp/klavis-client'
import { DenMcpClient, denMcpConfigured } from '@/lib/mcp/den-mcp'
import { getPeopleAiClientForUser, getPeopleAiServiceClient } from '@/lib/peopleai/client'
import { DELIVERY_TOOLS, nangoConfigured, resolveDeliveryConnection } from '@/lib/nango/delivery'
import { recordAudit } from '@/lib/audit'
import { createApproval, requiresApproval } from '@/lib/agents/approval'
import { retrieveContext, renderContext } from '@/lib/rag/retrieve'
import { retrieveKnowledge, renderKnowledge } from '@/lib/knowledge/retrieve'
import { embeddingsConfigured, embedQuery, embedTexts, cosineSimilarity } from '@/lib/rag/embeddings'
import { getGraphRagStore } from '@/lib/rag/get-store'
import { indexExecution } from '@/lib/rag/indexer'
import { McpClient, mcpConfigFromConnection } from '@/lib/mcp/mcp-client'
import { ensureFreshConnectionToken, persistRefreshedAuthcodeTokens } from '@/lib/mcp/connection-token'
import { isStrataUrl, selectedStrataServers } from '@/lib/mcp/strata'
import { GranolaToolClient, getGranolaApiKey, granolaTools } from '@/lib/integrations/granola'
import { SlackToolClient, slackTools } from '@/lib/integrations/slack'
import { EmailToolClient, emailTools } from '@/lib/integrations/email'
import { BUILTIN_CONNECTORS, nangoConnector, isSelected } from '@/lib/connectors/registry'
import { resolveAgentConnectorKeys } from '@/lib/connectors/agent-connectors'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { notify } from '@/lib/notifications/service'
import { checkMonthlyTokenBudget, recordTokenUsage } from '@/lib/usage/budget'
import { cacheGet, cacheSet } from '@/lib/cache'
import { buildAgentSystemPrompt } from './system-prompt'
import {
  createModelRunner,
  generateHeadline,
  DEFAULT_AGENT_MODEL,
  type ToolDefinition,
  type ToolResult,
} from '@/lib/llm/model-runner'
import { coerceToIR } from '@/lib/llm/ir'

export type AgentExecutionJob = {
  executionId?: string
  agentId: string
  organizationId: string
  userId: string
  input?: string
  resume?: boolean
  reply?: string
  // Multi-agent handoff: depth in the sub-agent chain (0 = top-level) and the
  // ancestor agent ids, used to bound recursion and prevent cycles.
  depth?: number
  ancestorAgentIds?: string[]
}

// Sub-agent handoff bounds. Kept conservative: sub-runs execute inline within
// the parent's tool loop, so many/deep runs would blow the run's time budget.
const MAX_SUBAGENT_DEPTH = 2
const MAX_SUBAGENTS_PER_RUN = 15

// Minimal interface that both KlavisClient and DenMcpClient satisfy,
// so ToolBinding.client can hold either without casting.
interface McpToolClient {
  executeTool(serverUrl: string, name: string, args: Record<string, unknown>): Promise<any>
}

type ToolBinding = {
  provider: string
  serverUrl: string
  toolName: string
  client: McpToolClient
}

type PendingQuestion = {
  toolCallId: string
  question: string
  stepId: string | null
  collectedResults: ToolResult[]
}

const ASK_USER_TOOL: ToolDefinition = {
  name: 'ask_user',
  description:
    'Pause the run and ask the user one question. Call this only when you are blocked on a decision, missing information, or approval that only the user can provide. The run resumes when they reply.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to show the user.' },
    },
    required: ['question'],
  },
}

function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

function toolName(provider: string, name: string) {
  return `${provider}_${name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
}

// MCP tool lists are near-static, but loadTools re-discovered them (initialize +
// tools/list round-trips) on EVERY run. Cache the discovery per server URL so a
// warm run skips the network entirely; busted on connection create/update.
const TOOL_DISCOVERY_TTL_MS = 10 * 60 * 1000
// Keyed by org too: MCP servers can gate tools/list by identity, so one org's
// discovery must not pin another's tool set on a shared serverUrl.
export const toolDiscoveryCacheKey = (organizationId: string, serverUrl: string) => `mcptools:${organizationId}:${serverUrl}`
async function cachedToolDiscovery<T>(organizationId: string, serverUrl: string, fetchTools: () => Promise<T[]>): Promise<T[]> {
  const key = toolDiscoveryCacheKey(organizationId, serverUrl)
  const hit = await cacheGet<T[]>(key)
  if (hit && hit.length > 0) return hit
  const fresh = await fetchTools()
  // Never cache an empty result — a transient empty/errored discovery must not
  // pin "no tools" for the whole TTL and silently disable the integration.
  if (fresh.length > 0) await cacheSet(key, fresh, TOOL_DISCOVERY_TTL_MS)
  return fresh
}

function metadataOf(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {}
}

// ── Idempotency ledger (durable resume) ──────────────────────────────────────
// A tool call is keyed by its node + a stable hash of its input. On resume, a
// re-issued call whose key matches an already-succeeded step replays that step's
// stored output instead of re-executing (and re-firing side effects).
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

function toolStepKey(node: string, input: unknown): string {
  return `${node}:${createHash('sha256').update(stableStringify(input)).digest('hex')}`
}

async function loadCompletedToolSteps(executionId: string): Promise<Map<string, unknown>> {
  const steps = await prisma.workflowStep.findMany({
    where: { executionId, status: 'succeeded' },
    select: { node: true, input: true, output: true },
  })
  const map = new Map<string, unknown>()
  for (const step of steps) map.set(toolStepKey(step.node, step.input), step.output)
  return map
}

// A tool discovered from some plane, before the global cap is applied. `isWrite`
// marks consequential outbound-delivery tools so they can be reserved a slice of
// the cap instead of being crowded out by many read tools.
export type DiscoveredTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  binding: ToolBinding
  isWrite: boolean
}

const TOOL_CAP = 64
const WRITE_RESERVE = 16

/**
 * Apply the global tool cap with a reserved write-tool budget: keep all write
 * tools (up to WRITE_RESERVE), then fill the rest with reads up to TOOL_CAP,
 * then any remaining writes. Dedupes by name (first wins). This is the single
 * place the cap/priority policy lives — previously each plane capped inline, so
 * write tools (loaded last) were silently dropped once reads filled 64.
 */
function materializeTools(picked: DiscoveredTool[]): { tools: ToolDefinition[]; bindings: Map<string, ToolBinding> } {
  const tools: ToolDefinition[] = []
  const bindings = new Map<string, ToolBinding>()
  for (const d of picked) {
    bindings.set(d.name, d.binding)
    tools.push({ name: d.name, description: d.description, inputSchema: d.inputSchema })
  }
  return { tools, bindings }
}

export function capDiscoveredTools(discovered: DiscoveredTool[], organizationId: string): { tools: ToolDefinition[]; bindings: Map<string, ToolBinding> } {
  const seen = new Set<string>()
  const dedupe = (list: DiscoveredTool[]) => list.filter((d) => (seen.has(d.name) ? false : (seen.add(d.name), true)))
  const writes = dedupe(discovered.filter((d) => d.isWrite))
  const reads = dedupe(discovered.filter((d) => !d.isWrite))

  const picked: DiscoveredTool[] = [...writes.slice(0, WRITE_RESERVE)]
  for (const d of reads) { if (picked.length >= TOOL_CAP) break; picked.push(d) }
  for (const d of writes.slice(WRITE_RESERVE)) { if (picked.length >= TOOL_CAP) break; picked.push(d) }

  const dropped = writes.length + reads.length - picked.length
  if (dropped > 0) {
    apiLogger.warn('loadTools: tool cap reached; some discovered tools not exposed', {
      organizationId, discovered: writes.length + reads.length, cap: TOOL_CAP, dropped, writesKept: Math.min(writes.length, picked.filter((p) => p.isWrite).length),
    })
  }

  return materializeTools(picked)
}

/**
 * Choose which discovered tools to expose when there are more than the cap.
 *
 * Over the cap, the deterministic policy (capDiscoveredTools) fills reads in
 * arbitrary discovery order — so a large connector can crowd out the handful of
 * tools this agent actually needs. Instead, rank the over-budget tools by
 * embedding similarity to the agent's objective and keep the most relevant.
 * Write tools keep their reserved slice (consequential; never relevance-dropped)
 * and overflow writes compete on relevance like reads.
 *
 * Best-effort: under the cap, without a query, without embeddings configured, or
 * on any embedding failure, it falls back to the deterministic cap so tool
 * loading never depends on the embeddings provider being up.
 */
export async function selectDiscoveredTools(
  discovered: DiscoveredTool[],
  organizationId: string,
  query?: string,
): Promise<{ tools: ToolDefinition[]; bindings: Map<string, ToolBinding> }> {
  const seen = new Set<string>()
  const unique = discovered.filter((d) => (seen.has(d.name) ? false : (seen.add(d.name), true)))

  if (unique.length <= TOOL_CAP || !query?.trim() || !embeddingsConfigured()) {
    return capDiscoveredTools(discovered, organizationId)
  }

  try {
    const writes = unique.filter((d) => d.isWrite)
    const reads = unique.filter((d) => !d.isWrite)
    const keptWrites = writes.slice(0, WRITE_RESERVE)
    const budget = Math.max(0, TOOL_CAP - keptWrites.length)
    const candidates = [...reads, ...writes.slice(WRITE_RESERVE)]

    const [queryVec, docVecs] = await Promise.all([
      embedQuery(query.slice(0, 2000)),
      embedTexts(candidates.map((d) => `${d.name}: ${d.description}`.slice(0, 2000)), { inputType: 'document' }),
    ])
    const ranked = candidates
      .map((d, i) => ({ d, score: cosineSimilarity(queryVec, docVecs[i]) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, budget)
      .map((r) => r.d)

    const picked = [...keptWrites, ...ranked]
    apiLogger.info('loadTools: selected tools by relevance to the objective', {
      organizationId, discovered: unique.length, cap: TOOL_CAP, kept: picked.length, dropped: unique.length - picked.length,
    })
    return materializeTools(picked)
  } catch (error) {
    apiLogger.warn('loadTools: relevance selection failed, using deterministic cap', {
      organizationId, error: error instanceof Error ? error.message : String(error),
    })
    return capDiscoveredTools(discovered, organizationId)
  }
}

async function loadTools(organizationId: string, providers: string[], ownerUserId?: string | null, query?: string) {
  // Every plane contributes to one list; the cap/priority policy is applied once
  // at the end (capDiscoveredTools) so write tools aren't crowded out.
  const discovered: DiscoveredTool[] = []

  // ---- Klavis-managed MCP servers ----------------------------------------
  // Non-Den providers that Klavis handles (Den/Sales AI is loaded
  // unconditionally below, so it never needs to appear in the providers list).
  const klavisProviders = providers.filter((p) => !/den/i.test(p))

  if (process.env.KLAVIS_API_KEY && klavisProviders.length > 0) {
    const client = new KlavisClient({ apiKey: process.env.KLAVIS_API_KEY, platformName: 'den' })
    const agents = await prisma.mCPAgent.findMany({
      where: {
        organizationId,
        isActive: true,
        agentType: { in: klavisProviders.map((provider) => provider.toUpperCase()) },
      },
    })

    // Discover all Klavis providers in parallel (cached per server URL); a
    // failing discovery for one provider degrades to empty, never aborts the
    // run. Bindings are built afterward, sequentially, so dedup + order stay
    // deterministic regardless of which discovery resolved first.
    const klavisResults = await Promise.all(agents.map(async (agent) => {
      const provider = String(agent.agentType).toLowerCase()
      try {
        const available = await cachedToolDiscovery(organizationId, agent.mcpServerUrl, () => client.getServerTools(agent.mcpServerUrl))
        return { provider, serverUrl: agent.mcpServerUrl, available }
      } catch (error) {
        apiLogger.warn('loadTools: Klavis tool discovery failed, skipping provider', {
          provider, organizationId, error: error instanceof Error ? error.message : String(error),
        })
        return { provider, serverUrl: agent.mcpServerUrl, available: [] as Awaited<ReturnType<typeof client.getServerTools>> }
      }
    }))

    for (const { provider, serverUrl, available } of klavisResults) {
      if (available.length > 20) {
        apiLogger.warn('loadTools: per-provider tool cap reached; some tools not exposed to the agent', {
          provider, organizationId, discovered: available.length, cap: 20, dropped: available.length - 20,
        })
      }
      for (const tool of available.slice(0, 20)) {
        discovered.push({
          name: toolName(provider, tool.name),
          description: tool.description || `${tool.name} via ${provider}`,
          inputSchema: tool.inputSchema || { type: 'object', properties: {} },
          binding: { provider, serverUrl, toolName: tool.name, client },
          isWrite: false,
        })
      }
    }
  }

  // ---- People.ai Sales AI MCP (a.k.a. Den MCP) -----------------------
  // Sales AI read tools are this product's core data spine, so they load for
  // EVERY agent whenever a People.ai client resolves — the same "connect once,
  // available everywhere" model as the org MCP connections below. (Previously
  // gated on the agent's providers list containing "den", but the agent
  // config UI never surfaced that toggle, so agents could never actually
  // receive these tools.) When no client resolves — an unentitled org with no
  // connection and no service key — nothing loads, which is harmless.
  //
  // Identity order matters for data isolation:
  //  1. The agent OWNER's delegated connection (mcp_* token) — the agent reads
  //     People.ai exactly as that rep.
  //  2. The org service key (PAI-Client-Id/Secret) for ownerless runs.
  //  3. Legacy env-configured service account (DEN_MCP_*), logged loudly
  //     because it is not tenant-isolated.
  try {
    let paiClient = ownerUserId ? await getPeopleAiClientForUser(ownerUserId, organizationId) : null
    let identity: 'user' | 'service' | 'legacy-env' = 'user'
    if (!paiClient) {
      paiClient = getPeopleAiServiceClient()
      identity = 'service'
    }

    if (paiClient) {
      const adapter: McpToolClient = {
        executeTool: (_serverUrl, name, args) => paiClient!.callTool(name, args),
      }
      if (identity !== 'user') {
        apiLogger.warn('loadTools: People.ai tools using service identity (no owner connection)', {
          organizationId, ownerUserId: ownerUserId ?? null,
        })
      }
      const available = await cachedToolDiscovery(organizationId, paiClient.serverUrl, () => paiClient!.listTools())
      for (const tool of available.slice(0, 20)) {
        discovered.push({
          name: toolName('den', tool.name),
          description: tool.description || `${tool.name} via Den`,
          inputSchema:
            tool.inputSchema && typeof tool.inputSchema === 'object'
              ? (tool.inputSchema as Record<string, unknown>)
              : { type: 'object', properties: {} },
          binding: { provider: 'den', serverUrl: paiClient.serverUrl, toolName: tool.name, client: adapter },
          isWrite: false,
        })
      }
    } else if (denMcpConfigured()) {
      apiLogger.warn('loadTools: People.ai tools using legacy env service account (no tenant isolation)', {
        organizationId,
      })
      const denUrl = process.env.DEN_MCP_URL!
      const denClient = new DenMcpClient()
      const available = await cachedToolDiscovery(organizationId, denUrl, () => denClient.getServerTools(denUrl))
      for (const tool of available.slice(0, 20)) {
        discovered.push({
          name: toolName('den', tool.name),
          description: tool.description || `${tool.name} via den`,
          inputSchema: tool.inputSchema || { type: 'object', properties: {} },
          binding: { provider: 'den', serverUrl: denUrl, toolName: tool.name, client: denClient },
          isWrite: false,
        })
      }
    }
  } catch (error) {
    apiLogger.warn('loadTools: People.ai tool discovery failed, skipping provider', {
      provider: 'den',
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  // ---- Per-org MCP connections (all active connections, any authType) ------
  // Custom MCP connections load for every agent regardless of the providers
  // list — EXCEPT Klavis Strata, which is opt-in per agent: its ~90 tools would
  // otherwise all be live at once. An agent gets Strata's meta-tools only when
  // it has selected at least one `strata:<server>`; the selected set scopes it
  // (see the system-prompt note added in the run). A failing/unreachable server
  // must NOT abort the run or block others.
  const strataSelected = selectedStrataServers(providers)
  const connections = (await prisma.mcpConnection.findMany({
    where: { organizationId, isActive: true },
  })).filter((conn) => !isStrataUrl(conn.serverUrl) || strataSelected.length > 0)

  // Discover all org MCP connections in parallel (cached per server URL); token
  // refresh + client build happen per-connection, discovery is cached. Failures
  // degrade to null and are skipped. Bindings built afterward, sequentially, so
  // dedup + the 64-tool cap apply deterministically.
  const orgMcp = await Promise.all(connections.map(async (conn) => {
    const slug = conn.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
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
      return { slug, serverUrl: fresh.serverUrl, name: fresh.name, client, available }
    } catch (error) {
      apiLogger.warn('loadTools: org MCP connection tool discovery failed, skipping', {
        connectionId: conn.id, connectionName: conn.name, serverUrl: conn.serverUrl,
        organizationId, error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }))

  for (const entry of orgMcp) {
    if (!entry) continue
    for (const tool of entry.available.slice(0, 20)) {
      discovered.push({
        name: toolName(entry.slug, tool.name),
        description: tool.description || `${tool.name} via ${entry.name}`,
        inputSchema: tool.inputSchema || { type: 'object', properties: {} },
        binding: { provider: entry.slug, serverUrl: entry.serverUrl, toolName: tool.name, client: entry.client },
        isWrite: false,
      })
    }
  }

  // ---- Granola REST API (built-in; no Klavis / MCP server required) --------
  // Gate: a Granola key must resolve for this org (saved key first, then the
  // GRANOLA_API_KEY env fallback) AND the agent's providers list must include
  // an entry matching /granola/i. A failure here must not abort the run or
  // prevent other tools from loading.
  const granolaConn = BUILTIN_CONNECTORS.find((c) => c.providerId === 'granola')!
  if (isSelected(granolaConn, providers)) {
    try {
      const granolaKey = await getGranolaApiKey(organizationId)
      if (granolaKey) {
        const client = new GranolaToolClient(granolaKey.apiKey)
        const serverUrl = 'https://public-api.granola.ai/v1'
        for (const def of granolaTools()) {
          discovered.push({
            name: toolName('granola', def.name),
            description: def.description,
            inputSchema: def.inputSchema,
            binding: { provider: 'granola', serverUrl, toolName: def.name, client },
            isWrite: granolaConn.isWrite,
          })
        }
      }
    } catch (error) {
      apiLogger.warn('loadTools: Granola tool setup failed, skipping provider', {
        provider: 'granola',
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // ---- Slack REST API (built-in; delivery integration) --------------------
  // Gate: SLACK_BOT_TOKEN must be set AND the agent's providers list must
  // include an entry matching /slack/i. A failure here must not abort the
  // run or prevent other tools from loading.
  const slackConn = BUILTIN_CONNECTORS.find((c) => c.kind === 'builtin' && c.providerId === 'slack')!
  if (slackConn.available() && isSelected(slackConn, providers)) {
    try {
      const client = new SlackToolClient()
      const serverUrl = 'https://slack.com/api'
      for (const def of slackTools()) {
        discovered.push({
          name: toolName('slack', def.name),
          description: def.description,
          inputSchema: def.inputSchema,
          binding: { provider: 'slack', serverUrl, toolName: def.name, client },
          isWrite: slackConn.isWrite,
        })
      }
    } catch (error) {
      apiLogger.warn('loadTools: Slack tool setup failed, skipping provider', {
        provider: 'slack',
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // ---- Email via Resend REST API (built-in; delivery integration) ----------
  // Gate: RESEND_API_KEY must be set AND the agent's providers list must
  // include an entry matching /email/i. A failure here must not abort the
  // run or prevent other tools from loading.
  const emailConn = BUILTIN_CONNECTORS.find((c) => c.providerId === 'email')!
  if (emailConn.available() && isSelected(emailConn, providers)) {
    try {
      const client = new EmailToolClient()
      const serverUrl = 'https://api.resend.com'
      for (const def of emailTools()) {
        discovered.push({
          name: toolName('email', def.name),
          description: def.description,
          inputSchema: def.inputSchema,
          binding: { provider: 'email', serverUrl, toolName: def.name, client },
          isWrite: emailConn.isWrite,
        })
      }
    } catch (error) {
      apiLogger.warn('loadTools: Email tool setup failed, skipping provider', {
        provider: 'email',
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // ---- Nango delivery (outbound writes as the acting user) -----------------
  // Slack/Gmail/Salesforce writes through the org's Nango connections,
  // preferring the agent owner's own connection so messages arrive as the rep.
  // Gated per capability on both a matching providers entry and a resolvable
  // connection. Failures never abort the run.
  if (nangoConfigured()) {
    for (const spec of DELIVERY_TOOLS) {
      const connector = nangoConnector(spec.capability)
      if (!connector || !isSelected(connector, providers)) continue
      try {
        const connection = await resolveDeliveryConnection(organizationId, spec.capability, ownerUserId)
        if (!connection) continue
        const deliveryClient: McpToolClient = {
          executeTool: (_serverUrl, _toolName, args) => spec.run(connection, args),
        }
        discovered.push({
          name: toolName('nango', spec.name),
          description: spec.description,
          inputSchema: spec.inputSchema,
          binding: { provider: connector.providerId, serverUrl: 'nango', toolName: spec.name, client: deliveryClient },
          isWrite: connector.isWrite,
        })
      } catch (error) {
        apiLogger.warn('loadTools: Nango delivery setup failed, skipping capability', {
          capability: spec.capability,
          organizationId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  // Select which tools to expose: over the cap, rank by relevance to the
  // objective (best-effort, embeddings-gated) with a reserved write budget;
  // otherwise the deterministic cap. Delivery tools aren't crowded out either way.
  return selectDiscoveredTools(discovered, organizationId, query)
}

async function recordEvent(executionId: string, stepId: string | null, kind: string, payload?: unknown) {
  await prisma.workflowEvent.create({
    data: { executionId, stepId, kind, payload: jsonValue(payload) },
  })
}

/**
 * Resume a suspended run (ask_user reply or approval decision) — inline in dev,
 * enqueued on the worker in prod. Shared by the reply route and the approval
 * decision route.
 */
export async function resumeAgentExecution(params: {
  executionId: string
  agentId: string
  organizationId: string
  userId: string
  reply: string
}): Promise<void> {
  if (inlineExecution) {
    await runAgentExecution({ ...params, resume: true })
    return
  }
  if (!workersEnabled) throw new Error('Agent worker is disabled')
  const queue = createQueue(QUEUE_NAMES.AGENT_EXECUTION)
  await queue.add('resume-agent', { ...params, resume: true }, { jobId: `${params.executionId}-resume-${Date.now()}` })
}

export async function runAgentExecution(data: AgentExecutionJob) {
  const { agentId, organizationId, userId } = data
  const agent = await prisma.agentTask.findFirst({
    where: { id: agentId, organizationId, status: 'ACTIVE' },
  })
  if (!agent) throw new Error('Agent not found or inactive')

  const agentMetadata = metadataOf(agent.metadata)
  const model = agentMetadata.model || DEFAULT_AGENT_MODEL
  const runner = createModelRunner(model)

  const queuedExecution = data.executionId
    ? await prisma.agentExecution.findFirst({
        where: {
          id: data.executionId,
          agentTaskId: agentId,
          organizationId,
        },
      })
    : null
  if (data.executionId && !queuedExecution) throw new Error('Queued execution does not match this tenant and agent')

  const resuming = Boolean(data.resume)
  if (resuming && !queuedExecution) throw new Error('Resume requested without an execution')

  // A re-delivered execution: skip terminal/waiting ones, but RESUME a run that
  // was interrupted mid-flight (status 'running' with a checkpointed transcript)
  // from its last completed turn instead of restarting from the top and
  // re-firing every side effect.
  let resumeFromCrash = false
  if (queuedExecution && !resuming && queuedExecution.status !== 'pending') {
    if (queuedExecution.status === 'running' && Array.isArray(queuedExecution.transcript)) {
      resumeFromCrash = true
    } else {
      return { status: queuedExecution.status, skipped: true as const }
    }
  }

  let transcript: unknown[]
  let pendingResults: ToolResult[] | null = null
  let startTurn = 0
  // On any resume, already-succeeded tool steps form an idempotency ledger so a
  // replayed call reuses its stored output instead of re-firing.
  let completedToolSteps = new Map<string, unknown>()

  if (resuming && queuedExecution) {
    const executionMetadata = metadataOf(queuedExecution.metadata)
    const pending = executionMetadata.pendingQuestion as PendingQuestion | undefined
    const waiting = queuedExecution.status === 'waiting_for_input' || queuedExecution.status === 'waiting_for_approval'
    if (!waiting || !pending || !Array.isArray(queuedExecution.transcript)) {
      throw new Error('Execution is not waiting for input or approval')
    }
    // Normalize to the provider-neutral IR so a run persisted in a native shape
    // (pre-IR, or by the other provider) resumes on whatever provider routes now.
    transcript = coerceToIR(queuedExecution.transcript as unknown[])
    startTurn = Number(executionMetadata.turnCursor) || 0
    completedToolSteps = await loadCompletedToolSteps(queuedExecution.id)
    const reply = data.reply?.trim() || 'The user did not provide an answer. Use your best judgment.'
    pendingResults = [
      ...(pending.collectedResults || []),
      { toolCallId: pending.toolCallId, content: reply },
    ]
    if (pending.stepId) {
      await prisma.workflowStep.update({
        where: { id: pending.stepId },
        data: { status: 'succeeded', output: jsonValue({ answer: reply }), completedAt: new Date() },
      })
    }
    await recordEvent(queuedExecution.id, pending.stepId || null, 'user.replied', { answer: reply })
  } else if (resumeFromCrash && queuedExecution) {
    transcript = coerceToIR(queuedExecution.transcript as unknown[])
    startTurn = Number(metadataOf(queuedExecution.metadata).turnCursor) || 0
    completedToolSteps = await loadCompletedToolSteps(queuedExecution.id)
    await recordEvent(queuedExecution.id, null, 'run.resumed', { fromTurn: startTurn })
  } else {
    transcript = runner.start(data.input || agent.objective)
  }

  const execution = queuedExecution
    ? await prisma.agentExecution.update({
        where: { id: queuedExecution.id },
        data: {
          status: 'running',
          model: runner.model,
          ...(resuming
            ? { metadata: jsonValue({ ...metadataOf(queuedExecution.metadata), pendingQuestion: null }) }
            : { startedAt: new Date() }),
        },
      })
    : await prisma.agentExecution.create({
        data: {
          agentType: agent.agentType,
          agentTaskId: agent.id,
          status: 'running',
          model: runner.model,
          input: { prompt: data.input || agent.objective },
          trigger: { type: 'schedule' },
          metadata: { title: agentMetadata.title || agent.description },
          userId,
          organizationId,
        },
      })

  if (!resuming) {
    await prisma.executionMessage.create({
      data: { executionId: execution.id, role: 'user', content: data.input || agent.objective },
    })
  }

  const executionMetadata = metadataOf(execution.metadata)
  const segmentStart = Date.now()
  const usage = { inputTokens: 0, outputTokens: 0 }

  try {
    // Enforce the workspace's monthly token ceiling before doing any model work.
    const budget = await checkMonthlyTokenBudget(organizationId)
    if (budget.over) {
      throw new Error(
        `Monthly token budget reached for this workspace (${budget.used.toLocaleString()}/${budget.limit.toLocaleString()} tokens). Raise AGENT_MONTHLY_TOKEN_LIMIT or wait for the next cycle.`,
      )
    }

    // Typed connector bindings gate tool loading; falls back to
    // metadata.integrations for agents created before the FK existed.
    const providers = await resolveAgentConnectorKeys(agent.id, agentMetadata)
    const skillIds = Array.isArray(agentMetadata.skills) ? agentMetadata.skills.map(String) : []
    const toolQuery = [agent.objective, data.input].filter(Boolean).join('\n')
    const { tools, bindings } = await loadTools(organizationId, providers, userId, toolQuery)
    let system = buildAgentSystemPrompt(agent.objective, skillIds)

    // Scope Klavis Strata to the servers this agent selected, so its discovery/
    // execute meta-tools only reach the intended tools rather than all ~90.
    const strataScope = selectedStrataServers(providers)
    if (strataScope.length) {
      system += `\nThrough the Klavis Strata meta-tools, use ONLY these servers: ${strataScope.join(', ')}. When calling the discovery and execute_action tools, restrict server_names to this list and do not use other Strata servers.`
    }

    // Multi-agent handoff: an opted-in agent can delegate to other agents via a
    // run_agent tool (fan-out over a set, or sequential pipeline stages). Bounded
    // by depth, a per-run count cap, and a cycle guard; sub-runs share the org's
    // token budget. Only offered to top-level/mid-chain runs under the depth cap.
    const depth = data.depth ?? 0
    const chain = [...(data.ancestorAgentIds ?? []), agent.id]
    if (agentMetadata.allowSubagents === true && depth < MAX_SUBAGENT_DEPTH) {
      const callable = await prisma.agentTask.findMany({
        where: {
          organizationId,
          status: 'ACTIVE',
          id: { notIn: chain },
          ...agentVisibilityScope(userId),
        },
        select: { id: true, description: true, metadata: true },
        take: 100,
      })
      const nameOf = (m: unknown) => (metadataOf(m).title as string) || ''
      const roster = callable
        .map((a) => `- "${nameOf(a.metadata) || a.description}"`)
        .join('\n')
      const runAgentTool: ToolDefinition = {
        name: 'run_agent',
        description:
          'Delegate a sub-task to another agent and get its result back. Use this to run a worker agent once per item (fan-out) or to chain a pipeline stage. ' +
          `You can call it up to ${MAX_SUBAGENTS_PER_RUN} times this run. Available agents:\n${roster || '(none)'}`,
        inputSchema: {
          type: 'object',
          properties: {
            agent: { type: 'string', description: 'The exact name of the agent to run (from the list above).' },
            input: { type: 'string', description: 'The task/input to give that agent (e.g. the account to score).' },
          },
          required: ['agent', 'input'],
        },
      }
      let subRunCount = 0
      const runAgentClient: McpToolClient = {
        executeTool: async (_serverUrl, _name, args) => {
          const wanted = String((args as Record<string, unknown>).agent || '').trim()
          const subInput = String((args as Record<string, unknown>).input || '').trim()
          if (!wanted) return { error: 'Provide the name of the agent to run.' }
          if (subRunCount >= MAX_SUBAGENTS_PER_RUN) {
            return { error: `Sub-agent limit reached (${MAX_SUBAGENTS_PER_RUN} per run). Summarize what you have instead of running more.` }
          }
          const target = callable.find(
            (a) => a.id === wanted || nameOf(a.metadata).toLowerCase() === wanted.toLowerCase() || a.description.toLowerCase() === wanted.toLowerCase(),
          )
          if (!target) return { error: `No agent named "${wanted}" is available to run.` }
          if (chain.includes(target.id)) return { error: `"${wanted}" is already running upstream — cycles are not allowed.` }
          subRunCount += 1
          try {
            const result = await runAgentExecution({
              agentId: target.id,
              organizationId,
              userId,
              input: subInput,
              depth: depth + 1,
              ancestorAgentIds: chain,
            })
            // A completed sub-run returns { summary }; a suspended one (asked
            // the user / awaiting approval) returns { status: 'waiting_*' }.
            const sub = result as { summary?: string; status?: string; question?: string }
            if (typeof sub?.summary === 'string') return { agent: nameOf(target.metadata) || target.description, output: sub.summary }
            if (typeof sub?.status === 'string' && sub.status.startsWith('waiting')) {
              return { agent: wanted, note: `The sub-agent paused (${sub.status}${sub.question ? `: ${sub.question}` : ''}), which pipelines do not support. Make it self-sufficient or pass what it needs in the input.` }
            }
            return { agent: wanted, note: 'The sub-agent produced no output.' }
          } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) }
          }
        },
      }
      tools.push(runAgentTool)
      bindings.set('run_agent', { provider: 'agent', serverUrl: '', toolName: 'run_agent', client: runAgentClient })
    }

    // Graph-RAG: give the agent correlated context (Sales AI signals,
    // integration/MCP data from prior runs, related accounts/opps) before it
    // acts. Best-effort and gated — a no-op when embeddings aren't configured.
    try {
      const execInput = (queuedExecution?.input ?? null) as { signal?: { accountId?: string; opportunityId?: string } } | null
      const signalRef = execInput?.signal
      const seedNodeIds = [
        signalRef?.accountId ? `account:${signalRef.accountId}` : null,
        signalRef?.opportunityId ? `opp:${signalRef.opportunityId}` : null,
      ].filter((id): id is string => Boolean(id))
      const ragContext = await retrieveContext(getGraphRagStore(), {
        organizationId,
        // Scope correlated context to this rep: shared org data + their own
        // private nodes, never another rep's private book.
        viewerUserId: userId,
        query: `${agent.objective}\n${data.input ?? ''}`.slice(0, 2000),
        seedNodeIds,
      })
      const rendered = renderContext(ragContext)
      if (rendered) {
        system = `${system}\n\n${rendered}`
        // Surface the correlated context in the run's activity log so the
        // "brain" is visible: what Sales AI signals / prior runs / related
        // accounts the agent pulled in before acting.
        await recordEvent(execution.id, null, 'context.retrieved', {
          source: 'graph-rag',
          hits: ragContext.hits.map((h) => ({ type: h.type, text: h.text })),
          related: ragContext.related.map((r) => ({ type: r.type, text: r.text })),
          summary: `Pulled ${ragContext.hits.length} correlated fact(s) + ${ragContext.related.length} connected entit(ies) from Sales AI, integrations, and prior runs.`,
        })
      }
    } catch (error) {
      apiLogger.warn('execute-agent: RAG context skipped', {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    // Uploaded file knowledge: retrieve the most relevant chunks for this agent
    // and inject them into the system prompt. Best-effort — never blocks a run.
    try {
      const knowledgeHits = await retrieveKnowledge({
        organizationId,
        agentId: agent.id,
        query: `${agent.objective}\n${data.input ?? ''}`.slice(0, 2000),
      })
      const knowledgeBlock = renderKnowledge(knowledgeHits)
      if (knowledgeBlock) {
        system = `${system}\n\n${knowledgeBlock}`
        await recordEvent(execution.id, null, 'knowledge.retrieved', {
          source: 'uploaded-files',
          files: [...new Set(knowledgeHits.map((h) => h.filename))],
          summary: `Pulled ${knowledgeHits.length} passage(s) from ${new Set(knowledgeHits.map((h) => h.filename)).size} uploaded file(s).`,
        })
      }
    } catch (error) {
      apiLogger.warn('execute-agent: knowledge retrieval skipped', {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    if (pendingResults) runner.appendToolResults(transcript, pendingResults)

    const maxTurns = Number(agentMetadata.maxTurns) || Number(process.env.AGENT_MAX_TURNS) || 16
    // Per-run token backstop against a pathological loop (independent of the
    // monthly ceiling). Generous by default; tune via AGENT_MAX_RUN_TOKENS.
    const perRunTokenCap = Number(process.env.AGENT_MAX_RUN_TOKENS) || 2_000_000
    const monthlyLimit = budget.limit
    let finalText = ''

    for (let turn = startTurn; turn < maxTurns; turn += 1) {
      const turnResult = await runner.next(transcript, system, [...tools, ASK_USER_TOOL])
      usage.inputTokens += turnResult.usage.inputTokens
      usage.outputTokens += turnResult.usage.outputTokens

      // Record this turn's spend on the live cross-process counter, then enforce
      // both the per-run cap and the (in-flight-aware) monthly ceiling mid-run so
      // a runaway can't blow far past the budget between the start-of-run check
      // and completion.
      const runTotal = usage.inputTokens + usage.outputTokens
      const monthTotal = await recordTokenUsage(organizationId, turnResult.usage.inputTokens + turnResult.usage.outputTokens)
      if (perRunTokenCap > 0 && runTotal >= perRunTokenCap) {
        finalText = turnResult.text || 'Run stopped: it reached its per-run token cap.'
        await recordEvent(execution.id, null, 'run.capped', { reason: 'per_run_token_cap', runTotal, cap: perRunTokenCap })
        break
      }
      if (monthlyLimit > 0 && (monthTotal ?? 0) >= monthlyLimit) {
        finalText = turnResult.text || 'Run stopped: the workspace monthly token budget was reached.'
        await recordEvent(execution.id, null, 'run.capped', { reason: 'monthly_budget', monthTotal, limit: monthlyLimit })
        break
      }

      if (!turnResult.toolCalls.length) {
        finalText = turnResult.text || 'Agent completed without a text response.'
        break
      }

      // Capture the assistant's narration that accompanies a tool-calling turn so
      // the activity log can show the agent's reasoning as it works, interleaved
      // with the tool calls it makes.
      if (turnResult.text && turnResult.text.trim()) {
        await recordEvent(execution.id, null, 'agent.thinking', { text: turnResult.text.trim() })
      }

      const results: ToolResult[] = []
      let pendingAsk: { toolCallId: string; question: string } | null = null
      let pendingApproval: { toolCallId: string; approvalId: string; stepId: string; summary: string } | null = null

      for (const call of turnResult.toolCalls) {
        if (call.name === ASK_USER_TOOL.name) {
          // At most ONE suspension per turn (a question OR an approval). A run
          // suspends by leaving exactly one tool_use id unresolved (it becomes
          // pendingQuestion.toolCallId, resolved on resume); a second unresolved
          // id would orphan a tool call and make the persisted transcript
          // unreplayable. So any further ask/approval gets a covering result.
          if (pendingAsk || pendingApproval) {
            results.push({
              toolCallId: call.id,
              content: JSON.stringify({ error: 'You can only pause once per turn (a question or an approval is already pending). Ask again after it resolves.' }),
              isError: true,
            })
            continue
          }
          pendingAsk = {
            toolCallId: call.id,
            question: String(call.input.question || 'The agent needs your input to continue.'),
          }
          continue
        }

        const binding = bindings.get(call.name)
        const step = await prisma.workflowStep.create({
          data: {
            executionId: execution.id,
            node: binding ? `${binding.provider}.${binding.toolName}` : call.name,
            status: 'running',
            input: jsonValue(call.input),
            startedAt: new Date(),
          },
        })
        await recordEvent(execution.id, step.id, 'tool.started', { name: step.node, args: call.input })

        try {
          if (!binding) throw new Error(`Tool binding not found: ${call.name}`)

          // Durable replay: if this exact call already succeeded in a prior
          // attempt of this run (crash/retry), reuse its stored output instead
          // of re-executing and re-firing side effects.
          const replayKey = toolStepKey(step.node, call.input)
          if (completedToolSteps.has(replayKey)) {
            const cached = completedToolSteps.get(replayKey)
            await prisma.workflowStep.update({
              where: { id: step.id },
              data: { status: 'succeeded', output: jsonValue(cached), completedAt: new Date() },
            })
            await recordEvent(execution.id, step.id, 'tool.replayed', { name: step.node })
            results.push({ toolCallId: call.id, content: JSON.stringify(cached) })
            continue
          }

          // Approval gate: if this agent requires approval and the tool is an
          // outbound write, queue it instead of executing — an approver runs
          // it out-of-band, and the RUN SUSPENDS until the decision. On approve,
          // decideApproval executes the write and resumes this run with its
          // result injected, so the agent acts on the real outcome (rather than
          // continuing blind on a "queued" placeholder).
          if (requiresApproval(agentMetadata, binding.provider)) {
            // Only ONE suspension per turn: if a question or another approval is
            // already pending, defer this one with a covering result (and do NOT
            // create an approval row, so nothing is orphaned) — the model
            // re-proposes it once the run resumes.
            if (pendingApproval || pendingAsk) {
              await prisma.workflowStep.update({
                where: { id: step.id },
                data: { status: 'succeeded', output: jsonValue({ deferred: true }), completedAt: new Date() },
              })
              results.push({
                toolCallId: call.id,
                content: JSON.stringify({ status: 'deferred', message: 'Another action is already pending this turn; re-propose this once it resolves.' }),
              })
              continue
            }
            const approval = await createApproval({
              organizationId,
              executionId: execution.id,
              userId,
              provider: binding.provider,
              tool: call.name,
              args: (call.input ?? {}) as Record<string, unknown>,
            })
            await prisma.workflowStep.update({
              where: { id: step.id },
              data: { status: 'waiting', output: jsonValue({ approvalId: approval.id }) },
            })
            await recordEvent(execution.id, step.id, 'tool.queued_for_approval', { name: step.node, approvalId: approval.id })
            pendingApproval = { toolCallId: call.id, approvalId: approval.id, stepId: step.id, summary: step.node }
            continue
          }

          const result = await binding.client.executeTool(binding.serverUrl, binding.toolName, call.input)
          await prisma.workflowStep.update({
            where: { id: step.id },
            data: { status: 'succeeded', output: jsonValue(result), completedAt: new Date() },
          })
          await recordEvent(execution.id, step.id, 'tool.completed', { name: step.node })
          // Immutable audit trail. Delivery/write planes (nango, slack, email,
          // salesforce, people.ai) are the consequential ones; the args are
          // hashed, not stored.
          const writePlanes = /^(nango|slack|email|den)/i
          await recordAudit({
            organizationId,
            executionId: execution.id,
            actorUserId: userId,
            actorKind: 'agent',
            action: writePlanes.test(binding.provider) ? 'tool.write' : 'tool.call',
            tool: call.name,
            resourceType: binding.provider,
            payload: call.input,
          })
          results.push({ toolCallId: call.id, content: JSON.stringify(result) })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await prisma.workflowStep.update({
            where: { id: step.id },
            data: { status: 'failed', error: jsonValue({ message }), completedAt: new Date() },
          })
          await recordEvent(execution.id, step.id, 'tool.failed', { name: step.node, error: message })
          results.push({ toolCallId: call.id, content: JSON.stringify({ error: message }), isError: true })
        }
      }

      if (pendingAsk) {
        const step = await prisma.workflowStep.create({
          data: {
            executionId: execution.id,
            node: 'ask_user',
            status: 'waiting',
            input: jsonValue({ question: pendingAsk.question }),
            startedAt: new Date(),
          },
        })
        await recordEvent(execution.id, step.id, 'agent.question', { question: pendingAsk.question })
        await prisma.executionMessage.create({
          data: { executionId: execution.id, role: 'agent', content: pendingAsk.question },
        })
        await prisma.agentExecution.update({
          where: { id: execution.id },
          data: {
            status: 'waiting_for_input',
            transcript: jsonValue(transcript),
            inputTokens: { increment: usage.inputTokens },
            outputTokens: { increment: usage.outputTokens },
            executionTime: { increment: Date.now() - segmentStart },
            metadata: jsonValue({
              ...executionMetadata,
              // Resume continues at the next turn (the reply completes this one).
              turnCursor: turn + 1,
              pendingQuestion: {
                toolCallId: pendingAsk.toolCallId,
                question: pendingAsk.question,
                stepId: step.id,
                collectedResults: results,
              } satisfies PendingQuestion,
            }),
          },
        })
        await notify({
          organizationId,
          userId,
          type: 'agent.needs_input',
          level: 'action',
          title: `${agentMetadata.title || agent.description} needs your input`,
          body: pendingAsk.question,
          agentTaskId: agent.id,
          executionId: execution.id,
        })
        return { status: 'waiting_for_input', question: pendingAsk.question, executionId: execution.id }
      }

      // Suspend for approval: persist state (reusing the pendingQuestion marker,
      // so the existing resume path injects the approver's result) and return.
      // decideApproval runs the write and resumes this run with the result.
      if (pendingApproval) {
        await prisma.agentExecution.update({
          where: { id: execution.id },
          data: {
            status: 'waiting_for_approval',
            transcript: jsonValue(transcript),
            inputTokens: { increment: usage.inputTokens },
            outputTokens: { increment: usage.outputTokens },
            executionTime: { increment: Date.now() - segmentStart },
            metadata: jsonValue({
              ...executionMetadata,
              turnCursor: turn + 1,
              pendingQuestion: {
                toolCallId: pendingApproval.toolCallId,
                question: `Awaiting approval: ${pendingApproval.summary}`,
                stepId: pendingApproval.stepId,
                collectedResults: results,
              } satisfies PendingQuestion,
            }),
          },
        })
        await notify({
          organizationId,
          userId,
          type: 'agent.needs_approval',
          level: 'action',
          title: `${agentMetadata.title || agent.description} needs approval`,
          body: `Approve or reject: ${pendingApproval.summary}`,
          agentTaskId: agent.id,
          executionId: execution.id,
        })
        return { status: 'waiting_for_approval', approvalId: pendingApproval.approvalId, executionId: execution.id }
      }

      runner.appendToolResults(transcript, results)

      // Durable checkpoint at a clean turn boundary (results appended → the
      // stored transcript is a valid, resumable conversation). A crash/retry
      // after this resumes from turn+1 instead of losing prior turns.
      await prisma.agentExecution.update({
        where: { id: execution.id },
        data: {
          transcript: jsonValue(transcript),
          metadata: jsonValue({ ...executionMetadata, turnCursor: turn + 1 }),
        },
      })
    }

    const summary = finalText || 'Agent reached the maximum number of tool-call turns.'
    const output = { summary }
    const headline = await generateHeadline(summary)

    await prisma.executionMessage.create({
      data: { executionId: execution.id, role: 'agent', content: summary },
    })
    await prisma.$transaction([
      prisma.agentExecution.update({
        where: { id: execution.id },
        data: {
          status: 'completed',
          output,
          transcript: jsonValue(transcript),
          inputTokens: { increment: usage.inputTokens },
          outputTokens: { increment: usage.outputTokens },
          executionTime: { increment: Date.now() - segmentStart },
          completedAt: new Date(),
          metadata: jsonValue({ ...executionMetadata, pendingQuestion: null, ...(headline ? { headline } : {}) }),
        },
      }),
      prisma.agentTask.update({
        where: { id: agent.id },
        data: {
          lastExecutedAt: new Date(),
          executionCount: { increment: 1 },
          lastResult: output,
        },
      }),
    ])
    await notify({
      organizationId,
      userId,
      type: 'agent.completed',
      level: 'success',
      title: `${agentMetadata.title || agent.description} completed`,
      body: headline || summary,
      agentTaskId: agent.id,
      executionId: execution.id,
    })
    // Index this run (output + correlated entities) into the graph-RAG store so
    // future agents/assistant answers can draw on what happened here. Fire and
    // forget — gated on embeddings, never blocks completion.
    void indexExecution({
      id: execution.id,
      organizationId,
      agentTaskId: agent.id,
      agentTitle: (agentMetadata.title as string) || agent.description,
      signalId: (queuedExecution?.input as { signal?: { id?: string } } | null)?.signal?.id ?? null,
      input: queuedExecution?.input ?? { prompt: data.input },
      output,
      status: 'completed',
      // Runs inherit the agent's scope: a private agent's runs stay private to
      // its owner, matching executionVisibilityScope for row-level access.
      ownerUserId: agent.userId ?? null,
      visibility: agent.visibility === 'private' ? 'private' : 'shared',
    }).catch(() => undefined)
    return { ...output, executionId: execution.id }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await prisma.agentExecution.update({
      where: { id: execution.id },
      data: {
        status: 'failed',
        // M5 — cap persisted error strings so they can't bloat the row.
        error: message.slice(0, 300),
        transcript: jsonValue(transcript),
        inputTokens: { increment: usage.inputTokens },
        outputTokens: { increment: usage.outputTokens },
        executionTime: { increment: Date.now() - segmentStart },
        completedAt: new Date(),
      },
    })
    await notify({
      organizationId,
      userId,
      type: 'agent.error',
      level: 'error',
      title: `${agentMetadata.title || agent.description} hit an error`,
      body: message,
      agentTaskId: agent.id,
      executionId: execution.id,
    })
    throw error
  }
}

export async function executeAgentJob(job: Job<AgentExecutionJob>) {
  return runAgentExecution(job.data)
}
