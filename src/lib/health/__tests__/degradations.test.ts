import { test } from 'node:test'
import assert from 'node:assert/strict'
import { degradedSubsystems } from '../degradations'

const configured = {
  RESEND_API_KEY: 'key',
  SENTRY_DSN: 'dsn',
  REDIS_URL: 'redis://host',
  VOYAGE_API_KEY: 'pa-key',
  NEO4J_URI: 'neo4j+s://host',
  NEO4J_USERNAME: 'neo4j',
  NEO4J_PASSWORD: 'pw',
}

const keysOf = (list: { key: string }[]) => list.map((d) => d.key).sort()

test('a fully configured, reachable deployment reports nothing degraded', () => {
  assert.deepEqual(degradedSubsystems(configured, { cacheReachable: true }), [])
})

// The three that were silently off in production on 2026-08-19.
test('a missing email key names every surface it takes down, not just the key', () => {
  const [found] = degradedSubsystems({ ...configured, RESEND_API_KEY: undefined }, { cacheReachable: true })
  assert.equal(found.key, 'RESEND_API_KEY')
  assert.match(found.impact, /contact form/i)
  assert.match(found.impact, /email/i)
})

test('a missing error-reporting DSN is itself reported', () => {
  const found = degradedSubsystems({ ...configured, SENTRY_DSN: undefined }, { cacheReachable: true })
  assert.deepEqual(keysOf(found), ['SENTRY_DSN'])
  assert.match(found[0].impact, /unreported|no alert/i)
})

// The subtle one: configured is not the same as working. A reachable-looking
// config with a dead backend silently turns workspace-wide ceilings into
// per-instance ones, multiplying every cap by the instance count.
test('a configured but unreachable cache is degraded, not healthy', () => {
  const found = degradedSubsystems(configured, { cacheReachable: false })
  assert.deepEqual(keysOf(found), ['cache'])
  assert.match(found[0].impact, /per-instance|per instance/i)
})

test('an entirely unconfigured cache backend is degraded too', () => {
  const found = degradedSubsystems({ ...configured, REDIS_URL: undefined }, { cacheReachable: false })
  assert.deepEqual(keysOf(found), ['cache'])
})

test('the Upstash REST pair counts as a configured cache backend', () => {
  const env = { ...configured, REDIS_URL: undefined, UPSTASH_REDIS_REST_URL: 'u', UPSTASH_REDIS_REST_TOKEN: 't' }
  assert.deepEqual(degradedSubsystems(env, { cacheReachable: true }), [])
})

test('every degradation carries an impact an operator can act on', () => {
  const found = degradedSubsystems({}, { cacheReachable: false })
  assert.ok(found.length >= 3, 'a bare environment degrades several subsystems')
  for (const entry of found) {
    assert.ok(entry.impact.length > 20, `${entry.key} needs a real consequence, got "${entry.impact}"`)
  }
})

// Unknown cache state (probe not run) must not invent a failure.
test('an unprobed cache is not reported as unreachable', () => {
  assert.deepEqual(degradedSubsystems(configured, {}), [])
})

// ── Graph-RAG ───────────────────────────────────────────────────────────────
//
// The failure that was live on 2026-08-24: the Fly worker carried no NEO4J_*
// and no VOYAGE_API_KEY, so every queue-executed agent run grounded on nothing
// and indexed nothing back — while /health reported ok the entire time. This
// is precisely the class this module exists to name, and it was uncovered.

test('a missing graph store degrades graph-RAG', () => {
  const found = degradedSubsystems({ ...configured, NEO4J_URI: undefined }, { cacheReachable: true, neo4jReachable: true })
  assert.deepEqual(keysOf(found), ['graph-rag'])
  assert.match(found[0].impact, /ground/i)
})

// Both gates matter: ragEnabled() is embeddings AND a durable store, so a
// graph with no embeddings key is exactly as dark as having no graph at all.
test('a graph store without an embeddings key is still degraded', () => {
  const found = degradedSubsystems({ ...configured, VOYAGE_API_KEY: undefined }, { cacheReachable: true, neo4jReachable: true })
  assert.deepEqual(keysOf(found), ['graph-rag'])
})

// neo4jConfigured() requires all three vars. Two of the three is not a partial
// graph — it silently falls back to the per-process in-memory store.
test('partial Neo4j credentials do not count as a configured graph store', () => {
  const found = degradedSubsystems({ ...configured, NEO4J_PASSWORD: undefined }, { cacheReachable: true, neo4jReachable: true })
  assert.deepEqual(keysOf(found), ['graph-rag'])
})

// Same lesson the cache probe teaches: configured is not the same as working.
test('a configured but unreachable graph store is degraded, not healthy', () => {
  const found = degradedSubsystems(configured, { cacheReachable: true, neo4jReachable: false })
  assert.deepEqual(keysOf(found), ['graph-rag'])
})
