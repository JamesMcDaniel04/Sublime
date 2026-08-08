import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'

  let prisma: any
  let seeded: any
  const realFetch = global.fetch

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    await prisma.user.update({
      where: { id: seeded.userId, organizationId: seeded.organizationId },
      data: { role: 'ADMIN' },
    })
    seeded.auth.dbUser.role = 'ADMIN'
    installTestAuth(seeded.auth)
    // Stub Slack auth.test — no live network in tests.
    global.fetch = (async (url: any, init?: any) => {
      if (String(url) === 'https://slack.com/api/auth.test') {
        return new Response(JSON.stringify({ ok: true, team_id: 'T0AAA111', team: 'Acme', user_id: 'U0BOT9999' }))
      }
      return realFetch(url, init)
    }) as typeof fetch
  })

  after(async () => {
    global.fetch = realFetch
    if (seeded) {
      await prisma.slackWorkspaceConnection.deleteMany({ where: { organizationId: seeded.organizationId } })
      await seeded.cleanup()
    }
  })

  const jsonReq = (method: string, body?: unknown, query = '') =>
    new NextRequest(new URL(`http://test/api/slack/connections${query}`), {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

  test('POST verifies via auth.test, encrypts, upserts, and returns a redacted binding', async () => {
    const { POST } = await import('@/app/api/slack/connections/route')
    const res = await POST(jsonReq('POST', { botToken: 'xoxb-live-token', signingSecret: 'sig-secret-1' }))
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.success, true)
    assert.equal(data.connection.teamId, 'T0AAA111')
    assert.equal(data.connection.botUserId, 'U0BOT9999')
    assert.equal(data.connection.hasBotToken, true)
    assert.ok(data.connection.ingressUrl.includes('/api/slack/events/'))
    assert.ok(!JSON.stringify(data).includes('xoxb-live-token'))
    assert.ok(!JSON.stringify(data).includes('sig-secret-1'))
    // Encrypted at rest, and posting again upserts the same (org, team) row.
    const row = await prisma.slackWorkspaceConnection.findFirst({ where: { organizationId: seeded.organizationId, teamId: 'T0AAA111' } })
    assert.ok(!JSON.stringify(row.botToken).includes('xoxb-live-token'))
    const res2 = await POST(jsonReq('POST', { botToken: 'xoxb-rotated', signingSecret: 'sig-secret-2' }))
    assert.equal((await res2.json()).connection.id, data.connection.id)
  })

  test('workspace members cannot list, execute, or delete another member\'s Slack credential', async () => {
    const { POST, GET, DELETE } = await import('@/app/api/slack/connections/route')
    const owner = await prisma.slackWorkspaceConnection.findFirstOrThrow({
      where: { organizationId: seeded.organizationId, userId: seeded.userId },
    })
    const other = await prisma.user.create({
      data: {
        supabaseId: crypto.randomUUID(),
        organizationId: seeded.organizationId,
        isActive: true,
        role: 'MEMBER',
      },
    })
    const { installTestAuth, makeTestAuthContext } = await import('@/lib/server/__tests__/test-auth')
    installTestAuth(makeTestAuthContext({
      organizationId: seeded.organizationId,
      userId: other.supabaseId,
      dbUser: other,
      user: { id: other.supabaseId } as never,
      role: 'MEMBER',
    }))
    try {
      const list = await (await GET(jsonReq('GET'))).json()
      assert.equal(list.connections.length, 0)
      const denied = await DELETE(jsonReq('DELETE', undefined, `?id=${owner.id}`))
      assert.equal(denied.status, 404)

      const connected = await POST(jsonReq('POST', { botToken: 'xoxb-other', signingSecret: 'sig-other' }))
      assert.equal(connected.status, 200)
      const otherId = (await connected.json()).connection.id
      assert.notEqual(otherId, owner.id, 'the same Slack team is a separate user-owned credential')
      await DELETE(jsonReq('DELETE', undefined, `?id=${otherId}`))
    } finally {
      installTestAuth(seeded.auth)
    }
  })

  test('GET lists redacted bindings; DELETE removes the row', async () => {
    const { GET, DELETE } = await import('@/app/api/slack/connections/route')
    const list = await (await GET(jsonReq('GET'))).json()
    assert.equal(list.connections.length, 1)
    const id = list.connections[0].id
    const del = await DELETE(jsonReq('DELETE', undefined, `?id=${id}`))
    assert.equal((await del.json()).success, true)
    assert.equal(await prisma.slackWorkspaceConnection.count({ where: { organizationId: seeded.organizationId } }), 0)
  })
} else {
  test('slack connections route (skipped — TEST_DATABASE_URL not set)', () => {})
}
