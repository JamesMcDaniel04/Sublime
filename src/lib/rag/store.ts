/**
 * Graph-RAG store abstraction.
 *
 * The platform's data is a graph: signals reference accounts/opportunities/
 * stakeholders; agents produce runs; runs reference signals; People.ai account
 * facts hang off accounts. This interface stores those as embedded nodes +
 * typed edges and supports the two graph-RAG operations: vector `search`
 * (find semantically relevant nodes) and `expand` (walk edges to gather the
 * connected neighborhood). Every operation is organization-scoped.
 *
 * Implementations: `MemoryGraphStore` (tests, local dev, and a working default
 * when no external store is configured) and `Neo4jGraphStore` (production).
 */

export type NodeType =
  | 'account'
  | 'opportunity'
  | 'stakeholder'
  | 'signal'
  | 'agent'
  | 'run'
  | 'insight'

/** Legacy storage marker. User-facing retrieval is owner-only. */
export type NodeVisibility = 'shared' | 'private'

export interface GraphNode {
  id: string
  organizationId: string
  type: NodeType
  /** Human-readable text that was embedded (title/summary/body). */
  text: string
  /** Structured attributes rendered into context (dates, amounts, status, url). */
  props: Record<string, unknown>
  embedding: number[]
  /**
   * The rep this node belongs to, or null/undefined for org-shared data (the
   * service-key book, webhook signals). Combined with `visibility` to scope
   * retrieval per rep — see `nodeVisibleTo`.
   */
  ownerUserId?: string | null
  /** Defaults to 'shared' when unset (legacy nodes read as shared). */
  visibility?: NodeVisibility
  updatedAt?: string
}

/**
 * The single owner contract shared by every store implementation. A signed-in
 * viewer sees only their nodes. A null/system viewer sees only unowned system
 * nodes. Legacy `shared` markers do not grant cross-user visibility.
 */
export function nodeVisibleTo(
  node: Pick<GraphNode, 'ownerUserId' | 'visibility'>,
  viewerUserId: string | null,
): boolean {
  return (node.ownerUserId ?? null) === viewerUserId
}

export type EdgeRelation =
  | 'about_account'
  | 'about_opportunity'
  | 'about_stakeholder'
  | 'triggered_run'
  | 'ran_agent'
  | 'belongs_to' // opportunity/stakeholder → account

export interface GraphEdge {
  organizationId: string
  from: string
  to: string
  rel: EdgeRelation
}

export interface SearchHit {
  node: GraphNode
  score: number
}

export interface GraphRagStore {
  upsertNodes(nodes: GraphNode[]): Promise<void>
  upsertEdges(edges: GraphEdge[]): Promise<void>
  /**
   * Vector search within an org, scoped to what `viewerUserId` may see (shared
   * nodes + their own private nodes). Pass null to see only shared nodes.
   * Returns top-k by cosine similarity.
   */
  search(organizationId: string, viewerUserId: string | null, queryEmbedding: number[], k: number): Promise<SearchHit[]>
  /**
   * Neighborhood expansion: visible nodes reachable from `nodeIds` within
   * `hops` edges, scoped to what `viewerUserId` may see.
   */
  expand(organizationId: string, viewerUserId: string | null, nodeIds: string[], hops: number): Promise<GraphNode[]>
  /**
   * Delete specific nodes (and their edges) within an org — keeps the graph in
   * step with Postgres deletes so removed data can't re-enter LLM context.
   */
  deleteNodes(organizationId: string, ids: string[]): Promise<void>
  /** Delete all nodes owned by a rep (user teardown / GDPR erasure). */
  deleteByOwner(organizationId: string, ownerUserId: string): Promise<void>
  /** For tests/cleanup and org teardown. */
  clear?(organizationId: string): Promise<void>
}
