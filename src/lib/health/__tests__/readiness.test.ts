import { test } from 'node:test'
import assert from 'node:assert/strict'
import { probeWithDeadline, collectHealthDetails } from '../readiness'

const never = () => new Promise<void>(() => {})

test('a healthy probe reports ok with its latency', async () => {
  const result = await probeWithDeadline(async () => {}, 500)
  assert.equal(result.ok, true)
  assert.equal(typeof result.ms, 'number')
})

// The incident: the pool was exhausted, so `SELECT 1` blocked on a checkout that
// takes 60s to give up. Without a deadline the probe cannot answer a liveness
// question — it either hangs until the platform kills it or wins a lucky slot
// and reports healthy while every real request fails.
test('a probe that hangs past its deadline reports unhealthy rather than waiting', async () => {
  const started = Date.now()
  const result = await probeWithDeadline(never, 80)
  const elapsed = Date.now() - started
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /timed out/i)
  assert.ok(elapsed < 1000, `probe must return on its own deadline, took ${elapsed}ms`)
})

test('the deadline is reported so an operator can tell a timeout from a refusal', async () => {
  const result = await probeWithDeadline(never, 60)
  assert.match(result.error ?? '', /60/, 'the error names the deadline it exceeded')
})

test('a probe that throws reports the failure, not a timeout', async () => {
  const result = await probeWithDeadline(async () => { throw new Error('connection refused') }, 500)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'connection refused')
})

// A slow-but-alive dependency must not be declared dead on a transient blip
// shorter than the deadline.
test('work that finishes inside the deadline still counts as healthy', async () => {
  const result = await probeWithDeadline(() => new Promise((resolve) => setTimeout(resolve, 30)), 300)
  assert.equal(result.ok, true)
})

// ── Degradation wiring ──────────────────────────────────────────────────────
//
// collectHealthDetails already probed Neo4j and dropped the result into
// `checks` without letting it reach degradedSubsystems. The graph could be
// unreachable and the payload would still report nothing degraded — the probe
// existed but was not wired to the thing that reports. These tests pin the
// wiring, not the rule (degradations.test.ts owns the rule).

const configuredEnv = {
  RESEND_API_KEY: 'key',
  SENTRY_DSN: 'dsn',
  REDIS_URL: 'redis://host',
  VOYAGE_API_KEY: 'pa-key',
  NEO4J_URI: 'neo4j+s://host',
  NEO4J_USERNAME: 'neo4j',
  NEO4J_PASSWORD: 'pw',
}
const withEnv = async <T>(run: () => Promise<T>): Promise<T> => {
  const saved = { ...process.env }
  Object.assign(process.env, configuredEnv)
  try {
    return await run()
  } finally {
    for (const key of Object.keys(configuredEnv)) delete process.env[key]
    Object.assign(process.env, saved)
  }
}
const okProbes = {
  db: async () => ({ ok: true, ms: 1 }),
  cache: async () => ({ ok: true, configured: true }),
  neo4j: async () => ({ ok: true, configured: true }),
  queue: async () => ({ ok: true }),
}

test('an unreachable graph store reaches the degraded list, not just checks', async () => {
  const details = await withEnv(() =>
    collectHealthDetails({ ...okProbes, neo4j: async () => ({ ok: false, configured: true }) }),
  )
  assert.ok(
    details.degraded.some((entry) => entry.key === 'graph-rag'),
    `expected graph-rag degraded, got: ${JSON.stringify(details.degraded.map((d) => d.key))}`,
  )
})

test('a reachable graph store in a configured environment is not reported degraded', async () => {
  const details = await withEnv(() => collectHealthDetails(okProbes))
  assert.ok(!details.degraded.some((entry) => entry.key === 'graph-rag'))
})

// The probe result must still be visible in its own right for an operator
// reading the payload — reporting it as degraded does not replace reporting it.
test('the graph probe result is still reported under checks', async () => {
  const details = await withEnv(() => collectHealthDetails(okProbes))
  assert.deepEqual(details.checks.neo4j, { ok: true, configured: true })
})
