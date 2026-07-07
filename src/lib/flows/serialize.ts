import type { FlowGraph } from '@/lib/flows/graph'

/** Wire shape for a flow, shared by the list page and the builder. */
export function serializeFlow(flow: {
  id: string
  name: string
  description: string
  status: string
  trigger: unknown
  graph: unknown
  publishedGraph?: unknown
  version?: number
  visibility: string
  createdAt: Date
  updatedAt: Date
}) {
  const graph = (flow.graph && typeof flow.graph === 'object' ? flow.graph : { nodes: [], edges: [] }) as FlowGraph
  const stepCount = (graph.nodes || []).filter((node) => node.type === 'agent').length
  const published = flow.publishedGraph != null
  return {
    id: flow.id,
    name: flow.name,
    description: flow.description,
    status: flow.status.toLowerCase(),
    trigger: flow.trigger ?? { type: 'manual' },
    graph,
    visibility: flow.visibility,
    stepCount,
    version: flow.version ?? 1,
    published,
    // True when the draft differs from what's published (or nothing is published).
    unpublishedChanges: !published || JSON.stringify(flow.publishedGraph) !== JSON.stringify(graph),
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
  }
}
