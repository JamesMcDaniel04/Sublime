import assert from 'node:assert/strict'
import test from 'node:test'
import type { ClientConfig } from 'pg'
import {
  buildClientConfig,
  displayTargetFor,
  safeError,
  withReadOnlyTransaction,
  withWriteTransaction,
  type PgClient,
} from '../client'

test('connection strings are reduced to explicit fields, never passed through', () => {
  const config = buildClientConfig('postgres://alice:s3cret@db.example.com:6543/analytics')
  assert.equal(config.host, 'db.example.com')
  assert.equal(config.port, 6543)
  assert.equal(config.user, 'alice')
  assert.equal(config.password, 's3cret')
  assert.equal(config.database, 'analytics')
  assert.deepEqual(config.ssl, { rejectUnauthorized: true })
})

test('query params that would relax hardening never reach the driver', () => {
  const config = buildClientConfig(
    'postgres://u:p@db.example.com/app?options=-c%20default_transaction_read_only%3Doff&statement_timeout=0&ssl=0',
  ) as ClientConfig & { options?: string }
  assert.equal(config.options, undefined)
  assert.equal(config.statement_timeout, 10_000)
  assert.deepEqual(config.ssl, { rejectUnauthorized: true })
})

test('TLS is mandatory off-loopback and cannot be disabled', () => {
  assert.throws(
    () => buildClientConfig('postgres://u:p@db.example.com/app?sslmode=disable'),
    /cannot disable TLS/i,
  )
  const withCa = buildClientConfig('postgres://u:p@db.example.com/app', 'CA-PEM')
  assert.deepEqual(withCa.ssl, { rejectUnauthorized: true, ca: 'CA-PEM' })
})

test('loopback connects without TLS so local and CI verification still work', () => {
  assert.equal(buildClientConfig('postgres://u@localhost:5432/app').ssl, undefined)
  assert.equal(buildClientConfig('postgres://u@127.0.0.1:5432/app').ssl, undefined)
})

test('malformed connection strings are rejected before any connection is attempted', () => {
  for (const value of ['', 'not-a-url', 'mysql://u:p@h/db', 'postgres://host-without-db']) {
    assert.throws(() => buildClientConfig(value), `expected rejection: ${value}`)
  }
})

test('the display target carries host and database but never credentials', () => {
  assert.equal(displayTargetFor('postgres://alice:s3cret@db.example.com:6543/analytics'), 'db.example.com:6543/analytics')
  assert.equal(displayTargetFor('postgres://alice:s3cret@db.example.com/analytics'), 'db.example.com:5432/analytics')
})

test('driver errors are stripped of anything credential-shaped', () => {
  const connectionString = 'postgres://alice:s3cret@db.example.com:5432/analytics'
  const message = safeError(new Error(`failed for alice using ${connectionString}`), connectionString).message
  assert.ok(!message.includes('s3cret'), message)
  assert.ok(!message.includes('alice'), message)
  assert.ok(message.includes('[redacted]'), message)
})

test('a TLS failure explains the CA route rather than suggesting an opt-out', () => {
  const message = safeError(new Error('self signed certificate in chain'), 'postgres://u@h/db').message
  assert.match(message, /CA certificate/i)
  assert.match(message, /cannot be disabled/i)
})

/** Records every statement issued so the transaction envelope can be asserted. */
function recordingClient(): { client: PgClient; statements: string[]; ended: () => boolean } {
  const statements: string[] = []
  let ended = false
  return {
    statements,
    ended: () => ended,
    client: {
      connect: async () => undefined,
      query: async (text: string) => {
        statements.push(text)
        return { rows: [{ n: 1 }], rowCount: 1 } as never
      },
      end: async () => { ended = true },
    },
  }
}

test('reads run inside a server-enforced READ ONLY transaction with a statement timeout', async () => {
  const { client, statements, ended } = recordingClient()
  await withReadOnlyTransaction(
    { connectionString: 'postgres://u@localhost/db', createClient: () => client },
    (c) => c.query('SELECT 1'),
  )
  assert.equal(statements[0], 'BEGIN TRANSACTION READ ONLY')
  assert.match(statements[1], /SET LOCAL statement_timeout/)
  assert.equal(statements[2], 'SELECT 1')
  assert.equal(statements[3], 'COMMIT')
  assert.ok(ended(), 'the client must always be closed')
})

test('a failed read rolls the connection up in a redacted error and still closes it', async () => {
  const connectionString = 'postgres://alice:s3cret@localhost/db'
  let ended = false
  const client: PgClient = {
    connect: async () => undefined,
    query: async () => { throw new Error(`boom at ${connectionString}`) },
    end: async () => { ended = true },
  }
  await assert.rejects(
    withReadOnlyTransaction({ connectionString, createClient: () => client }, (c) => c.query('SELECT 1')),
    (error: Error) => !error.message.includes('s3cret'),
  )
  assert.ok(ended, 'the client must be closed even on failure')
})

test('writes use a normal transaction and roll back on failure', async () => {
  const statements: string[] = []
  const client: PgClient = {
    connect: async () => undefined,
    query: async (text: string) => {
      statements.push(text)
      if (text.startsWith('INSERT')) throw new Error('constraint violation')
      return { rows: [], rowCount: 0 } as never
    },
    end: async () => undefined,
  }
  await assert.rejects(
    withWriteTransaction(
      { connectionString: 'postgres://u@localhost/db', createClient: () => client },
      (c) => c.query('INSERT INTO t VALUES (1)'),
    ),
  )
  assert.equal(statements[0], 'BEGIN')
  assert.ok(statements.includes('ROLLBACK'), statements.join(' | '))
  assert.ok(!statements.includes('COMMIT'), 'a failed write must not commit')
})
