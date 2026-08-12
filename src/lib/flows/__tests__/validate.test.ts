import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '../graph'
import { nodeLabel, validateFlowGraph, validationErrorMessage } from '../validate'

test('validateFlowGraph accepts a runnable agent flow', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'agent-1', input: 'Use {{trigger.input}}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'a' }],
  }
  const result = validateFlowGraph(graph, { agents: [{ id: 'agent-1', title: 'Agent' }] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
})

test('validateFlowGraph reports missing agents and dangling edges', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'missing', input: 'x' } },
    ],
    edges: [{ id: 'bad', source: 'trigger', target: 'nope' }],
  }
  const result = validateFlowGraph(graph, { agents: [{ id: 'agent-1' }] })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((issue) => issue.code === 'UNKNOWN_AGENT'))
  assert.ok(result.errors.some((issue) => issue.code === 'DANGLING_EDGE'))
  assert.match(validationErrorMessage(result), /agent|edge|missing/i)
})

test('validateFlowGraph checks tool connection, tool name, and object-shaped JSON args', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't', type: 'tool', data: { connectionId: 'c1', toolName: 'missing_tool', args: '{"broken":' } },
      { id: 'arr', type: 'tool', data: { connectionId: 'c1', toolName: 'send', args: '[]' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 't' }, { id: 'e2', source: 't', target: 'arr' }],
  }
  const result = validateFlowGraph(graph, { toolCatalog: [{ id: 'c1', tools: [{ name: 'send' }] }] })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((issue) => issue.code === 'UNKNOWN_TOOL'))
  assert.ok(result.errors.some((issue) => issue.code === 'INVALID_JSON_OBJECT' && issue.nodeId === 't'))
  assert.ok(result.errors.some((issue) => issue.code === 'INVALID_JSON_OBJECT' && issue.nodeId === 'arr'))
})

test('validateFlowGraph checks required tool arguments from input schema', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't', type: 'tool', data: { connectionId: 'c1', toolName: 'send', args: '{"channel":"{{trigger.input.channel}}"}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 't' }],
  }
  const result = validateFlowGraph(graph, {
    toolCatalog: [
      {
        id: 'c1',
        tools: [
          {
            name: 'send',
            inputSchema: { type: 'object', required: ['channel', 'message'], properties: { channel: { type: 'string' }, message: { type: 'string' } } },
          },
        ],
      },
    ],
  })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((issue) => issue.code === 'MISSING_TOOL_ARG' && issue.message.includes('message')))
  assert.ok(!result.errors.some((issue) => issue.code === 'MISSING_TOOL_ARG' && issue.message.includes('channel')))
})

test('validateFlowGraph accepts required object tool args supplied by exact data tokens', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't', type: 'tool', data: { connectionId: 'c1', toolName: 'upsert', args: '{"record":"{{trigger.input.record}}"}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 't' }],
  }
  const result = validateFlowGraph(graph, {
    toolCatalog: [{ id: 'c1', tools: [{ name: 'upsert', inputSchema: { type: 'object', required: ['record'] } }] }],
  })
  assert.equal(result.ok, true)
})

test('validateFlowGraph checks HTTP request configuration', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'bad-url', type: 'http', data: { method: 'POST', url: 'ftp://example.com', headers: '[]', query: '"bad"', bodyMode: 'json', body: '{broken' } },
      { id: 'insecure-url', type: 'http', data: { method: 'POST', url: 'http://api.example.com' } },
      // Only an explicit Send Body triggers the warning — a leftover body from a
      // method switch with the toggle off is dropped quietly, by design.
      { id: 'get-body', type: 'http', data: { method: 'GET', url: 'https://api.example.com', sendBody: true, body: '{"ignored":true}' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'bad-url' },
      { id: 'e2', source: 'bad-url', target: 'insecure-url' },
      { id: 'e3', source: 'insecure-url', target: 'get-body' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((issue) => issue.code === 'INVALID_HTTP_URL'))
  assert.ok(result.errors.some((issue) => issue.code === 'INVALID_HTTP_URL' && issue.message.includes('https://') && issue.nodeId === 'insecure-url'))
  assert.ok(result.errors.some((issue) => issue.code === 'INVALID_JSON_OBJECT' && issue.message.includes('headers')))
  assert.ok(result.errors.some((issue) => issue.code === 'INVALID_JSON_OBJECT' && issue.message.includes('query')))
  assert.ok(result.errors.some((issue) => issue.code === 'INVALID_JSON' && issue.message.includes('body')))
  assert.ok(result.warnings.some((issue) => issue.code === 'HTTP_BODY_IGNORED'))
})

