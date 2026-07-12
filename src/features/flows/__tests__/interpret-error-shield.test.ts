import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

function shieldGraph(): FlowGraph {
  return {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 's', type: 'errorShield', data: { body: ['boom'], fallback: ['fb'] } },
      { id: 'boom', type: 'agent', data: { agentId: 'boom', input: 'go' } },
      { id: 'fb', type: 'agent', data: { agentId: 'ok', input: 'fallback saw: {{error}}' } },
      { id: 'after', type: 'agent', data: { agentId: 'ok', input: 'after' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 's' }, { id: 'e1', source: 's', target: 'after' }],
  }
}

const runAgent: RunAgentFn = async (n) => (n.agentId === 'boom' ? { error: 'kaboom' } : { output: n.input })

test('body failure routes to the fallback and shields the error', async () => {
  const result = await interpretFlow(shieldGraph(), '', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'after')
  const shield = result.steps.find((s) => s.nodeId === 's')
  assert.equal(shield?.status, 'succeeded')
  const fb = result.steps.find((s) => s.nodeId === 'fb')
  assert.equal(fb?.output, 'fallback saw: kaboom')
})

test('a succeeding body skips the fallback', async () => {
  const g = shieldGraph()
  const result = await interpretFlow(g, '', { runAgent: async (n) => ({ output: n.agentId === 'boom' ? 'BODY' : n.input }) })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.steps.find((s) => s.nodeId === 'fb'), undefined)
})

test('a stop inside the body is NOT shielded', async () => {
  const g: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 's', type: 'errorShield', data: { body: ['stop'], fallback: ['fb'] } },
      { id: 'stop', type: 'stop', data: { reason: 'halt' } },
      { id: 'fb', type: 'agent', data: { agentId: 'ok', input: 'fb' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 's' }],
  }
  const result = await interpretFlow(g, '', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.steps.find((s) => s.nodeId === 'fb'), undefined)
})

test('a pause (human review) inside the body is NOT shielded', async () => {
  const g: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 's', type: 'errorShield', data: { body: ['hr'], fallback: ['fb'] } },
      { id: 'hr', type: 'humanReview', data: { message: 'Please confirm' } },
      { id: 'fb', type: 'agent', data: { agentId: 'ok', input: 'fb' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 's' }],
  }
  const result = await interpretFlow(g, '', { runAgent })
  assert.equal(result.status, 'waiting')
  assert.equal(result.waiting?.nodeId, 'hr')
  assert.equal(result.steps.find((s) => s.nodeId === 'fb'), undefined)
})

test('a failing fallback is NOT shielded (you cannot shield the shield)', async () => {
  const g: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 's', type: 'errorShield', data: { body: ['boom'], fallback: ['fbBoom'] } },
      { id: 'boom', type: 'agent', data: { agentId: 'boom', input: 'go' } },
      { id: 'fbBoom', type: 'agent', data: { agentId: 'fbBoom', input: 'try again' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 's' }],
  }
  const flakyAgent: RunAgentFn = async (n) =>
    n.agentId === 'boom' ? { error: 'kaboom' } : n.agentId === 'fbBoom' ? { error: 'still broken' } : { output: n.input }
  const result = await interpretFlow(g, '', { runAgent: flakyAgent })
  assert.equal(result.status, 'failed')
  assert.equal(result.error, 'still broken')
  const shield = result.steps.find((s) => s.nodeId === 's')
  assert.equal(shield?.status, 'failed')
})
