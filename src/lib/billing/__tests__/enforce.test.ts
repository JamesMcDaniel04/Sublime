/**
 * DB-backed tests for plan-limit gates (enforce.ts). The capacity counts must
 * agree with what the product SHOWS as existing resources: the agents list
 * hides status DELETED (soft delete) and agentType SYSTEM (hidden org-
 * intelligence agent), so neither may consume a plan slot.
 *
 * Gated on TEST_DATABASE_URL like sync-subscription-e2e — see the `verify` skill.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let enforce: typeof import('../enforce')
  const orgIds: string[] = []

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    enforce = await import('../enforce')
  })
  after(async () => {
    for (const id of orgIds) await prisma.organization.delete({ where: { id } }).catch(() => {})
  })

  // STARTER carries the Individual limits: maxAgents 5.
  async function seedOrg() {
    const org = await prisma.organization.create({
      data: { name: 'Enforce', slug: `enforce-${crypto.randomUUID()}`, plan: 'STARTER' },
    })
    orgIds.push(org.id)
    return org
  }

  const agent = (organizationId: string, over: Record<string, unknown> = {}) =>
    prisma.agentTask.create({
      data: { description: 'd', objective: 'o', organizationId, ...over },
    })

  test('soft-deleted agents do not consume plan capacity', async () => {
    const org = await seedOrg()
    for (let i = 0; i < 5; i++) await agent(org.id, { status: 'DELETED' })
    // 5 deleted agents on a 5-cap plan: creating a live agent must be allowed.
    await assert.doesNotReject(() => enforce.assertAgentCapacity(org.id))
  })

  test('hidden SYSTEM agents do not consume plan capacity', async () => {
    const org = await seedOrg()
    await agent(org.id, { agentType: 'SYSTEM' })
    for (let i = 0; i < 4; i++) await agent(org.id)
    // 4 visible + 1 invisible SYSTEM on a 5-cap plan: the 5th visible slot
    // must still be available.
    await assert.doesNotReject(() => enforce.assertAgentCapacity(org.id))
  })

  test('live visible agents at cap are rejected', async () => {
    const org = await seedOrg()
    for (let i = 0; i < 5; i++) await agent(org.id)
    await assert.rejects(() => enforce.assertAgentCapacity(org.id), (err: any) => err?.code === 'PLAN_LIMIT')
  })

  test('flowCapacityAvailable: false at cap, true below — never throws', async () => {
    const org = await seedOrg()
    // STARTER maxFlows is 5.
    assert.equal(await enforce.flowCapacityAvailable(org.id), true)
    for (let i = 0; i < 5; i++) {
      await prisma.flow.create({
        data: { name: `f${i}`, organizationId: org.id, status: 'DRAFT', graph: { nodes: [], edges: [] } },
      })
    }
    assert.equal(await enforce.flowCapacityAvailable(org.id), false)
  })

  test('orgUsageSummary reports what the UI shows: no DELETED, no SYSTEM', async () => {
    const org = await seedOrg()
    await agent(org.id)
    await agent(org.id, { status: 'DELETED' })
    await agent(org.id, { agentType: 'SYSTEM' })
    const usage = await enforce.orgUsageSummary(org.id)
    assert.equal(usage.agents, 1, 'only the one live visible agent counts')
  })
}
