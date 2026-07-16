import { z } from 'zod'
import {
  flowEdgeSchema,
  flowGraphSchema,
  flowNodeSchema,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
} from './graph'

const nodeChangeSchema = z.object({
  id: z.string().min(1),
  before: flowNodeSchema.nullable(),
  after: flowNodeSchema.nullable(),
})

const edgeChangeSchema = z.object({
  id: z.string().min(1),
  before: flowEdgeSchema.nullable(),
  after: flowEdgeSchema.nullable(),
})

const layoutPositionSchema = z.object({ x: z.number(), y: z.number() })
const layoutChangeSchema = z.object({
  id: z.string().min(1),
  before: layoutPositionSchema.nullable(),
  after: layoutPositionSchema.nullable(),
})

// One data property of one node: LWW per FIELD, so two peers editing different
// fields of the same step both win. `after` is always a value to SET — key
// removals (rare: node data keys are fixed per type) fall back to a whole-node
// change, which keeps `undefined` out of the wire format (JSON drops it).
const fieldChangeSchema = z.object({
  key: z.string().min(1),
  before: z.unknown(),
  after: z.unknown(),
})
const nodeFieldsChangeSchema = z.object({
  id: z.string().min(1),
  // Type guard: a field patch only applies while the node is still this type.
  type: z.string().min(1),
  fields: z.array(fieldChangeSchema).min(1).max(64),
})

export const flowCollaborationPatchSchema = z.object({
  mutationId: z.string().min(1).max(100),
  nodes: z.array(nodeChangeSchema).max(500),
  edges: z.array(edgeChangeSchema).max(1000),
  // Canvas positions travel with the patch — without this, a drag produced an
  // EMPTY patch, so the next server reconcile reverted it (the "snap back to
  // auto-layout" bug). `.default([])` keeps payloads from older clients valid.
  layout: z.array(layoutChangeSchema).max(500).default([]),
  // Field-level node edits (`.default([])` for the same back-compat reason).
  nodeFields: z.array(nodeFieldsChangeSchema).max(500).default([]),
})

export type FlowCollaborationPatch = z.infer<typeof flowCollaborationPatchSchema>

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

function changesById<T extends { id: string }>(before: T[], after: T[]) {
  const previous = new Map(before.map((value) => [value.id, value]))
  const next = new Map(after.map((value) => [value.id, value]))
  const ids = new Set([...previous.keys(), ...next.keys()])
  return [...ids]
    .filter((id) => !same(previous.get(id), next.get(id)))
    .map((id) => ({ id, before: previous.get(id) ?? null, after: next.get(id) ?? null }))
}

/** Layout is a map keyed by node id; diff it entry-wise like nodes/edges. */
function layoutChangesOf(before: FlowGraph, after: FlowGraph) {
  const previous = before.layout ?? {}
  const next = after.layout ?? {}
  const ids = new Set([...Object.keys(previous), ...Object.keys(next)])
  return [...ids]
    .filter((id) => !same(previous[id], next[id]))
    .map((id) => ({ id, before: previous[id] ?? null, after: next[id] ?? null }))
}

type NodeFieldsChange = z.infer<typeof nodeFieldsChangeSchema>

/**
 * Per-key diff of a node's `data`. Returns null when the edit can't be
 * expressed as field SETs (a key was removed, or a value became undefined) —
 * the caller falls back to a whole-node change for those.
 */
function dataFieldChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): NodeFieldsChange['fields'] | null {
  for (const key of Object.keys(before)) {
    if (before[key] !== undefined && after[key] === undefined) return null
  }
  const changes: NodeFieldsChange['fields'] = []
  for (const key of Object.keys(after)) {
    if (after[key] === undefined) continue
    if (!same(before[key], after[key])) changes.push({ key, before: before[key], after: after[key] })
  }
  return changes.length > 0 ? changes : null
}

/**
 * Node changes, split by expressiveness: an edit that only touches `data`
 * values of a surviving same-type node becomes FIELD changes (so two peers
 * editing different fields of the same step both win); everything else —
 * add, remove, type swap, key removal — stays a whole-node change.
 */
function splitNodeChanges(before: FlowNode[], after: FlowNode[]) {
  const previous = new Map(before.map((node) => [node.id, node]))
  const next = new Map(after.map((node) => [node.id, node]))
  const ids = new Set([...previous.keys(), ...next.keys()])
  const nodes: Array<{ id: string; before: FlowNode | null; after: FlowNode | null }> = []
  const nodeFields: NodeFieldsChange[] = []
  for (const id of ids) {
    const prev = previous.get(id)
    const curr = next.get(id)
    if (same(prev, curr)) continue
    if (prev && curr && prev.type === curr.type) {
      const fields = dataFieldChanges(
        prev.data as Record<string, unknown>,
        curr.data as Record<string, unknown>,
      )
      if (fields) {
        nodeFields.push({ id, type: prev.type, fields })
        continue
      }
    }
    nodes.push({ id, before: prev ?? null, after: curr ?? null })
  }
  return { nodes, nodeFields }
}

