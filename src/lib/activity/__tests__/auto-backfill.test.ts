import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { autoBackfillSource, SLACK_BACKFILL_WINDOW } from '../auto-backfill'

test('slack backfill uses the same 90d window as the Nango sources', () => {
  // A divergent window would show up later as inconsistent windowDays across
  // an org's baselines, and confidence scales with coverage.
  assert.equal(SLACK_BACKFILL_WINDOW, '90d')
})

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

  test('triggerSlackBackfill starts once and does not restart on reconnect', async () => {
    const { triggerSlackBackfill } = await import('../auto-backfill')
    await triggerSlackBackfill(organizationId, 'slack-conn-1')
    const first = await prisma.activityBackfill.findMany({ where: { organizationId, source: 'slack' } })
    assert.equal(first.length, 1)
    assert.equal(first[0].connectionRef, 'slack-conn-1')
    assert.equal(first[0].window, '90d')

    // The Slack connections route upserts on every token save, and
    // startActivityBackfill resets cursor + eventsIngested. Without a guard a
    // routine settings save would restart a 90-day pull from zero.
    await prisma.activityBackfill.update({
      where: { id: first[0].id },
      data: { status: 'running', cursor: 'page-7', eventsIngested: 400 },
    })
    await triggerSlackBackfill(organizationId, 'slack-conn-1')
    const second = await prisma.activityBackfill.findMany({ where: { organizationId, source: 'slack' } })
    assert.equal(second.length, 1)
    assert.equal(second[0].cursor, 'page-7')
    assert.equal(second[0].eventsIngested, 400)
  })
} else {
  test('auto-backfill trigger (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
