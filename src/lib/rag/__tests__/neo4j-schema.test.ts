/**
 * Schema assertions for a Neo4j instance backing graph-RAG.
 *
 * Every DDL statement in Neo4jGraphStore.ensureIndexes() ends in
 * `.catch(() => undefined)` — deliberately, so a server that cannot create a
 * vector index (Community edition) does not crash the app. The cost is that a
 * failed creation is COMPLETELY silent: search() then falls into its fallback
 * branch, a full `MATCH (e:Entity {organizationId})` label scan that pulls
 * every node in the org into Node.js to cosine-score in a loop. Correct, and
 * quietly O(n) forever.
 *
 * These rules turn that silence into an answer. Pure over driver rows so the
 * cases below can be written as literals instead of needing a live server.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeNeo4jSchema } from '../neo4j-schema'

const healthyIndexes = [
  {
    name: 'entity_embedding',
    type: 'VECTOR',
    state: 'ONLINE',
    labelsOrTypes: ['Entity'],
    properties: ['embedding'],
    options: { indexConfig: { 'vector.dimensions': 1024, 'vector.similarity_function': 'cosine' } },
  },
]
const healthyConstraints = [
  { name: 'entity_key', type: 'UNIQUENESS', labelsOrTypes: ['Entity'], properties: ['key'] },
]

test('a correctly provisioned instance reports ok with no problems', () => {
  const report = summarizeNeo4jSchema(healthyIndexes, healthyConstraints, 1024)
  assert.equal(report.ok, true)
  assert.deepEqual(report.problems, [])
  assert.equal(report.vectorIndex.present, true)
  assert.equal(report.vectorIndex.dimensions, 1024)
})

// The failure this script exists to catch.
test('a missing vector index is a problem that names the fallback it causes', () => {
  const report = summarizeNeo4jSchema([], healthyConstraints, 1024)
  assert.equal(report.ok, false)
  assert.equal(report.vectorIndex.present, false)
  assert.match(report.problems.join(' '), /scan|fallback/i)
})

// EMBEDDING_DIM is 1024. An index built at another width does not error — it
// simply never matches the vectors being written, so search silently returns
// nothing useful.
test('a vector index at the wrong dimension is a problem, not a pass', () => {
  const wrong = [{ ...healthyIndexes[0], options: { indexConfig: { 'vector.dimensions': 1536, 'vector.similarity_function': 'cosine' } } }]
  const report = summarizeNeo4jSchema(wrong, healthyConstraints, 1024)
  assert.equal(report.ok, false)
  assert.match(report.problems.join(' '), /1536.*1024|1024.*1536/)
})

// upsertNodes writes cosine-normalised embeddings and search() scores with
// cosineSimilarity; an index built on euclidean ranks by a different metric.
test('a vector index with the wrong similarity function is a problem', () => {
  const wrong = [{ ...healthyIndexes[0], options: { indexConfig: { 'vector.dimensions': 1024, 'vector.similarity_function': 'euclidean' } } }]
  const report = summarizeNeo4jSchema(wrong, healthyConstraints, 1024)
  assert.equal(report.ok, false)
  assert.match(report.problems.join(' '), /cosine/i)
})

// A freshly created index populates asynchronously. Reporting it as ready
// before it is ONLINE is how a backfill appears to succeed and return nothing.
test('a vector index that is not yet ONLINE is reported as not ready', () => {
  const populating = [{ ...healthyIndexes[0], state: 'POPULATING' }]
  const report = summarizeNeo4jSchema(populating, healthyConstraints, 1024)
  assert.equal(report.vectorIndex.present, true)
  assert.equal(report.vectorIndex.online, false)
  assert.equal(report.ok, false)
  assert.match(report.problems.join(' '), /POPULATING|not online/i)
})

// Without entity_key uniqueness, concurrent upserts of the same tenant key can
// MERGE into duplicate nodes — the constraint is what makes upsertNodes an
// upsert rather than an append.
test('a missing tenant-key constraint is a problem', () => {
  const report = summarizeNeo4jSchema(healthyIndexes, [], 1024)
  assert.equal(report.ok, false)
  assert.equal(report.tenantConstraint.present, false)
  assert.match(report.problems.join(' '), /entity_key/)
})

// The legacy global constraint from before nodes were keyed per tenant. While
// it exists, two workspaces cannot hold the same logical id at all — so ids
// like `tool:slack`, identical across every org connecting that provider, make
// the second org's write fail outright instead of colliding silently.
test('the legacy global entity_id constraint is flagged if it survived', () => {
  const legacy = [
    ...healthyConstraints,
    { name: 'entity_id', type: 'UNIQUENESS', labelsOrTypes: ['Entity'], properties: ['id'] },
  ]
  const report = summarizeNeo4jSchema(healthyIndexes, legacy, 1024)
  assert.equal(report.ok, false)
  assert.match(report.problems.join(' '), /entity_id/)
})

// The neo4j driver returns lossless Integer objects ({low, high}) unless the
// driver is built with disableLosslessIntegers. `Number({low:1024,high:0})` is
// NaN, which would report a dimension MISMATCH on a perfectly healthy index —
// a verification tool that cries wolf is worse than none, so the rules
// normalise the shape rather than trusting every caller to.
test('a lossless Integer dimension is read as its number, not a false mismatch', () => {
  const lossless = [{
    ...healthyIndexes[0],
    options: { indexConfig: { 'vector.dimensions': { low: 1024, high: 0 }, 'vector.similarity_function': 'cosine' } },
  }]
  const report = summarizeNeo4jSchema(lossless, healthyConstraints, 1024)
  assert.equal(report.vectorIndex.dimensions, 1024)
  assert.deepEqual(report.problems, [])
  assert.equal(report.ok, true)
})

// Found by running scripts/verify-neo4j.ts against a real Aura instance: the
// server reports the similarity function UPPERCASED ('COSINE'), so a
// case-sensitive comparison declares a correctly-provisioned index broken.
// This is precisely the cry-wolf failure the header warns about — a
// verification tool that reports false problems gets ignored within a week.
test('a similarity function reported as COSINE is accepted, not flagged', () => {
  const upper = [{
    ...healthyIndexes[0],
    options: { indexConfig: { 'vector.dimensions': 1024, 'vector.similarity_function': 'COSINE' } },
  }]
  const report = summarizeNeo4jSchema(upper, healthyConstraints, 1024)
  assert.deepEqual(report.problems, [])
  assert.equal(report.ok, true)
})

// The genuinely wrong metric must still be caught, whatever its casing.
test('a EUCLIDEAN index is still flagged despite the casing fix', () => {
  const euclid = [{
    ...healthyIndexes[0],
    options: { indexConfig: { 'vector.dimensions': 1024, 'vector.similarity_function': 'EUCLIDEAN' } },
  }]
  assert.equal(summarizeNeo4jSchema(euclid, healthyConstraints, 1024).ok, false)
})
