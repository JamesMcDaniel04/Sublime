import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '../graph'
import { validateFlowGraph, validationErrorMessage } from '../validate'

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
      { id: 'get-body', type: 'http', data: { method: 'GET', url: 'https://api.example.com', body: '{"ignored":true}' } },
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

test('blocks an approval-gated (nango) tool inside a loop body', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['send'] } },
      { id: 'send', type: 'tool', data: { label: 'Post message', connectionId: 'nango:slack', toolName: 'slack_post_message', args: '{}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'loop' }],
  } as FlowGraph
  const result = validateFlowGraph(graph)
  assert.equal(result.ok, false)
  const issue = result.errors.find((entry) => entry.code === 'APPROVAL_IN_CONTAINER')
  assert.ok(issue)
  assert.equal(issue?.nodeId, 'send')
  assert.match(issue?.message ?? '', /Post message needs an approval to send/)
  assert.match(issue?.message ?? '', /Move it after the loop/)
})

test('blocks an approval-gated (nango) tool inside a parallel branch', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'par', type: 'parallel', data: { branches: [['send'], ['other']] } },
      { id: 'send', type: 'tool', data: { connectionId: 'nango:gmail', toolName: 'gmail_send_email', args: '{}' } },
      { id: 'other', type: 'http', data: { method: 'GET', url: 'https://example.test' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'par' }],
  } as FlowGraph
  const result = validateFlowGraph(graph)
  assert.ok(result.errors.some((entry) => entry.code === 'APPROVAL_IN_CONTAINER' && entry.nodeId === 'send'))
})

test('allows the same nango tool on the spine, outside any container', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'send', type: 'tool', data: { connectionId: 'nango:slack', toolName: 'slack_post_message', args: '{}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'send' }],
  } as FlowGraph
  const result = validateFlowGraph(graph)
  assert.equal(result.errors.some((entry) => entry.code === 'APPROVAL_IN_CONTAINER'), false)
  assert.equal(result.ok, true)
})

test('allows a non-approval (mcp) tool inside a loop body', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['read'] } },
      { id: 'read', type: 'tool', data: { connectionId: 'mcp-row-1', toolName: 'search_things', args: '{}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'loop' }],
  } as FlowGraph
  const result = validateFlowGraph(graph)
  assert.equal(result.errors.some((entry) => entry.code === 'APPROVAL_IN_CONTAINER'), false)
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

test('blocks a condition inside a loop body (branching cannot route in flat bodies)', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['c1'] } },
      { id: 'c1', type: 'condition', data: { match: 'all', clauses: [{ left: '{{item}}', op: 'eq', right: 'x' }] } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'loop' }],
  }
  const result = validateFlowGraph(graph)
  const issue = result.errors.find((candidate) => candidate.code === 'CONDITION_IN_CONTAINER')
  assert.ok(issue, 'expected CONDITION_IN_CONTAINER error')
  assert.equal(issue!.nodeId, 'c1')
  assert.match(issue!.message, /Filter step/)
})

test('blocks a switch inside a parallel branch; a main-chain condition stays valid', () => {
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
  assert.ok(result.errors.some((issue) => issue.code === 'CONDITION_IN_CONTAINER' && issue.nodeId === 's1'))
  assert.ok(!result.errors.some((issue) => issue.nodeId === 'c-main'))
})
