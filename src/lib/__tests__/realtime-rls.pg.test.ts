/**
 * Realtime RLS helpers must admit every identity that resolves to a member —
 * findDbUser (auth-utils) resolves users via users.supabaseId OR a
 * user_identities row, so a member signed in through a LINKED identity is a
 * fully authenticated app user. can_access_run_events previously matched
 * users.supabaseId only: such a member failed the channel join and silently
 * degraded to polling (run events) or lost collaboration (flow jam).
 *
 * Drives the REAL functions in the QA Postgres by redefining the stubbed
 * auth.uid() per assertion (the verify-skill stub returns NULL by default).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  const cleanup: Array<() => Promise<unknown>> = []

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
  })
  after(async () => {
    for (const step of cleanup.reverse()) await step().catch(() => {})
    if (prisma) {
      await prisma.$executeRawUnsafe(
        `CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid'`,
      )
    }
  })

  const actAs = (supabaseId: string | null) =>
    prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT ${supabaseId ? `'${supabaseId}'::uuid` : 'NULL::uuid'} $$`,
    )

  const canAccessRunEvents = async (topic: string): Promise<boolean> => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT public.can_access_run_events($1) AS ok`,
      topic,
    )
    return rows[0].ok === true
  }

  test('run-events join: primary identity, linked identity, and stranger', async () => {
    const primaryId = crypto.randomUUID()
    const linkedId = crypto.randomUUID()
    const strangerId = crypto.randomUUID()

    const org = await prisma.organization.create({
      data: { name: 'RLS', slug: `rls-${crypto.randomUUID()}` },
    })
    cleanup.push(() => prisma.organization.delete({ where: { id: org.id } }))
    const user = await prisma.user.create({
      data: { email: `rls-${crypto.randomUUID()}@example.com`, supabaseId: primaryId, organizationId: org.id, isActive: true },
    })
    cleanup.push(() => prisma.user.delete({ where: { id: user.id } }))
    const identity = await prisma.userIdentity.create({
      data: { supabaseId: linkedId, userId: user.id, provider: 'google' },
    })
    cleanup.push(() => prisma.userIdentity.delete({ where: { id: identity.id } }).catch(() => {}))

    const topic = `run-events:${org.id}`

    await actAs(primaryId)
    assert.equal(await canAccessRunEvents(topic), true, 'primary identity joins')

    await actAs(linkedId)
    assert.equal(await canAccessRunEvents(topic), true, 'linked identity joins')

    await actAs(strangerId)
    assert.equal(await canAccessRunEvents(topic), false, 'stranger rejected')

    await actAs(null)
    assert.equal(await canAccessRunEvents(topic), false, 'anonymous rejected')
  })

  test('flow-jam join honors linked identities the same way', async () => {
    const linkedId = crypto.randomUUID()
    const org = await prisma.organization.create({
      data: { name: 'RLSJ', slug: `rlsj-${crypto.randomUUID()}` },
    })
    cleanup.push(() => prisma.organization.delete({ where: { id: org.id } }))
    const user = await prisma.user.create({
      data: { email: `rlsj-${crypto.randomUUID()}@example.com`, supabaseId: crypto.randomUUID(), organizationId: org.id, isActive: true },
    })
    cleanup.push(() => prisma.user.delete({ where: { id: user.id } }))
    const identity = await prisma.userIdentity.create({
      data: { supabaseId: linkedId, userId: user.id, provider: 'google' },
    })
    cleanup.push(() => prisma.userIdentity.delete({ where: { id: identity.id } }).catch(() => {}))
    const flow = await prisma.flow.create({
      data: { name: 'jam-rls', organizationId: org.id, userId: user.id, status: 'DRAFT', graph: { nodes: [], edges: [] } },
    })
    cleanup.push(() => prisma.flow.delete({ where: { id: flow.id } }).catch(() => {}))

    await actAs(linkedId)
    const rows = await prisma.$queryRawUnsafe(
      `SELECT public.can_access_flow_jam($1) AS ok`,
      `flow-jam:${flow.id}`,
    )
    assert.equal(rows[0].ok, true, 'owner via linked identity joins the jam channel')
  })
}
