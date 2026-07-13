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
  metadata?: unknown
  collaborationRevision?: number
  createdAt: Date
  updatedAt: Date
}) {
  const graph = (flow.graph && typeof flow.graph === 'object' ? flow.graph : { nodes: [], edges: [] }) as FlowGraph
  const stepCount = (graph.nodes || []).filter((node) => node.type === 'agent').length
  const published = flow.publishedGraph != null
  const metadata = flow.metadata && typeof flow.metadata === 'object' && !Array.isArray(flow.metadata) ? (flow.metadata as Record<string, unknown>) : {}
  return {
    id: flow.id,
    name: flow.name,
    description: flow.description,
    status: flow.status.toLowerCase(),
    trigger: flow.trigger ?? { type: 'manual' },
    graph,
    visibility: flow.visibility,
    // Behavioral-intelligence: true for a self-suggested draft flow (see
    // src/lib/intelligence/suggest-workflows.ts) — drives the "Suggested for
    // you" rail on the flows list page.
    suggested: metadata.suggested === true,
    stepCount,
    version: flow.version ?? 1,
    collaborationRevision: flow.collaborationRevision ?? 0,
    published,
    // True when the draft differs from what's published (or nothing is published).
    unpublishedChanges: !published || JSON.stringify(flow.publishedGraph) !== JSON.stringify(graph),
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
  }
}
