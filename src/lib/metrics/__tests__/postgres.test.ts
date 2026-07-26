import assert from 'node:assert/strict'
import test from 'node:test'
import type { ClientConfig } from 'pg'
import {
  makePostgresMetricSource,
  parsePostgresNumber,
  validateReadOnlyQuery,
} from '../sources/postgres'

test('read-only validation accepts select/with and rejects unsafe statement shapes', () => {
  assert.equal(validateReadOnlyQuery(' SELECT 42 '), 'SELECT 42')
  assert.equal(validateReadOnlyQuery('with value as (select 42) select * from value'), 'with value as (select 42) select * from value')
  for (const query of ['', 'UPDATE things SET x = 1', 'DELETE FROM things', 'CREATE TABLE x(a int)', 'SELECT 1; SELECT 2', `SELECT '${'x'.repeat(10_000)}'`]) {
    assert.throws(() => validateReadOnlyQuery(query))
  }
})

test('Postgres numeric coercion shares spreadsheet rules', () => {
  assert.equal(parsePostgresNumber(' $41,203.50 '), 41_203.5)
  assert.equal(parsePostgresNumber(42), 42)
  assert.throws(() => parsePostgresNumber('not a number'))
})

test('adapter enforces read-only session options, timeout, and one statement', async () => {
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
  assert.deepEqual(queries, ['SELECT 42'])
  assert.equal(configs[0].statement_timeout, 10_000)
  assert.equal(configs[0].connectionTimeoutMillis, 10_000)
  assert.equal(configs[0].options, '-c default_transaction_read_only=on')
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
