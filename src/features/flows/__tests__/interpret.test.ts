import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn, type RunActionFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

// A runAgent stub that echoes a canned output per agentId (default: echoes input).
const stub =
  (map: Record<string, unknown>): RunAgentFn =>
  async (node) => ({ output: map[node.agentId] ?? `ran:${node.input}` })

test('linear flow threads output between two agent steps', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: '{{trigger.input}}' } },
      { id: 'n2', type: 'agent', data: { agentId: 'a2', input: 'got {{step.n1.output}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  }
  const result = await interpretFlow(graph, 'hello', { runAgent: stub({ a1: 'ONE' }) })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'ran:got ONE')
  assert.equal(result.steps.filter((s) => s.status === 'succeeded').length, 2)
})

test('structured trigger input fields are addressable', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: 'Account {{trigger.input.account.name}} has {{trigger.input.items.0}}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  const runAgent: RunAgentFn = async (node) => ({ output: node.input })
  const result = await interpretFlow(graph, { account: { name: 'Acme' }, items: ['A'] }, { runAgent })
  assert.equal(result.output, 'Account Acme has A')
})

test('condition routes to the true branch', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'score', input: '{{trigger.input}}' } },
      { id: 'c', type: 'condition', data: { left: '{{step.n1.output.score}}', op: 'gt', right: '80' } },
      { id: 'hi', type: 'agent', data: { agentId: 'high', input: 'x' } },
      { id: 'lo', type: 'agent', data: { agentId: 'low', input: 'x' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'c' },
      { id: 'e2', source: 'c', target: 'hi', branch: 'true' },
      { id: 'e3', source: 'c', target: 'lo', branch: 'false' },
    ],
  }
  const result = await interpretFlow(graph, 'Acme', { runAgent: stub({ score: '{"score":91}', high: 'HIGH', low: 'LOW' }) })
  assert.equal(result.output, 'HIGH')
})

test('loop fans out over an array and collects results', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'list', type: 'agent', data: { agentId: 'list', input: 'x' } },
      { id: 'loop', type: 'loop', data: { over: '{{step.list.output}}', concurrency: 2, body: ['score'] } },
      { id: 'score', type: 'agent', data: { agentId: 'score', input: 'score {{item}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'list' },
      { id: 'e1', source: 'list', target: 'loop' },
    ],
  }
  const result = await interpretFlow(graph, '', { runAgent: stub({ list: '["A","B","C"]' }) })
  // The `score` agent isn't in the stub map, so it echoes `ran:<input>`, which
  // confirms the loop resolved `score {{item}}` per item before delegating.
  assert.deepEqual(result.output, ['ran:score A', 'ran:score B', 'ran:score C'])
})

test('loop honors concurrency while preserving output order', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', concurrency: 2, body: ['echo'] } },
      { id: 'echo', type: 'agent', data: { agentId: 'echo', input: '{{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  let active = 0
  let maxActive = 0
  const delays: Record<string, number> = { '0': 30, '1': 5, '2': 10, '3': 1 }
  const runAgent: RunAgentFn = async (node) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, delays[node.input] ?? 1))
    active -= 1
    return { output: node.input }
  }
  const result = await interpretFlow(graph, [0, 1, 2, 3], { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(maxActive, 2)
  assert.deepEqual(result.output, ['0', '1', '2', '3'])
})

test('waiting sub-run halts the flow', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'ask', input: 'x' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'n1' }],
  }
  const runAgent: RunAgentFn = async () => ({ waiting: { status: 'waiting_for_input', question: 'Which segment?' } })
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'waiting')
  assert.equal(result.waiting?.question, 'Which segment?')
})

test('onError:stop fails the flow; onError:continue proceeds', async () => {
  const base = (onError: 'stop' | 'continue'): FlowGraph => ({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'boom', input: 'x', onError } },
      { id: 'n2', type: 'agent', data: { agentId: 'ok', input: 'y' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'n2' },
    ],
  })
  const runAgent: RunAgentFn = async (n) => (n.agentId === 'boom' ? { error: 'kaboom' } : { output: 'DONE' })
  assert.equal((await interpretFlow(base('stop'), '', { runAgent })).status, 'failed')
  assert.equal((await interpretFlow(base('continue'), '', { runAgent })).output, 'DONE')
})

test('stop node ends the flow early and skips later steps', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: 'x' } },
      { id: 's', type: 'stop', data: { reason: 'done' } },
      { id: 'n2', type: 'agent', data: { agentId: 'a2', input: 'y' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 's' },
      { id: 'e2', source: 's', target: 'n2' },
    ],
  }
  const seen: string[] = []
  const runAgent: RunAgentFn = async (n) => { seen.push(n.agentId); return { output: n.agentId } }
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(seen, ['a1']) // a2 never runs
  assert.equal(result.output, 'a1')
})

test('nested loops fan out at two levels', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'outer', type: 'loop', data: { over: '{{trigger.input}}', concurrency: 2, body: ['inner'] } },
      { id: 'inner', type: 'loop', data: { over: '{{item}}', concurrency: 2, body: ['echo'] } },
      { id: 'echo', type: 'agent', data: { agentId: 'echo', input: 'v={{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'outer' }],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const result = await interpretFlow(graph, [[1, 2], [3, 4]], { runAgent })
  assert.deepEqual(result.output, [['v=1', 'v=2'], ['v=3', 'v=4']])
})

