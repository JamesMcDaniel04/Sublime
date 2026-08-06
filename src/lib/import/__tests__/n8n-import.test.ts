import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '@/lib/flows/graph'
import { fromN8nWorkflow } from '../n8n'

type NodeOf<T extends FlowGraph['nodes'][number]['type']> = Extract<FlowGraph['nodes'][number], { type: T }>

/** Realistic n8n export: webhook → if → (http | slack), plus a sticky note. */
const FIXTURE = {
  name: 'Lead router',
  nodes: [
    { parameters: { path: 'lead' }, id: 'n-hook', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0] },
    {
      parameters: {
        conditions: {
          combinator: 'and',
          conditions: [{ leftValue: '={{ $json.score }}', rightValue: 50, operator: { type: 'number', operation: 'larger' } }],
        },
      },
      id: 'n-if', name: 'Qualified?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [200, 0],
    },
    {
      parameters: {
        method: 'POST', url: 'https://api.crm.example/leads',
        sendHeaders: true, headerParameters: { parameters: [{ name: 'X-Team', value: 'sales' }] },
        sendBody: true, jsonBody: '={{ JSON.stringify($json) }}',
      },
      id: 'n-http', name: 'Create CRM lead', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [400, -100],
    },
    { parameters: { channel: '#leads', text: 'low score' }, id: 'n-slack', name: 'Notify Slack', type: 'n8n-nodes-base.slack', typeVersion: 2.2, position: [400, 100] },
    { parameters: { content: 'docs' }, id: 'n-note', name: 'Note', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [0, 300] },
  ],
  connections: {
    Webhook: { main: [[{ node: 'Qualified?', type: 'main', index: 0 }]] },
    'Qualified?': {
      main: [
        [{ node: 'Create CRM lead', type: 'main', index: 0 }],
        [{ node: 'Notify Slack', type: 'main', index: 0 }],
      ],
    },
  },
  settings: {},
}

test('converts the fixture: trigger, condition with branches, http, slack stub', () => {
  const imported = fromN8nWorkflow(JSON.parse(JSON.stringify(FIXTURE)))
  assert.equal(imported.source, 'n8n')
  assert.equal(imported.name, 'Lead router')
  assert.equal(imported.trigger.type, 'webhook')

  const byId = new Map(imported.graph.nodes.map((node) => [node.id, node]))
  const trigger = byId.get('trigger')
  assert.equal(trigger?.type, 'trigger')

  const condition = imported.graph.nodes.find((node) => node.type === 'condition') as NodeOf<'condition'>
  assert.equal(condition.data.label, 'Qualified?')
  assert.deepEqual(condition.data.clauses, [{ left: '={{ $json.score }}', op: 'gt', right: '50' }])

  const http = imported.graph.nodes.find((node) => node.type === 'http' && node.data.url) as NodeOf<'http'>
  assert.equal(http.data.method, 'POST')
  assert.equal(http.data.url, 'https://api.crm.example/leads')

  // Slack is an integration node → http stub, reported.
  assert.equal(imported.stubbedNodes.length, 1)
  assert.equal(imported.stubbedNodes[0].originalType, 'n8n-nodes-base.slack')
  const stub = byId.get(imported.stubbedNodes[0].nodeId) as NodeOf<'http'>
  assert.equal(stub.type, 'http')
  assert.equal(stub.data.label, 'Notify Slack')
  assert.ok(stub.data.note?.includes('n8n-nodes-base.slack'))

  // Sticky note dropped without a stub.
  assert.equal(imported.graph.nodes.length, 4)

  // Branch wiring: if output 0 → 'true', output 1 → 'false'.
  const trueEdge = imported.graph.edges.find((edge) => edge.source === condition.id && edge.target === http.id)
  const falseEdge = imported.graph.edges.find((edge) => edge.source === condition.id && edge.target === stub.id)
  assert.equal(trueEdge?.branch, 'true')
  assert.equal(falseEdge?.branch, 'false')

  // Layout carried across.
  assert.deepEqual(imported.graph.layout?.[condition.id], { x: 200, y: 0 })

  // Expressions were detected and warned about once.
  assert.ok(imported.warnings.some((warning) => warning.includes('expression')))
})

