import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FLOW_TRIGGER_TYPES, normalizeFlowTrigger } from '@/lib/flows/trigger'
import { validateFlowGraph } from '@/lib/flows/validate'
import type { FlowGraph } from '@/lib/flows/graph'

const graphWith = (trigger: Record<string, unknown>): FlowGraph =>
  ({
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger } },
      { id: 'a1', type: 'agent', position: { x: 0, y: 0 }, data: { agentId: '', prompt: 'Reply helpfully', input: '{{trigger.input.text}}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'a1' }],
  }) as unknown as FlowGraph

test('slack is a known trigger type and normalizes intact', () => {
  assert.ok((FLOW_TRIGGER_TYPES as readonly string[]).includes('slack'))
  const trigger = normalizeFlowTrigger({ type: 'slack', events: ['app_mention'], threadMemory: true })
  assert.equal(trigger.type, 'slack')
  assert.deepEqual(trigger.events, ['app_mention'])
  assert.equal(trigger.threadMemory, true)
})

test('slack trigger requires at least one valid event kind', () => {
  const none = validateFlowGraph(graphWith({ type: 'slack' }))
  assert.ok(none.errors.some((e) => e.code === 'MISSING_SLACK_EVENTS'))
  const empty = validateFlowGraph(graphWith({ type: 'slack', events: [] }))
  assert.ok(empty.errors.some((e) => e.code === 'MISSING_SLACK_EVENTS'))
  const bogus = validateFlowGraph(graphWith({ type: 'slack', events: ['app_mention', 'reaction_added'] }))
  assert.ok(bogus.errors.some((e) => e.code === 'INVALID_SLACK_EVENT'))
})

test('slash_command requires a command; other kinds do not', () => {
  const missing = validateFlowGraph(graphWith({ type: 'slack', events: ['slash_command'] }))
  assert.ok(missing.errors.some((e) => e.code === 'MISSING_SLACK_COMMAND'))
  const ok = validateFlowGraph(graphWith({ type: 'slack', events: ['slash_command'], command: '/deploy' }))
  assert.ok(!ok.errors.some((e) => e.code.startsWith('MISSING_SLACK') || e.code.startsWith('INVALID_SLACK')))
  const mention = validateFlowGraph(graphWith({ type: 'slack', events: ['app_mention'] }))
  assert.ok(!mention.errors.some((e) => e.code === 'MISSING_SLACK_COMMAND'))
})

test('existing trigger types are untouched (additive change)', () => {
  const webhook = validateFlowGraph(graphWith({ type: 'webhook' }))
  assert.ok(!webhook.errors.some((e) => e.code.includes('SLACK')))
  assert.deepEqual((FLOW_TRIGGER_TYPES as readonly string[]).slice(0, 4), ['manual', 'schedule', 'webhook', 'signal'])
})
