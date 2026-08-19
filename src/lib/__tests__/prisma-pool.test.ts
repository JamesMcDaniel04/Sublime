import { test } from 'node:test'
import assert from 'node:assert/strict'
import { poolConfigFromDatabaseUrl } from '../prisma-pool'

const url = (query: string) => `postgresql://u:p@host:6543/db${query}`

// The operational contract the whole deployment is tuned around: serverless
// sets connection_limit=1, the worker sets it >= its total job concurrency
// (src/lib/env.ts asserts both). Prisma 6's engine honoured it; Prisma 7 hands
// pooling to node-postgres, which does not understand the parameter at all.
test('honours connection_limit=1, the serverless setting', () => {
  assert.equal(poolConfigFromDatabaseUrl(url('?pgbouncer=true&connection_limit=1')).max, 1)
})

test('honours a worker-sized connection_limit', () => {
  assert.equal(poolConfigFromDatabaseUrl(url('?connection_limit=22')).max, 22)
})

test('passes the connection string through untouched', () => {
  const original = url('?pgbouncer=true&connection_limit=1&sslmode=require')
  assert.equal(poolConfigFromDatabaseUrl(original).connectionString, original)
})

// An unset limit is already reported by assertEnv; the pool must not invent a
// bound that would starve a high-concurrency worker into P2024 timeouts.
test('leaves the driver default in place when no limit is configured', () => {
  assert.equal(poolConfigFromDatabaseUrl(url('')).max, undefined)
  assert.equal(poolConfigFromDatabaseUrl(url('?pgbouncer=true')).max, undefined)
})

test('ignores a limit that is not a usable positive integer', () => {
  for (const bad of ['0', '-4', 'abc', '', '1.5']) {
    assert.equal(poolConfigFromDatabaseUrl(url(`?connection_limit=${bad}`)).max, undefined, `limit "${bad}"`)
  }
})

// Resolved lazily at first query, so a malformed or absent URL must not throw
// here — that would turn a config problem into a crash on import.
test('never throws on a missing or unparseable url', () => {
  assert.equal(poolConfigFromDatabaseUrl(undefined).max, undefined)
  assert.equal(poolConfigFromDatabaseUrl('').max, undefined)
  assert.equal(poolConfigFromDatabaseUrl('not-a-url').max, undefined)
})
