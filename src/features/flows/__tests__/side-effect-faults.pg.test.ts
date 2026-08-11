import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let flow: any
  let run: any
  let ledger: typeof import('../side-effect-ledger')

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    flow = await prisma.flow.create({ data: { name: 'effect fault test', organizationId: seeded.organizationId, userId: seeded.userId } })
    run = await prisma.flowRun.create({ data: { flowId: flow.id, organizationId: seeded.organizationId, userId: seeded.userId } })
    ledger = await import('../side-effect-ledger')
  })

  after(async () => {
    await seeded?.cleanup()
    await prisma?.$disconnect()
  })

  async function step(nodeId: string) {
    return prisma.flowRunStep.create({ data: { flowRunId: run.id, nodeId, status: 'running' } })
  }

  test('provider committed, response lost: an unsafe write becomes durable ambiguous state and cannot execute twice', async () => {
    const firstStep = await step('unsafe-send')
    const input = {
      organizationId: seeded.organizationId,
      flowRunId: run.id,
      flowRunStepId: firstStep.id,
      nodeId: 'unsafe-send',
      kind: 'tool' as const,
      provider: 'mail',
      operation: 'send',
      safety: 'unsafe_write' as const,
      request: { recipientRef: 'customer-1' },
    }
    const first = await ledger.claimSideEffect(input)
    assert.equal(first.mode, 'execute')
    if (first.mode === 'execute') await ledger.recordSideEffectAttempt(first.id, seeded.organizationId)

    // Fault injection: the provider committed, then the process vanished
    // before completeSideEffect could persist the response.
    const restartedStep = await step('unsafe-send')
    await assert.rejects(
      ledger.claimSideEffect({ ...input, flowRunStepId: restartedStep.id }),
      (error: any) => error?.code === 'FLOW_SIDE_EFFECT_AMBIGUOUS',
    )
    const row = await prisma.flowSideEffect.findFirst({ where: { flowRunId: run.id, organizationId: seeded.organizationId, nodeId: 'unsafe-send' } })
    assert.equal(row.status, 'ambiguous')
    assert.equal(row.attempts, 1)
  })

  test('worker crash: a provider-keyed write reclaims the same key and stores one replayable success', async () => {
    const firstStep = await step('safe-send')
    const input = {
      organizationId: seeded.organizationId,
      flowRunId: run.id,
      flowRunStepId: firstStep.id,
      nodeId: 'safe-send',
      kind: 'http' as const,
      provider: 'payments',
      operation: 'POST /charge',
      safety: 'idempotent_write' as const,
      request: { customerRef: 'customer-1', amount: 100 },
    }
    const first = await ledger.claimSideEffect(input)
    assert.equal(first.mode, 'execute')
    if (first.mode !== 'execute') return
    await ledger.recordSideEffectAttempt(first.id, seeded.organizationId)

    const restartedStep = await step('safe-send')
    const recovered = await ledger.claimSideEffect({ ...input, flowRunStepId: restartedStep.id })
    assert.equal(recovered.mode, 'execute')
    if (recovered.mode !== 'execute') return
    assert.equal(recovered.providerKey, first.providerKey)
    await ledger.recordSideEffectAttempt(recovered.id, seeded.organizationId)
    await ledger.completeSideEffect({ id: recovered.id, organizationId: seeded.organizationId, output: { chargeRef: 'ch_1' } })

    const replay = await ledger.claimSideEffect({ ...input, flowRunStepId: (await step('safe-send')).id })
    assert.equal(replay.mode, 'replay')
    if (replay.mode === 'replay') assert.deepEqual(replay.output, { chargeRef: 'ch_1' })
    assert.equal(await prisma.flowSideEffect.count({ where: { flowRunId: run.id, organizationId: seeded.organizationId, nodeId: 'safe-send' } }), 1)
  })
} else {
  test('side-effect fault injection pg (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
