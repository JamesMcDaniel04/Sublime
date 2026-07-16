/**
 * Peer-safe undo for Flow Jam (Figma's model): undo/redo are PATCHES of your
 * own operations, applied strictly — each sub-change lands only where the
 * graph still matches what your operation produced. A teammate's later edit
 * to the same node/field makes that sub-change a silent skip, never a revert
 * of their work. Whole-graph snapshot undo (the old model) is exactly how a
 * ⌘Z resurrected steps a peer had deleted.
 */
import {
  flowNodeSchema,
  flowGraphSchema,
  type FlowGraph,
  type FlowNode,
} from './graph'
import type { FlowCollaborationPatch } from './collaboration'

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

/** The reverse operation: swap before/after on every sub-change. */
export function invertPatch(patch: FlowCollaborationPatch, mutationId: string): FlowCollaborationPatch {
  return {
    mutationId,
    nodes: patch.nodes.map((change) => ({ id: change.id, before: change.after, after: change.before })),
    edges: patch.edges.map((change) => ({ id: change.id, before: change.after, after: change.before })),
    layout: patch.layout.map((change) => ({ id: change.id, before: change.after, after: change.before })),
    nodeFields: patch.nodeFields.map((change) => ({
      ...change,
      fields: change.fields.map((field) => ({ key: field.key, before: field.after, after: field.before })),
    })),
  }
}

/**
 * Apply a patch STRICTLY: each sub-change lands only if the current state
 * still equals its `before`; anything else is skipped and reported. Used for
 * undo (apply the inverse) and redo (re-apply the forward patch).
 *
 * Unlike `applyFlowCollaborationPatch` (incoming-wins, for merging peer
 * edits), this never overwrites state it doesn't recognize.
 */
export function applyPatchStrict(
  graph: FlowGraph,
  patch: FlowCollaborationPatch,
): { graph: FlowGraph; skipped: string[] } {
  const skipped: string[] = []

  // Whole-node add/remove/replace.
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const order = graph.nodes.map((node) => node.id)
  for (const change of patch.nodes) {
    const current = byId.get(change.id) ?? null
    if (!same(current, change.before)) {
      skipped.push(`node:${change.id}`)
      continue
    }
    if (change.after === null) {
      byId.delete(change.id)
    } else {
      if (!byId.has(change.id)) order.push(change.id)
      byId.set(change.id, change.after)
    }
  }

  // Field-level edits. An inverted "field was added" change carries
  // after === undefined, which means: remove the key again.
  for (const change of patch.nodeFields) {
    const current = byId.get(change.id)
    if (!current || current.type !== change.type) {
      skipped.push(`node:${change.id}`)
      continue
    }
    const data = { ...(current.data as Record<string, unknown>) }
    for (const field of change.fields) {
      if (!same(data[field.key], field.before)) {
        skipped.push(`node:${change.id}.${field.key}`)
        continue
      }
      if (field.after === undefined) delete data[field.key]
      else data[field.key] = field.after
    }
    const parsed = flowNodeSchema.safeParse({ ...current, data })
    if (!parsed.success) {
      skipped.push(`node:${change.id}`)
      continue
    }
    byId.set(change.id, parsed.data)
  }

  const nodes: FlowNode[] = order.flatMap((id) => {
    const node = byId.get(id)
    return node ? [node] : []
  })
  const nodeIds = new Set(nodes.map((node) => node.id))

  // Edges: strict by value, then referential cleanup — undoing a node add must
  // not leave a peer-added wire dangling into the void.
  const edgesById = new Map(graph.edges.map((edge) => [edge.id, edge]))
  const edgeOrder = graph.edges.map((edge) => edge.id)
  for (const change of patch.edges) {
    const current = edgesById.get(change.id) ?? null
    if (!same(current, change.before)) {
      skipped.push(`edge:${change.id}`)
      continue
    }
    if (change.after === null) {
      edgesById.delete(change.id)
    } else {
      if (!edgesById.has(change.id)) edgeOrder.push(change.id)
      edgesById.set(change.id, change.after)
    }
  }
  const edges = edgeOrder.flatMap((id) => {
    const edge = edgesById.get(id)
    return edge && nodeIds.has(edge.source) && nodeIds.has(edge.target) ? [edge] : []
  })

  // Layout: strict per node id.
  const layout = { ...(graph.layout ?? {}) }
  for (const change of patch.layout) {
    if (!same(layout[change.id] ?? null, change.before)) {
      skipped.push(`layout:${change.id}`)
      continue
    }
    if (change.after === null) delete layout[change.id]
    else layout[change.id] = change.after
  }
  for (const id of Object.keys(layout)) {
    if (!nodeIds.has(id)) delete layout[id]
  }

  const next = {
    nodes,
    edges,
    ...(Object.keys(layout).length > 0 ? { layout } : {}),
  }
  return { graph: flowGraphSchema.parse(next), skipped }
}