test('a workflow without a trigger gets a manual trigger wired to entry nodes', () => {
  const imported = fromN8nWorkflow({
    name: 'headless',
    nodes: [{ parameters: {}, id: 'n1', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [0, 0] }],
    connections: {},
  })
  assert.equal(imported.trigger.type, 'manual')
  assert.ok(imported.graph.nodes.some((node) => node.id === 'trigger'))
  assert.deepEqual(
    imported.graph.edges.map((edge) => [edge.source, edge.target]),
    [['trigger', 'n1']],
  )
})

test('merge and noOp nodes are dropped and rewired through', () => {
  const imported = fromN8nWorkflow({
    nodes: [
      { parameters: {}, id: 'n-t', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
      { parameters: {}, id: 'n-noop', name: 'NoOp', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [100, 0] },
      { parameters: { amount: 5, unit: 'minutes' }, id: 'n-wait', name: 'Wait', type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [200, 0] },
    ],
    connections: {
      Manual: { main: [[{ node: 'NoOp', type: 'main', index: 0 }]] },
      NoOp: { main: [[{ node: 'Wait', type: 'main', index: 0 }]] },
    },
  })
  assert.deepEqual(
    imported.graph.edges.map((edge) => [edge.source, edge.target]),
    [['trigger', 'n-wait']],
  )
  const wait = imported.graph.nodes.find((node) => node.type === 'wait') as NodeOf<'wait'>
  assert.equal(wait.data.amount, 5)
  assert.equal(wait.data.unit, 'minutes')
})

test('core mappings: code, set, switch, stopAndError, respondToWebhook, executeWorkflow, splitInBatches, langchain agent', () => {
  const nodes = [
    { parameters: {}, id: 'n-t', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
    { parameters: { jsCode: 'return items', mode: 'runOnceForEachItem' }, id: 'n-code', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [0, 0] },
    { parameters: { assignments: { assignments: [{ id: 'a1', name: 'greeting', value: 'hello', type: 'string' }] } }, id: 'n-set', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [0, 0] },
    { parameters: { rules: { values: [{ outputKey: 'big', conditions: { combinator: 'and', conditions: [{ leftValue: '={{ $json.n }}', rightValue: 10, operator: { type: 'number', operation: 'larger' } }] } }] } }, id: 'n-switch', name: 'Switch', type: 'n8n-nodes-base.switch', typeVersion: 3, position: [0, 0] },
    { parameters: { errorMessage: 'boom' }, id: 'n-stop', name: 'Stop', type: 'n8n-nodes-base.stopAndError', typeVersion: 1, position: [0, 0] },
    { parameters: { respondWith: 'json', responseBody: '{"ok":true}' }, id: 'n-resp', name: 'Respond', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [0, 0] },
    { parameters: { workflowId: 'wf-far-away' }, id: 'n-sub', name: 'Run other', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.1, position: [0, 0] },
    { parameters: { batchSize: 10 }, id: 'n-batch', name: 'Loop', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [0, 0] },
    { parameters: { text: 'You are a helpful bot' }, id: 'n-ai', name: 'AI Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 1.7, position: [0, 0] },
  ]
  const imported = fromN8nWorkflow({ nodes, connections: {} })
  const byId = new Map(imported.graph.nodes.map((node) => [node.id, node]))

  const code = byId.get('n-code') as NodeOf<'code'>
  assert.equal(code.type, 'code')
  assert.equal(code.data.code, 'return items')
  assert.equal(code.data.mode, 'eachItem')

  const set = byId.get('n-set') as NodeOf<'transform'>
  assert.equal(set.type, 'transform')
  assert.deepEqual(set.data.fields, [{ name: 'greeting', value: 'hello' }])

  const sw = byId.get('n-switch') as NodeOf<'switch'>
  assert.equal(sw.type, 'switch')
  assert.equal(sw.data.cases.length, 1)
  assert.equal(sw.data.cases[0].op, 'gt')

  assert.equal((byId.get('n-stop') as NodeOf<'stop'>).data.reason, 'boom')
  assert.equal(byId.get('n-resp')?.type, 'respondWebhook')

  const sub = byId.get('n-sub') as NodeOf<'subflow'>
  assert.equal(sub.type, 'subflow')
  assert.equal(sub.data.flowId, '')

  assert.equal(byId.get('n-batch')?.type, 'loop')

  // A standalone agent node still materializes a real agent; its `text`
  // param is the USER prompt (n8n semantics), so it lands on the step input.
  const ai = byId.get('n-ai') as NodeOf<'agent'>
  assert.equal(ai.type, 'agent')
  assert.equal(ai.data.agentId, 'n-ai')
  assert.equal(ai.data.input, 'You are a helpful bot')
  assert.ok(imported.agentsToCreate.some((agent) => agent.ref === 'n-ai'))

  // No integration stubs in this set — everything above maps natively.
  assert.equal(imported.stubbedNodes.length, 0)
})

test('absorbs the AI agent cluster: model, tools, memory become one materialized agent', () => {
  const imported = fromN8nWorkflow({
    name: 'Support triage',
    nodes: [
      { parameters: {}, id: 'n-t', name: 'When chat message received', type: '@n8n/n8n-nodes-langchain.chatTrigger', typeVersion: 1.4, position: [0, 0] },
      {
        parameters: {
          promptType: 'auto',
          text: '={{ $json.chatInput }}',
          options: { systemMessage: 'You are a support triage specialist. Route tickets by urgency.', maxIterations: 10 },
        },
        id: 'n-agent', name: 'Triage Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 3.1, position: [200, 0],
        onError: 'continueRegularOutput', retryOnFail: true, maxTries: 3,
      },
      {
        parameters: { model: { __rl: true, mode: 'list', value: 'claude-sonnet-4-6', cachedResultName: 'Claude Sonnet 4.6' } },
        id: 'n-model', name: 'Anthropic Chat Model', type: '@n8n/n8n-nodes-langchain.lmChatAnthropic', typeVersion: 1.5, position: [100, 200],
      },
      { parameters: { descriptionType: 'auto' }, id: 'n-gmail', name: 'Send follow-up', type: 'n8n-nodes-base.gmailTool', typeVersion: 2.2, position: [250, 200] },
      { parameters: {}, id: 'n-sheets', name: 'Log to sheet', type: 'n8n-nodes-base.googleSheetsTool', typeVersion: 4.7, position: [300, 200] },
      { parameters: { endpointUrl: 'https://mcp.example.dev/mcp', serverTransport: 'httpStreamable' }, id: 'n-mcp', name: 'Internal MCP', type: '@n8n/n8n-nodes-langchain.mcpClientTool', typeVersion: 1.2, position: [350, 200] },
      { parameters: { contextWindowLength: 5 }, id: 'n-mem', name: 'Simple Memory', type: '@n8n/n8n-nodes-langchain.memoryBufferWindow', typeVersion: 1.3, position: [150, 200] },
    ],
    connections: {
      'When chat message received': { main: [[{ node: 'Triage Agent', type: 'main', index: 0 }]] },
      'Anthropic Chat Model': { ai_languageModel: [[{ node: 'Triage Agent', type: 'ai_languageModel', index: 0 }]] },
      'Send follow-up': { ai_tool: [[{ node: 'Triage Agent', type: 'ai_tool', index: 0 }]] },
      'Log to sheet': { ai_tool: [[{ node: 'Triage Agent', type: 'ai_tool', index: 0 }]] },
      'Internal MCP': { ai_tool: [[{ node: 'Triage Agent', type: 'ai_tool', index: 0 }]] },
      'Simple Memory': { ai_memory: [[{ node: 'Triage Agent', type: 'ai_memory', index: 0 }]] },
    },
  })

  // Sub-nodes are absorbed — only trigger + agent remain.
  assert.deepEqual(imported.graph.nodes.map((node) => node.type).sort(), ['agent', 'trigger'])
  assert.equal(imported.stubbedNodes.length, 0)

  // The agent step references a materialized agent carrying the cluster.
  assert.equal(imported.agentsToCreate.length, 1)
  const spec = imported.agentsToCreate[0]
  assert.equal(spec.ref, 'n-agent')
  assert.equal(spec.title, 'Triage Agent')
  assert.ok(spec.instructions.includes('support triage specialist'))
  assert.equal(spec.model, 'claude-sonnet-4-6')
  assert.deepEqual([...spec.integrations].sort(), ['gmail', 'google_sheets'])

  const step = imported.graph.nodes.find((node) => node.type === 'agent') as NodeOf<'agent'>
  assert.equal(step.data.agentId, 'n-agent')
  // Default chat input collapses to upstream context, and node-level props map.
  assert.equal(step.data.input, '')
  assert.equal(step.data.onError, 'continue')
  assert.equal(step.data.retries, 3)

  // MCP tool and memory surface as actionable warnings, not silence.
  assert.ok(imported.warnings.some((warning) => warning.includes('https://mcp.example.dev/mcp')))
  assert.ok(imported.warnings.some((warning) => warning.toLowerCase().includes('memory')))
})

test('non-claude models fall back with a warning; chainLlm becomes an agent too', () => {
  const imported = fromN8nWorkflow({
    nodes: [
      { parameters: {}, id: 'n-t', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
      {
        parameters: {
          promptType: 'define', text: 'Summarize: {{ $json.body }}',
          messages: { messageValues: [{ type: 'system', message: 'You summarize crisply.' }] },
        },
        id: 'n-chain', name: 'Summarize', type: '@n8n/n8n-nodes-langchain.chainLlm', typeVersion: 1.7, position: [200, 0],
      },
      { parameters: { model: { __rl: true, mode: 'id', value: 'gpt-4o-mini' } }, id: 'n-gpt', name: 'OpenAI Chat Model', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1.2, position: [150, 150] },
    ],
    connections: {
      Manual: { main: [[{ node: 'Summarize', type: 'main', index: 0 }]] },
      'OpenAI Chat Model': { ai_languageModel: [[{ node: 'Summarize', type: 'ai_languageModel', index: 0 }]] },
    },
  })
  const spec = imported.agentsToCreate[0]
  assert.equal(spec.ref, 'n-chain')
  assert.ok(spec.instructions.includes('You summarize crisply.'))
  assert.equal(spec.model, undefined)
  assert.ok(imported.warnings.some((warning) => warning.includes('gpt-4o-mini')))
})

test('condition operator expansion: startsWith, boolean, empty, dateTime', () => {
  const clauseFor = (operator: { type: string; operation: string }, rightValue: unknown = 'x') => {
    const imported = fromN8nWorkflow({
      nodes: [
        { parameters: {}, id: 'n-t', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
        {
          parameters: { conditions: { combinator: 'and', conditions: [{ leftValue: '={{ $json.v }}', rightValue, operator }] } },
          id: 'n-if', name: 'Check', type: 'n8n-nodes-base.if', typeVersion: 2.3, position: [100, 0],
        },
      ],
      connections: { Manual: { main: [[{ node: 'Check', type: 'main', index: 0 }]] } },
    })
    const condition = imported.graph.nodes.find((node) => node.type === 'condition') as NodeOf<'condition'>
    return condition.data.clauses?.[0]
  }

  assert.deepEqual(clauseFor({ type: 'string', operation: 'startsWith' }, 'Re:'), { left: '={{ $json.v }}', op: 'matches', right: '^Re\\:' })
  assert.deepEqual(clauseFor({ type: 'string', operation: 'endsWith' }, '.pdf'), { left: '={{ $json.v }}', op: 'matches', right: '\\.pdf$' })
  assert.deepEqual(clauseFor({ type: 'boolean', operation: 'true' }, ''), { left: '={{ $json.v }}', op: 'eq', right: 'true' })
  assert.deepEqual(clauseFor({ type: 'string', operation: 'empty' }, ''), { left: '={{ $json.v }}', op: 'eq', right: '' })
  assert.deepEqual(clauseFor({ type: 'dateTime', operation: 'after' }, '2026-01-01'), { left: '={{ $json.v }}', op: 'gt', right: '2026-01-01' })
})

test('respondToWebhook reads options.responseCode and maps respondWith', () => {
  const imported = fromN8nWorkflow({
    nodes: [
      { parameters: { path: 'x' }, id: 'n-t', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2.1, position: [0, 0] },
      { parameters: { respondWith: 'text', responseBody: 'ok!', options: { responseCode: 201 } }, id: 'n-r', name: 'Respond', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.5, position: [100, 0] },
    ],
    connections: { Webhook: { main: [[{ node: 'Respond', type: 'main', index: 0 }]] } },
  })
  const respond = imported.graph.nodes.find((node) => node.type === 'respondWebhook') as NodeOf<'respondWebhook'>
  assert.equal(respond.data.statusCode, 201)
  assert.equal(respond.data.bodyMode, 'text')
  assert.equal(respond.data.body, 'ok!')
})

test('scheduleTrigger maps to a runnable Sublime schedule', () => {
  const cronImport = fromN8nWorkflow({
    nodes: [{ parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 30 9 * * 1' }] } }, id: 'n-s', name: 'Schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0] }],
    connections: {},
  })
  assert.equal(cronImport.trigger.type, 'schedule')
  assert.deepEqual((cronImport.trigger as { schedule?: { type?: string; cron?: string } }).schedule, { type: 'cron', cron: '30 9 * * 1' })

  const dailyImport = fromN8nWorkflow({
    nodes: [{ parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 7, triggerAtMinute: 15 }] } }, id: 'n-s', name: 'Schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0] }],
    connections: {},
  })
  const daily = (dailyImport.trigger as { schedule?: { type?: string; time?: string } }).schedule
  assert.equal(daily?.type, 'daily')
  assert.equal(daily?.time, '07:15')

  const hourlyImport = fromN8nWorkflow({
    nodes: [{ parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 2 }] } }, id: 'n-s', name: 'Schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0] }],
    connections: {},
  })
  assert.deepEqual((hourlyImport.trigger as { schedule?: { type?: string; cron?: string } }).schedule, { type: 'cron', cron: '0 */2 * * *' })
})

