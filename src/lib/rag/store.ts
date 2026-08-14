/**
 * Graph-RAG store abstraction.
 *
 * The platform's data is a graph: signals reference accounts/opportunities/
 * stakeholders; agents produce runs; and runs reference signals. This
 * interface stores those as embedded nodes +
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
  | 'actor'
  | 'activity'
  | 'entity'
  | 'tool'
  | 'capability'

/** Who may see a node. 'shared' = the whole org; 'private' = only its owner. */
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
 * The single visibility contract, shared by every store implementation so
 * MemoryGraphStore and Neo4jGraphStore scope identically. A node is visible to
 * `viewerUserId` unless it is private and owned by someone else. Mirrors the
 * Prisma `agentReadScope`/`executionVisibilityScope` row-level rules.
 */
export function nodeVisibleTo(
  node: Pick<GraphNode, 'ownerUserId' | 'visibility'>,
  viewerUserId: string | null,
): boolean {
  if ((node.visibility ?? 'shared') !== 'private') return true
  return node.ownerUserId != null && node.ownerUserId === viewerUserId
}

/**
 * The storage key for a node: its tenant plus its logical id.
 *
 * Node ids are NOT all database UUIDs. src/lib/rag/indexer.ts mints
 * `tool:slack`, `capability:slack:post_message`, `actor:slack:U0123` and
 * `entity:salesforce:Account:001xx` — strings that are byte-identical across
 * every workspace that connects the same provider or sees the same external
 * record. Storing by id alone therefore made one workspace's indexing overwrite
 * another's node: whoever wrote last owned it, and the other org's copy simply
 * disappeared from their search results.
 *
 * Both store implementations key on this, and both use THIS function, so
 * MemoryGraphStore and Neo4jGraphStore cannot drift apart on the one property
 * that keeps tenants separate — the same reason nodeVisibleTo above is shared.
 *
 * `organizationId` is a UUID (Prisma `@db.Uuid`), so it contains no `::` and
 * the encoding is unambiguous.
 */
export function tenantNodeKey(organizationId: string, id: string): string {
  return `${organizationId}::${id}`
}

export type EdgeRelation =
  | 'about_account'
  | 'about_opportunity'
  | 'about_stakeholder'
  | 'triggered_run'
  | 'ran_agent'
  | 'belongs_to' // opportunity/stakeholder → account
  | 'performed' // actor → activity
  | 'on' // activity → entity
  | 'relates_to' // activity → account/opportunity
  | 'participant' // activity → actor
  | 'preceded_by' // activity → prior activity on same entity (state chains)
  | 'evidence' // insight(inferred_pattern) → activity
  | 'based_on' // insight(recommendation) → insight(inferred_pattern)
  | 'provides' // tool → capability (the tool catalog, materialized)
  | 'used' // activity → tool (this user action touched this tool)
  | 'used_with' // insight(tool_correlation) → tool (tools a correlation binds)

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