test('validateFlowGraph warns when an http step authenticates with an unavailable connection', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'h1', type: 'http', data: { method: 'POST', url: 'https://api.example.com', connectionId: 'gone' } },
      { id: 'h2', type: 'http', data: { method: 'POST', url: 'https://api.example.com', connectionId: 'c1' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'h1' }, { id: 'e2', source: 'h1', target: 'h2' }],
  }
  const result = validateFlowGraph(graph, { toolCatalog: [{ id: 'c1', tools: [] }] })
  assert.equal(result.ok, true) // warning only — never blocks a run
  assert.ok(result.warnings.some((issue) => issue.code === 'UNKNOWN_HTTP_CONNECTION' && issue.nodeId === 'h1'))
  assert.ok(!result.warnings.some((issue) => issue.code === 'UNKNOWN_HTTP_CONNECTION' && issue.nodeId === 'h2'))
  // No catalog context (e.g. plain graph checks): no warning either
  const noContext = validateFlowGraph(graph)
  assert.ok(!noContext.warnings.some((issue) => issue.code === 'UNKNOWN_HTTP_CONNECTION'))
})

test('validateFlowGraph checks loop bodies and switch defaults', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: [] } },
      { id: 'sw', type: 'switch', data: { cases: [{ id: 'c1', left: '{{trigger.input}}', op: 'eq', right: 'x' }] } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'loop' }, { id: 'e2', source: 'loop', target: 'sw' }],
  }
  const result = validateFlowGraph(graph)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((issue) => issue.code === 'EMPTY_LOOP_BODY'))
  assert.ok(result.warnings.some((issue) => issue.code === 'MISSING_SWITCH_DEFAULT'))
})

test('validateFlowGraph allows saving an empty draft when runnable checks are disabled', () => {
  const graph: FlowGraph = { nodes: [{ id: 'trigger', type: 'trigger', data: {} }], edges: [] }
  assert.equal(validateFlowGraph(graph).ok, false)
  assert.equal(validateFlowGraph(graph, { requireRunnable: false }).ok, true)
})

test('validateFlowGraph checks trigger configuration', () => {
  const invalidType: FlowGraph = {
    nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'mystery' } } }],
    edges: [],
  }
  assert.ok(validateFlowGraph(invalidType, { requireRunnable: false }).errors.some((issue) => issue.code === 'INVALID_TRIGGER_TYPE'))

  const missingCron: FlowGraph = {
    nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'schedule', schedule: { type: 'cron' } } } }],
    edges: [],
  }
  assert.ok(validateFlowGraph(missingCron, { requireRunnable: false }).errors.some((issue) => issue.code === 'MISSING_CRON'))

  const duplicateInputFields: FlowGraph = {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'manual', inputFields: [{ name: 'account', type: 'string' }, { name: 'account', type: 'number' }] } },
      },
    ],
    edges: [],
  }
  assert.ok(validateFlowGraph(duplicateInputFields, { requireRunnable: false }).errors.some((issue) => issue.code === 'DUPLICATE_INPUT_FIELD'))
})

test('warns when a step maps fields from a text-only agent', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a1', type: 'agent', data: { agentId: 'agentA' } },
      { id: 'h1', type: 'http', data: { method: 'POST', url: 'https://x.test', body: 'score: {{step.a1.output.score}}' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'a1' },
      { id: 'e2', source: 'a1', target: 'h1' },
    ],
  } as FlowGraph
  const result = validateFlowGraph(graph, { agents: [{ id: 'agentA', title: 'A' }] })
  assert.ok(result.warnings.some((w) => w.code === 'TEXT_AGENT_FIELD_REF' && w.nodeId === 'h1'))
})

