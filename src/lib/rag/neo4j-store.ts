/**
 * Neo4j GraphRagStore adapter.
 *
 * Nodes are stored as `(:Entity {key, id, organizationId, type, text, embedding,
 * props, updatedAt})`, uniquely keyed by `key` = tenantNodeKey(org, id) so two
 * workspaces can hold the same logical id; edges as typed relationships. Vector search uses a
 * Neo4j vector index when present, falling back to org-scoped cosine scoring.
 * `expand` is a variable-length undirected traversal.
 *
 * The neo4j-driver import is dynamic so the package is only required when
 * NEO4J_* is configured — the app builds and runs without it.
 */

import { cosineSimilarity, EMBEDDING_DIM } from './embeddings'
import { nodeVisibleTo, tenantNodeKey, type GraphEdge, type GraphNode, type GraphRagStore, type NodeType, type NodeVisibility, type SearchHit } from './store'

const VECTOR_INDEX = 'entity_embedding'

// Bounded driver config, shared by the store and the health ping. The driver
// defaults (30s connect, 60s acquisition, 100-connection pool) meant a slow
// Neo4j hung RAG-touching requests for up to a minute, and every lambda
// instance could theoretically hold 100 connections against a small Aura cap.
const DRIVER_OPTIONS = {
  connectionTimeout: 5_000,
  connectionAcquisitionTimeout: 10_000,
  maxConnectionPoolSize: 10,
}

export function neo4jConfigured(): boolean {
  return Boolean(process.env.NEO4J_URI && process.env.NEO4J_USERNAME && process.env.NEO4J_PASSWORD)
}

let pingDriver: { verifyConnectivity: () => Promise<unknown> } | null = null

/**
 * Health probe: verify Neo4j connectivity. Non-fatal — RAG degrades if down.
 * Reuses one module-level driver (this used to construct AND destroy a whole
 * driver per call on an unauthenticated endpoint — a free amplification
 * vector) and bounds the probe at 3s.
 */
export async function neo4jPing(): Promise<{ configured: boolean; ok: boolean }> {
  if (!neo4jConfigured()) return { configured: false, ok: false }
  try {
    if (!pingDriver) {
      const neo4j = (await import('neo4j-driver')).default
      pingDriver = neo4j.driver(
        process.env.NEO4J_URI!,
        neo4j.auth.basic(process.env.NEO4J_USERNAME!, process.env.NEO4J_PASSWORD!),
        DRIVER_OPTIONS,
      )
    }
    const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('neo4j ping timeout')), 3_000))
    await Promise.race([pingDriver.verifyConnectivity(), deadline])
    return { configured: true, ok: true }
  } catch {
    return { configured: true, ok: false }
  }
}

type Driver = {
  executeQuery: (query: string, params?: Record<string, unknown>) => Promise<{ records: Array<{ get: (k: string) => unknown }> }>
  close: () => Promise<void>
}

export class Neo4jGraphStore implements GraphRagStore {
  private driverPromise: Promise<Driver> | null = null

  private async driver(): Promise<Driver> {
    if (!this.driverPromise) {
      this.driverPromise = (async () => {
        const neo4j = (await import('neo4j-driver')).default
        const driver = neo4j.driver(
          process.env.NEO4J_URI!,
          neo4j.auth.basic(process.env.NEO4J_USERNAME!, process.env.NEO4J_PASSWORD!),
          DRIVER_OPTIONS,
        ) as unknown as Driver
        await this.ensureIndexes(driver)
        return driver
      })()
    }
    return this.driverPromise
  }