test('loop exposes {{loop.index}}', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['e'] } },
      { id: 'e', type: 'agent', data: { agentId: 'e', input: '{{loop.index}}:{{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const result = await interpretFlow(graph, ['a', 'b', 'c'], { runAgent })
  assert.deepEqual(result.output, ['0:a', '1:b', '2:c'])
})

test('loop accepts comma-separated and newline-separated text input', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['e'] } },
      { id: 'e', type: 'agent', data: { agentId: 'e', input: '{{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  assert.deepEqual((await interpretFlow(graph, 'Acme, Globex', { runAgent })).output, ['Acme', 'Globex'])
  assert.deepEqual((await interpretFlow(graph, 'Acme\nGlobex', { runAgent })).output, ['Acme', 'Globex'])
})

test('loop accepts common object payload lists', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['e'] } },
      { id: 'e', type: 'agent', data: { agentId: 'e', input: '{{item.name}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const result = await interpretFlow(graph, JSON.stringify({ items: [{ name: 'Acme' }, { name: 'Globex' }] }), { runAgent })
  assert.deepEqual(result.output, ['Acme', 'Globex'])
})

test('an error inside a loop item propagates and fails the flow', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['boom'] } },
      { id: 'boom', type: 'agent', data: { agentId: 'boom', input: '{{item}}', onError: 'stop' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const runAgent: RunAgentFn = async () => ({ error: 'kaboom' })
  const result = await interpretFlow(graph, ['a', 'b'], { runAgent })
  assert.equal(result.status, 'failed')
})

test('multi-criteria condition (AND) routes correctly', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'score', input: 'x' } },
      {
        id: 'c',
        type: 'condition',
        data: {
          match: 'all',
          clauses: [
            { left: '{{step.n1.output.score}}', op: 'gt', right: '80' },
            { left: '{{trigger.input}}', op: 'contains', right: 'Acme' },
          ],
        },
      },
      { id: 'hi', type: 'agent', data: { agentId: 'high', input: 'x' } },
      { id: 'lo', type: 'agent', data: { agentId: 'low', input: 'x' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'c' },
      { id: 'e2', source: 'c', target: 'hi', branch: 'true' },
      { id: 'e3', source: 'c', target: 'lo', branch: 'false' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.agentId === 'score' ? '{"score":91}' : n.agentId.toUpperCase() })
  const result = await interpretFlow(graph, 'Acme Corp', { runAgent })
  assert.equal(result.output, 'HIGH')
})

test('resume skips completed nodes and re-runs the paused one', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: 'x' } },
      { id: 'n2', type: 'agent', data: { agentId: 'ask', input: 'y' } },
      { id: 'n3', type: 'agent', data: { agentId: 'a3', input: 'got {{step.n2.output}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ],
  }
  const ran: string[] = []
  const runAgent: RunAgentFn = async (n) => {
    ran.push(n.id)
    if (n.id === 'n2') return { output: n.resume ? 'ANSWERED' : 'ignored' }
    return { output: n.input }
  }
  // Resume: n1 already completed (skipped), n2 is the paused node (re-runs w/ reply).
  const result = await interpretFlow(graph, '', {
    runAgent,
    completed: { n1: 'a1' },
    resumeNodeId: 'n2',
  })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(ran, ['n2', 'n3']) // n1 was skipped, not re-run
  assert.equal(result.output, 'got ANSWERED') // n3 saw the resumed n2 output
})

test('tool and http steps resolve templates and thread output', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't1', type: 'tool', data: { connectionId: 'c1', toolName: 'lookup', args: '{"account":"{{trigger.input}}"}' } },
      { id: 'h1', type: 'http', data: { method: 'POST', url: 'https://example.com/hook', body: 'got {{step.t1.output.score}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 't1' },
      { id: 'e1', source: 't1', target: 'h1' },
    ],
  }
  const calls: Record<string, unknown>[] = []
  const runAction: RunActionFn = async (node) => {
    calls.push({ kind: node.kind, ...node.config })
    return node.kind === 'tool' ? { output: '{"score":88}' } : { output: `sent:${node.config.body}` }
  }
  const runAgent: RunAgentFn = async () => ({ output: 'unused' })
  const result = await interpretFlow(graph, 'Acme', { runAgent, runAction })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(calls[0].args, { account: 'Acme' }) // template resolved into tool args
  assert.equal(result.output, 'sent:got 88') // http body saw the tool's structured output
})

