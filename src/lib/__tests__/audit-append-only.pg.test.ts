/**
 * audit_events is append-only at the DATABASE layer (migration
 * 20260819130000_audit_events_append_only), not merely in application code.
 *
 * The threat: anyone holding the app's DB credential could otherwise rewrite or
 * erase the audit trail — including the rows recording their own actions. The
 * trigger refuses every UPDATE and refuses DELETE of any row newer than the
 * 90-day retention floor, while still letting the nightly retention sweep prune
 * genuinely aged-out rows.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  const recentId = `aud_recent_${Date.now()}`
  const agedId = `aud_aged_${Date.now()}`

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    await prisma.auditEvent.create({ data: { id: recentId, action: 'test.recent', actorKind: 'system' } })
    // INSERT is allowed; the trigger fires only on UPDATE/DELETE. An explicit
    // aged createdAt is the only way to stage a deletable row.
    await prisma.$executeRawUnsafe(
      `INSERT INTO audit_events (id, action, "actorKind", "createdAt") VALUES ($1, 'test.aged', 'system', now() - interval '200 days')`,
      agedId,
    )
  })

  after(async () => {
    // Cleanup must bypass the guard the test is proving — session_replication_role
    // = replica disables triggers for the owning role, the standard escape hatch
    // for maintenance. Best-effort on a throwaway QA database.
    await prisma.$executeRawUnsafe(`SET session_replication_role = replica`).catch(() => {})
    await prisma.$executeRawUnsafe(`DELETE FROM audit_events WHERE id = ANY($1::text[])`, [recentId, agedId]).catch(() => {})
    await prisma.$executeRawUnsafe(`SET session_replication_role = origin`).catch(() => {})
    await prisma.$disconnect?.()
  })

  test('UPDATE of an audit row is refused by the database', async () => {
    await assert.rejects(
      prisma.$executeRawUnsafe(`UPDATE audit_events SET action = 'tampered' WHERE id = $1`, recentId),
      /append-only/i,
    )
  })

  test('DELETE of a recent audit row is refused', async () => {
    await assert.rejects(
      prisma.$executeRawUnsafe(`DELETE FROM audit_events WHERE id = $1`, recentId),
      /append-only|retention floor/i,
    )
  })

  test('DELETE of a row past the retention floor succeeds (retention still works)', async () => {
    const deleted = await prisma.auditEvent.deleteMany({ where: { id: agedId } })
    assert.equal(deleted.count, 1)
  })

  test('the ON DELETE SET NULL cascade is permitted (workspace delete keeps the audit trail)', async () => {
    // A workspace delete nulls organizationId on its audit rows so the trail
    // survives as orphans. The append-only trigger must NOT block that cascade.
    const org = await prisma.organization.create({ data: { name: 'Cascade QA', slug: `casc-${Date.now()}` } })
    const rowId = `aud_cascade_${Date.now()}`
    await prisma.auditEvent.create({ data: { id: rowId, action: 'test.cascade', actorKind: 'system', organizationId: org.id } })
    // Deleting the org fires the SET NULL cascade — this must not throw.
    await prisma.organization.delete({ where: { id: org.id } })
    const survivor = await prisma.auditEvent.findUnique({ where: { id: rowId } })
    assert.ok(survivor, 'audit row did not survive the workspace delete')
    assert.equal(survivor.organizationId, null)
    // Cleanup: age it out then delete (trigger-bypass for a recent row).
    await prisma.$executeRawUnsafe(`SET session_replication_role = replica`).catch(() => {})
    await prisma.$executeRawUnsafe(`DELETE FROM audit_events WHERE id = $1`, rowId).catch(() => {})
    await prisma.$executeRawUnsafe(`SET session_replication_role = origin`).catch(() => {})
  })
}
