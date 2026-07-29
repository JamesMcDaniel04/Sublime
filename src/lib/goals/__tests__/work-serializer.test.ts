import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serializeWorkForNonMember, ANONYMISED_WORK_KEYS } from '../work-serializer'

const row = {
  id: 'w1',
  organizationId: 'o1',
  goalId: 'g1',
  resourceType: 'agent',
  resourceId: 'a1',
  runId: 'r1',
  subject: 'Follow up with Acme',
  subjectRef: 'acme-1',
  produced: 'draft',
  body: 'Hi there',
  bodyFormat: 'markdown',
  signals: { pipelineValue: 40000, stage: 'negotiation' },
  probeForRuleId: 'rule_1',
  assigneeUserId: 'u1',
  disposition: 'pending',
  dispositionBy: null,
  dispositionAt: null,
  skipReason: null,
  skipNote: null,
  outcome: 'unknown',
  outcomeSource: null,
  outcomeNote: null,
  outcomeAt: null,
  createdAt: new Date(),
} as never

test('the serializer emits exactly the allow-listed keys', () => {
  const output = serializeWorkForNonMember(row)
  assert.deepEqual(Object.keys(output).sort(), [...ANONYMISED_WORK_KEYS].sort())
})

test('signals never escape — they leak the goals shape', () => {
  // signals is free-form JSON the agent used to PICK this subject, so it
  // reveals what the goal is about more directly than the goal's own name.
  const output = serializeWorkForNonMember(row) as Record<string, unknown>
  assert.equal(output.signals, undefined)
  assert.equal(output.probeForRuleId, undefined)
  assert.equal(output.goalId, undefined)
  assert.equal(output.subjectRef, undefined)
})

test('the assignee still gets what they need to do the work', () => {
  const output = serializeWorkForNonMember(row)
  assert.equal(output.subject, 'Follow up with Acme')
  assert.equal(output.body, 'Hi there')
  assert.equal(output.disposition, 'pending')
})

test('a newly added GoalWork column is excluded until someone opts it in', () => {
  // The property that makes this an allow-list rather than a deny-list: the
  // default for new data is "not leaked". A deny-list would leak every future
  // column until somebody remembered to add it.
  const withNewColumn = { ...(row as object), someFutureSecret: 'leak me' } as never
  const output = serializeWorkForNonMember(withNewColumn) as Record<string, unknown>
  assert.equal(output.someFutureSecret, undefined)
})
