/**
 * Flow static data against a real database.
 *
 * The partition rule is unit-tested; this covers what it cannot — persistence
 * across runs, org scoping, and the concurrency guarantee.
 *
 * That last one is the whole point. Two runs of the same flow polling at once
 * both read the same seen-set, both conclude the same rows are new, and both
 * act on them — the double-send dedupe exists to prevent, and it appears only
 * under the load where it hurts most. `takeUnseen` locks the row, so this test
 * is the evidence that it does.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  test('flow static data', async (t) => {
    const { prisma } = await import('@/lib/prisma')
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    const { readStaticData, writeStaticData, takeUnseen } = await import('../static-store')

    const seeded = await seedTestOrg(prisma)
    const other = await seedTestOrg(prisma)
    after(async () => {
      await seeded.cleanup()
      await other.cleanup()
      await prisma.$disconnect()
    })

    const makeFlow = (orgId: string, userId: string) =>
      prisma.flow.create({ data: { name: `f-${Date.now()}-${Math.round(Math.random() * 1e6)}`, organizationId: orgId, userId } })

    await t.test('a value written in one run reads back in the next', async () => {
      const flow = await makeFlow(seeded.auth.organizationId, seeded.auth.dbUser.id)
      await writeStaticData(seeded.auth.organizationId, flow.id, 'cursor', { at: '2026-01-01' })
      assert.deepEqual(await readStaticData(seeded.auth.organizationId, flow.id, 'cursor'), { at: '2026-01-01' })
    })

    await t.test('writing the same key updates rather than duplicating', async () => {
      const flow = await makeFlow(seeded.auth.organizationId, seeded.auth.dbUser.id)
      await writeStaticData(seeded.auth.organizationId, flow.id, 'cursor', { n: 1 })
      await writeStaticData(seeded.auth.organizationId, flow.id, 'cursor', { n: 2 })
      assert.deepEqual(await readStaticData(seeded.auth.organizationId, flow.id, 'cursor'), { n: 2 })
      const rows = await prisma.flowStaticData.count({ where: { organizationId: seeded.auth.organizationId, flowId: flow.id } })
      assert.equal(rows, 1)
    })

    await t.test('another workspace cannot read this flow state', async () => {
      const flow = await makeFlow(seeded.auth.organizationId, seeded.auth.dbUser.id)
      await writeStaticData(seeded.auth.organizationId, flow.id, 'cursor', { secret: true })
      assert.equal(await readStaticData(other.auth.organizationId, flow.id, 'cursor'), undefined)
    })

    await t.test('an item is emitted once across separate runs', async () => {
      const flow = await makeFlow(seeded.auth.organizationId, seeded.auth.dbUser.id)
      const batch = [{ id: 'a' }, { id: 'b' }]

      const first = await takeUnseen(seeded.auth.organizationId, flow.id, batch, 'id')
      assert.equal(first.fresh.length, 2)

      // Same batch again — a poll that returned the same page.
      const second = await takeUnseen(seeded.auth.organizationId, flow.id, batch, 'id')
      assert.equal(second.fresh.length, 0, 'a second run re-emitted rows it had already seen')

      // …and a genuinely new row still comes through.
      const third = await takeUnseen(seeded.auth.organizationId, flow.id, [...batch, { id: 'c' }], 'id')
      assert.deepEqual(third.fresh, [{ id: 'c' }])
    })

    // The guarantee that needs a database to demonstrate.
    await t.test('two concurrent runs cannot both claim the same rows', async () => {
      const flow = await makeFlow(seeded.auth.organizationId, seeded.auth.dbUser.id)
      const batch = Array.from({ length: 20 }, (_, i) => ({ id: `x${i}` }))

      const [a, b] = await Promise.all([
        takeUnseen(seeded.auth.organizationId, flow.id, batch, 'id'),
        takeUnseen(seeded.auth.organizationId, flow.id, batch, 'id'),
      ])

      // Every row claimed exactly once between them, not twice.
      assert.equal(a.fresh.length + b.fresh.length, 20, 'a row was emitted by both runs, or lost by both')
    })

    await t.test('items with no id field dedupe by content', async () => {
      const flow = await makeFlow(seeded.auth.organizationId, seeded.auth.dbUser.id)
      const batch = [{ name: 'a' }, { name: 'b' }]
      assert.equal((await takeUnseen(seeded.auth.organizationId, flow.id, batch, 'id')).fresh.length, 2)
      assert.equal((await takeUnseen(seeded.auth.organizationId, flow.id, batch, 'id')).fresh.length, 0)
    })

    await t.test('deleting a flow takes its state with it', async () => {
      const flow = await makeFlow(seeded.auth.organizationId, seeded.auth.dbUser.id)
      await writeStaticData(seeded.auth.organizationId, flow.id, 'cursor', { n: 1 })
      await prisma.flow.deleteMany({ where: { id: flow.id, organizationId: seeded.auth.organizationId } })
      const rows = await prisma.flowStaticData.count({ where: { organizationId: seeded.auth.organizationId, flowId: flow.id } })
      assert.equal(rows, 0, 'the cascade should have removed the state')
    })
  })
} else {
  test('flow static data (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
