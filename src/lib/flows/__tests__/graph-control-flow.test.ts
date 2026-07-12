import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowGraphSchema, emptyGraph } from '../graph'

test('router node parses with labelled branches', () => {
  const parsed = flowGraphSchema.safeParse({
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'r', type: 'router', data: { input: '{{trigger.input}}', branches: [
        { id: 'billing', label: 'Billing', description: 'Payment, invoices, refunds' },
        { id: 'tech', label: 'Tech', description: 'Bugs and errors' },
      ] } },
    ],
    edges: [],
  })
  assert.equal(parsed.success, true)
  const r = parsed.success && parsed.data.nodes.find((n) => n.type === 'router')
  assert.ok(r && r.type === 'router')
  assert.equal(r.data.branches[0].id, 'billing')
})

test('errorShield node parses with body + fallback member lists', () => {
  const parsed = flowGraphSchema.safeParse({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'shield', type: 'errorShield', data: { body: ['a'], fallback: ['b'] } },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'y' } },
      { id: 'b', type: 'agent', data: { agentId: 'z', input: 'w' } },
    ],
    edges: [],
  })
  assert.equal(parsed.success, true)
  const s = parsed.success && parsed.data.nodes.find((n) => n.type === 'errorShield')
  assert.ok(s && s.type === 'errorShield')
  assert.deepEqual(s.data.body, ['a'])
  assert.deepEqual(s.data.fallback, ['b'])
})

test('agent gains inline prompt+model; loop gains threadAgent; parallel gains join', () => {
  const parsed = flowGraphSchema.safeParse({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'inline', type: 'agent', data: { agentId: '', prompt: 'Classify {{trigger.input}}', model: 'claude-haiku-4-5' } },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', threadAgent: true, body: ['inline'] } },
      { id: 'par', type: 'parallel', data: { join: 'array', labels: ['a', 'b'], branches: [['inline'], ['inline']] } },
    ],
    edges: [],
  })
  assert.equal(parsed.success, true)
  const a = parsed.success && parsed.data.nodes.find((n) => n.id === 'inline')
  assert.ok(a && a.type === 'agent' && a.data.prompt === 'Classify {{trigger.input}}')
})

test('BACK-COMPAT: emptyGraph + a parallel with no join still parse', () => {
  assert.equal(flowGraphSchema.safeParse(emptyGraph()).success, true)
  const legacy = flowGraphSchema.safeParse({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'p', type: 'parallel', data: { branches: [['x']] } },
      { id: 'x', type: 'agent', data: { agentId: 'a', input: 'i' } },
    ],
    edges: [],
  })
  assert.equal(legacy.success, true)
})