/** Build an id-addressed patch so unrelated concurrent edits are preserved. */
export function diffFlowGraphs(
  before: FlowGraph,
  after: FlowGraph,
  mutationId: string,
): FlowCollaborationPatch {
  const { nodes, nodeFields } = splitNodeChanges(before.nodes, after.nodes)
  return {
    mutationId,
    nodes,
    edges: changesById<FlowEdge>(before.edges, after.edges),
    layout: layoutChangesOf(before, after),
    nodeFields,
  }
}

export function patchIsEmpty(patch: FlowCollaborationPatch): boolean {
  return (
    patch.nodes.length === 0 &&
    patch.edges.length === 0 &&
    patch.layout.length === 0 &&
    patch.nodeFields.length === 0
  )
}

export function patchChangesTopology(patch: FlowCollaborationPatch): boolean {
  return (
    patch.edges.length > 0 ||
    patch.nodes.some(
      (change) =>
        change.before === null ||
        change.after === null ||
        change.before.type !== change.after.type,
    )
  )
}

function applyChanges<T extends { id: string }>(
  current: T[],
  changes: Array<{ id: string; before: T | null; after: T | null }>,
  kind: 'node' | 'edge',
  conflicts: string[],
): T[] {
  const byId = new Map(current.map((value) => [value.id, value]))
  const order = current.map((value) => value.id)

  for (const change of changes) {
    const existing = byId.get(change.id) ?? null
    if (!same(existing, change.before) && !same(existing, change.after)) {
      conflicts.push(`${kind}:${change.id}`)
    }
    if (change.after === null) {
      byId.delete(change.id)
      continue
    }
    if (!byId.has(change.id)) order.push(change.id)
    byId.set(change.id, change.after)
  }

  return order.flatMap((id) => {
    const value = byId.get(id)
    return value ? [value] : []
  })
}

/**
 * Field-level LWW application. A field patch only lands on a node that still
 * exists with the same type AND still yields a schema-valid node — otherwise
 * the whole change is rejected as a conflict (deletion/typing wins, and a
 * malformed peer payload can never corrupt the graph).
 */
function applyFieldChanges(
  nodes: FlowNode[],
  changes: NodeFieldsChange[],
  conflicts: string[],
): FlowNode[] {
  if (changes.length === 0) return nodes
  const byId = new Map(nodes.map((node) => [node.id, node]))
  for (const change of changes) {
    const existing = byId.get(change.id)
    if (!existing || existing.type !== change.type) {
      conflicts.push(`node:${change.id}`)
      continue
    }
    const data = { ...(existing.data as Record<string, unknown>) }
    const fieldConflicts: string[] = []
    for (const field of change.fields) {
      const current = data[field.key]
      if (!same(current, field.before) && !same(current, field.after)) {
        fieldConflicts.push(`node:${change.id}.${field.key}`)
      }
      data[field.key] = field.after
    }
    const parsed = flowNodeSchema.safeParse({ ...existing, data })
    if (!parsed.success) {
      conflicts.push(`node:${change.id}`)
      continue
    }
    conflicts.push(...fieldConflicts)
    byId.set(change.id, parsed.data)
  }
  return nodes.map((node) => byId.get(node.id) ?? node)
}

export function applyFlowCollaborationPatch(
  graph: FlowGraph,
  input: FlowCollaborationPatch,
): { graph: FlowGraph; conflicts: string[] } {
  const patch = flowCollaborationPatchSchema.parse(input)
  const conflicts: string[] = []
  const nodes = applyFieldChanges(
    applyChanges(graph.nodes, patch.nodes, 'node', conflicts),
    patch.nodeFields,
    conflicts,
  )

  // Positions merge last-write-wins (no conflict tracking — two people nudging
  // the same widget is not a fight worth surfacing). CRITICALLY, untouched
  // entries carry over: this function used to rebuild the graph WITHOUT the
  // layout key, so any accepted patch erased every stored position.
  const layout = { ...(graph.layout ?? {}) }
  for (const change of patch.layout) {
    if (change.after === null) delete layout[change.id]
    else layout[change.id] = change.after
  }
  // A deleted node's position is dead weight — drop it with the node.
  for (const change of patch.nodes) {
    if (change.after === null) delete layout[change.id]
  }

  const next = {
    nodes,
    edges: applyChanges(graph.edges, patch.edges, 'edge', conflicts),
    ...(Object.keys(layout).length > 0 ? { layout } : {}),
  }
  return { graph: flowGraphSchema.parse(next), conflicts }
}