test('http steps preserve structured query, headers, and body values', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      {
        id: 'h1',
        type: 'http',
        data: {
          method: 'POST',
          url: 'https://example.com/accounts/{{trigger.input.accountId}}',
          query: '{"tags": "{{trigger.input.tags}}", "active": "{{trigger.input.active}}"}',
          headers: '{"authorization": "Bearer {{trigger.input.token}}"}',
          bodyMode: 'json',
          responseType: 'json',
          failOnHttpError: false,
          retries: 2,
          timeoutMs: 15000,
          body: '{"record": "{{trigger.input.record}}"}',
        },
      },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'h1' }],
  }
  const calls: Record<string, unknown>[] = []
  const runAction: RunActionFn = async (node) => {
    calls.push(node.config)
    return { output: { ok: true } }
  }
  const input = { accountId: 'acct_1', tags: ['a', 'b'], active: true, token: 'tok', record: { name: 'Acme' } }
  const result = await interpretFlow(graph, input, { runAgent: async () => ({ output: 'unused' }), runAction })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(calls[0], {
    method: 'POST',
    url: 'https://example.com/accounts/acct_1',
    query: { tags: ['a', 'b'], active: true },
    headers: { authorization: 'Bearer tok' },
    body: { record: { name: 'Acme' } },
    bodyMode: 'json',
    responseType: 'json',
    failOnHttpError: false,
    retries: 2,
    timeoutMs: 15000,
  })
})

test('tool args preserve object values from loop items', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['tool'] } },
      { id: 'tool', type: 'tool', data: { connectionId: 'c1', toolName: 'send', args: '{"account": "{{item}}", "name": "{{item.name}}"}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const calls: Record<string, unknown>[] = []
  const runAction: RunActionFn = async (node) => {
    calls.push(node.config)
    return { output: 'ok' }
  }
  const runAgent: RunAgentFn = async () => ({ output: 'unused' })
  const input = JSON.stringify([{ name: 'Acme', score: 91 }])
  const result = await interpretFlow(graph, input, { runAgent, runAction })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(calls[0].args, { account: { name: 'Acme', score: 91 }, name: 'Acme' })
})

test('tool steps pass retry and timeout config to the action runtime', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      {
        id: 'tool',
        type: 'tool',
        data: {
          connectionId: 'c1',
          toolName: 'send',
          retries: 2,
          timeoutMs: 15000,
          args: '{"message":"{{trigger.input.message}}"}',
        },
      },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'tool' }],
  }
  const calls: Record<string, unknown>[] = []
  const result = await interpretFlow(graph, { message: 'hello' }, {
    runAgent: async () => ({ output: '' }),
    runAction: async (node) => {
      calls.push(node.config)
      return { output: { ok: true } }
    },
  })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(calls[0], {
    connectionId: 'c1',
    toolName: 'send',
    args: { message: 'hello' },
    retries: 2,
    timeoutMs: 15000,
  })
})

test('a failing tool step honors onError', async () => {
  const graph = (onError: 'stop' | 'continue'): FlowGraph => ({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't1', type: 'tool', data: { connectionId: 'c1', toolName: 'boom', onError } },
      { id: 'a1', type: 'agent', data: { agentId: 'ok', input: 'x' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 't1' },
      { id: 'e1', source: 't1', target: 'a1' },
    ],
  })
  const runAction: RunActionFn = async () => ({ error: 'tool exploded' })
  const runAgent: RunAgentFn = async () => ({ output: 'OK' })
  assert.equal((await interpretFlow(graph('stop'), '', { runAgent, runAction })).status, 'failed')
  assert.equal((await interpretFlow(graph('continue'), '', { runAgent, runAction })).output, 'OK')
})

test('transform builds an object from templated fields', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a', input: 'x' } },
      { id: 'set', type: 'transform', data: { fields: [{ name: 'account', value: '{{trigger.input}}' }, { name: 'score', value: '{{step.n1.output.score}}' }] } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'n1' }, { id: 'e1', source: 'n1', target: 'set' }],
  }
  const runAgent: RunAgentFn = async () => ({ output: '{"score":91}' })
  const result = await interpretFlow(graph, 'Acme', { runAgent })
  assert.deepEqual(result.output, { account: 'Acme', score: 91 })
})

test('filter drops loop items that fail and ends the chain when it fails', async () => {
  const loopGraph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['keep', 'echo'] } },
      { id: 'keep', type: 'filter', data: { clauses: [{ left: '{{item.score}}', op: 'gt', right: '80' }] } },
      { id: 'echo', type: 'agent', data: { agentId: 'e', input: '{{item.name}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const items = [{ name: 'A', score: 91 }, { name: 'B', score: 40 }, { name: 'C', score: 88 }]
  const result = await interpretFlow(loopGraph, items, { runAgent })
  assert.deepEqual(result.output, ['A', 'C']) // B (score 40) filtered out
})

test('switch routes to the matching case, else default', async () => {
  const graph = (_tier: string): FlowGraph => ({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'sw', type: 'switch', data: { cases: [{ id: 'ent', left: '{{trigger.input}}', op: 'eq', right: 'enterprise' }, { id: 'mid', left: '{{trigger.input}}', op: 'eq', right: 'mid' }] } },
      { id: 'e', type: 'agent', data: { agentId: 'ent', input: 'ENT' } },
      { id: 'm', type: 'agent', data: { agentId: 'mid', input: 'MID' } },
      { id: 'd', type: 'agent', data: { agentId: 'def', input: 'DEFAULT' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'sw' },
      { id: 'e1', source: 'sw', target: 'e', branch: 'ent' },
      { id: 'e2', source: 'sw', target: 'm', branch: 'mid' },
      { id: 'e3', source: 'sw', target: 'd', branch: 'default' },
    ],
  })
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  assert.equal((await interpretFlow(graph('enterprise'), 'enterprise', { runAgent })).output, 'ENT')
  assert.equal((await interpretFlow(graph('mid'), 'mid', { runAgent })).output, 'MID')
  assert.equal((await interpretFlow(graph('smb'), 'smb', { runAgent })).output, 'DEFAULT')
})

