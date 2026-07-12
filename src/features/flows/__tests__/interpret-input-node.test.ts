import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

const echo: RunAgentFn = async (node) => ({ output: node.input })

test('input node coerces params and exposes {{input.<name>}}', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'in', type: 'input', data: { params: [
        { name: 'account', type: 'string', required: true },
        { name: 'limit', type: 'number', default: '10' },
      ] } },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: '{{input.account}} limit={{input.limit}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'in' },
      { id: 'e1', source: 'in', target: 'a' },
    ],
  }
  const result = await interpretFlow(graph, { account: 'Acme' }, { runAgent: echo })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'Acme limit=10')
})

test('input precedence user > webhook, and required-missing fails the node', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'in', type: 'input', data: { params: [{ name: 'q', type: 'string', required: true }] } },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: '{{input.q}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'in' }, { id: 'e1', source: 'in', target: 'a' }],
  }
  const ok = await interpretFlow(graph, { q: 'user' }, { runAgent: echo, webhookInput: { q: 'hook' } })
  assert.equal(ok.output, 'user')
  const fail = await interpretFlow(graph, {}, { runAgent: echo })
  assert.equal(fail.status, 'failed')
  assert.match(fail.error ?? '', /Missing required input "q"/)
})

test('BACK-COMPAT: a flow with no input node still resolves {{trigger.input}}', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'got {{trigger.input}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'a' }],
  }
  const result = await interpretFlow(graph, 'hello', { runAgent: echo })
  assert.equal(result.output, 'got hello')
})

test('input binding is visible inside a loop body', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'in', type: 'input', data: { params: [{ name: 'tag', type: 'string' }] } },
      { id: 'loop', type: 'loop', data: { over: '["a","b"]', body: ['e'] } },
      { id: 'e', type: 'agent', data: { agentId: 'x', input: '{{input.tag}}:{{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'in' }, { id: 'e1', source: 'in', target: 'loop' }],
  }
  const result = await interpretFlow(graph, { tag: 'T' }, { runAgent: echo })
  assert.deepEqual(result.output, ['T:a', 'T:b'])
})