test('no field-ref warning for structured agents or whole-output references', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a1', type: 'agent', data: { agentId: 'agentA', responseFormat: 'structured', outputFields: [{ name: 'score', type: 'number' }] } },
      { id: 'h1', type: 'http', data: { method: 'POST', url: 'https://x.test', body: '{{step.a1.output.score}} and {{step.a1.output}}' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'a1' },
      { id: 'e2', source: 'a1', target: 'h1' },
    ],
  } as FlowGraph
  const result = validateFlowGraph(graph, { agents: [{ id: 'agentA', title: 'A' }] })
  assert.equal(result.warnings.some((w) => w.code === 'TEXT_AGENT_FIELD_REF'), false)
})

test('allows a nango tool on the spine', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'send', type: 'tool', data: { connectionId: 'nango:slack', toolName: 'slack_post_message', args: '{}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'send' }],
  } as FlowGraph
  const result = validateFlowGraph(graph)
  assert.equal(result.ok, true)
})

test('validateFlowGraph accepts a well-formed variable flow', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'count', varType: 'integer', value: '0' } },
      { id: 'v2', type: 'variable', data: { op: 'increment', name: 'count' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.deepEqual(result.errors, [])
})

test('validateFlowGraph requires a variable name and values for set/append', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: '' } },
      { id: 'v2', type: 'variable', data: { op: 'initialize', name: 'log' } },
      { id: 'v3', type: 'variable', data: { op: 'appendString', name: 'log', value: '' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
      { id: 'e2', source: 'v2', target: 'v3' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.ok(result.errors.some((issue) => issue.code === 'MISSING_VARIABLE_NAME' && issue.nodeId === 'v1'))
  assert.ok(result.errors.some((issue) => issue.code === 'MISSING_VARIABLE_VALUE' && issue.nodeId === 'v3'))
})

test('validateFlowGraph rejects duplicate variable initializations', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'count' } },
      { id: 'v2', type: 'variable', data: { op: 'initialize', name: 'count' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.ok(result.errors.some((issue) => issue.code === 'DUPLICATE_VARIABLE'))
})

test('validateFlowGraph rejects mutations of variables that are never or only later initialized', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'set', name: 'ghost', value: 'x' } },
      { id: 'v2', type: 'variable', data: { op: 'increment', name: 'late' } },
      { id: 'v3', type: 'variable', data: { op: 'initialize', name: 'late', varType: 'integer' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
      { id: 'e2', source: 'v2', target: 'v3' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.ok(result.errors.some((issue) => issue.code === 'UNINITIALIZED_VARIABLE' && issue.nodeId === 'v1'))
  assert.ok(result.errors.some((issue) => issue.code === 'UNINITIALIZED_VARIABLE' && issue.nodeId === 'v2'))
})

test('validateFlowGraph rejects increment/decrement on non-numeric variables', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'v1', type: 'variable', data: { op: 'initialize', name: 'greeting', varType: 'string' } },
      { id: 'v2', type: 'variable', data: { op: 'increment', name: 'greeting' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'v1' },
      { id: 'e1', source: 'v1', target: 'v2' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.ok(result.errors.some((issue) => issue.code === 'VARIABLE_NOT_NUMERIC' && issue.nodeId === 'v2'))
})

test('validateFlowGraph accepts a well-formed data operation flow', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'd1', type: 'data', data: { op: 'join', input: '{{trigger.input}}', separator: ', ' } },
      { id: 'd2', type: 'data', data: { op: 'select', input: '{{step.d1.output}}', fields: [{ name: 'x', value: '{{item}}' }] } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'd1' },
      { id: 'e1', source: 'd1', target: 'd2' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.deepEqual(result.errors, [])
})

test('validateFlowGraph requires an input on every data operation', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'd1', type: 'data', data: { op: 'compose', input: '' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'd1' }],
  }
  const result = validateFlowGraph(graph)
  assert.ok(result.errors.some((issue) => issue.code === 'MISSING_DATA_INPUT' && issue.nodeId === 'd1'))
})