test('onStep reports every node including containers', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['e'] } },
      { id: 'e', type: 'agent', data: { agentId: 'e', input: '{{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const outcomes: string[] = []
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  await interpretFlow(graph, ['a', 'b'], { runAgent, onStep: (o) => outcomes.push(o.nodeId) })
  assert.ok(outcomes.includes('loop')) // the container itself is reported
  assert.equal(outcomes.filter((id) => id === 'e').length, 2) // one per item
})

test('structured agent steps append the JSON instruction and expose parsed fields', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      {
        id: 'n1',
        type: 'agent',
        data: {
          agentId: 'a1',
          input: 'Score this account',
          responseFormat: 'structured',
          outputFields: [{ name: 'score', type: 'number' }],
        },
      },
      { id: 'n2', type: 'transform', data: { fields: [{ name: 'finalScore', value: '{{step.n1.output.score}}' }] } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'n1' },
      { id: 'e2', source: 'n1', target: 'n2' },
    ],
  }
  let sentInput = ''
  const runAgent: RunAgentFn = async (node) => {
    sentInput = node.input
    return { output: '{"score": 91}' }
  }
  const result = await interpretFlow(graph, 'acme', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.match(sentInput, /JSON object/)
  assert.match(sentInput, /"score"/)
  assert.deepEqual(result.output, { finalScore: 91 })
})

test('structured agent steps fail when the reply is not the required JSON', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      {
        id: 'n1',
        type: 'agent',
        data: { agentId: 'a1', responseFormat: 'structured', outputFields: [{ name: 'score', type: 'number' }] },
      },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  const runAgent: RunAgentFn = async () => ({ output: 'no json here' })
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'failed')
  const step = result.steps.find((s) => s.nodeId === 'n1')
  assert.equal(step?.status, 'failed')
  assert.match(step?.error ?? '', /JSON/)
})

test('humanAssistance=false turns a waiting agent into a failed step', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', humanAssistance: false } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  const runAgent: RunAgentFn = async () => ({ waiting: { status: 'waiting_user', question: 'Which region?' } })
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'failed')
  assert.equal(result.steps.find((s) => s.nodeId === 'n1')?.status, 'failed')
})

test('humanAssistance defaults to allowing the pause', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  const runAgent: RunAgentFn = async () => ({ waiting: { status: 'waiting_user', question: 'Which region?' } })
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'waiting')
  assert.equal(result.waiting?.nodeId, 'n1')
})

test('an agent timeout fails the step without starting a second concurrent execution', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: 'x', retries: 3, timeoutMs: 1000 } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  let calls = 0
  // Never resolves: simulates a live execution that outruns the step timeout.
  const runAgent: RunAgentFn = async () => {
    calls += 1
    return new Promise(() => {})
  }
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'failed')
  assert.equal(calls, 1) // retries: 3 must NOT re-run the still-live agent
  const step = result.steps.find((s) => s.nodeId === 'n1')
  assert.equal(step?.status, 'failed')
  assert.match(step?.error ?? '', /Timed out after 1s — the agent may still be finishing in the background\./)
  // The run-level result carries the same message so callers can persist it
  // on the run record (FlowRun.error) — it must not live only in the step.
  assert.match(result.error ?? '', /Timed out after 1s — the agent may still be finishing in the background\./)
})

test('a failed result carries the failing step error at the run level', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: 'x' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  const runAgent: RunAgentFn = async () => ({ error: 'boom' })
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'failed')
  assert.equal(result.error, 'boom')
})

test('agent hard errors still retry up to the configured budget', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: 'x', retries: 1, timeoutMs: 30000 } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  let calls = 0
  const runAgent: RunAgentFn = async () => {
    calls += 1
    return calls < 2 ? { error: 'boom' } : { output: 'recovered' }
  }
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(calls, 2)
  assert.equal(result.output, 'recovered')
})

// ── Variables: a typed symbol table threaded through the run ──────────────

