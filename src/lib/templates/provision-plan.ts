import type { FlowGraph } from '@/lib/flows/graph'

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