test('validateFlowGraph requires clauses on filter array and fields on select', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'd1', type: 'data', data: { op: 'filterArray', input: '{{trigger.input}}' } },
      { id: 'd2', type: 'data', data: { op: 'select', input: '{{trigger.input}}', fields: [] } },
      { id: 'd3', type: 'data', data: { op: 'select', input: '{{trigger.input}}', fields: [{ name: '', value: '{{item}}' }] } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'd1' },
      { id: 'e1', source: 'd1', target: 'd2' },
      { id: 'e2', source: 'd2', target: 'd3' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.ok(result.errors.some((issue) => issue.code === 'EMPTY_DATA_CLAUSES' && issue.nodeId === 'd1'))
  assert.ok(result.errors.some((issue) => issue.code === 'EMPTY_DATA_FIELDS' && issue.nodeId === 'd2'))
  assert.ok(result.errors.some((issue) => issue.code === 'MISSING_DATA_FIELD_NAME' && issue.nodeId === 'd3'))
})

test('validateFlowGraph requires a reviewer message on humanReview steps', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'hr', type: 'humanReview', data: { message: '   ' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'hr' }],
  }
  const result = validateFlowGraph(graph)
  assert.ok(
    result.errors.some(
      (issue) =>
        issue.code === 'MISSING_REVIEW_MESSAGE' &&
        issue.nodeId === 'hr' &&
        issue.message === 'Request information needs a message for the reviewer.',
    ),
  )
})

test('validateFlowGraph accepts a humanReview step with a message and optional assignee', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'hr', type: 'humanReview', data: { message: 'What segment should we target?', assigneeUserId: 'user-1' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'hr' }],
  }
  const result = validateFlowGraph(graph)
  assert.deepEqual(result.errors, [])
})

test('validateFlowGraph warns (not errors) on a humanReview step inside a loop or parallel branch', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'l1', type: 'loop', data: { over: '{{trigger.input}}', body: ['hr1'] } },
      { id: 'hr1', type: 'humanReview', data: { message: 'Approve this item?' } },
      { id: 'p1', type: 'parallel', data: { branches: [['hr2']] } },
      { id: 'hr2', type: 'humanReview', data: { message: 'Anything to add?' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'l1' },
      { id: 'e1', source: 'l1', target: 'p1' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.equal(result.ok, true) // warning only — the flow stays runnable
  for (const nodeId of ['hr1', 'hr2']) {
    const issue = result.warnings.find((entry) => entry.code === 'HUMAN_REVIEW_IN_CONTAINER' && entry.nodeId === nodeId)
    assert.ok(issue, `expected a container warning for ${nodeId}`)
    assert.match(issue!.message, /re-ask on resume/)
  }
})

test('validateFlowGraph does not warn on a humanReview step in the main flow', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'hr', type: 'humanReview', data: { message: 'What segment should we target?' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'hr' }],
  }
  const result = validateFlowGraph(graph)
  assert.ok(!result.warnings.some((entry) => entry.code === 'HUMAN_REVIEW_IN_CONTAINER'))
})

test('allows a condition inside a loop body', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['c1'] } },
      { id: 'c1', type: 'condition', data: { match: 'all', clauses: [{ left: '{{item}}', op: 'eq', right: 'x' }] } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'loop' }],
  }
  const result = validateFlowGraph(graph)
  assert.ok(!result.errors.some((candidate) => candidate.code === 'CONDITION_IN_CONTAINER'))
})

test('allows a switch inside a parallel branch; a main-chain condition stays valid', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'p1', type: 'parallel', data: { branches: [['s1']] } },
      { id: 's1', type: 'switch', data: { cases: [{ id: 'k1', left: '{{item}}', op: 'eq', right: 'x' }] } },
      { id: 'c-main', type: 'condition', data: { match: 'all', clauses: [{ left: '1', op: 'eq', right: '1' }] } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'p1' },
      { id: 'e2', source: 'p1', target: 'c-main' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.ok(!result.errors.some((issue) => issue.code === 'CONDITION_IN_CONTAINER' && issue.nodeId === 's1'))
  assert.ok(!result.errors.some((issue) => issue.nodeId === 'c-main'))
})

test('input node: rejects blank/duplicate param names and >1 input node', () => {
  const r = validateFlowGraph({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'in1', type: 'input', data: { params: [{ name: 'a', type: 'string' }, { name: 'a', type: 'string' }] } },
      { id: 'in2', type: 'input', data: { params: [{ name: 'b', type: 'string' }] } },
    ],
    edges: [{ id: 'e', source: 'trigger', target: 'in1' }],
  })
  const codes = r.errors.map((e) => e.code)
  assert.ok(codes.includes('DUPLICATE_INPUT_PARAM'))
  assert.ok(codes.includes('MULTIPLE_INPUT_NODES'))
})

