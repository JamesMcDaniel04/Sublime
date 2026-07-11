import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { requiresApproval, capabilityFromProvider } from '../approval'

test('requiresApproval only when flag set AND provider is a write plane', () => {
  assert.equal(requiresApproval({ requireApproval: true }, 'nango:slack'), true)
  assert.equal(requiresApproval({ requireApproval: true }, 'nango:gmail'), true)
  assert.equal(requiresApproval({ requireApproval: true }, 'granola'), false)
  assert.equal(requiresApproval({ requireApproval: false }, 'nango:slack'), false)
  assert.equal(requiresApproval({}, 'nango:slack'), false)
})

test('capabilityFromProvider extracts the delivery capability', () => {
  assert.equal(capabilityFromProvider('nango:salesforce'), 'salesforce')
  assert.equal(capabilityFromProvider('klavis:github'), null)
})

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let createApproval: any
  let decideApproval: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ createApproval, decideApproval } = await import('../approval'))
    const org = await prisma.organization.create({ data: { name: 'Ap', slug: `ap-${Date.now()}` } })
    const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id } })
    const agent = await prisma.agentTask.create({
      data: { description: 'a', objective: 'o', status: 'ACTIVE', agentType: 'assistant', organizationId: org.id, userId: user.id },
    })
    const execution = await prisma.agentExecution.create({
      data: { agentType: 'assistant', agentTaskId: agent.id, status: 'running', input: {}, trigger: {}, userId: user.id, organizationId: org.id },
    })
    ids.org = org.id
    ids.user = user.id
    ids.execution = execution.id
  })

  after(async () => {
    await prisma.auditEvent.deleteMany({ where: { organizationId: ids.org } })
    await prisma.approvalRequest.deleteMany({ where: { organizationId: ids.org } })
    await prisma.agentExecution.deleteMany({ where: { organizationId: ids.org } })
    await prisma.agentTask.deleteMany({ where: { organizationId: ids.org } })
    await prisma.user.deleteMany({ where: { id: ids.user } })
    await prisma.organization.deleteMany({ where: { id: ids.org } })
    await prisma.$disconnect()
  })

  test('rejecting an approval marks it rejected, does not execute, and audits', async () => {
    const { id } = await createApproval({
      organizationId: ids.org, executionId: ids.execution, userId: ids.user,
      provider: 'nango:slack', tool: 'slack_post_message', args: { channel: '#x', text: 'hi' },
    })
    const result = await decideApproval({ approvalId: id, organizationId: ids.org, deciderUserId: ids.user, approve: false })
    assert.deepEqual(result, { status: 'rejected', executed: false })
    const audit = await prisma.auditEvent.findMany({ where: { organizationId: ids.org, action: 'approval.rejected' } })
    assert.equal(audit.length, 1)
  })

  test('deciding a non-pending approval is idempotent', async () => {
    const { id } = await createApproval({
      organizationId: ids.org, executionId: ids.execution, userId: ids.user,
      provider: 'nango:slack', tool: 'slack_post_message', args: {},
    })
    await decideApproval({ approvalId: id, organizationId: ids.org, deciderUserId: ids.user, approve: false })
    const second = await decideApproval({ approvalId: id, organizationId: ids.org, deciderUserId: ids.user, approve: true })
    assert.equal(second.status, 'rejected')
    assert.equal(second.executed, false)
  })

  test('deciding a superseded approval reports superseded, never executes, never resumes', async () => {
    // A resumed flow run supersedes its still-pending approvals (the re-run
    // re-queues fresh ones) — approving the stale one must be an inert no-op.
    const { id } = await createApproval({
      organizationId: ids.org, executionId: ids.execution, userId: ids.user,
      provider: 'nango:slack', tool: 'slack_post_message', args: {},
    })
    await prisma.approvalRequest.update({ where: { id, organizationId: ids.org }, data: { status: 'superseded' } })
    const result = await decideApproval({ approvalId: id, organizationId: ids.org, deciderUserId: ids.user, approve: true })
    assert.deepEqual(result, { status: 'superseded', executed: false })
    const current = await prisma.approvalRequest.findUnique({ where: { id, organizationId: ids.org } })
    assert.equal(current.status, 'superseded')
  })

  test('cross-org decision is refused', async () => {
    const { id } = await createApproval({
      organizationId: ids.org, executionId: ids.execution, userId: ids.user,
      provider: 'nango:slack', tool: 'slack_post_message', args: {},
    })
    await assert.rejects(
      decideApproval({ approvalId: id, organizationId: crypto.randomUUID(), deciderUserId: ids.user, approve: true }),
      /Approval not found/,
    )
  })
}
