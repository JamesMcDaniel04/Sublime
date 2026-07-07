/**
 * Store selection: Neo4j when configured, in-memory otherwise. The in-memory
 * store is per-process (not durable across serverless invocations), so it's a
 * dev/test substrate and a graceful fallback — production sets NEO4J_* for a
 * persistent, shared graph.
 */

import { MemoryGraphStore } from './memory-store'
import { Neo4jGraphStore, neo4jConfigured } from './neo4j-store'
import { embeddingsConfigured } from './embeddings'
import type { GraphRagStore } from './store'

let cached: GraphRagStore | null = null

export function getGraphRagStore(): GraphRagStore {
  if (cached) return cached
  cached = neo4jConfigured() ? new Neo4jGraphStore() : new MemoryGraphStore()
  return cached
}

/** True when a durable external store is configured (Neo4j). */
export function graphRagPersistent(): boolean {
  return neo4jConfigured()
}

/**
 * Graph-RAG is live only when embeddings AND a durable store are both
 * configured. Without persistence, indexing would embed into a per-process
 * store that's dropped between serverless invocations — so we skip it entirely
 * rather than burn embedding quota. Retrieval and indexing both gate on this.
 */
export function ragEnabled(): boolean {
  return embeddingsConfigured() && graphRagPersistent()
}
