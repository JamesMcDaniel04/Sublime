/**
 * Graph-RAG indexing pipeline.
 *
 * Turns platform data into embedded nodes + typed edges so retrieval can
 * correlate across sources:
 *   - Executions (runs + tool outputs)   → run nodes carrying MCP/integration results + edges
 *   - Agents                             → agent nodes
 *
 * Everything is best-effort and GATED on embeddings being configured — when
 * VOYAGE_API_KEY is unset these are no-ops, so callers can fire them
 * unconditionally without breaking the hot path. Indexing failures are
 * swallowed (logged) and never propagate to the triggering request/run.
 */

import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { embedTexts } from './embeddings'
import { getGraphRagStore, graphRagPersistent, ragEnabled } from './get-store'
import type { GraphEdge, GraphNode, NodeType, NodeVisibility } from './store'

// ── Node id scheme (stable, so re-indexing upserts in place) ─────────────────
export const nodeIds = {
  account: (id: string) => `account:${id}`,
  opportunity: (id: string) => `opp:${id}`,
  stakeholder: (id: string) => `stakeholder:${id}`,
  run: (id: string) => `run:${id}`,
  agent: (id: string) => `agent:${id}`,
  activity: (id: string) => `activity:${id}`,
  actor: (source: string, ref: string) => `actor:${source}:${ref}`,
  entity: (source: string, type: string, ref: string) => `entity:${source}:${type}:${ref}`,
  flow: (id: string) => `flow:${id}`,
  userEvent: (id: string) => `uevent:${id}`,
  /** Provider strings are plane-scoped runtime binding ids (tool-planes.ts). */
  tool: (provider: string) => `tool:${provider}`,
  capability: (provider: string, toolName: string) => `capability:${provider}:${toolName}`,
}
const nid = nodeIds

export interface PendingNode {
  id: string
  type: NodeType
  text: string
  props: Record<string, unknown>
  /** Owner for per-rep scoping; omit/null for org-shared data. */
  ownerUserId?: string | null
  /** Defaults to 'shared' when omitted. */
  visibility?: NodeVisibility
}

/** Embed pending nodes in one batch and persist nodes + edges. Reused by backfill. */
export async function commitGraph(organizationId: string, nodes: PendingNode[], edges: GraphEdge[]): Promise<void> {
  return commit(organizationId, nodes, edges)
}

/** Embed pending nodes in one batch and persist nodes + edges. */
async function commit(organizationId: string, nodes: PendingNode[], edges: GraphEdge[]): Promise<void> {
  if (!ragEnabled() || (nodes.length === 0 && edges.length === 0)) return
  const store = getGraphRagStore()
  if (nodes.length) {
    const embeddings = await embedTexts(nodes.map((n) => n.text), { inputType: 'document' })
    const graphNodes: GraphNode[] = nodes.map((n, i) => ({
      id: n.id,
      organizationId,
      type: n.type,
      text: n.text,
      props: n.props,
      embedding: embeddings[i] ?? [],
      ownerUserId: n.ownerUserId ?? null,
      visibility: n.visibility ?? 'shared',
      updatedAt: new Date().toISOString(),
    }))
    await store.upsertNodes(graphNodes)
  }
  if (edges.length) await store.upsertEdges(edges)
}

export interface ExecutionRecord {
  id: string
  organizationId: string
  agentTaskId: string | null
  agentTitle?: string | null
  input: unknown
  output: unknown
  status: string
  toolSummaries?: string[]
  /** Owner of the run node — the run's agent owner, so runs inherit agent scope. */
  ownerUserId?: string | null
  /** Run visibility; inherits the agent's visibility. Defaults to 'shared'. */
  visibility?: NodeVisibility
}

export async function indexExecution(execution: ExecutionRecord): Promise<void> {
  if (!ragEnabled()) return
  try {
    const org = execution.organizationId
    const outputText = outputSummary(execution.output).slice(0, 1500)
    const tools = execution.toolSummaries?.length ? ` Tools: ${execution.toolSummaries.join('; ')}.` : ''
    const nodes: PendingNode[] = [
      {
        id: nid.run(execution.id), type: 'run',
        text: `Agent run (${execution.status}) for "${execution.agentTitle ?? execution.agentTaskId ?? 'agent'}".${tools} Output: ${outputText}`,
        props: { status: execution.status, agentTaskId: execution.agentTaskId },
        ownerUserId: execution.ownerUserId ?? null,
        visibility: execution.visibility ?? 'shared',
      },
    ]
    const edges: GraphEdge[] = []
    if (execution.agentTaskId) {
      edges.push({ organizationId: org, from: nid.run(execution.id), to: nid.agent(execution.agentTaskId), rel: 'ran_agent' })
    }
    await commit(org, nodes, edges)
  } catch (error) {
    warn('indexExecution', error)
  }
}

