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

export const flowCollaborationPatchSchema = z.object({
  mutationId: z.string().min(1).max(100),
  nodes: z.array(nodeChangeSchema).max(500),
  edges: z.array(edgeChangeSchema).max(1000),
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

/** Build an id-addressed patch so unrelated concurrent edits are preserved. */
export function diffFlowGraphs(
  before: FlowGraph,
  after: FlowGraph,
  mutationId: string,
): FlowCollaborationPatch {
  return {
    mutationId,
    nodes: changesById<FlowNode>(before.nodes, after.nodes),
    edges: changesById<FlowEdge>(before.edges, after.edges),
  }
}

export function patchIsEmpty(patch: FlowCollaborationPatch): boolean {
  return patch.nodes.length === 0 && patch.edges.length === 0
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

export function applyFlowCollaborationPatch(
  graph: FlowGraph,
  input: FlowCollaborationPatch,
): { graph: FlowGraph; conflicts: string[] } {
  const patch = flowCollaborationPatchSchema.parse(input)
  const conflicts: string[] = []
  const next = {
    nodes: applyChanges(graph.nodes, patch.nodes, 'node', conflicts),
    edges: applyChanges(graph.edges, patch.edges, 'edge', conflicts),
  }
  return { graph: flowGraphSchema.parse(next), conflicts }
}
