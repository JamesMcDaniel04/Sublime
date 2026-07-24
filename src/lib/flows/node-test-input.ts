/**
 * Single-node test support: pure graph walks deciding what a "Test step" run
 * feeds the selected node, what stands in its way, and what a "Run from here"
 * would fire. Pure and synchronous — the interesting behaviour is traversal
 * and precedence, not I/O — so every edge lives in a unit test.
 */
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'
import { nodeLabel } from '@/lib/flows/validate'

export type NodeRisk = 'read' | 'write' | 'destructive'
export type NodeRef = { id: string; label: string; risk: NodeRisk }
export type NodeTestInput = {
  mockOutputs: Record<string, unknown>
  missing: NodeRef[]
  riskyMissing: NodeRef[]
}

/**
 * How dangerous is it to run this node unattended?
 *
 * Errs toward `write` when unsure: a false `write` costs one extra
 * confirmation, a false `read` silently fires a real side effect. Tool nodes
 * carry their catalog classification on `data.risk` (older graphs may not —
 * those default to write). Agents can call write tools and subflows can
 * contain anything, so both count as writes. Everything else is an in-memory
 * step.
 */
export function riskForNode(node: FlowNode): NodeRisk {
  if (node.type === 'tool') return node.data.risk ?? 'write'
  if (node.type === 'http') return node.data.method === 'GET' || node.data.method === 'HEAD' ? 'read' : 'write'
  if (node.type === 'agent' || node.type === 'subflow') return 'write'
  return 'read'
}

/** parent-lists keyed by child id, from the graph's edges. */
function parentsByChild(graph: FlowGraph): Map<string, string[]> {
  const parents = new Map<string, string[]>()
  for (const edge of graph.edges ?? []) {
    const list = parents.get(edge.target)
    if (list) list.push(edge.source)
    else parents.set(edge.target, [edge.source])
  }
  return parents
}

/**
 * Decide what a single-node test should feed the selected node.
 *
 * Resolution order per transitive ancestor: pinned output › last run's output
 * › report as missing. `riskyMissing` is the subset of `missing` that performs
 * an external write, so the caller can name those actions before offering to
 * run them — running a write action to satisfy a config check is a real side
 * effect and must be an explicit, informed choice.
 *
 * The trigger is never missing: a manual test supplies its input directly.
 */
export function resolveNodeTestInput({
  nodeId,
  graph,
  pins,
  lastOutputs,
  riskOf,
  labelOf,
}: {
  nodeId: string
  graph: FlowGraph
  pins: Record<string, unknown>
  lastOutputs: Record<string, unknown>
  riskOf?: (nodeId: string) => NodeRisk
  labelOf?: (nodeId: string) => string
}): NodeTestInput {
  const parents = parentsByChild(graph)
  const byId = new Map((graph.nodes ?? []).map((node) => [node.id, node]))

  // Every transitive ancestor, deduped — a diamond's shared root is one entry.
  const ancestors = new Set<string>()
  const stack = [...(parents.get(nodeId) ?? [])]
  while (stack.length) {
    const id = stack.pop()!
    if (ancestors.has(id)) continue
    ancestors.add(id)
    for (const parent of parents.get(id) ?? []) stack.push(parent)
  }

  const mockOutputs: Record<string, unknown> = {}
  const missing: NodeRef[] = []
  for (const id of ancestors) {
    const node = byId.get(id)
    if (node?.type === 'trigger') continue
    if (id in pins) mockOutputs[id] = pins[id]
    else if (id in lastOutputs) mockOutputs[id] = lastOutputs[id]
    else {
      missing.push({
        id,
        label: labelOf?.(id) ?? nodeLabel(node) ?? id,
        risk: riskOf?.(id) ?? (node ? riskForNode(node) : 'write'),
      })
    }
  }
  return { mockOutputs, missing, riskyMissing: missing.filter((ref) => ref.risk !== 'read') }
}

/**
 * Transitive descendants of `nodeId` that perform an external write — what a
 * "Run from here" (startNodeId) would fire beyond the selected node. The
 * mirror image of resolveNodeTestInput's ancestor walk.
 */
export function downstreamWriteActions({ nodeId, graph }: { nodeId: string; graph: FlowGraph }): NodeRef[] {
  const children = new Map<string, string[]>()
  for (const edge of graph.edges ?? []) {
    const list = children.get(edge.source)
    if (list) list.push(edge.target)
    else children.set(edge.source, [edge.target])
  }
  const byId = new Map((graph.nodes ?? []).map((node) => [node.id, node]))
  const seen = new Set<string>()
  const stack = [...(children.get(nodeId) ?? [])]
  const writes: NodeRef[] = []
  while (stack.length) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const node = byId.get(id)
    if (node) {
      const risk = riskForNode(node)
      if (risk !== 'read') writes.push({ id, label: nodeLabel(node) ?? id, risk })
    }
    for (const child of children.get(id) ?? []) stack.push(child)
  }
  return writes
}

/**
 * Order `refs` so every node follows its own ancestors — the order to
 * materialise missing test data in, each /test-node call feeding the next.
 * Kahn's algorithm over the subgraph induced by `refs`; edges to nodes outside
 * the set are ignored, because those are already satisfied by the caller's
 * accumulated outputs.
 */
export function topoSortByGraph(refs: NodeRef[], graph: FlowGraph): NodeRef[] {
  const inSet = new Map(refs.map((ref) => [ref.id, ref]))
  const remaining = new Map<string, Set<string>>()
  for (const ref of refs) remaining.set(ref.id, new Set())
  for (const edge of graph.edges ?? []) {
    if (inSet.has(edge.source) && inSet.has(edge.target)) remaining.get(edge.target)!.add(edge.source)
  }
  const ordered: NodeRef[] = []
  const done = new Set<string>()
  const ready = refs.filter((ref) => remaining.get(ref.id)!.size === 0)
  const queued = new Set(ready.map((ref) => ref.id))
  while (ready.length) {
    const ref = ready.shift()!
    ordered.push(ref)
    done.add(ref.id)
    for (const [id, deps] of remaining) {
      if (!deps.delete(ref.id) || deps.size > 0 || queued.has(id) || done.has(id)) continue
      queued.add(id)
      ready.push(inSet.get(id)!)
    }
  }
  // A cycle would strand nodes; append them so the caller still tries rather
  // than silently dropping work. graph validation already rejects cyclic
  // graphs, so this is a belt-and-braces path, not an expected one.
  for (const ref of refs) if (!done.has(ref.id)) ordered.push(ref)
  return ordered
}