export interface AgentRecord {
  id: string
  organizationId: string
  title: string
  objective: string | null
  description: string | null
  /** Agent owner; scopes the agent node per rep. */
  ownerUserId?: string | null
  /** 'private' hides the agent (and its runs) from other reps. Defaults to 'shared'. */
  visibility?: NodeVisibility
}

export async function indexAgent(agent: AgentRecord): Promise<void> {
  if (!ragEnabled()) return
  try {
    await commit(
      agent.organizationId,
      [{
        id: nid.agent(agent.id), type: 'agent',
        text: `Agent "${agent.title}". ${agent.description ?? ''} Objective: ${agent.objective ?? ''}`.slice(0, 1200),
        props: { agentId: agent.id, title: agent.title },
        ownerUserId: agent.ownerUserId ?? null,
        visibility: agent.visibility ?? 'shared',
      }],
      [],
    )
  } catch (error) {
    warn('indexAgent', error)
  }
}

/**
 * Index an agent memory (a learned fact, user answer, or suggestion the agent
 * accumulated) as a shared insight node linked to its agent, so retrieval can
 * surface it alongside runs and signals for that agent. Best-effort; gated on
 * embeddings.
 */
export async function indexAgentMemory(params: {
  memoryId: string
  organizationId: string
  agentId: string
  kind: string
  title: string
  content: string
  ownerUserId?: string | null
}): Promise<void> {
  if (!ragEnabled()) return
  try {
    const nodeId = `insight:mem:${params.memoryId}`
    const text = `Agent memory (${params.kind}): ${params.title}. ${params.content}`.slice(0, 1500)
    const nodes: PendingNode[] = [{
      id: nodeId, type: 'insight', text,
      props: { kind: params.kind, agentId: params.agentId },
      ownerUserId: params.ownerUserId ?? null, visibility: 'shared',
    }]
    const edges: GraphEdge[] = [
      { organizationId: params.organizationId, from: nodeId, to: nid.agent(params.agentId), rel: 'belongs_to' },
    ]
    await commitGraph(params.organizationId, nodes, edges)
  } catch (error) {
    warn('indexAgentMemory', error)
  }
}

/**
 * Index a connection scan's distilled usage profile as an org-shared insight
 * node, keyed stably by plane+connection so a rescan full-replaces the prior
 * profile rather than accumulating stale copies. Best-effort; gated on
 * embeddings. Only the distilled profile text is stored — never raw sampled
 * tool output.
 */
export async function indexConnectionScan(params: {
  organizationId: string
  plane: string
  connectionRef: string
  connectionName: string
  profile: { summary: string; entities: string[]; processes: string[]; automationCandidates: string[] }
}): Promise<void> {
  if (!ragEnabled()) return
  try {
    const nodeId = `insight:scan:${params.plane}:${params.connectionRef}`
    const text = [
      `How we use ${params.connectionName}: ${params.profile.summary}`,
      '',
      `Processes: ${params.profile.processes.join('; ')}`,
      `Entities: ${params.profile.entities.join('; ')}`,
    ].join('\n').slice(0, 4000)
    const nodes: PendingNode[] = [{
      id: nodeId, type: 'insight', text,
      props: { plane: params.plane, connectionRef: params.connectionRef },
      visibility: 'shared',
    }]
    await commitGraph(params.organizationId, nodes, [])
  } catch (error) {
    warn('indexConnectionScan', error)
  }
}

/**
 * Materialize the tool catalog as org-shared tool + capability nodes with
 * `provides` edges, so correlation insights and later phases (cross-user,
 * archetypes) can traverse tool topology. Keyed stably by provider/toolName —
 * refreshes upsert in place. Best-effort; gated on embeddings.
 */
