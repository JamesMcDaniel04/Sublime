import test from 'node:test'
import assert from 'node:assert/strict'
import { formatAge, shapeNeedsYou } from '../needs-you'

const now = new Date('2026-08-27T12:00:00Z')
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000)
const agent = { id: 'a1', description: 'Renewal Scout', metadata: { title: 'Riley' } }

test('a parked question is an ask; a held write is an approval — same source, different decision', () => {
  const items = shapeNeedsYou({
    executions: [
      { id: 'e1', startedAt: ago(5), metadata: { pendingQuestion: { question: 'Which contract?' } }, agentTask: agent },
      { id: 'e2', startedAt: ago(3), metadata: { pendingApproval: { node: 'slack.send_message', input: {} } }, agentTask: agent },
    ],
    flowRuns: [], work: [], goalActions: [],
  }, now)
  const ask = items.find((i) => i.id === 'run:e1')!
  assert.equal(ask.kind, 'ask'); assert.equal(ask.subject, 'Riley'); assert.equal(ask.detail, 'Which contract?')
  assert.deepEqual(ask.actions, [{ kind: 'reply', executionId: 'e1' }])
  const approval = items.find((i) => i.id === 'run:e2')!
  assert.equal(approval.kind, 'approval'); assert.match(approval.detail, /slack\.send_message/)
  assert.deepEqual(approval.actions, [{ kind: 'approve', executionId: 'e2' }])
})

test('only an INPUT wait on a flow needs a person; a timed wait needs nobody', () => {
  const items = shapeNeedsYou({
    executions: [],
    flowRuns: [
      { id: 'f1', flowId: 'fl1', startedAt: ago(10), waiting: { kind: 'input', question: 'Approve the send?' }, flow: { name: 'Digest' } },
      { id: 'f2', flowId: 'fl2', startedAt: ago(10), waiting: { kind: 'time', wakeAt: 'later' } as never, flow: { name: 'Nightly' } },
      { id: 'f3', flowId: 'fl3', startedAt: ago(10), waiting: null, flow: { name: 'Done' } },
    ],
    work: [], goalActions: [],
  }, now)
  assert.deepEqual(items.map((i) => i.id), ['flow:f1'])
  assert.equal(items[0].href, '/flows/fl1/activity')
})

test('work offers Use inline but sends Skip to the workroom, where a reason is required', () => {
  const [item] = shapeNeedsYou({
    executions: [], flowRuns: [], goalActions: [],
    work: [{ id: 'w1', goalId: 'g1', subject: 'Acme renewal', produced: 'follow-up email', createdAt: ago(120), goal: { name: 'Retain Acme' } }],
  }, now)
  assert.equal(item.kind, 'work')
  assert.deepEqual(item.actions, [{ kind: 'use_work', goalId: 'g1', workId: 'w1' }, { kind: 'open', href: '/goals/g1' }])
})

test('a goal action links to its goal, or to the goals list when it names none', () => {
  const items = shapeNeedsYou({
    executions: [], flowRuns: [], work: [],
    goalActions: [
      { id: 's1', title: 'Q3 renewals at risk', description: 'Two accounts slipped.', targetId: 'g9', createdAt: ago(60), },
      { id: 's2', title: 'Orphan', description: '', targetId: null, createdAt: ago(60) },
    ],
  }, now)
  assert.equal(items.find((i) => i.id === 'goal:s1')!.href, '/goals/g9')
  assert.equal(items.find((i) => i.id === 'goal:s2')!.href, '/goals')
})

test('the queue is oldest first — the item that has waited longest costs the most', () => {
  const items = shapeNeedsYou({
    executions: [{ id: 'e', startedAt: ago(1), metadata: { pendingQuestion: { question: 'q' } }, agentTask: agent }],
    flowRuns: [{ id: 'f', flowId: 'x', startedAt: ago(90), waiting: { kind: 'input' }, flow: { name: 'F' } }],
    work: [{ id: 'w', goalId: 'g', subject: 's', produced: 'p', createdAt: ago(30), goal: { name: 'G' } }],
    goalActions: [],
  }, now)
  assert.deepEqual(items.map((i) => i.id), ['flow:f', 'work:w', 'run:e'])
})

test('an agent with no title falls back to its description, never to "undefined"', () => {
  const [item] = shapeNeedsYou({
    executions: [{ id: 'e', startedAt: ago(1), metadata: {}, agentTask: { id: 'a', description: 'Scout', metadata: null } }],
    flowRuns: [], work: [], goalActions: [],
  }, now)
  assert.equal(item.subject, 'Scout'); assert.equal(item.detail, 'asked a question')
})

test('ages read at a glance', () => {
  assert.equal(formatAge(20_000), 'now'); assert.equal(formatAge(12 * 60_000), '12m')
  assert.equal(formatAge(3 * 3_600_000), '3h'); assert.equal(formatAge(3 * 86_400_000), '3d')
})
