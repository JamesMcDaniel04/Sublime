import type { FlowGraph } from '@/lib/flows/graph'
import type { FlowToolCatalogConnection } from '@/lib/flows/tool-catalog'

export const TEMPLATE_CONNECTION_PREFIX = 'template:'

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '')

/** One template-placeholder → real-connection decision, recorded on the
 *  provisioned flow's metadata so the binding is auditable and re-runnable. */
export type ResolvedBinding = { provider: string; connectionId: string; connectionName: string }

/**
 * The catalog connections that can satisfy `provider`, deterministically
 * ordered: Nango first (broadest tool coverage), then stable by id so two
 * provisions of the same template in the same workspace always bind the same
 * connection even when an org has several accounts for one provider.
 */
function candidatesFor(provider: string, catalog: FlowToolCatalogConnection[]): FlowToolCatalogConnection[] {
  const rank = (id: string) => (id.startsWith('nango:') ? 0 : 1)
  return catalog
    .filter((connection) => slug(connection.name) === slug(provider))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))
}

/**
 * Required providers with no satisfying connection in the workspace catalog.
 * Uses the SAME matching as resolveGraphToolConnections, so a pre-flight pass
 * on this list guarantees the later binding pass cannot fail on a missing
 * provider — the 409 happens before any rows are created, never a 500 after.
 */
export function missingRequiredProviders(required: string[], catalog: FlowToolCatalogConnection[]): string[] {
  return required.filter((provider) => candidatesFor(provider, catalog).length === 0)
}

/**
 * Bind catalogue-only tool placeholders to this workspace's real connections.
 * Selection is deterministic (see candidatesFor); `overrides` lets a caller pin
 * a specific connection id per provider slug (multi-account workspaces).
 * Returns the bound graph plus the binding decisions that were made.
 */
export function resolveGraphToolConnections(
  graph: FlowGraph,
  catalog: FlowToolCatalogConnection[],
  overrides: Record<string, string> = {},
): { graph: FlowGraph; bindings: ResolvedBinding[] } {
  const clone: FlowGraph = JSON.parse(JSON.stringify(graph))
  const bindings: ResolvedBinding[] = []
  for (const node of clone.nodes) {
    if (node.type !== 'tool' || !node.data.connectionId.startsWith(TEMPLATE_CONNECTION_PREFIX)) continue
    const provider = node.data.connectionId.slice(TEMPLATE_CONNECTION_PREFIX.length)
    const candidates = candidatesFor(provider, catalog)
    const overrideId = overrides[slug(provider)]
    const connection = (overrideId && candidates.find((c) => c.id === overrideId)) || candidates[0]
    if (!connection) throw new Error(`Connect ${provider} before using this template`)

    const requested = slug(node.data.toolName)
    const tool = connection.tools.find((candidate) => slug(candidate.name) === requested)
      ?? connection.tools.find((candidate) => slug(candidate.name).endsWith(requested) || requested.endsWith(slug(candidate.name)))
    if (!tool) throw new Error(`${connection.name} does not provide the required ${node.data.toolName} action`)
    node.data.connectionId = connection.id
    node.data.toolName = tool.name
    bindings.push({ provider, connectionId: connection.id, connectionName: connection.name })
  }
  return { graph: clone, bindings }
}

/**
 * A flow graph needs true flow mechanics — and so cannot be faithfully
 * collapsed into a single agent — when it has an HTTP node (deterministic
 * mid-flow API/data passing) or more than one tool step (multi-step
 * orchestration). Single-delivery flows still collapse cleanly to an agent.
 */
export function graphNeedsBackingFlow(graph: FlowGraph): boolean {
  let toolNodes = 0
  for (const node of graph.nodes) {
    if (node.type === 'http') return true
    if (node.type === 'tool') toolNodes += 1
  }
  return toolNodes >= 2
}

/**
 * Return a deep copy of `graph` with every agent node's placeholder `agentId`
 * (a TemplateAgentSpec.ref) replaced by the materialized AgentTask id from
 * `refToId`. Throws when a ref has no mapping — a real AgentTask id is
 * mandatory because the flow interpreter executes agent nodes purely by
 * `data.agentId` (inline prompts are not executed; see interpret.ts L321).
 */
export function rewriteGraphAgentRefs(graph: FlowGraph, refToId: Record<string, string>): FlowGraph {
  const clone: FlowGraph = JSON.parse(JSON.stringify(graph))
  for (const node of clone.nodes) {
    if (node.type !== 'agent') continue
    const id = refToId[node.data.agentId]
    if (!id) throw new Error(`unresolved agent ref "${node.data.agentId}" — no materialized agent`)
    node.data.agentId = id
  }
  return clone
}