test('variable initialize + set + read across steps', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'greeting', varType: 'string', value: 'hello' } },
      { id: 'v2', type: 'variable', data: { op: 'set', name: 'greeting', value: 'hi {{trigger.input}}' } },
      { id: 'n1', type: 'agent', data: { agentId: 'e', input: '{{var.greeting}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
      { id: 'e2', source: 'v2', target: 'n1' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const result = await interpretFlow(graph, 'Acme', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'hi Acme') // the agent read {{var.greeting}} after set
  // Step output mirrors the new variable value, so {{step.<id>.output}} works too.
  assert.equal(result.steps.find((s) => s.nodeId === 'v1')?.output, 'hello')
  assert.equal(result.steps.find((s) => s.nodeId === 'v2')?.output, 'hi Acme')
})

test('variable increment defaults to 1 and honors an explicit amount', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'count', varType: 'integer', value: '10' } },
      { id: 'v2', type: 'variable', data: { op: 'increment', name: 'count' } },
      { id: 'v3', type: 'variable', data: { op: 'increment', name: 'count', value: '5' } },
      { id: 'n1', type: 'agent', data: { agentId: 'e', input: 'count={{var.count}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
      { id: 'e2', source: 'v2', target: 'v3' },
      { id: 'e3', source: 'v3', target: 'n1' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.steps.find((s) => s.nodeId === 'v2')?.output, 11)
  assert.equal(result.steps.find((s) => s.nodeId === 'v3')?.output, 16)
  assert.equal(result.output, 'count=16')
})

test('variable decrement subtracts the amount', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'count', varType: 'integer', value: '10' } },
      { id: 'v2', type: 'variable', data: { op: 'decrement', name: 'count', value: '3' } },
      { id: 'v3', type: 'variable', data: { op: 'decrement', name: 'count' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
      { id: 'e2', source: 'v2', target: 'v3' },
    ],
  }
  const result = await interpretFlow(graph, '', { runAgent: async () => ({ output: '' }) })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.steps.find((s) => s.nodeId === 'v2')?.output, 7)
  assert.equal(result.steps.find((s) => s.nodeId === 'v3')?.output, 6)
})

test('variable appendArray pushes onto an initialized array', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'tags', varType: 'array', value: '["a"]' } },
      { id: 'v2', type: 'variable', data: { op: 'appendArray', name: 'tags', value: 'b' } },
      { id: 'v3', type: 'variable', data: { op: 'appendArray', name: 'tags', value: '{{trigger.input}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
      { id: 'e2', source: 'v2', target: 'v3' },
    ],
  }
  const result = await interpretFlow(graph, { name: 'Acme' }, { runAgent: async () => ({ output: '' }) })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(result.steps.find((s) => s.nodeId === 'v3')?.output, ['a', 'b', { name: 'Acme' }])
})

test('variable appendString concatenates onto an initialized string', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'log', value: 'start' } },
      { id: 'v2', type: 'variable', data: { op: 'appendString', name: 'log', value: ' then {{trigger.input}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
    ],
  }
  const result = await interpretFlow(graph, 'Acme', { runAgent: async () => ({ output: '' }) })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.steps.find((s) => s.nodeId === 'v2')?.output, 'start then Acme')
})

test('variable set resolves a templated value referencing a prior step', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'score', varType: 'integer', value: '0' } },
      { id: 'n1', type: 'agent', data: { agentId: 'score', input: 'x' } },
      { id: 'v2', type: 'variable', data: { op: 'set', name: 'score', value: '{{step.n1.output.score}}' } },
      { id: 'n2', type: 'agent', data: { agentId: 'e', input: 'score={{var.score}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'n1' },
      { id: 'e2', source: 'n1', target: 'v2' },
      { id: 'e3', source: 'v2', target: 'n2' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.agentId === 'score' ? '{"score":91}' : n.input })
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.steps.find((s) => s.nodeId === 'v2')?.output, 91) // stays numeric
  assert.equal(result.output, 'score=91')
})

test('variable initialize integer with a non-numeric value fails with a plain message', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'count', varType: 'integer', value: 'abc' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'v1' }],
  }
  const result = await interpretFlow(graph, '', { runAgent: async () => ({ output: '' }) })
  assert.equal(result.status, 'failed')
  const step = result.steps.find((s) => s.nodeId === 'v1')
  assert.equal(step?.status, 'failed')
  assert.match(step?.error ?? '', /whole number/)
  assert.match(step?.error ?? '', /"abc"/)
})

test('variable increment on a string variable fails', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'greeting', varType: 'string', value: 'hi' } },
      { id: 'v2', type: 'variable', data: { op: 'increment', name: 'greeting' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
    ],
  }
  const result = await interpretFlow(graph, '', { runAgent: async () => ({ output: '' }) })
  assert.equal(result.status, 'failed')
  assert.match(result.steps.find((s) => s.nodeId === 'v2')?.error ?? '', /isn't a number/)
})

test('variable ops on a never-initialized name fail cleanly', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'set', name: 'ghost', value: 'x' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'v1' }],
  }
  const result = await interpretFlow(graph, '', { runAgent: async () => ({ output: '' }) })
  assert.equal(result.status, 'failed')
  assert.match(result.steps.find((s) => s.nodeId === 'v1')?.error ?? '', /hasn't been initialized/)
})

test('{{var.x}} resolves inside an agent step input, including object fields', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'deal', varType: 'object', value: '{"name":"Acme","stage":"closed"}' } },
      { id: 'n1', type: 'agent', data: { agentId: 'e', input: 'deal {{var.deal.name}} is {{var.deal.stage}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'n1' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.output, 'deal Acme is closed')
})

