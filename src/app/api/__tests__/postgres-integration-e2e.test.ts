/**
 * The native Postgres integration end to end, against a real database and
 * real route handlers.
 *
 * The test Postgres plays BOTH roles: the app's own store, and the "customer
 * database" being connected. That is what makes this a real exercise of the
 * connect → verify → introspect → query → guarded-write path rather than a
 * mock of it. Every leg below caught something the unit suites could not:
 * a background scan failing the response, an introspection cap swallowing an
 * explicitly-named table, and an unscoped write reaching the tenant guard.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let cleanup: (() => Promise<void>) | undefined

  const json = (path: string, method: string, body?: unknown) =>
    new NextRequest(new URL(`http://test${path}`), {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: { 'content-type': 'application/json' },
    } as never)

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    cleanup = seeded.cleanup
    // Connecting a database is an admin action — a production credential is
    // workspace infrastructure.
    await prisma.user.update({ where: { id: seeded.auth.dbUser.id }, data: { role: 'ADMIN' } })
    seeded.auth.dbUser.role = 'ADMIN'
    installTestAuth(seeded.auth)
  })

  after(async () => { await cleanup?.() })

  test('connect stores the secret encrypted, verifies it, and mirrors it to the grid', async () => {
    const { POST } = await import('../postgres/connections/route')
    const response = await POST(json('/api/postgres/connections', 'POST', {
      name: 'QA warehouse',
      connectionString: TEST_DB,
    }))
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))

    const connection = body.connection
    assert.equal(connection.status, 'connected')
    assert.equal(connection.allowWrites, false, 'writes must default off')
    // No response may ever carry the connection string, in any form.
    assert.ok(!JSON.stringify(body).includes('://'), 'no connection string may leave the API')

    const stored = await prisma.postgresConnection.findFirst({
      where: { id: connection.id, organizationId: seeded.organizationId },
      select: { authConfig: true },
    })
    assert.ok(
      !JSON.stringify(stored.authConfig).includes('://'),
      'the stored blob must be ciphertext, not a readable URL',
    )

    // The grid, /api/nango/status and the scan plane all read this mirror.
    const mirror = await prisma.nangoConnection.findFirst({
      where: { organizationId: seeded.organizationId, connectionId: connection.id },
      select: { providerConfigKey: true, provider: true, status: true },
    })
    assert.deepEqual(mirror, { providerConfigKey: 'postgres', provider: 'postgres-native', status: 'connected' })
  })

  test('the tool plane exposes read tools that introspect and query for real', async () => {
    const { loadPostgresPlaneGroups } = await import('@/features/agents/tool-planes')
    const [group] = await loadPostgresPlaneGroups(seeded.organizationId)
    assert.ok(group?.client, 'a connected database must produce a plane group with a live client')
    assert.equal(group.provider, 'postgres', 'a read-only connection is not a write plane')
    assert.deepEqual(group.tools.map((tool: any) => tool.name), ['list_tables', 'describe_schema', 'query'])

    const listed = await group.client.executeTool('', 'list_tables', {})
    assert.ok(
      listed.tables.some((row: any) => row.table === 'postgres_connections'),
      'list_tables must report real tables',
    )

    // Regression: the describe-everything cap must not apply when a specific
    // table is named — 'postgres_connections' sorts past it in a real schema.
    const described = await group.client.executeTool('', 'describe_schema', { table: 'postgres_connections' })
    assert.ok(described.columns.some((c: any) => c.column === 'allowWrites'))
    assert.ok(described.columns.some((c: any) => c.column === 'id' && c.isPrimaryKey))

    const queried = await group.client.executeTool('', 'query', {
      sql: 'SELECT count(*) AS n FROM postgres_connections',
    })
    assert.equal(String(queried.rows[0].n), '1')
  })

  test('the server-enforced READ ONLY transaction refuses what the denylist misses', async () => {
    const { loadPostgresPlaneGroups } = await import('@/features/agents/tool-planes')
    const [group] = await loadPostgresPlaneGroups(seeded.organizationId)
    assert.ok(group?.client)
    // `SELECT ... INTO` creates a table but carries no denylisted keyword, so
    // the SERVER is the only thing that can refuse it. This is the probe that
    // proves layer 2 is real rather than decorative.
    await assert.rejects(
      group.client.executeTool('', 'query', { sql: 'SELECT 1 AS n INTO smoke_side_effect' }),
      /read-only transaction/i,
    )
    const leaked = await prisma.$queryRawUnsafe(
      "SELECT to_regclass('public.smoke_side_effect') IS NOT NULL AS created",
    )
    assert.equal(leaked[0].created, false, 'nothing may have been created')
  })

  test('writes are refused until the connection opts in, then are approval-gated', async () => {
    const { loadPostgresPlaneGroups } = await import('@/features/agents/tool-planes')
    const row = await prisma.postgresConnection.findFirst({
      where: { organizationId: seeded.organizationId },
      select: { id: true },
    })

    const [readOnly] = await loadPostgresPlaneGroups(seeded.organizationId)
    assert.ok(readOnly?.client, 'the read-only connection must load')
    await assert.rejects(
      readOnly.client.executeTool('', 'execute', { sql: "DELETE FROM postgres_connections WHERE id = 'x'" }),
      /Writes are disabled/i,
    )

    const { PATCH } = await import('../postgres/connections/[id]/route')
    const patched = await PATCH(json(`/api/postgres/connections/${row.id}`, 'PATCH', { allowWrites: true }))
    assert.equal(patched.status, 200, await patched.clone().text())

    const [writable] = await loadPostgresPlaneGroups(seeded.organizationId)
    assert.ok(writable?.client, 'the write-enabled connection must still load')
    assert.equal(writable.provider, 'postgres:write')
    assert.ok(writable.tools.some((tool: any) => tool.name === 'execute'))

    // The whole point of the separate provider: approval is mandatory even
    // for an agent that never opted into approvals.
    const { toolNeedsApproval } = await import('@/features/agents/approval')
    assert.equal(toolNeedsApproval({ requireApproval: false, provider: writable.provider }), true)

    // Enabled writes still mean ROWS, never schema — and never unqualified.
    await assert.rejects(
      writable.client.executeTool('', 'execute', { sql: 'DROP TABLE postgres_connections' }),
      /INSERT, UPDATE, or DELETE/i,
    )
    await assert.rejects(
      writable.client.executeTool('', 'execute', { sql: 'DELETE FROM postgres_connections' }),
      /WHERE/i,
    )

    const wrote = await writable.client.executeTool('', 'execute', {
      sql: `UPDATE postgres_connections SET "defaultSchema" = 'public' WHERE id = '${row.id}'`,
    })
    assert.equal(wrote.rowCount, 1)
  })

  test('a goal metric binds to the connection and the picker offers it', async () => {
    const row = await prisma.postgresConnection.findFirst({
      where: { organizationId: seeded.organizationId },
      select: { id: true, name: true },
    })

    const { postgresMetricSource } = await import('@/lib/metrics/sources/postgres')
    const reading = await postgresMetricSource.fetchValue(
      {
        organizationId: seeded.organizationId,
        userId: seeded.auth.dbUser.id,
        connectionRef: `postgres:${row.id}`,
        config: { query: 'SELECT count(*) FROM postgres_connections' },
      },
      'postgres.query',
    )
    assert.equal(reading.value, 1)

    const { listMetricSourceOptions } = await import('@/lib/metrics/available-sources')
    const options = await listMetricSourceOptions(seeded.auth)
    const postgres = options.find((option: any) => option.source === 'postgres')
    assert.ok(
      postgres?.connections?.some((c: any) => c.ref === `postgres:${row.id}` && c.label === row.name),
      'the connected database must appear in the goal source picker',
    )
  })

  test('an unreachable database still saves, with a redacted reason visible', async () => {
    const { POST } = await import('../postgres/connections/route')
    // Save-then-test: a database behind a VPN must be recordable before the
    // network path exists, or the user can never save it at all.
    const response = await POST(json('/api/postgres/connections', 'POST', {
      name: 'Behind a VPN',
      connectionString: 'postgres://nobody:hunter2@127.0.0.1:1/nowhere',
    }))
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.connection.status, 'error')
    assert.ok(body.connection.lastError, 'the reason must be visible on the row')
    assert.ok(!JSON.stringify(body).includes('hunter2'), 'a password must never surface in an error')
  })

  test('disconnect removes the row and its grid mirror', async () => {
    const row = await prisma.postgresConnection.findFirst({
      where: { organizationId: seeded.organizationId, name: 'Behind a VPN' },
      select: { id: true },
    })
    const { DELETE } = await import('../postgres/connections/[id]/route')
    const response = await DELETE(json(`/api/postgres/connections/${row.id}`, 'DELETE'))
    assert.equal(response.status, 200)

    assert.equal(
      await prisma.postgresConnection.count({ where: { organizationId: seeded.organizationId, id: row.id } }),
      0,
    )
    assert.equal(
      await prisma.nangoConnection.count({ where: { organizationId: seeded.organizationId, connectionId: row.id } }),
      0,
      'the grid mirror must not outlive the connection',
    )
  })

  test('a non-admin cannot connect a database', async () => {
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    // Explicitly MEMBER: seedTestOrg defaults to ADMIN (matching how production
    // provisions a workspace creator), so a refusal test must say what it means.
    const member = await seedTestOrg(prisma, { role: 'MEMBER' })
    try {
      installTestAuth(member.auth)
      const { POST } = await import('../postgres/connections/route')
      const response = await POST(json('/api/postgres/connections', 'POST', {
        name: 'Sneaky',
        connectionString: TEST_DB,
      }))
      assert.equal(response.status, 403)
    } finally {
      await member.cleanup()
      installTestAuth(seeded.auth)
    }
  })
}
