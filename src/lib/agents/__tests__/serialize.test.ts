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
    },
    folder: null,
    visibility: 'shared',
    status: 'ACTIVE',
    priority: 'MEDIUM',
    schedule: {},
    createdAt: new Date('2026-07-12T00:00:00Z'),
    lastExecutedAt: null,
    executionCount: 0,
  })
  assert.deepEqual(agent.requiredIntegrations, ['salesforce'])
})
