import assert from 'node:assert/strict'
import test from 'node:test'
import type { PgClient } from '../client'
import { PostgresToolClient, postgresTools, truncateRows, MAX_RESULT_ROWS } from '../tools'

const connection = (allowWrites: boolean) => ({
  id: 'pg1',
  name: 'Prod DB',
  connectionString: 'postgres://u@localhost/db',
  allowWrites,
  defaultSchema: 'public',
})

function fakeClient(rows: Record<string, unknown>[] = [{ n: 1 }]) {
  const statements: string[] = []
  const client: PgClient = {
    connect: async () => undefined,
    query: async (text: string) => {
      statements.push(text)
      return { rows, rowCount: rows.length } as never
    },
    end: async () => undefined,
  }
  return { client, statements }
}

test('the write tool is offered only when the connection allows writes', () => {
  assert.deepEqual(
    postgresTools(false).map((tool) => tool.name),
    ['list_tables', 'describe_schema', 'query'],
  )
  assert.ok(postgresTools(true).some((tool) => tool.name === 'execute'))
})

test('tool names avoid the scan sampler’s read allowlist for the SQL tools', () => {
  // The generic scan picks read-looking tools by regex and calls them with
  // EMPTY ARGS. `query`/`execute` must not read as list/describe operations,
  // or the sampler would invoke them with no SQL.
  const readAllowlist = /(list|get|search|recent|fetch|read|find|history|describe)/i
  const sqlTools = postgresTools(true).filter((tool) => ['query', 'execute'].includes(tool.name))
  assert.equal(sqlTools.length, 2)
  for (const tool of sqlTools) {
    assert.ok(!readAllowlist.test(tool.name), `${tool.name} must not look like a listing tool`)
  }
})

test('a read query runs inside the READ ONLY envelope', async () => {
  const { client, statements } = fakeClient([{ total: 7 }])
  const result = await new PostgresToolClient(connection(false), () => client).executeTool(
    '',
    'query',
    { sql: 'SELECT count(*) AS total FROM orders' },
  )
  assert.equal(statements[0], 'BEGIN TRANSACTION READ ONLY')
  assert.deepEqual(result, { rows: [{ total: 7 }], rowCount: 1 })
})

test('a read query that is not read-only is refused before connecting', async () => {
  const { client, statements } = fakeClient()
  await assert.rejects(
    new PostgresToolClient(connection(true), () => client).executeTool('', 'query', {
      sql: 'DELETE FROM orders WHERE id = 1',
    }),
    /must start with SELECT or WITH/i,
  )
  assert.equal(statements.length, 0, 'validation must happen before any statement is issued')
})

test('a SELECT-shaped statement hiding a mutation is refused by the denylist', async () => {
  const { client, statements } = fakeClient()
  await assert.rejects(
    new PostgresToolClient(connection(true), () => client).executeTool('', 'query', {
      sql: 'WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x',
    }),
    /read-only/i,
  )
  assert.equal(statements.length, 0)
})

test('the write tool refuses to run when the connection disallows writes', async () => {
  const { client, statements } = fakeClient()
  await assert.rejects(
    new PostgresToolClient(connection(false), () => client).executeTool('', 'execute', {
      sql: 'UPDATE orders SET status = 1 WHERE id = 2',
    }),
    /Writes are disabled/i,
  )
  assert.equal(statements.length, 0)
})

test('an allowed write runs in a normal transaction and reports rows affected', async () => {
  const { client, statements } = fakeClient([{ ok: true }])
  const result = await new PostgresToolClient(connection(true), () => client).executeTool('', 'execute', {
    sql: 'UPDATE orders SET status = 1 WHERE id = 2',
  })
  assert.equal(statements[0], 'BEGIN')
  assert.ok(!statements.includes('BEGIN TRANSACTION READ ONLY'))
  assert.deepEqual(result, { rowCount: 1 })
})

test('an unknown tool name is refused', async () => {
  const { client } = fakeClient()
  await assert.rejects(
    new PostgresToolClient(connection(true), () => client).executeTool('', 'drop_everything', {}),
    /Unknown Postgres tool/,
  )
})

test('result truncation bounds both row count and serialized size', () => {
  const many = Array.from({ length: MAX_RESULT_ROWS + 50 }, (_, i) => ({ i }))
  const byRows = truncateRows(many)
  assert.equal(byRows.rows.length, MAX_RESULT_ROWS)
  assert.equal(byRows.truncated, true)
  assert.equal(byRows.totalRows, MAX_RESULT_ROWS + 50)

  // Few rows, but each enormous: the char budget has to bite independently.
  const fat = Array.from({ length: 20 }, () => ({ blob: 'x'.repeat(20_000) }))
  const byChars = truncateRows(fat)
  assert.ok(byChars.rows.length < 20, 'a wide result must be truncated by size')
  assert.equal(byChars.truncated, true)
})
