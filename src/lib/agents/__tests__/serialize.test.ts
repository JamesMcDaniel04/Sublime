import assert from 'node:assert/strict'
import test from 'node:test'
import { serializeAgent } from '../serialize'

test('preserves template-required integrations in the agent wire shape', () => {
  const agent = serializeAgent({
    id: 'agent-1',
    description: 'Lead agent',
    objective: 'Qualify leads',
    goal: null,
    metadata: {
      title: 'Lead agent',
      integrations: ['salesforce', 'slack'],
      requiredIntegrations: ['salesforce'],
      maxTurns: 24,
      outputFields: [{ name: 'account', type: 'string', description: 'Account name' }],
      responseFormat: 'structured',
    },
    folder: null, workerId: null,
    visibility: 'shared',
    status: 'ACTIVE',
    schedule: {},
    createdAt: new Date('2026-07-12T00:00:00Z'),
    lastExecutedAt: null,
    executionCount: 0,
  })
  assert.deepEqual(agent.requiredIntegrations, ['salesforce'])
  assert.equal(agent.autoAnswerFromMemory, true, 'legacy agents reuse remembered blocking answers by default')
  assert.equal(agent.maxTurns, 24)
  assert.deepEqual(agent.outputFields, [{ name: 'account', type: 'string', description: 'Account name' }])
})

test('preserves an explicit remembered-answer opt-out', () => {
  const agent = serializeAgent({
    id: 'agent-2', description: 'Approval agent', objective: 'Request a fresh approval', goal: null,
    metadata: { title: 'Approval agent', autoAnswerFromMemory: false }, folder: null, workerId: null,
    visibility: 'shared', status: 'ACTIVE', schedule: {},
    createdAt: new Date('2026-07-12T00:00:00Z'), lastExecutedAt: null, executionCount: 0,
  })
  assert.equal(agent.autoAnswerFromMemory, false)
  assert.equal(agent.maxTurns, 16, 'legacy agents get the runtime default in the editor')
  assert.deepEqual(agent.outputFields, [])
})

test('carries the roster identity fields — a stored avatar seed and role label', () => {
  const agent = serializeAgent({
    id: 'agent-roster-1', description: 'Pipeline agent', objective: 'Chase deals', goal: null,
    metadata: { title: 'Pipeline agent', avatarSeed: 'seed-7', roleLabel: 'Pipeline Analyst' }, folder: null, workerId: null,
    visibility: 'shared', status: 'ACTIVE', schedule: {},
    createdAt: new Date('2026-07-12T00:00:00Z'), lastExecutedAt: null, executionCount: 0,
  })
  assert.equal(agent.avatarSeed, 'seed-7')
  assert.equal(agent.roleLabel, 'Pipeline Analyst')
})

test('leaves roster identity fields null when unset, so the client falls back to id and department', () => {
  const agent = serializeAgent({
    id: 'agent-roster-2', description: 'Plain agent', objective: 'Do a thing', goal: null,
    metadata: { title: 'Plain agent' }, folder: null, workerId: null,
    visibility: 'shared', status: 'ACTIVE', schedule: {},
    createdAt: new Date('2026-07-12T00:00:00Z'), lastExecutedAt: null, executionCount: 0,
  })
  assert.equal(agent.avatarSeed, null)
  assert.equal(agent.roleLabel, null)
})

// metadata is an unvalidated JSON grab-bag, so the wire boundary is the last
// place to stop a label that a legacy row or a hand-edited record carries.
test('a malformed stored role label is dropped at the wire boundary rather than rendered', () => {
  const agent = serializeAgent({
    id: 'agent-roster-3', description: 'Odd agent', objective: 'Do a thing', goal: null,
    metadata: { title: 'Odd agent', roleLabel: '<img src=x onerror=alert(1)>' }, folder: null, workerId: null,
    visibility: 'shared', status: 'ACTIVE', schedule: {},
    createdAt: new Date('2026-07-12T00:00:00Z'), lastExecutedAt: null, executionCount: 0,
  })
  assert.equal(agent.roleLabel, null)
})
