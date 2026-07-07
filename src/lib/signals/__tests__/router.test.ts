import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
const ENABLED = Boolean(TEST_DB)

if (!ENABLED) {
  test('signal router (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}

if (ENABLED) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let routeSignal: any
  let matchesFilter: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ routeSignal, matchesFilter } = await import('../router'))

    const org = await prisma.organization.create({ data: { name: 'R', slug: `r-${Date.now()}` } })
    const user = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), organizationId: org.id },
    })
    const agent = await prisma.agentTask.create({
      data: {
        description: 'risk responder',
        objective: 'When a deal risk arrives, draft a summary.',
        status: 'ACTIVE',
        agentType: 'assistant',
        organizationId: org.id,
        userId: user.id,
      },
    })
    const subscription = await prisma.signalSubscription.create({
      data: {
        organizationId: org.id,
        signalType: 'deal.risk_detected',
        filter: { risk_level: 'high' },
        agentTaskId: agent.id,
      },
    })
    const signal = await prisma.signal.create({
      data: {
        organizationId: org.id,
        type: 'deal.risk_detected',
        opportunityId: 'opp-1',
        payload: { data: { risk_level: 'high' } },
        dedupeKey: `evt-${Date.now()}`,
      },
    })
    const lowSignal = await prisma.signal.create({
      data: {
        organizationId: org.id,
        type: 'deal.risk_detected',
        opportunityId: 'opp-2',
        payload: { data: { risk_level: 'low' } },
        dedupeKey: `evt-low-${Date.now()}`,
      },
    })
    Object.assign(ids, { org: org.id, user: user.id, agent: agent.id, subscription: subscription.id, signal: signal.id, lowSignal: lowSignal.id })
  })

  after(async () => {
    await prisma.agentExecution.deleteMany({ where: { organizationId: ids.org } })
    await prisma.signalSubscription.deleteMany({ where: { organizationId: ids.org } })
    await prisma.signal.deleteMany({ where: { organizationId: ids.org } })
    await prisma.agentTask.deleteMany({ where: { organizationId: ids.org } })
    await prisma.user.deleteMany({ where: { id: ids.user } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.$disconnect()
  })

  test('matchesFilter: empty matches, entity/payload keys match, mismatch rejects', () => {
    const signal = {
      id: 's', organizationId: 'o', type: 'deal.risk_detected',
      accountId: 'a-1', opportunityId: 'o-1', stakeholderId: null,
      payload: { data: { risk_level: 'high' } },
    }
    assert.equal(matchesFilter(signal, {}), true)
    assert.equal(matchesFilter(signal, { risk_level: 'high' }), true)
    assert.equal(matchesFilter(signal, { opportunityId: 'o-1' }), true)
    assert.equal(matchesFilter(signal, { risk_level: 'low' }), false)
  })

  test('routes a matching signal: creates one execution and dispatches it', async () => {
    const dispatched: any[] = []
    const result = await routeSignal(ids.signal, async (job: any) => dispatched.push(job))
    assert.equal(result.matched, 1)
    assert.equal(result.started, 1)
    assert.equal(dispatched.length, 1)

    const execution = await prisma.agentExecution.findFirst({
      where: { organizationId: ids.org, signalId: ids.signal },
    })
    assert.ok(execution)
    assert.equal(execution.idempotencyKey, `${ids.signal}:${ids.agent}`)
    assert.equal((execution.input as any).signal.type, 'deal.risk_detected')

    const processed = await prisma.signal.findUnique({ where: { id: ids.signal } })
    assert.ok(processed.processedAt, 'signal marked processed')
  })

  test('replaying the same signal does not double-fire (idempotency)', async () => {
    const dispatched: any[] = []
    const result = await routeSignal(ids.signal, async (job: any) => dispatched.push(job))
    assert.equal(result.matched, 1)
    assert.equal(result.started, 0)
    assert.equal(result.skippedDuplicates, 1)
    assert.equal(dispatched.length, 0)
    const count = await prisma.agentExecution.count({ where: { signalId: ids.signal } })
    assert.equal(count, 1)
  })

  test('non-matching filter routes nothing', async () => {
    const result = await routeSignal(ids.lowSignal, async () => {
      throw new Error('should not dispatch')
    })
    assert.equal(result.matched, 0)
    assert.equal(result.started, 0)
  })
}
