import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn, type RouteAiFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

const echo: RunAgentFn = async (node) => ({ output: node.input })

const routerGraph: FlowGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: {} },
    { id: 'r', type: 'router', data: { input: '{{trigger.input}}', branches: [{ id: 'billing' }, { id: 'tech' }] } },
    { id: 'b', type: 'agent', data: { agentId: 'x', input: 'BILLING' } },
    { id: 't', type: 'agent', data: { agentId: 'x', input: 'TECH' } },
    { id: 'd', type: 'agent', data: { agentId: 'x', input: 'DEFAULT' } },
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'r' },
    { id: 'e1', source: 'r', target: 'b', branch: 'billing' },
    { id: 'e2', source: 'r', target: 't', branch: 'tech' },
    { id: 'e3', source: 'r', target: 'd', branch: 'default' },
  ],
}

test('router routes to the AI-chosen branch', async () => {
  const routeAi: RouteAiFn = async () => ({ branch: 'tech' })
  const result = await interpretFlow(routerGraph, 'my app crashed', { runAgent: echo, routeAi })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'TECH')
})

test('router falls to the default edge when the model says default', async () => {
  const routeAi: RouteAiFn = async () => ({ branch: 'default' })
  const result = await interpretFlow(routerGraph, '???', { runAgent: echo, routeAi })
  assert.equal(result.output, 'DEFAULT')
})

test('router fails cleanly with no routeAi adapter', async () => {
  const result = await interpretFlow(routerGraph, 'x', { runAgent: echo })
  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /AI runtime/)
})

test('RESUME reuses the branch chosen on the first run (no re-call)', async () => {
  let calls = 0
  const routeAi: RouteAiFn = async () => { calls += 1; return { branch: 'billing' } }
  const result = await interpretFlow(routerGraph, 'x', { runAgent: echo, routeAi, completed: { r: 'tech' } })
  assert.equal(calls, 0)
  assert.equal(result.output, 'TECH')
})
