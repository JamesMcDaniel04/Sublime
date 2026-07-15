/**
 * Graph ordering helpers shared by the LINEAR export targets.
 *
 * n8n is a real DAG so it needs none of this. Workato recipes and Power Automate
 * flows are trees/sequences, so a DAG has to be flattened into a run order — and
 * the merges that flattening loses have to be reported, not silently dropped.
 */
import type { FlowEdge, FlowNode } from '@/lib/flows/graph'

/** target id → the ids feeding it. */
export function parentsOf(edges: FlowEdge[]): Map<string, string[]> {
  const parents = new Map<string, string[]>()
  for (const edge of edges) {
    const list = parents.get(edge.target)
    if (list) list.push(edge.source)
    else parents.set(edge.target, [edge.source])
  }
  return parents
}

/**
 * Kahn topological sort: a valid execution order where every step appears after
 * the steps that feed it. Nodes in a cycle (or otherwise unresolvable) are
 * appended at the end rather than dropped — an export must never silently lose a
 * step, even from a graph the engine would reject.
 */
export function topoOrder(nodes: FlowNode[], edges: FlowEdge[]): FlowNode[] {
  const parents = parentsOf(edges)
  const remaining = new Map(nodes.map((node) => [node.id, (parents.get(node.id) ?? []).filter((id) => nodes.some((n) => n.id === id)).length]))
  const children = new Map<string, string[]>()
  for (const edge of edges) {
    const list = children.get(edge.source)
    if (list) list.push(edge.target)
    else children.set(edge.source, [edge.target])
  }

  const byId = new Map(nodes.map((node) => [node.id, node]))
  // Seed in the graph's own node order so a straight chain keeps its authored
  // sequence rather than an arbitrary one.
  const ready = nodes.filter((node) => (remaining.get(node.id) ?? 0) === 0).map((node) => node.id)
  const ordered: FlowNode[] = []
  const seen = new Set<string>()

  while (ready.length) {
    const id = ready.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const node = byId.get(id)
    if (node) ordered.push(node)
    for (const child of children.get(id) ?? []) {
      const left = (remaining.get(child) ?? 0) - 1
      remaining.set(child, left)
      if (left <= 0 && !seen.has(child)) ready.push(child)
    }
  }
  // Anything left is in a cycle — keep it, flagged by its absence from the sort.
  for (const node of nodes) if (!seen.has(node.id)) ordered.push(node)
  return ordered
}