test('variables mutated inside a loop body persist after the loop', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'count', varType: 'integer', value: '0' } },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['inc'] } },
      { id: 'inc', type: 'variable', data: { op: 'increment', name: 'count' } },
      { id: 'n1', type: 'agent', data: { agentId: 'e', input: 'count={{var.count}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'loop' },
      { id: 'e2', source: 'loop', target: 'n1' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const result = await interpretFlow(graph, ['a', 'b', 'c'], { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'count=3')
})

test('resume replays completed variable steps back into the symbol table', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'count', varType: 'integer', value: '1' } },
      { id: 'v2', type: 'variable', data: { op: 'increment', name: 'count' } },
      { id: 'ask', type: 'agent', data: { agentId: 'ask', input: 'x' } },
      { id: 'n2', type: 'agent', data: { agentId: 'e', input: 'count={{var.count}} reply={{step.ask.output}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
      { id: 'e2', source: 'v2', target: 'ask' },
      { id: 'e3', source: 'ask', target: 'n2' },
    ],
  }
  const ran: string[] = []
  const runAgent: RunAgentFn = async (n) => {
    ran.push(n.id)
    if (n.id === 'ask') return { output: n.resume ? 'ANSWERED' : 'ignored' }
    return { output: n.input }
  }
  // Resume: v1/v2 replay from stored outputs (they are NOT re-executed), so the
  // variables map must be reconstructed from those outputs for n2 to read.
  const result = await interpretFlow(graph, '', {
    runAgent,
    completed: { v1: 1, v2: 2 },
    resumeNodeId: 'ask',
  })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(ran, ['ask', 'n2'])
  assert.equal(result.output, 'count=2 reply=ANSWERED')
})

test('resume restores variable writes made inside a completed loop body', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'count', varType: 'integer', value: '0' } },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['inc'] } },
      { id: 'inc', type: 'variable', data: { op: 'increment', name: 'count' } },
      { id: 'ask', type: 'agent', data: { agentId: 'ask', input: 'x' } },
      { id: 'n2', type: 'agent', data: { agentId: 'e', input: 'count={{var.count}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'loop' },
      { id: 'e2', source: 'loop', target: 'ask' },
      { id: 'e3', source: 'ask', target: 'n2' },
    ],
  }
  const ran: string[] = []
  const runAgent: RunAgentFn = async (n) => {
    ran.push(n.id)
    if (n.id === 'ask') return { output: 'ANSWERED' }
    return { output: n.input }
  }
  // Prior run: v1 wrote 0, the loop body incremented count to 3 (a stored
  // output is the LAST post-op value for that node), the loop completed, then
  // `ask` paused. The resumed walk short-circuits the completed loop without
  // entering its body — `inc` lives in `contained` — so its write must be
  // replayed from the completed map up front, not during the walk.
  const result = await interpretFlow(graph, ['a', 'b', 'c'], {
    runAgent,
    completed: { v1: 0, inc: 3, loop: [1, 2, 3] },
    resumeNodeId: 'ask',
  })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(ran, ['ask', 'n2'])
  assert.equal(result.output, 'count=3')
})

test('resume restores variable writes made inside completed parallel branches', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'total', varType: 'integer', value: '0' } },
      { id: 'par', type: 'parallel', data: { branches: [['va'], ['vb']] } },
      { id: 'va', type: 'variable', data: { op: 'increment', name: 'total', value: '1' } },
      { id: 'vb', type: 'variable', data: { op: 'increment', name: 'total', value: '2' } },
      { id: 'ask', type: 'agent', data: { agentId: 'ask', input: 'x' } },
      { id: 'n2', type: 'agent', data: { agentId: 'e', input: 'total={{var.total}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'par' },
      { id: 'e2', source: 'par', target: 'ask' },
      { id: 'e3', source: 'ask', target: 'n2' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.id === 'ask' ? 'ANSWERED' : n.input })
  const result = await interpretFlow(graph, '', {
    runAgent,
    completed: { v1: 0, va: 1, vb: 3, par: { va: 1, vb: 3 } },
    resumeNodeId: 'ask',
  })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'total=3')
})

test('resume replays completed variable steps in execution order — the later set wins', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'greeting', varType: 'string', value: 'first' } },
      { id: 'v2', type: 'variable', data: { op: 'set', name: 'greeting', value: 'second' } },
      { id: 'ask', type: 'agent', data: { agentId: 'ask', input: 'x' } },
      { id: 'n2', type: 'agent', data: { agentId: 'e', input: 'greeting={{var.greeting}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
      { id: 'e2', source: 'v2', target: 'ask' },
      { id: 'e3', source: 'ask', target: 'n2' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.id === 'ask' ? 'ANSWERED' : n.input })
  // `completed` preserves execution order (rows load `order asc`), so the
  // initialize replays first and the set's value is what survives.
  const result = await interpretFlow(graph, '', {
    runAgent,
    completed: { v1: 'first', v2: 'second' },
    resumeNodeId: 'ask',
  })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'greeting=second')
})