test('set raw mode becomes a data parseJson step; legacy fields.values still map', () => {
  const imported = fromN8nWorkflow({
    nodes: [
      { parameters: {}, id: 'n-t', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
      { parameters: { mode: 'raw', jsonOutput: '={ "user": "{{ $json.name }}" }' }, id: 'n-raw', name: 'Raw set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [100, 0] },
      { parameters: { values: { string: [{ name: 'greeting', value: 'hi' }], number: [{ name: 'count', value: 2 }] } }, id: 'n-legacy', name: 'Legacy set', type: 'n8n-nodes-base.set', typeVersion: 2, position: [200, 0] },
    ],
    connections: {
      Manual: { main: [[{ node: 'Raw set', type: 'main', index: 0 }]] },
      'Raw set': { main: [[{ node: 'Legacy set', type: 'main', index: 0 }]] },
    },
  })
  const raw = imported.graph.nodes.find((node) => node.type === 'data') as NodeOf<'data'>
  assert.equal(raw.data.op, 'parseJson')
  const legacy = imported.graph.nodes.find((node) => node.id === 'n-legacy') as NodeOf<'transform'>
  assert.deepEqual(legacy.data.fields, [{ name: 'greeting', value: 'hi' }, { name: 'count', value: '2' }])
})

test('httpRequest maps keypair body, timeout, redirects, and warns on credentials', () => {
  const imported = fromN8nWorkflow({
    nodes: [
      { parameters: {}, id: 'n-t', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
      {
        parameters: {
          method: 'POST', url: 'https://api.example.com/v1',
          authentication: 'predefinedCredentialType', nodeCredentialType: 'slackApi',
          sendBody: true, contentType: 'json', specifyBody: 'keypair',
          bodyParameters: { parameters: [{ name: 'channel', value: '#general' }] },
          options: { timeout: 30000, redirect: { redirect: { followRedirects: true, maxRedirects: 4 } } },
        },
        id: 'n-http', name: 'Call API', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [100, 0],
        notes: 'posts to slack', disabled: true,
      },
    ],
    connections: { Manual: { main: [[{ node: 'Call API', type: 'main', index: 0 }]] } },
  })
  const http = imported.graph.nodes.find((node) => node.type === 'http') as NodeOf<'http'>
  assert.equal(http.data.body, JSON.stringify({ channel: '#general' }))
  assert.equal(http.data.timeoutMs, 30000)
  assert.equal(http.data.followRedirects, true)
  assert.equal(http.data.maxRedirects, 4)
  assert.equal(http.data.note, 'posts to slack')
  assert.equal(http.data.disabled, true)
  assert.ok(imported.warnings.some((warning) => warning.includes('credentials')))
})

test('round-trips our own n8n export back into a flow', async () => {
  const { toN8nWorkflow } = await import('@/lib/export/n8n')
  const { toPortableFlow } = await import('@/lib/export/portable')
  const portable = toPortableFlow(
    {
      name: 'RT', description: '', trigger: { type: 'manual' },
      graph: {
        nodes: [
          { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
          { id: 'call', type: 'http', data: { label: 'Call API', method: 'GET', url: 'https://api.example.com/v1/data' } },
        ],
        edges: [{ id: 'e1', source: 'trigger', target: 'call' }],
      },
    },
    [], '2026-08-05T00:00:00.000Z',
  )
  const imported = fromN8nWorkflow(toN8nWorkflow(portable) as unknown)
  assert.equal(imported.trigger.type, 'manual')
  const http = imported.graph.nodes.find((node) => node.type === 'http') as NodeOf<'http'>
  assert.equal(http.data.url, 'https://api.example.com/v1/data')
  assert.equal(imported.graph.edges.length, 1)
})
