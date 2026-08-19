/**
 * The nightly run-data backfill converges legacy plaintext rows onto encryption
 * at rest, and — critically — is idempotent: a second sweep must not re-encrypt
 * an already-encrypted row (which would double-wrap it and break reads).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'backfill-test-key-0123456789abcdef'

  let prisma: any
  let systemPrisma: any
  let orgId: string
  let userId: string
  let execId: string
  let msgId: string

  before(async () => {
    ;({ prisma, systemPrisma } = await import('@/lib/prisma'))
    const org = await prisma.organization.create({ data: { name: 'Backfill QA', slug: `bf-${crypto.randomUUID()}` } })
    orgId = org.id
    const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), email: `bf-${Date.now()}@t.test`, organizationId: orgId } })
    userId = user.id
    // Write legacy PLAINTEXT directly (bypassing the encrypting write path).
    const exec = await prisma.agentExecution.create({
      data: { agentType: 'task', status: 'completed', input: { prompt: 'legacy secret sk-plain' }, output: { answer: 'legacy out' }, trigger: {}, userId, organizationId: orgId },
    })
    execId = exec.id
    const msg = await prisma.executionMessage.create({ data: { executionId: execId, role: 'user', content: 'legacy plaintext content' } })
    msgId = msg.id
  })

  after(async () => {
    await prisma.executionMessage.deleteMany({ where: { executionId: execId } }).catch(() => {})
    await prisma.agentExecution.deleteMany({ where: { id: execId } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
    await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {})
    await prisma.$disconnect?.()
  })

  test('a legacy plaintext run row is converged to ciphertext at rest', async () => {
    const { encryptLegacyAgentRuns } = await import('../encrypt-backfill')
    const result = await encryptLegacyAgentRuns(systemPrisma)
    assert.ok('executions' in result && result.executions >= 1, 'expected at least one execution converged')
    assert.ok('messages' in result && result.messages >= 1, 'expected at least one message converged')

    // At rest is now ciphertext — a raw read reveals no plaintext.
    const rawExec = await prisma.$queryRawUnsafe(`SELECT input::text AS input, output::text AS output FROM agent_executions WHERE id = $1`, execId)
    assert.ok(!JSON.stringify(rawExec).includes('sk-plain'), 'input plaintext still at rest')
    assert.ok(!JSON.stringify(rawExec).includes('legacy out'), 'output plaintext still at rest')
    const rawMsg = await prisma.$queryRawUnsafe(`SELECT content FROM execution_messages WHERE id = $1`, msgId)
    assert.ok(!JSON.stringify(rawMsg).includes('legacy plaintext content'), 'message plaintext still at rest')

    // Reads still return the original values (decrypt round-trip).
    const { decryptRunValue, decryptRunText } = await import('../run-crypto')
    const exec = await systemPrisma.agentExecution.findUnique({ where: { id: execId } })
    assert.deepEqual(decryptRunValue(exec.input), { prompt: 'legacy secret sk-plain' })
    const msg = await systemPrisma.executionMessage.findUnique({ where: { id: msgId } })
    assert.equal(decryptRunText(msg.content), 'legacy plaintext content')
  })

  test('a second sweep is a no-op (idempotent, no double-encryption)', async () => {
    const { encryptLegacyAgentRuns } = await import('../encrypt-backfill')
    const result = await encryptLegacyAgentRuns(systemPrisma)
    assert.ok('executions' in result && result.executions === 0, 'already-encrypted rows must not be re-encrypted')
    assert.ok('messages' in result && result.messages === 0)
  })
}
