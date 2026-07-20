import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { autoBackfillSource } from '../auto-backfill'

test('autoBackfillSource: github provider keys map; slack and adapterless providers do not', () => {
  assert.equal(autoBackfillSource('github-app'), 'github')
  assert.equal(autoBackfillSource('github'), 'github')
  assert.equal(autoBackfillSource('slack'), null) // slack's adapter keys on SlackWorkspaceConnection.id, not a Nango id
  assert.equal(autoBackfillSource('salesforce'), null) // no adapter registered
  assert.equal(autoBackfillSource('unknown-thing'), null)
})

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  let prisma: any
  let seeded: any
  let organizationId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    organizationId = seeded.organizationId
  })
  after(async () => { if (seeded) await seeded.cleanup() })

  test('triggerAutoBackfills creates a 90d backfill row for adapter-backed sources only', async () => {
    const { triggerAutoBackfills } = await import('../auto-backfill')
    await triggerAutoBackfills(organizationId, [
      { connectionId: 'conn-gh-1', providerConfigKey: 'github-app' },
      { connectionId: 'conn-sf-1', providerConfigKey: 'salesforce' },
    ])
    const rows = await prisma.activityBackfill.findMany({ where: { organizationId } })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].source, 'github')
    assert.equal(rows[0].connectionRef, 'conn-gh-1')
    assert.equal(rows[0].window, '90d')
  })
} else {
  test('auto-backfill trigger (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