  private async ensureIndexes(driver: Driver): Promise<void> {
    // ── Tenant-key migration ────────────────────────────────────────────────
    //
    // `id` used to be the storage key, under a GLOBAL uniqueness constraint.
    // But ids are not all UUIDs — indexer.ts mints `tool:slack`,
    // `capability:slack:post_message` and `actor:slack:U0123`, which are
    // identical across every workspace connecting the same provider. Two orgs
    // therefore MERGEd into one node and the later write took ownership of it,
    // silently removing the node from the earlier org's results.
    //
    // Nodes are now keyed by `key` = tenantNodeKey(organizationId, id).
    //
    // The three steps must run in this order. Backfilling after creating the
    // constraint would fail on the nulls; dropping the old constraint after
    // creating the new one is harmless but leaves a window where the global
    // id-uniqueness rule still rejects a legitimate second-tenant write.
    //
    // Runs on driver construction, so once per process. After the first pass
    // the backfill matches nothing — it is a label scan that returns no rows,
    // which is the price of not having a migration runner for Neo4j.
    await driver.executeQuery(
      `MATCH (e:Entity)
       WHERE e.key IS NULL AND e.organizationId IS NOT NULL
       SET e.key = e.organizationId + '::' + e.id`,
    ).catch(() => undefined)

    // Must be dropped: while it exists, two tenants cannot hold the same id at
    // all, so the collision this migration fixes would simply become an error.
    await driver.executeQuery('DROP CONSTRAINT entity_id IF EXISTS').catch(() => undefined)

    await driver.executeQuery(
      'CREATE CONSTRAINT entity_key IF NOT EXISTS FOR (e:Entity) REQUIRE e.key IS UNIQUE',
    ).catch(() => undefined)
    await driver.executeQuery(
      `CREATE VECTOR INDEX ${VECTOR_INDEX} IF NOT EXISTS FOR (e:Entity) ON (e.embedding)
       OPTIONS { indexConfig: { \`vector.dimensions\`: ${EMBEDDING_DIM}, \`vector.similarity_function\`: 'cosine' } }`,
    ).catch(() => undefined)
  }

  async upsertNodes(nodes: GraphNode[]): Promise<void> {
    if (nodes.length === 0) return
    const driver = await this.driver()
    await driver.executeQuery(
      `UNWIND $rows AS row
       MERGE (e:Entity { key: row.key })
       SET e.id = row.id, e.organizationId = row.organizationId, e.type = row.type, e.text = row.text,
           e.props = row.props, e.embedding = row.embedding, e.updatedAt = row.updatedAt,
           e.ownerUserId = row.ownerUserId, e.visibility = row.visibility`,
      {
        rows: nodes.map((n) => ({
          key: tenantNodeKey(n.organizationId, n.id),
          id: n.id, organizationId: n.organizationId, type: n.type, text: n.text,
          props: JSON.stringify(n.props ?? {}), embedding: n.embedding, updatedAt: n.updatedAt ?? new Date().toISOString(),
          ownerUserId: n.ownerUserId ?? null, visibility: n.visibility ?? 'shared',
        })),
      },
    )
  }

  async upsertEdges(edges: GraphEdge[]): Promise<void> {
    if (edges.length === 0) return
    const driver = await this.driver()
    // Relationship type can't be parameterized; it's from our fixed EdgeRelation
    // union (never user input), so interpolation is safe. One UNWIND per
    // relationship type instead of one round-trip per edge — a run producing
    // 50 edges was previously 50 sequential network calls.
    const byRel = new Map<string, GraphEdge[]>()
    for (const edge of edges) {
      const rel = edge.rel.toUpperCase()
      byRel.set(rel, [...(byRel.get(rel) ?? []), edge])
    }
    for (const [rel, group] of byRel) {
      await driver.executeQuery(
        // Endpoints are matched by TENANT KEY. Matching on the bare id let an
        // edge attach to whichever tenant happened to own a colliding node,
        // which is how a traversal could leave its own workspace.
        `UNWIND $rows AS row
         MATCH (a:Entity { key: row.fromKey }), (b:Entity { key: row.toKey })
         MERGE (a)-[r:${rel}]->(b)
         SET r.organizationId = row.organizationId`,
        {
          rows: group.map((edge) => ({
            fromKey: tenantNodeKey(edge.organizationId, edge.from),
            toKey: tenantNodeKey(edge.organizationId, edge.to),
            organizationId: edge.organizationId,
          })),
        },
      )
    }
  }

