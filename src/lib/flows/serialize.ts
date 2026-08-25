import type { FlowGraph } from '@/lib/flows/graph'
import { flowSettings } from '@/lib/flows/settings'

/**
 * Wire shape for a flow, shared by the list page and the builder.
 *
 * `precomputed` lets the LIST endpoint skip loading `publishedGraph`
 * entirely: the published/changed flags are computed in Postgres
 * (`IS DISTINCT FROM`) instead of shipping every flow's full published graph
 * over the pooler and JSON.stringify-comparing it per row on the request
 * path (200 flows = 400 full-graph serializations of lambda CPU, per poll).
 */
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
  createdAt: Date
  updatedAt: Date
}, precomputed?: { published: boolean; unpublishedChanges: boolean }) {
  const graph = (flow.graph && typeof flow.graph === 'object' ? flow.graph : { nodes: [], edges: [] }) as FlowGraph
  // Every executable node counts as a step — counting only agents made a
  // tool/http/condition-built flow read "0 steps" on the list card.
  const stepCount = (graph.nodes || []).filter((node) => node.type !== 'trigger').length
  const published = precomputed ? precomputed.published : flow.publishedGraph != null
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
    errorFlowId: typeof metadata.errorFlowId === 'string' ? metadata.errorFlowId : null,
    // Through the typed reader, so the builder shows the zone the RUN will
    // actually use — an invalid stored value reads back as UTC here too.
    timezone: flowSettings(metadata).timezone,
    callerPolicy: flowSettings(metadata).callerPolicy,
    // Imported-credential bulk bind (persisted at import time): the builder
    // surfaces groups whose member steps still lack a credential.
    importedCredentialGroups: Array.isArray(metadata.importedCredentialGroups) ? metadata.importedCredentialGroups : [],
    stepCount,
    version: flow.version ?? 1,
    published,
    // True when the draft differs from what's published (or nothing is published).
    unpublishedChanges: precomputed
      ? !published || precomputed.unpublishedChanges
      : !published || JSON.stringify(flow.publishedGraph) !== JSON.stringify(graph),
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
  }
}
