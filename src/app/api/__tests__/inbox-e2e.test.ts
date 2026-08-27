/**
 * GET /api/inbox against QA Postgres: every source appears, and each is scoped
 * to what the caller can ACT on — nobody else's parked run, nobody else's
 * assigned work, nobody else's recommendation. Inert without TEST_DATABASE_URL.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  let prisma: any
  let seeded: any
  let organizationId: string
  let userId: string
  let otherId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    organizationId = seeded.organizationId
    userId = seeded.userId
    otherId = (await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId, isActive: true, name: 'Sam' } })).id

    const agent = await prisma.agentTask.create({ data: { agentType: 'CUSTOM', description: 'Renewal Scout', objective: 'o', status: 'ACTIVE', visibility: 'shared', organizationId, userId, metadata: { title: 'Riley' } } })
    const exec = (owner: string, metadata: unknown, minutesAgo: number) => prisma.agentExecution.create({
      data: { agentType: 'CUSTOM', agentTaskId: agent.id, status: 'waiting_for_input', input: {}, trigger: { type: 'manual' }, metadata, userId: owner, organizationId, startedAt: new Date(Date.now() - minutesAgo * 60_000) },
    })
    await exec(userId, { pendingQuestion: { question: 'Which Acme contract?' } }, 30)
    await exec(userId, { pendingApproval: { node: 'slack.send_message', input: { channel: '#sales' } } }, 5)
    await exec(otherId, { pendingQuestion: { question: 'not yours' } }, 60)

    const goal = await prisma.goal.create({ data: { organizationId, name: 'Retain Acme', kind: 'retention', createdByUserId: userId, targetValue: 1, startValue: 0, targetDate: new Date('2026-12-31') } })
    const workRow = (assignee: string | null, subject: string) => prisma.goalWork.create({ data: { organizationId, goalId: goal.id, resourceType: 'agent', resourceId: agent.id, subject, produced: 'email', assigneeUserId: assignee, createdAt: new Date(Date.now() - 120 * 60_000) } })
    await workRow(userId, 'Acme renewal draft')
    await workRow(otherId, "Sam's item")
    await workRow(null, 'Unassigned item')
    await prisma.goalWork.create({ data: { organizationId, goalId: goal.id, resourceType: 'agent', resourceId: agent.id, subject: 'Already used', produced: 'x', assigneeUserId: userId, disposition: 'used' } })

    const suggestion = (owner: string, status: string, title: string) => prisma.userSuggestion.create({ data: { organizationId, userId: owner, kind: 'goal_action', title, description: 'd', targetType: 'goal', targetId: goal.id, status, createdAt: new Date(Date.now() - 24 * 3_600_000) } })
    await suggestion(userId, 'open', 'Q3 renewals at risk')
    await suggestion(userId, 'dismissed', 'Old one')
    await suggestion(otherId, 'open', "Sam's")
    await prisma.userSuggestion.create({ data: { organizationId, userId, kind: 'new_flow', title: 'Not a goal action', description: 'd', status: 'open' } })

    const flow = await prisma.flow.create({ data: { name: 'Weekly digest', organizationId, userId, status: 'ACTIVE', visibility: 'private', graph: { nodes: [], edges: [] } } })
    const run = await prisma.flowRun.create({ data: { flowId: flow.id, status: 'waiting', input: {}, trigger: { type: 'manual' }, organizationId, userId, startedAt: new Date(Date.now() - 45 * 60_000) } })
    await prisma.flowRunStep.create({ data: { flowRunId: run.id, nodeId: 'review', status: 'waiting', order: 1, output: { waiting: { kind: 'input', question: 'Approve the send?' } } } })
    const timed = await prisma.flowRun.create({ data: { flowId: flow.id, status: 'waiting', input: {}, trigger: { type: 'manual' }, organizationId, userId } })
    await prisma.flowRunStep.create({ data: { flowRunId: timed.id, nodeId: 'wait', status: 'waiting', order: 1, output: { waiting: { kind: 'time', wakeAt: '2099-01-01' } } } })
  })

  after(async () => { await seeded?.cleanup?.() })

  test('every source appears once, scoped to me, oldest first', async () => {
    const { GET } = await import('../inbox/route')
    const response = await GET(new NextRequest('http://localhost/api/inbox'))
    assert.equal(response.status, 200)
    const { items, count } = await response.json()
    const kinds = items.map((i: { kind: string }) => i.kind)
    assert.deepEqual([...kinds].sort(), ['approval', 'ask', 'flow_wait', 'goal_action', 'work'], JSON.stringify(items.map((i: any) => [i.kind, i.subject])))
    assert.equal(count, 5)
    // Oldest first: the 24h-old recommendation leads; the 5-minute approval is last.
    assert.equal(items[0].kind, 'goal_action')
    assert.equal(items[items.length - 1].kind, 'approval')
    const ask = items.find((i: any) => i.kind === 'ask')
    assert.equal(ask.subject, 'Riley'); assert.equal(ask.detail, 'Which Acme contract?')
    const approval = items.find((i: any) => i.kind === 'approval')
    assert.match(approval.detail, /slack\.send_message/)
    const work = items.find((i: any) => i.kind === 'work')
    assert.match(work.detail, /Acme renewal draft/, "only the item assigned to ME — not Sam's, not unassigned, not used")
    const flow = items.find((i: any) => i.kind === 'flow_wait')
    assert.equal(flow.detail, 'Approve the send?', 'the input wait, never the timed one')
    assert.equal(JSON.stringify(items).includes('not yours'), false, "another member's parked run is not mine to answer")
    assert.equal(JSON.stringify(items).includes("Sam's"), false)
  })
}
