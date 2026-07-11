/**
 * DB-gated integration test for `purgeConnectionLearnings` (Task 4.5,
 * purge-on-disconnect): must hard-delete only the AgentMemory rows whose
 * sourceRef matches the disconnected connection, leaving memories from other
 * connections (and memories with no sourceRef at all) untouched. Self-skips
 * (0 tests reported) when TEST_DATABASE_URL isn't set — same convention as
 * suggest-workflows-synthesis.test.ts.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let purgeConnectionLearnings: any
  let orgIntelligenceAgentId: any
  const orgIds: string[] = []

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ purgeConnectionLearnings, orgIntelligenceAgentId } = await import('../connection-scan'))
  })

  after(async () => {
    for (const id of orgIds) {
      await prisma.agentMemory.deleteMany({ where: { organizationId: id } })
      await prisma.agentTask.deleteMany({ where: { organizationId: id } })
      await prisma.organization.delete({ where: { id } }).catch(() => {})
    }
  })

  test('purgeConnectionLearnings hard-deletes only the matching sourceRef memories', async () => {
    const org = await prisma.organization.create({ data: { name: 'Purge Org', slug: `purge-${crypto.randomUUID()}` } })
    orgIds.push(org.id)
    const agentId = await orgIntelligenceAgentId(org.id)

    const matching = await prisma.agentMemory.create({
      data: { organizationId: org.id, agentId, kind: 'learning', title: 'Matching', content: 'x', sourceRef: 'mcp:conn123' },
    })
    const other = await prisma.agentMemory.create({
      data: { organizationId: org.id, agentId, kind: 'learning', title: 'Other', content: 'y', sourceRef: 'mcp:otherConn' },
    })
    const noRef = await prisma.agentMemory.create({
      data: { organizationId: org.id, agentId, kind: 'learning', title: 'No ref', content: 'z' },
    })

    await purgeConnectionLearnings({ organizationId: org.id, plane: 'mcp', connectionRef: 'conn123' })

    const remaining = await prisma.agentMemory.findMany({ where: { organizationId: org.id }, select: { id: true } })
    const remainingIds = remaining.map((row: { id: string }) => row.id)
    assert.ok(!remainingIds.includes(matching.id), 'matching sourceRef memory should be hard-deleted')
    assert.ok(remainingIds.includes(other.id), "a different connection's memory must survive")
    assert.ok(remainingIds.includes(noRef.id), 'a memory with no sourceRef must survive')
  })

  test('purgeConnectionLearnings is a silent no-op when the org never scanned anything', async () => {
    const org = await prisma.organization.create({ data: { name: 'Purge Org No Scan', slug: `purge-noscan-${crypto.randomUUID()}` } })
    orgIds.push(org.id)
    // No hidden org-intelligence agent exists yet — must not throw or create one.
    await purgeConnectionLearnings({ organizationId: org.id, plane: 'mcp', connectionRef: 'conn123' })
    const agentCount = await prisma.agentTask.count({ where: { organizationId: org.id } })
    assert.equal(agentCount, 0)
  })
}
