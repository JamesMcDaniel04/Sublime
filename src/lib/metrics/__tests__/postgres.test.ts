import assert from 'node:assert/strict'
import test from 'node:test'
import type { ClientConfig } from 'pg'
import {
  buildClientConfig,
  makePostgresMetricSource,
  parsePostgresNumber,
  validateReadOnlyQuery,
} from '../sources/postgres'

test('read-only validation accepts select/with and rejects unsafe statement shapes', () => {
  assert.equal(validateReadOnlyQuery(' SELECT 42 '), 'SELECT 42')
  assert.equal(
    validateReadOnlyQuery('with value as (select 42) select * from value'),
    'with value as (select 42) select * from value',
  )
  for (const query of [
    '',
    'UPDATE things SET x = 1',
    'DELETE FROM things',
    'CREATE TABLE x(a int)',
    'SELECT 1; SELECT 2',
    `SELECT '${'x'.repeat(10_000)}'`,
  ]) {
    assert.throws(() => validateReadOnlyQuery(query))
  }
})

test('data-modifying CTEs and SELECT-shaped side effects are rejected', () => {
  for (const query of [
    'WITH x AS (UPDATE things SET n = n + 1 RETURNING 1) SELECT count(*) FROM x',
    'with d as (delete from logs returning id) select count(*) from d',
    'WITH i AS (INSERT INTO t VALUES (1) RETURNING *) SELECT 1',
    "SELECT nextval('seq')",
    "select setval('seq', 10)",
    'SELECT pg_advisory_lock(1)',
    "SELECT dblink_exec('conn', 'drop table x')",
    'SELECT * FROM t FOR UPDATE',
    "SELECT pg_read_file('/etc/passwd')",
  ]) {
    assert.throws(() => validateReadOnlyQuery(query), `should reject: ${query}`)
  }
  // Word boundaries: column/identifier names containing keywords still pass.
  assert.equal(
    validateReadOnlyQuery('SELECT updated_at, creates, offset_total FROM metrics'),
    'SELECT updated_at, creates, offset_total FROM metrics',
  )
})

test('Postgres numeric coercion shares spreadsheet rules', () => {
  assert.equal(parsePostgresNumber(' $41,203.50 '), 41_203.5)
  assert.equal(parsePostgresNumber(42), 42)
  assert.throws(() => parsePostgresNumber('not a number'))
})

test('connection-string query params never reach the driver config', () => {
  // pg merges string params OVER explicit config, so the adapter must strip
  // them by construction: a hostile credential cannot relax any layer.
  const config = buildClientConfig(
    'postgres://reader:pw@db.example.com:6432/app?options=-c%20default_transaction_read_only%3Doff&statement_timeout=0&ssl=0',
  )
  assert.equal('connectionString' in config, false)
  assert.equal('options' in config, false)
  assert.equal(config.host, 'db.example.com')
  assert.equal(config.port, 6432)
  assert.equal(config.database, 'app')
  assert.equal(config.statement_timeout, 10_000)
  assert.deepEqual(config.ssl, { rejectUnauthorized: true })
})

test('TLS defaults: verified for remote hosts, plain only for loopback', () => {
  const remote = buildClientConfig('postgres://u:p@db.example.com/app', 'PRIVATE CA')
  assert.deepEqual(remote.ssl, { rejectUnauthorized: true, ca: 'PRIVATE CA' })
  const local = buildClientConfig('postgres://qa@127.0.0.1:54339/sublime_qa')
  assert.equal('ssl' in local, false)
  assert.throws(
    () => buildClientConfig('postgres://u:p@db.example.com/app?sslmode=disable'),
    /cannot disable TLS verification/,
  )
  assert.throws(() => buildClientConfig('mysql://u:p@db.example.com/app'))
  assert.throws(() => buildClientConfig('not a url'))
})

test('adapter wraps the query in a server-enforced READ ONLY transaction', async () => {
  const configs: ClientConfig[] = []
  const queries: string[] = []
  let ended = false
  const source = makePostgresMetricSource({
    resolve: async () => ({
      connectionString: 'postgres://reader:secret@db.example.com/app?sslmode=require',
      caCert: 'PRIVATE CA',
    }),
    createClient: (value) => {
      configs.push(value)
      return {
        connect: async () => undefined,
        query: async (query) => {
          queries.push(query)
          return { rows: [{ answer: '42' }] } as never
        },
        end: async () => {
          ended = true
        },
      }
    },
  })
  const reading = await source.fetchValue(
    {
      organizationId: 'org',
      userId: 'user',
      connectionRef: 'credential:cred',
      config: { query: 'SELECT 42' },
    },
    'postgres.query',
  )
  assert.equal(reading.value, 42)
  assert.deepEqual(queries, [
    'BEGIN TRANSACTION READ ONLY',
    "SET LOCAL statement_timeout = '10000ms'",
    'SELECT 42',
    'COMMIT',
  ])
  assert.equal(configs[0].statement_timeout, 10_000)
  assert.equal(configs[0].connectionTimeoutMillis, 10_000)
  assert.deepEqual(configs[0].ssl, { rejectUnauthorized: true, ca: 'PRIVATE CA' })
  assert.equal(ended, true)
})

test('adapter rejects disabled TLS and redacts connection secrets from errors', async () => {
  const disabled = makePostgresMetricSource({
    resolve: async () => ({
      connectionString: 'postgres://reader:super-secret@db.example.com/app?sslmode=disable',
    }),
  })
  await assert.rejects(
    disabled.fetchValue(
      {
        organizationId: 'org',
        connectionRef: 'credential:cred',
        config: { query: 'SELECT 42' },
      },
      'postgres.query',
    ),
    /cannot disable TLS verification/,
  )

  const connectionString = 'postgres://reader:super-secret@db.example.com/app'
  const failing = makePostgresMetricSource({
    resolve: async () => ({ connectionString }),
    createClient: () => ({
      connect: async () => {
        throw new Error(`could not connect using ${connectionString}`)
      },
      query: async () => ({ rows: [] }) as never,
      end: async () => undefined,
    }),
  })
  await assert.rejects(
    failing.fetchValue(
      {
        organizationId: 'org',
        connectionRef: 'credential:cred',
        config: { query: 'SELECT 42' },
      },
      'postgres.query',
    ),
    (error: unknown) =>
      error instanceof Error &&
      !error.message.includes('super-secret') &&
      !error.message.includes(connectionString),
  )
})