export async function indexToolCatalog(
  organizationId: string,
  groups: Array<{ provider: string; name: string; tools: Array<{ name: string; description?: string; risk?: string }> }>,
): Promise<void> {
  if (!ragEnabled()) return
  try {
    const nodes: PendingNode[] = []
    const edges: GraphEdge[] = []
    for (const group of groups) {
      const toolNodeId = nid.tool(group.provider)
      nodes.push({
        id: toolNodeId, type: 'tool',
        text: `Connected tool ${group.name} (${group.provider}) with ${group.tools.length} capabilities.`,
        props: { provider: group.provider, name: group.name, capabilityCount: group.tools.length },
        visibility: 'shared',
      })
      for (const tool of group.tools) {
        const capabilityId = nid.capability(group.provider, tool.name)
        nodes.push({
          id: capabilityId, type: 'capability',
          text: `${group.name} capability ${tool.name}: ${tool.description ?? ''}`.slice(0, 800),
          props: { provider: group.provider, toolName: tool.name, risk: tool.risk ?? 'read' },
          visibility: 'shared',
        })
        edges.push({ organizationId, from: toolNodeId, to: capabilityId, rel: 'provides' })
      }
    }
    await commit(organizationId, nodes, edges)
  } catch (error) {
    warn('indexToolCatalog', error)
  }
}

/**
 * Remove an agent and its run nodes from the graph when the agent is deleted,
 * so its (possibly stale) content can't resurface in retrieval or LLM context.
 * Best-effort; only meaningful for the persistent (Neo4j) store.
 */
export async function removeAgentFromGraph(organizationId: string, agentId: string): Promise<void> {
  if (!graphRagPersistent()) return
  try {
    const execs = await prisma.agentExecution.findMany({
      where: { organizationId, agentTaskId: agentId }, select: { id: true },
    })
    const ids = [nid.agent(agentId), ...execs.map((e) => nid.run(e.id))]
    await getGraphRagStore().deleteNodes(organizationId, ids)
  } catch (error) {
    warn('removeAgentFromGraph', error)
  }
}

/** Remove a single run node when its execution is deleted. Best-effort. */
export async function removeExecutionFromGraph(organizationId: string, executionId: string): Promise<void> {
  if (!graphRagPersistent()) return
  try {
    await getGraphRagStore().deleteNodes(organizationId, [nid.run(executionId)])
  } catch (error) {
    warn('removeExecutionFromGraph', error)
  }
}

/**
 * Remove a connection's scan insight node from the graph when the
 * connection is disconnected (Task 4.5 purge-on-disconnect), so its
 * (possibly stale) usage profile can't resurface in retrieval or LLM
 * context. Id must match indexConnectionScan's scheme exactly
 * (`insight:scan:<plane>:<connectionRef>`). Best-effort; only meaningful for
 * the persistent (Neo4j) store.
 */
export async function removeConnectionScanFromGraph(params: {
  organizationId: string
  plane: string
  connectionRef: string
}): Promise<void> {
  if (!graphRagPersistent()) return
  try {
    await getGraphRagStore().deleteNodes(params.organizationId, [`insight:scan:${params.plane}:${params.connectionRef}`])
  } catch (error) {
    warn('removeConnectionScanFromGraph', error)
  }
}

/**
 * Bulk graph cleanup for the retention job: delete the run: nodes for
 * rows Postgres is about to (or just did) prune, grouped per org because the
 * store API scopes deletes by organizationId. Best-effort — retention must
 * never fail on graph cleanup; a missed node is re-swept the next day only if
 * ids are still known, so callers should delete graph-first or tolerate loss.
 */
export async function removeRetiredFromGraph(
  groups: Array<{ organizationId: string; executionIds: string[] }>,
): Promise<void> {
  if (!graphRagPersistent()) return
  const store = getGraphRagStore()
  for (const group of groups) {
    const ids = group.executionIds.map((id) => nid.run(id))
    if (ids.length === 0) continue
    try {
      await store.deleteNodes(group.organizationId, ids)
    } catch (error) {
      warn('removeRetiredFromGraph', error)
    }
  }
}

function safeJson(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value ?? {})
  } catch {
    return ''
  }
}

/**
 * Human-readable text for a run's output. Agent outputs are typically
 * `{ summary, response, ... }` blobs — retrieval facts built from raw
 * JSON.stringify read as escaped noise in the correlated-context UI, so prefer
 * the summary/response string and only fall back to JSON for unknown shapes.
 * (Mirrors resultText() in the dashboard's activity pane.)
 */
function outputSummary(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const blob = value as { summary?: unknown; response?: unknown }
    if (typeof blob.summary === 'string' && blob.summary.trim()) return blob.summary
    if (typeof blob.response === 'string' && blob.response.trim()) return blob.response
  }
  return safeJson(value)
}

function warn(scope: string, error: unknown): void {
  apiLogger.warn(`rag.${scope} failed`, { error: error instanceof Error ? error.message : String(error) })
}