test('declared float type governs set and increment even when the current value is whole', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'pi', varType: 'float' } },
      { id: 'v2', type: 'variable', data: { op: 'set', name: 'pi', value: '3.5' } },
      { id: 'v3', type: 'variable', data: { op: 'increment', name: 'pi', value: '0.25' } },
      { id: 'n1', type: 'agent', data: { agentId: 'e', input: 'pi={{var.pi}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
      { id: 'e2', source: 'v2', target: 'v3' },
      { id: 'e3', source: 'v3', target: 'n1' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  // The blank initialize defaults pi to 0 — a whole number — but the DECLARED
  // float type must keep governing later coercions.
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'pi=3.75')
})

test('set on a declared integer variable still rejects a non-whole value', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'count', varType: 'integer', value: '0' } },
      { id: 'v2', type: 'variable', data: { op: 'set', name: 'count', value: '3.7' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
    ],
  }
  const result = await interpretFlow(graph, '', { runAgent: stub({}) })
  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /whole number/)
})

test('increment amount that resolves empty fails instead of silently adding 0', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'count', varType: 'integer', value: '5' } },
      { id: 'v2', type: 'variable', data: { op: 'increment', name: 'count', value: '{{step.missing.output}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
    ],
  }
  const result = await interpretFlow(graph, '', { runAgent: stub({}) })
  assert.equal(result.status, 'failed')
  assert.equal(result.error, 'Variable "count" needs a number for the amount — the value came back empty.')
})

test('set value that resolves empty fails instead of resetting to the type default', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'label', varType: 'string', value: 'x' } },
      { id: 'v2', type: 'variable', data: { op: 'set', name: 'label', value: '{{step.missing.output}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
    ],
  }
  const result = await interpretFlow(graph, '', { runAgent: stub({}) })
  assert.equal(result.status, 'failed')
  assert.equal(result.error, 'Variable "label" needs a value — the value came back empty.')
})

test('set with a literally empty value field still clears a string variable', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'greeting', varType: 'string', value: 'hello' } },
      { id: 'v2', type: 'variable', data: { op: 'set', name: 'greeting', value: '' } },
      { id: 'n1', type: 'agent', data: { agentId: 'e', input: 'greeting=[{{var.greeting}}]' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
      { id: 'e2', source: 'v2', target: 'n1' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  // The user configured an empty value on purpose — an empty string is a
  // legitimate set, unlike a token that resolved to nothing.
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'greeting=[]')
})

// ── data operation steps ─────────────────────────────────────────────────────

test('data step joins a prior step output and feeds a later step', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'list', input: 'x' } },
      { id: 'd1', type: 'data', data: { op: 'join', input: '{{step.n1.output}}', separator: ' - ' } },
      { id: 'n2', type: 'agent', data: { agentId: 'echo', input: 'got {{step.d1.output}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'd1' },
      { id: 'e2', source: 'd1', target: 'n2' },
    ],
  }
  const result = await interpretFlow(graph, '', { runAgent: stub({ list: '["a","b","c"]' }) })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'ran:got a - b - c')
})

test('data parseJson exposes fields to downstream steps', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'd1', type: 'data', data: { op: 'parseJson', input: '{{trigger.input}}' } },
      { id: 'n1', type: 'agent', data: { agentId: 'echo', input: 'score={{step.d1.output.score}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'd1' },
      { id: 'e1', source: 'd1', target: 'n1' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const result = await interpretFlow(graph, '{"score": 91}', { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'score=91')
})

test('data parseJson on invalid content fails the run with a plain message', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'd1', type: 'data', data: { op: 'parseJson', input: '{{trigger.input}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'd1' }],
  }
  const result = await interpretFlow(graph, 'not json at all', { runAgent: stub({}) })
  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /Parse JSON needs valid JSON/)
})

test('data filterArray filters a prior step output by item fields', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'list', input: 'x' } },
      { id: 'd1', type: 'data', data: { op: 'filterArray', input: '{{step.n1.output}}', clauses: [{ left: '{{item.stage}}', op: 'eq', right: 'open' }] } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'd1' },
    ],
  }
  const result = await interpretFlow(graph, '', {
    runAgent: stub({ list: '[{"stage":"open","name":"A"},{"stage":"closed","name":"B"}]' }),
  })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(result.output, [{ stage: 'open', name: 'A' }])
})

test('data select maps items and feeds an html table downstream', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'd1', type: 'data', data: { op: 'select', input: '{{trigger.input}}', fields: [{ name: 'company', value: '{{item.name}}' }] } },
      { id: 'd2', type: 'data', data: { op: 'htmlTable', input: '{{step.d1.output}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'd1' },
      { id: 'e1', source: 'd1', target: 'd2' },
    ],
  }
  const result = await interpretFlow(graph, [{ name: '<b>Acme</b>' }], { runAgent: stub({}) })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, '<table><thead><tr><th>company</th></tr></thead><tbody><tr><td>&lt;b&gt;Acme&lt;/b&gt;</td></tr></tbody></table>')
})

test('data compose passes trigger input structure through to later steps', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'd1', type: 'data', data: { op: 'compose', input: '{{trigger.input.account}}' } },
      { id: 'n1', type: 'agent', data: { agentId: 'echo', input: 'name={{step.d1.output.name}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'd1' },
      { id: 'e1', source: 'd1', target: 'n1' },
    ],
  }
  const runAgent: RunAgentFn = async (n) => ({ output: n.input })
  const result = await interpretFlow(graph, { account: { name: 'Acme' } }, { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'name=Acme')
})

