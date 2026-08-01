/**
 * /api/system/behavior is the CRON_SECRET-gated operator seam for the
 * behavior-intelligence pipeline. Hand-rolled auth (not withAuthenticatedApi)
 * means only a test checks it — the same reason the cron routes have theirs.
 *
 * Gated on TEST_DATABASE_URL: the sweep/run legs hit the database.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  const SECRET = `behavior-test-${crypto.randomUUID()}`
  let prisma: any
  let orgId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const org = await prisma.organization.create({
      data: { name: 'Behavior', slug: `behavior-${crypto.randomUUID()}` },
    })
    orgId = org.id
  })
  after(async () => {
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {})
  })

  const post = async (body: unknown, auth?: string) => {
    const { POST } = await import('../system/behavior/route')
    return POST(
      new Request('http://test/api/system/behavior', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
      }),
    )
  }

  test('fails closed: 503 with no CRON_SECRET, 401 on wrong or missing bearer', async () => {
    delete process.env.CRON_SECRET
    assert.equal((await post({ action: 'sweep', organizationId: orgId }, `Bearer ${SECRET}`)).status, 503)

    process.env.CRON_SECRET = SECRET
    assert.equal((await post({ action: 'sweep', organizationId: orgId })).status, 401)
    assert.equal((await post({ action: 'sweep', organizationId: orgId }, 'Bearer wrong')).status, 401)
  })

  test('valid secret: malformed body is 400, sweep runs and reports', async () => {
    process.env.CRON_SECRET = SECRET
    assert.equal((await post({ action: 'nope' }, `Bearer ${SECRET}`)).status, 400)
    assert.equal((await post({ action: 'run-user', organizationId: orgId }, `Bearer ${SECRET}`)).status, 400, 'run-user without userId')

    const res = await post({ action: 'sweep', organizationId: orgId }, `Bearer ${SECRET}`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.success, true)
    assert.equal(body.action, 'sweep')
  })
}