test('subflow node needs a flowId', () => {
  const r = validateFlowGraph({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 's', type: 'subflow', data: { flowId: '' } },
    ],
    edges: [{ id: 'e', source: 'trigger', target: 's' }],
  })
  assert.ok(r.errors.some((e) => e.code === 'MISSING_SUBFLOW_FLOW'))
})

test('input node inside a loop body is rejected', () => {
  const r = validateFlowGraph({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['in'] } },
      { id: 'in', type: 'input', data: { params: [{ name: 'a', type: 'string' }] } },
    ],
    edges: [{ id: 'e', source: 'trigger', target: 'loop' }],
  })
  assert.ok(r.errors.some((e) => e.code === 'IO_NODE_IN_CONTAINER'))
})

test('subflow node inside a loop body is ALLOWED (subflow-per-item pattern)', () => {
  const r = validateFlowGraph({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['sub'] } },
      { id: 'sub', type: 'subflow', data: { flowId: 'flw_child', input: '{"item":"{{item}}"}' } },
    ],
    edges: [{ id: 'e', source: 'trigger', target: 'loop' }],
  })
  assert.ok(!r.errors.some((e) => e.code === 'IO_NODE_IN_CONTAINER'))
})

test('router needs unique branch ids and may run inside a container', () => {
  const r = validateFlowGraph({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['r'] } },
      { id: 'r', type: 'router', data: { branches: [{ id: 'a' }, { id: 'a' }] } },
    ],
    edges: [{ id: 'e', source: 'trigger', target: 'loop' }],
  })
  const codes = r.errors.map((e) => e.code)
  assert.ok(codes.includes('DUPLICATE_ROUTER_BRANCH'))
  assert.ok(!codes.includes('ROUTER_IN_CONTAINER'))
})

test('errorShield needs a body; empty fallback is a warning', () => {
  const r = validateFlowGraph({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 's', type: 'errorShield', data: { body: [], fallback: [] } },
    ],
    edges: [{ id: 'e', source: 'trigger', target: 's' }],
  })
  assert.ok(r.errors.some((e) => e.code === 'EMPTY_SHIELD_BODY'))
  assert.ok(r.warnings.some((e) => e.code === 'EMPTY_SHIELD_FALLBACK'))
})

test('inline agent: no agentId AND no prompt is an error', () => {
  const r = validateFlowGraph({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: '', prompt: '' } },
    ],
    edges: [{ id: 'e', source: 'trigger', target: 'a' }],
  }, { agents: [] })
  assert.ok(r.errors.some((e) => e.code === 'MISSING_AGENT_OR_PROMPT'))
})

test('inline agent with a prompt and no agentId is valid', () => {
  const r = validateFlowGraph({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: '', prompt: 'Classify {{trigger.input}}' } },
    ],
    edges: [{ id: 'e', source: 'trigger', target: 'a' }],
  }, { agents: [] })
  assert.equal(r.errors.some((e) => e.code === 'MISSING_AGENT'), false)
  assert.equal(r.errors.some((e) => e.code === 'MISSING_AGENT_OR_PROMPT'), false)
})

test('warns when a plain edge from an If/else can never run (both outputs already wired)', () => {
  const agent = (id: string) => ({ id, type: 'agent' as const, data: { agentId: 'a1', input: 'x' } })
  const r = validateFlowGraph({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'cond', type: 'condition', data: { match: 'all', clauses: [{ left: 'x', op: 'contains', right: 'y' }] } },
      agent('yes'), agent('no'), agent('dead'),
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'cond' },
      { id: 'e1', source: 'cond', target: 'yes', branch: 'true' },
      { id: 'e2', source: 'cond', target: 'no', branch: 'false' },
      // The engine only follows plain edges when the chosen branch has no
      // labeled wire — with both outputs covered, this edge never lights.
      { id: 'e3', source: 'cond', target: 'dead' },
    ],
  }, { agents: [{ id: 'a1', title: 'A' }] })
  assert.ok(r.warnings.some((w) => w.code === 'UNREACHABLE_PLAIN_EDGE' && w.nodeId === 'cond'))
})

