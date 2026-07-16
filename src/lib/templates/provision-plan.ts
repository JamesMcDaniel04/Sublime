import type { FlowGraph } from '@/lib/flows/graph'
import type { FlowToolCatalogConnection } from '@/lib/flows/tool-catalog'

export const TEMPLATE_CONNECTION_PREFIX = 'template:'

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '')

/**
 * Bind catalogue-only tool placeholders to this workspace's real connection.
 * Nango is preferred; native/MCP are compatibility fallbacks.
 */
export function resolveGraphToolConnections(graph: FlowGraph, catalog: FlowToolCatalogConnection[]): FlowGraph {
  const clone: FlowGraph = JSON.parse(JSON.stringify(graph))
  for (const node of clone.nodes) {
    if (node.type !== 'tool' || !node.data.connectionId.startsWith(TEMPLATE_CONNECTION_PREFIX)) continue
    const provider = node.data.connectionId.slice(TEMPLATE_CONNECTION_PREFIX.length)
    const matches = catalog.filter((connection) => slug(connection.name) === slug(provider))
    const connection = matches.sort((a, b) => {
      const rank = (id: string) => id.startsWith('nango:') ? 0 : 1
      return rank(a.id) - rank(b.id)
    })[0]
    if (!connection) throw new Error(`Connect ${provider} before using this template`)

    const requested = slug(node.data.toolName)
    const tool = connection.tools.find((candidate) => slug(candidate.name) === requested)
      ?? connection.tools.find((candidate) => slug(candidate.name).endsWith(requested) || requested.endsWith(slug(candidate.name)))
    if (!tool) throw new Error(`${connection.name} does not provide the required ${node.data.toolName} action`)
    node.data.connectionId = connection.id
    node.data.toolName = tool.name
  }
  return clone
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
