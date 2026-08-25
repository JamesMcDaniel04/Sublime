/**
 * The driver config must be a fresh object per construction.
 *
 * `neo4j.driver()` MUTATES the config object it is handed. Constructing one
 * driver writes `encrypted: 'ENCRYPTION_ON'` and
 * `trust: 'TRUST_SYSTEM_CA_SIGNED_CERTIFICATES'` (plus userAgent, boltAgent,
 * maxConnectionLifetime, fetchSize) straight into the caller's object.
 *
 * With a `neo4j+s://` URI — which every Aura instance uses — encryption is
 * already specified by the URL scheme. So the SECOND construction from the
 * same object throws:
 *
 *     Encryption/trust can only be configured either through URL or config,
 *     not both
 *
 * A single module-level config const shared between `neo4jPing()` and
 * `Neo4jGraphStore.driver()` therefore means whichever runs first poisons the
 * object for the other. In production that is: a health check runs, and every
 * graph-RAG operation in that process fails for the rest of its life — silently,
 * because every RAG caller catches and degrades.
 *
 * It did not bite on an unencrypted `neo4j://` URI, where config-level
 * encryption is permitted. It appears the moment you move to Aura.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { driverOptions } from '../neo4j-store'

test('each call returns a distinct object, not one shared instance', () => {
  assert.notEqual(driverOptions(), driverOptions())
})

// The actual failure, reproduced without a server: the driver writes these
// keys into whatever object it is given.
test('mutating one result cannot contaminate the next', () => {
  const first = driverOptions() as Record<string, unknown>
  first.encrypted = 'ENCRYPTION_ON'
  first.trust = 'TRUST_SYSTEM_CA_SIGNED_CERTIFICATES'

  const second = driverOptions() as Record<string, unknown>
  assert.equal(second.encrypted, undefined, 'a poisoned earlier config leaked into a later one')
  assert.equal(second.trust, undefined)
})

// The bounds are the point of having a config at all — they must survive.
test('the bounded pool and timeout settings are still applied', () => {
  const options = driverOptions()
  assert.equal(options.connectionTimeout, 5_000)
  assert.equal(options.connectionAcquisitionTimeout, 10_000)
  assert.equal(options.maxConnectionPoolSize, 10)
})

// Encryption must come from the URL scheme alone. Setting it here is what
// makes the two sources conflict in the first place.
test('encryption is never specified in config — the URL scheme owns it', () => {
  const options = driverOptions() as Record<string, unknown>
  assert.equal('encrypted' in options, false)
  assert.equal('trust' in options, false)
})