test('a plain edge from an If/else with an uncovered output is a live fallback — no warning', () => {
  const agent = (id: string) => ({ id, type: 'agent' as const, data: { agentId: 'a1', input: 'x' } })
  const r = validateFlowGraph({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'cond', type: 'condition', data: { match: 'all', clauses: [{ left: 'x', op: 'contains', right: 'y' }] } },
      agent('yes'), agent('fallback'),
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'cond' },
      { id: 'e1', source: 'cond', target: 'yes', branch: 'true' },
      { id: 'e2', source: 'cond', target: 'fallback' }, // runs whenever the condition is false
    ],
  }, { agents: [{ id: 'a1', title: 'A' }] })
  assert.equal(r.warnings.some((w) => w.code === 'UNREACHABLE_PLAIN_EDGE'), false)
})

test('warns on a dead plain edge from a Switch whose cases and default are all wired', () => {
  const agent = (id: string) => ({ id, type: 'agent' as const, data: { agentId: 'a1', input: 'x' } })
  const r = validateFlowGraph({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'sw', type: 'switch', data: { cases: [{ id: 'case1', left: 'x', op: 'contains', right: 'y' }] } },
      agent('c1'), agent('dflt'), agent('dead'),
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'sw' },
      { id: 'e1', source: 'sw', target: 'c1', branch: 'case1' },
      { id: 'e2', source: 'sw', target: 'dflt', branch: 'default' },
      { id: 'e3', source: 'sw', target: 'dead' },
    ],
  }, { agents: [{ id: 'a1', title: 'A' }] })
  assert.ok(r.warnings.some((w) => w.code === 'UNREACHABLE_PLAIN_EDGE' && w.nodeId === 'sw'))
})

test('foreign n8n-style expressions produce a targeted warning', async () => {
  const { validateFlowGraph } = await import('../validate')
  const result = validateFlowGraph({
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'h', type: 'http', data: { method: 'GET', url: '={{ $json.leftover }}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'h' }],
  }, { requireRunnable: false })
  const foreign = result.warnings.find((issue) => issue.code === 'FOREIGN_EXPRESSION')
  assert.ok(foreign, 'expected FOREIGN_EXPRESSION warning')
  assert.equal(foreign?.nodeId, 'h')
})

test('nodeLabel never renders as undefined for unknown ops or node types', () => {
  const nodes = [
    { id: 'd', type: 'data', data: { op: 'brandNewOp', input: 'x' } },
    { id: 'v', type: 'variable', data: { op: 'squareRoot', name: 'n' } },
    { id: 'f', type: 'hologram', data: {} },
     
  ] as any[]
  for (const node of nodes) {
    const label = nodeLabel(node)
    assert.equal(typeof label, 'string', `label for ${node.type} should be a string`)
    assert.notEqual(label, 'undefined')
    assert.ok(label.length > 0)
  }
})

test('a deactivated step suppresses its config errors — except inline secrets', async () => {
  const { validateFlowGraph } = await import('../validate')
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger' as const, data: { trigger: { type: 'manual' } } },
      // Half-configured but deactivated: must not block publish (n8n parity).
      { id: 'off', type: 'tool' as const, data: { label: 'Off tool', connectionId: '', toolName: '', disabled: true } },
      { id: 'ok', type: 'http' as const, data: { label: 'Live', method: 'GET' as const, url: 'https://api/x' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'off' },
      { id: 'e1', source: 'off', target: 'ok' },
    ],
  }
  const result = validateFlowGraph(graph)
  assert.equal(result.errors.some((issue) => issue.nodeId === 'off'), false, 'deactivated step raised errors')

  // …but a literal inline secret is a leak in the stored graph whether or not
  // the step runs — still a hard error.
  const leaky = {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === 'off'
        ? { id: 'off', type: 'http' as const, data: { method: 'GET' as const, url: 'https://api/x', auth: { type: 'bearer' as const, token: 'sk_live_abc' }, disabled: true } }
        : node,
    ),
  }
  const leakyResult = validateFlowGraph(leaky)
  assert.equal(leakyResult.errors.some((issue) => issue.code === 'INLINE_AUTH_SECRET' && issue.nodeId === 'off'), true)
})