test('humanReview pauses the flow with a resolved templated message', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: '{{trigger.input}}' } },
      { id: 'hr', type: 'humanReview', data: { message: 'Confirm the plan for {{step.n1.output}}' } },
      { id: 'n2', type: 'agent', data: { agentId: 'a2', input: 'never runs' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'hr' },
      { id: 'e2', source: 'hr', target: 'n2' },
    ],
  }
  const result = await interpretFlow(graph, 'x', { runAgent: stub({ a1: 'Acme' }) })
  assert.equal(result.status, 'waiting')
  assert.equal(result.waiting?.nodeId, 'hr')
  assert.equal(result.waiting?.question, 'Confirm the plan for Acme')
  const hr = result.steps.find((step) => step.nodeId === 'hr')
  assert.equal(hr?.status, 'waiting')
  // The pause reason rides on the outcome so execute-flow's onStep persistence
  // stores the same waiting shape the agent adapter writes (kind 'input').
  assert.deepEqual(hr?.output, { waiting: { kind: 'input', question: 'Confirm the plan for Acme' } })
  assert.ok(!result.steps.some((step) => step.nodeId === 'n2'))
})

test('humanReview resume turns the reply into the step output for downstream steps', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: '{{trigger.input}}' } },
      { id: 'hr', type: 'humanReview', data: { message: 'Confirm the plan for {{step.n1.output}}' } },
      { id: 'n2', type: 'agent', data: { agentId: 'a2', input: 'got {{step.hr.output}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n1' },
      { id: 'e1', source: 'n1', target: 'hr' },
      { id: 'e2', source: 'hr', target: 'n2' },
    ],
  }
  const result = await interpretFlow(graph, 'x', {
    runAgent: stub({}),
    completed: { n1: 'Acme' },
    resumeNodeId: 'hr',
    resumeReply: 'Approved by Jane',
  })
  assert.equal(result.status, 'succeeded')
  const hr = result.steps.find((step) => step.nodeId === 'hr')
  assert.equal(hr?.status, 'succeeded')
  assert.equal(hr?.output, 'Approved by Jane')
  assert.equal(result.output, 'ran:got Approved by Jane')
})

test('condition inside a loop body fails the run loudly (no silent skip)', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['c1'] } },
      { id: 'c1', type: 'condition', data: { match: 'all', clauses: [{ left: '{{item}}', op: 'eq', right: 'a' }] } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'loop' }],
  }
  const result = await interpretFlow(graph, ['a', 'b'], { runAgent: stub({}) })
  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /can't run inside a For each \/ Parallel body/)
})

test('a condition on the main chain still routes normally after the body guard', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'c1', type: 'condition', data: { match: 'all', clauses: [{ left: '{{trigger.input}}', op: 'eq', right: 'go' }] } },
      { id: 'yes', type: 'agent', data: { agentId: 'a1', input: 'yes' } },
      { id: 'no', type: 'agent', data: { agentId: 'a2', input: 'no' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'c1' },
      { id: 'e1', source: 'c1', target: 'yes', branch: 'true' },
      { id: 'e2', source: 'c1', target: 'no', branch: 'false' },
    ],
  }
  const result = await interpretFlow(graph, 'go', { runAgent: stub({ a1: 'took-true' }) })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'took-true')
})

test('trigger filter false → run succeeds immediately with a skipped trigger, nothing else runs', async () => {
  let agentRan = false
  const graph: FlowGraph = {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'webhook', filter: { match: 'all', clauses: [{ left: '{{trigger.input.status}}', op: 'eq', right: 'urgent' }] } } },
      },
      { id: 'a1', type: 'agent', data: { agentId: 'a1', input: 'go' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'a1' }],
  }
  const runAgent: RunAgentFn = async () => {
    agentRan = true
    return { output: 'x' }
  }
  const result = await interpretFlow(graph, { status: 'routine' }, { runAgent })
  assert.equal(result.status, 'succeeded')
  assert.equal(agentRan, false)
  assert.equal(result.output, 'Trigger filter did not match — run skipped.')
  assert.equal(result.steps.length, 1)
  assert.equal(result.steps[0].status, 'skipped')
})

test('trigger filter true → normal execution', async () => {
  const graph: FlowGraph = {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'webhook', filter: { match: 'all', clauses: [{ left: '{{trigger.input.status}}', op: 'eq', right: 'urgent' }] } } },
      },
      { id: 'a1', type: 'agent', data: { agentId: 'a1', input: 'go' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'a1' }],
  }
  const result = await interpretFlow(graph, { status: 'urgent' }, { runAgent: stub({ a1: 'ran-normally' }) })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'ran-normally')
})

test('a trigger without a filter (or with empty clauses) is unaffected', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'webhook', filter: { match: 'all', clauses: [] } } } },
      { id: 'a1', type: 'agent', data: { agentId: 'a1', input: 'go' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'a1' }],
  }
  const result = await interpretFlow(graph, { status: 'anything' }, { runAgent: stub({ a1: 'ran' }) })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.output, 'ran')
})
