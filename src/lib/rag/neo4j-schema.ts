/**
 * Schema rules for a Neo4j instance backing graph-RAG.
 *
 * `Neo4jGraphStore.ensureIndexes()` creates the tenant-key constraint and the
 * vector index on first driver construction, and every statement there ends in
 * `.catch(() => undefined)` so a server that cannot honour them (Community
 * edition has no vector index) degrades instead of crashing the app. That is
 * the right default and it has one consequence: a failed creation is silent.
 * `search()` quietly falls back to a full org label scan scored in-process,
 * which is correct, O(n), and indistinguishable from a healthy instance at
 * every level except latency.
 *
 * These rules exist to be run against a NEW instance, before it carries real
 * traffic, so that silence becomes an answer. Kept pure over driver rows —
 * the I/O lives in scripts/verify-neo4j.ts.
 */

/** One row of `SHOW INDEXES`, narrowed to the fields these rules read. */
export interface IndexRow {
  name: string
  type: string
  state?: string
  labelsOrTypes?: string[] | null
  properties?: string[] | null
  options?: Record<string, unknown> | null
}

/** One row of `SHOW CONSTRAINTS`, likewise narrowed. */
export interface ConstraintRow {
  name: string
  type?: string
  labelsOrTypes?: string[] | null
  properties?: string[] | null
}

export interface SchemaReport {
  /** True when the instance is fit to serve graph-RAG with no silent fallback. */
  ok: boolean
  vectorIndex: {
    present: boolean
    online: boolean
    dimensions?: number
    similarity?: string
  }
  tenantConstraint: { present: boolean }
  /** Operator-readable failures, each naming its runtime consequence. */
  problems: string[]
}

/** Names created by ensureIndexes(); `entity_id` is the legacy one it drops. */
const VECTOR_INDEX = 'entity_embedding'
const TENANT_CONSTRAINT = 'entity_key'
const LEGACY_CONSTRAINT = 'entity_id'

/**
 * Read a driver numeric that may arrive as a plain number OR as a neo4j
 * lossless Integer (`{low, high}`), which is the driver's DEFAULT shape.
 * `Number({low: 1024, high: 0})` is NaN, so trusting the raw value would
 * report a dimension mismatch on a perfectly healthy index. `high` is the
 * upper 32 bits; index dimensions never reach that range, but honouring it
 * costs nothing and keeps the conversion honest.
 */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (value && typeof value === 'object' && 'low' in value) {
    const { low, high } = value as { low: number; high?: number }
    if (typeof low !== 'number') return undefined
    return (high ?? 0) * 2 ** 32 + (low >>> 0)
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function indexConfig(row: IndexRow | undefined): Record<string, unknown> {
  const config = (row?.options as { indexConfig?: unknown } | null | undefined)?.indexConfig
  return config && typeof config === 'object' ? (config as Record<string, unknown>) : {}
}

export function summarizeNeo4jSchema(
  indexes: IndexRow[],
  constraints: ConstraintRow[],
  expectedDimensions: number,
): SchemaReport {
  const problems: string[] = []

  const vector = indexes.find((row) => row.name === VECTOR_INDEX)
  const config = indexConfig(vector)
  const dimensions = toNumber(config['vector.dimensions'])
  // Neo4j reports this UPPERCASED ('COSINE'), while ensureIndexes() creates it
  // lowercased. Comparing case-sensitively declared a correctly-provisioned
  // Aura instance broken — the cry-wolf failure this file's header warns
  // about, found by running the verify script against a real instance.
  const rawSimilarity = config['vector.similarity_function']
  const similarity = typeof rawSimilarity === 'string' ? rawSimilarity.toLowerCase() : undefined
  // A vector index populates asynchronously; only ONLINE is queryable.
  const online = vector?.state === 'ONLINE'

  if (!vector) {
    problems.push(
      `vector index "${VECTOR_INDEX}" is missing — search() silently falls back to a full label scan of every node in the org, scored in-process (correct, but O(n) per query).`,
    )
  } else {
    if (!online) {
      problems.push(
        `vector index "${VECTOR_INDEX}" is ${vector.state ?? 'in an unknown state'}, not ONLINE — queries against it return nothing useful until population finishes.`,
      )
    }
    if (dimensions !== expectedDimensions) {
      problems.push(
        `vector index "${VECTOR_INDEX}" has ${dimensions ?? 'unknown'} dimensions but embeddings are written at ${expectedDimensions} — the index can never match the vectors stored.`,
      )
    }
    if (similarity !== 'cosine') {
      problems.push(
        `vector index "${VECTOR_INDEX}" ranks by ${similarity ?? 'an unknown function'}, but retrieval scores with cosine similarity — ranking will not agree with the fallback path.`,
      )
    }
  }

  const tenantConstraint = constraints.some((row) => row.name === TENANT_CONSTRAINT)
  if (!tenantConstraint) {
    problems.push(
      `uniqueness constraint "${TENANT_CONSTRAINT}" is missing — MERGE on the tenant key is no longer guaranteed unique, so upsertNodes can append duplicates instead of updating.`,
    )
  }

  // Pre-tenant-key leftover. While it exists, ids that are byte-identical
  // across workspaces (`tool:slack`, `capability:slack:post_message`) make the
  // second org's write fail outright rather than coexist.
  if (constraints.some((row) => row.name === LEGACY_CONSTRAINT)) {
    problems.push(
      `legacy constraint "${LEGACY_CONSTRAINT}" still exists — it enforces global id uniqueness, so a second workspace indexing the same provider id is rejected. ensureIndexes() drops it; if it survived, drop it manually.`,
    )
  }

  return {
    ok: problems.length === 0,
    vectorIndex: { present: Boolean(vector), online, dimensions, similarity },
    tenantConstraint: { present: tenantConstraint },
    problems,
  }
}