  async search(organizationId: string, viewerUserId: string | null, queryEmbedding: number[], k: number): Promise<SearchHit[]> {
    if (queryEmbedding.length === 0) return []
    const driver = await this.driver()
    // Over-fetch from the vector index, then filter to the org + viewer scope
    // and take k. `coalesce(...,'shared')` makes legacy nodes (no visibility
    // property) read as shared, so no migration is needed.
    const { records } = await driver.executeQuery(
      `CALL db.index.vector.queryNodes($index, $fetch, $q) YIELD node, score
       WHERE node.organizationId = $org
         AND (coalesce(node.visibility, 'shared') <> 'private' OR node.ownerUserId = $viewer)
       RETURN node, score LIMIT $k`,
      { index: VECTOR_INDEX, fetch: Math.max(k * 4, 20), q: queryEmbedding, org: organizationId, viewer: viewerUserId, k },
    ).catch(async () => {
      // No vector index (e.g. Community edition): fall back to scoring in-app.
      const all = await driver.executeQuery(
        'MATCH (e:Entity { organizationId: $org }) RETURN e AS node',
        { org: organizationId },
      )
      const scored = all.records
        .map((r) => hydrate(r.get('node')))
        .filter((n): n is GraphNode => n !== null && n.embedding.length > 0 && nodeVisibleTo(n, viewerUserId))
        .map((node) => ({ node, score: cosineSimilarity(queryEmbedding, node.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
      return { records: scored.map((s) => ({ get: (key: string) => (key === 'node' ? toRaw(s.node) : s.score) })) }
    })

    return records
      .map((r) => ({ node: hydrate(r.get('node')), score: Number(r.get('score')) || 0 }))
      .filter((h): h is SearchHit => h.node !== null)
  }

  async expand(organizationId: string, viewerUserId: string | null, nodeIds: string[], hops: number): Promise<GraphNode[]> {
    if (nodeIds.length === 0) return []
    const driver = await this.driver()
    // Seeds are scoped to the org AND the viewer, not just the returned
    // neighbors: node ids are partly derived from execution input, so an
    // unscoped seed match would let a foreign-tenant (or another rep's
    // private) node anchor the traversal even though its neighbors are
    // filtered. Only return neighbors the viewer may see — a private node
    // owned by another rep is never surfaced, even if reachable by an edge.
    const { records } = await driver.executeQuery(
      `MATCH (seed:Entity { organizationId: $org }) WHERE seed.id IN $ids
         AND (coalesce(seed.visibility, 'shared') <> 'private' OR seed.ownerUserId = $viewer)
       MATCH (seed)-[*1..${Math.max(1, Math.min(hops, 3))}]-(n:Entity { organizationId: $org })
       WHERE NOT n.id IN $ids
         AND (coalesce(n.visibility, 'shared') <> 'private' OR n.ownerUserId = $viewer)
       RETURN DISTINCT n AS node`,
      { ids: nodeIds, org: organizationId, viewer: viewerUserId },
    )
    return records.map((r) => hydrate(r.get('node'))).filter((n): n is GraphNode => n !== null)
  }

  async deleteNodes(organizationId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const driver = await this.driver()
    await driver.executeQuery(
      'MATCH (e:Entity) WHERE e.organizationId = $org AND e.id IN $ids DETACH DELETE e',
      { org: organizationId, ids },
    )
  }

  async deleteByOwner(organizationId: string, ownerUserId: string): Promise<void> {
    const driver = await this.driver()
    await driver.executeQuery(
      'MATCH (e:Entity) WHERE e.organizationId = $org AND e.ownerUserId = $owner DETACH DELETE e',
      { org: organizationId, owner: ownerUserId },
    )
  }

  /** Release the bolt driver (tests/graceful shutdown); safe when never opened. */
  async close(): Promise<void> {
    if (!this.driverPromise) return
    const driver = await this.driverPromise.catch(() => null)
    this.driverPromise = null
    await driver?.close().catch(() => undefined)
  }

  /** Org teardown: remove every node (and their edges) for this org. */
  async clear(organizationId: string): Promise<void> {
    const driver = await this.driver()
    await driver.executeQuery(
      'MATCH (e:Entity) WHERE e.organizationId = $org DETACH DELETE e',
      { org: organizationId },
    )
  }
}

function toRaw(node: GraphNode) {
  return { properties: { ...node, props: JSON.stringify(node.props ?? {}) } }
}

/** Convert a driver node record into a GraphNode, tolerating shape differences. */
function hydrate(raw: unknown): GraphNode | null {
  const props = (raw as { properties?: Record<string, unknown> })?.properties ?? (raw as Record<string, unknown>)
  if (!props || typeof props !== 'object') return null
  const p = props as Record<string, unknown>
  if (typeof p.id !== 'string' || typeof p.organizationId !== 'string') return null
  let parsedProps: Record<string, unknown> = {}
  try {
    parsedProps = typeof p.props === 'string' ? JSON.parse(p.props) : (p.props as Record<string, unknown>) ?? {}
  } catch {
    parsedProps = {}
  }
  return {
    id: p.id,
    organizationId: p.organizationId,
    type: (p.type as NodeType) ?? 'insight',
    text: typeof p.text === 'string' ? p.text : '',
    props: parsedProps,
    embedding: Array.isArray(p.embedding) ? (p.embedding as number[]) : [],
    ownerUserId: typeof p.ownerUserId === 'string' ? p.ownerUserId : null,
    visibility: p.visibility === 'private' ? 'private' : ('shared' as NodeVisibility),
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : undefined,
  }
}
