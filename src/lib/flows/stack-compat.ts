/**
 * Can this graph render in the classic STACK view? The stack walks one chain
 * (following each node's single plain outgoing edge, plus condition/switch
 * branch chains) — it cannot express fan-out (two plain wires from one node)
 * or fan-in (two parents converging). The page uses this to lock non-linear
 * graphs to the free-form canvas instead of silently hiding wires.
 */
import type { FlowGraph } from './graph'
import { containedNodeIds } from './auto-layout'

export function stackCompatible(graph: FlowGraph): boolean {
  const contained = containedNodeIds(graph)
  const incoming = new Map<string, number>()
  const plainOutgoing = new Map<string, number>()
  for (const edge of graph.edges) {
    if (contained.has(edge.source) || contained.has(edge.target)) continue
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1)
    if (!edge.branch) plainOutgoing.set(edge.source, (plainOutgoing.get(edge.source) ?? 0) + 1)
  }
  for (const count of incoming.values()) if (count > 1) return false
  for (const count of plainOutgoing.values()) if (count > 1) return false
  return true
}
