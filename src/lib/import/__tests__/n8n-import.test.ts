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
  // Tier-3 translation: the trigger is the if node's only predecessor.
  assert.deepEqual(condition.data.clauses, [{ left: '{{trigger.input.score}}', op: 'gt', right: '50' }])

  const http = imported.graph.nodes.find((node) => node.type === 'http' && node.data.url) as NodeOf<'http'>
  assert.equal(http.data.method, 'POST')
  assert.equal(http.data.url, 'https://api.crm.example/leads')

  // Slack message-post maps to a NATIVE tool step now (gap 4) — no stub.
  assert.equal(imported.stubbedNodes.length, 0)
  const slack = byId.get('n-slack') as NodeOf<'tool'>
  assert.equal(slack.type, 'tool')
  assert.equal(slack.data.connectionId, 'nango:slack')
  assert.equal(slack.data.label, 'Notify Slack')

  // Sticky note dropped; the CRM step's computed jsonBody extracted into a
  // per-item code step (trigger, condition, code, http, slack tool = 5).
  assert.equal(imported.graph.nodes.length, 5)
  const extracted = imported.graph.nodes.find((node) => node.id.includes('-expr'))
  assert.equal(extracted?.type, 'code')

  // Branch wiring: if output 0 → 'true' (through the extracted code step), 1 → 'false'.
  const trueEdge = imported.graph.edges.find((edge) => edge.source === condition.id && edge.target === extracted!.id)
  const falseEdge = imported.graph.edges.find((edge) => edge.source === condition.id && edge.target === slack.id)
  assert.ok(imported.graph.edges.some((edge) => edge.source === extracted!.id && edge.target === http.id))
  assert.equal(trueEdge?.branch, 'true')
  assert.equal(falseEdge?.branch, 'false')

  // Layout carried across.
  assert.deepEqual(imported.graph.layout?.[condition.id], { x: 200, y: 0 })

  // Every expression translated or extracted — nothing left to warn about.
  assert.equal(imported.warnings.some((warning) => warning.includes('expression')), false)
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
  // Imported JS is wrapped in the n8n compatibility shim; the original travels inside.
  assert.ok(code.data.code.includes('return items'))
  assert.ok(code.data.code.includes('n8n compatibility'))
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

test('n8n HTTP tool sub-nodes become configured agent endpoints', () => {
  const imported = fromN8nWorkflow({
    nodes: [
      { parameters: {}, id: 'n-t', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
      { parameters: { options: { systemMessage: 'Enrich leads.' } }, id: 'n-agent', name: 'Enricher', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 3.1, position: [200, 0] },
      {
        parameters: {
          toolDescription: 'Look up a company by domain',
          method: 'GET',
          url: 'https://api.enrich.example/companies/{domain}',
          sendQuery: true,
          specifyQuery: 'keypair',
          parametersQuery: { values: [
            { name: 'depth', valueProvider: 'fieldValue', value: 'full' },
            { name: 'locale', valueProvider: 'modelRequired' },
          ] },
          placeholderDefinitions: { values: [{ name: 'domain', description: 'Company domain' }] },
        },
        id: 'n-lookup', name: 'Company lookup', type: '@n8n/n8n-nodes-langchain.toolHttpRequest', typeVersion: 1.1, position: [150, 150],
      },
      {
        parameters: {
          toolDescription: 'Post an enrichment result',
          method: 'POST',
          url: 'https://hooks.example.com/enriched',
          sendBody: true, specifyBody: 'json',
          jsonBody: '={{ JSON.stringify({ company: $fromAI("company_name", "The company name"), tier: "gold" }) }}',
        },
        id: 'n-post', name: 'Post result', type: 'n8n-nodes-base.httpRequestTool', typeVersion: 4.2, position: [250, 150],
      },
    ],
    connections: {
      Manual: { main: [[{ node: 'Enricher', type: 'main', index: 0 }]] },
      'Company lookup': { ai_tool: [[{ node: 'Enricher', type: 'ai_tool', index: 0 }]] },
      'Post result': { ai_tool: [[{ node: 'Enricher', type: 'ai_tool', index: 0 }]] },
    },
  })

  const spec = imported.agentsToCreate[0]
  assert.equal(spec.httpTools?.length, 2)

  const lookup = spec.httpTools?.find((tool) => tool.name === 'Company lookup')
  assert.ok(lookup)
  assert.equal(lookup?.description, 'Look up a company by domain')
  assert.equal(lookup?.config.method, 'GET')
  // {placeholder} syntax → {{input.…}}; keypair query with model-provided value.
  assert.equal(lookup?.config.url, 'https://api.enrich.example/companies/{{input.domain}}')
  assert.equal(lookup?.config.query, JSON.stringify({ depth: 'full', locale: '{{input.locale}}' }))

  const post = spec.httpTools?.find((tool) => tool.name === 'Post result')
  assert.ok(post)
  assert.equal(post?.config.method, 'POST')
  // $fromAI("company_name", …) → {{input.company_name}}
  assert.ok(post?.config.body?.includes('{{input.company_name}}'))
  assert.equal(post?.config.body?.includes('$fromAI'), false)

  // No "rebuild manually" warnings for converted HTTP tools.
  assert.equal(imported.warnings.some((warning) => warning.includes('custom HTTP tool')), false)
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

  // left values also pass Tier-3 translation (trigger is the predecessor).
  assert.deepEqual(clauseFor({ type: 'string', operation: 'startsWith' }, 'Re:'), { left: '{{trigger.input.v}}', op: 'matches', right: '^Re\\:' })
  assert.deepEqual(clauseFor({ type: 'string', operation: 'endsWith' }, '.pdf'), { left: '{{trigger.input.v}}', op: 'matches', right: '\\.pdf$' })
  assert.deepEqual(clauseFor({ type: 'boolean', operation: 'true' }, ''), { left: '{{trigger.input.v}}', op: 'eq', right: 'true' })
  assert.deepEqual(clauseFor({ type: 'string', operation: 'empty' }, ''), { left: '{{trigger.input.v}}', op: 'eq', right: '' })
  assert.deepEqual(clauseFor({ type: 'dateTime', operation: 'after' }, '2026-01-01'), { left: '{{trigger.input.v}}', op: 'gt', right: '2026-01-01' })
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

/**
 * Run a generated code node's JS the way run-js does: async fn body with
 * `items` in scope. Test-only: the code under test is OUR generator's output
 * from fixtures owned by this file (production runs it inside the QuickJS
 * sandbox); nothing user-controlled reaches this Function body.
 */
async function runGenerated(code: string, items: unknown[]): Promise<unknown> {
  const fn = new Function('items', `return (async () => {\n${code}\n})()`)
  return await fn(items)
}

test('pure data nodes become runnable generated code', async () => {
  const imported = fromN8nWorkflow({
    nodes: [
      { parameters: {}, id: 'n-t', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
      { parameters: { maxItems: 2, keep: 'firstItems' }, id: 'n-limit', name: 'Limit', type: 'n8n-nodes-base.limit', typeVersion: 1, position: [0, 0] },
      { parameters: { type: 'simple', sortFieldsUi: { sortField: [{ fieldName: 'score', order: 'descending' }] } }, id: 'n-sort', name: 'Sort', type: 'n8n-nodes-base.sort', typeVersion: 1, position: [0, 0] },
      { parameters: { fieldToSplitOut: 'emails', include: 'allOtherFields' }, id: 'n-split', name: 'Split Out', type: 'n8n-nodes-base.splitOut', typeVersion: 1, position: [0, 0] },
      { parameters: { aggregate: 'aggregateAllItemData', destinationFieldName: 'data' }, id: 'n-agg', name: 'Aggregate', type: 'n8n-nodes-base.aggregate', typeVersion: 1, position: [0, 0] },
      { parameters: { operation: 'removeDuplicateInputItems', compare: 'selectedFields', fieldsToCompare: 'email' }, id: 'n-dedupe', name: 'Dedupe', type: 'n8n-nodes-base.removeDuplicates', typeVersion: 2, position: [0, 0] },
      { parameters: { keys: { key: [{ currentKey: 'fullName', newKey: 'name' }] } }, id: 'n-rename', name: 'Rename', type: 'n8n-nodes-base.renameKeys', typeVersion: 1, position: [0, 0] },
    ],
    connections: {},
  })
  const byId = new Map(imported.graph.nodes.map((node) => [node.id, node]))
  const codeOf = (id: string) => {
    const node = byId.get(id) as NodeOf<'code'>
    assert.equal(node.type, 'code', `${id} should be a code node`)
    return node.data.code
  }
  // None of these are stubs.
  assert.equal(imported.stubbedNodes.length, 0)

  assert.deepEqual(await runGenerated(codeOf('n-limit'), [1, 2, 3]), [1, 2])
  assert.deepEqual(
    await runGenerated(codeOf('n-sort'), [{ score: 1 }, { score: 9 }, { score: 4 }]),
    [{ score: 9 }, { score: 4 }, { score: 1 }],
  )
  assert.deepEqual(
    await runGenerated(codeOf('n-split'), [{ emails: ['a@x.co', 'b@x.co'], team: 'ops' }]),
    [{ emails: 'a@x.co', team: 'ops' }, { emails: 'b@x.co', team: 'ops' }],
  )
  assert.deepEqual(await runGenerated(codeOf('n-agg'), [{ a: 1 }, { a: 2 }]), { data: [{ a: 1 }, { a: 2 }] })
  assert.deepEqual(
    await runGenerated(codeOf('n-dedupe'), [{ email: 'a@x.co', n: 1 }, { email: 'a@x.co', n: 2 }, { email: 'b@x.co', n: 3 }]),
    [{ email: 'a@x.co', n: 1 }, { email: 'b@x.co', n: 3 }],
  )
  assert.deepEqual(
    await runGenerated(codeOf('n-rename'), [{ fullName: 'Ada', role: 'eng' }]),
    [{ name: 'Ada', role: 'eng' }],
  )
})

test('splitInBatches loops absorb their body when the cycle is clean', () => {
  const imported = fromN8nWorkflow({
    nodes: [
      { parameters: {}, id: 'n-t', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
      { parameters: { batchSize: 1 }, id: 'n-loop', name: 'Loop Over Items', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [100, 0] },
      { parameters: { method: 'POST', url: 'https://api.example.com/notify' }, id: 'n-notify', name: 'Notify', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [200, 100] },
      { parameters: { amount: 2, unit: 'seconds' }, id: 'n-pause', name: 'Pause', type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [300, 100] },
      { parameters: { assignments: { assignments: [{ name: 'done', value: 'yes' }] } }, id: 'n-after', name: 'After', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [300, -100] },
    ],
    connections: {
      Manual: { main: [[{ node: 'Loop Over Items', type: 'main', index: 0 }]] },
      'Loop Over Items': {
        main: [
          [{ node: 'After', type: 'main', index: 0 }],   // output 0 = done
          [{ node: 'Notify', type: 'main', index: 0 }],  // output 1 = loop
        ],
      },
      Notify: { main: [[{ node: 'Pause', type: 'main', index: 0 }]] },
      Pause: { main: [[{ node: 'Loop Over Items', type: 'main', index: 0 }]] },
    },
  })
  const loop = imported.graph.nodes.find((node) => node.type === 'loop') as NodeOf<'loop'>
  assert.deepEqual(loop.data.body, ['n-notify', 'n-pause'])
  assert.equal(loop.data.over, '{{trigger.input}}')
  // Loop-body nodes keep their node entries but lose their chain edges;
  // the done path is the only remaining continuation.
  assert.deepEqual(
    imported.graph.edges.map((edge) => [edge.source, edge.target]).sort(),
    [['n-loop', 'n-after'], ['trigger', 'n-loop']],
  )
  // The clean-absorb path should not emit the "does not translate" warning.
  assert.equal(imported.warnings.some((warning) => warning.includes('does not translate')), false)
})

test('formTrigger becomes a typed input node behind the trigger', () => {
  const imported = fromN8nWorkflow({
    nodes: [
      {
        parameters: {
          formTitle: 'Vendor intake',
          formFields: { values: [
            { fieldLabel: 'Company Name', fieldType: 'text', requiredField: true },
            { fieldLabel: 'Seats', fieldType: 'number' },
          ] },
        },
        id: 'n-form', name: 'On form submission', type: 'n8n-nodes-base.formTrigger', typeVersion: 2.6, position: [0, 0],
      },
      { parameters: { assignments: { assignments: [{ name: 'ok', value: 'yes' }] } }, id: 'n-set', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [200, 0] },
    ],
    connections: { 'On form submission': { main: [[{ node: 'Set', type: 'main', index: 0 }]] } },
  })
  const input = imported.graph.nodes.find((node) => node.type === 'input') as NodeOf<'input'>
  assert.ok(input, 'expected an input node')
  assert.deepEqual(input.data.params, [
    { name: 'company_name', type: 'string', required: true },
    { name: 'seats', type: 'number' },
  ])
  // Wiring: trigger → input → former trigger targets.
  const edgePairs = imported.graph.edges.map((edge) => [edge.source, edge.target])
  assert.ok(edgePairs.some(([source, target]) => source === 'trigger' && target === input.id))
  assert.ok(edgePairs.some(([source, target]) => source === input.id && target === 'n-set'))
})

test('expressions translate when the data path is unambiguous', () => {
  const imported = fromN8nWorkflow({
    nodes: [
      { parameters: {}, id: 'n-t', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
      { parameters: { assignments: { assignments: [{ name: 'team', value: 'ops' }] } }, id: 'n-set', name: 'Set team', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [100, 0] },
      {
        parameters: {
          method: 'POST',
          url: '={{ $json.team }}',
          sendBody: true,
          jsonBody: '=Hello {{ $json.team }}, via {{ $node["Set team"].json.team }}',
        },
        id: 'n-http', name: 'Call', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [200, 0],
      },
      { parameters: { method: 'GET', url: "={{ JSON.stringify($('Set team').first().json) }}" }, id: 'n-http2', name: 'Complex', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [300, 0] },
    ],
    connections: {
      Manual: { main: [[{ node: 'Set team', type: 'main', index: 0 }]] },
      'Set team': { main: [[{ node: 'Call', type: 'main', index: 0 }]] },
      Call: { main: [[{ node: 'Complex', type: 'main', index: 0 }]] },
    },
  })
  const byId = new Map(imported.graph.nodes.map((node) => [node.id, node]))
  const call = byId.get('n-http') as NodeOf<'http'>
  // $json marks an item-scoped step (n8n ran it per item): forEachItem is set
  // and $json refs bind to {{item.…}}; $('Node') refs stay step-scoped.
  assert.equal(call.data.forEachItem, true)
  assert.equal(call.data.url, '{{item.team}}')
  assert.equal(call.data.body, 'Hello {{item.team}}, via {{step.n-set.output.team}}')
  // Computed segments with cross-node refs can neither translate nor extract
  // (a code step has no cross-step access) — they stay verbatim + warned.
  const complex = byId.get('n-http2') as NodeOf<'http'>
  assert.equal(complex.data.url, "={{ JSON.stringify($('Set team').first().json) }}")
  assert.ok(imported.warnings.some((warning) => warning.includes('expression')))
})

test('$json with the trigger as predecessor becomes trigger.input', () => {
  const imported = fromN8nWorkflow({
    nodes: [
      { parameters: { path: 'lead' }, id: 'n-t', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2.1, position: [0, 0] },
      { parameters: { method: 'POST', url: 'https://api.example.com', sendBody: true, jsonBody: '={{ $json.email }}' }, id: 'n-http', name: 'Call', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [100, 0] },
    ],
    connections: { Webhook: { main: [[{ node: 'Call', type: 'main', index: 0 }]] } },
  })
  const call = imported.graph.nodes.find((node) => node.type === 'http') as NodeOf<'http'>
  // $json → item-scoped (forEachItem); with the trigger as sole input the
  // single webhook payload is the one item, so behavior is identical.
  assert.equal(call.data.body, '{{item.email}}')
})

test('code node contents are never expression-translated', () => {
  const imported = fromN8nWorkflow({
    nodes: [
      { parameters: {}, id: 'n-t', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
      { parameters: { jsCode: 'const x = $json.value; return [x]' }, id: 'n-code', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2, position: [100, 0] },
    ],
    connections: { Manual: { main: [[{ node: 'Code', type: 'main', index: 0 }]] } },
  })
  const code = imported.graph.nodes.find((node) => node.type === 'code') as NodeOf<'code'>
  // The $json reference inside user code survives untouched (only wrapped by the shim).
  assert.ok(code.data.code.includes('const x = $json.value; return [x]'))
})

test('gap 2: n8n code dialect runs via the compatibility shim', async () => {
  const imported = fromN8nWorkflow({
    nodes: [
      { parameters: {}, id: 'n-t', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
      {
        parameters: { jsCode: "const all = $input.all();\nconst raw = all[0]?.json?.body || all[0]?.json || {};\nreturn [{ json: { id: raw.opportunityId, n: all.length } }];" },
        id: 'n-code', name: 'Parse Trigger', type: 'n8n-nodes-base.code', typeVersion: 2, position: [100, 0],
      },
    ],
    connections: { Manual: { main: [[{ node: 'Parse Trigger', type: 'main', index: 0 }]] } },
  })
  const code = imported.graph.nodes.find((node) => node.type === 'code') as NodeOf<'code'>
  assert.ok(code.data.code.includes('n8n compatibility'), 'expected the shim preamble')
  // Sublime feeds RAW items (no {json} wrapper); n8n-dialect code must still work,
  // and the returned [{json}] array must unwrap back to plain values.
  const result = await runGenerated(code.data.code, [{ body: { opportunityId: 'OPP-9' } }])
  assert.deepEqual(result, [{ id: 'OPP-9', n: 1 }])
})

test("gap 3: $('Node') references and $env variables translate", () => {
  const imported = fromN8nWorkflow({
    nodes: [
      { parameters: { path: 'x' }, id: 'n-t', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0] },
      { parameters: { assignments: { assignments: [{ name: 'documentId', value: 'd-1' }] } }, id: 'n-doc', name: 'Create Doc', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [100, 0] },
      {
        parameters: { method: 'POST', url: "={{ $env.SF_INSTANCE_URL }}/documents/{{ $('Create Doc').first().json.documentId }}:batchUpdate" },
        id: 'n-write', name: 'Write Doc', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [200, 0],
      },
    ],
    connections: {
      Webhook: { main: [[{ node: 'Create Doc', type: 'main', index: 0 }]] },
      'Create Doc': { main: [[{ node: 'Write Doc', type: 'main', index: 0 }]] },
    },
  })
  const write = imported.graph.nodes.find((node) => node.id === 'n-write') as NodeOf<'http'>
  assert.equal(write.data.url, '{{var.SF_INSTANCE_URL}}/documents/{{step.n-doc.output.documentId}}:batchUpdate')
  // A variable-init step materializes each $env reference right after the trigger.
  const variable = imported.graph.nodes.find((node) => node.type === 'variable') as NodeOf<'variable'>
  assert.ok(variable, 'expected a variable node for SF_INSTANCE_URL')
  assert.equal(variable.data.op, 'initialize')
  assert.equal(variable.data.name, 'SF_INSTANCE_URL')
  const edgePairs = imported.graph.edges.map((edge) => [edge.source, edge.target])
  assert.ok(edgePairs.some(([source, target]) => source === 'trigger' && target === variable.id))
  assert.ok(imported.warnings.some((warning) => warning.includes('SF_INSTANCE_URL')))
})

test('gap 4: slack post and gmail send become native tool steps, not stubs', () => {
  const imported = fromN8nWorkflow({
    nodes: [
      { parameters: {}, id: 'n-t', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
      {
        parameters: { select: 'channel', channelId: { __rl: true, value: 'C0123', mode: 'id' }, text: '={{ $json.msg }}' },
        id: 'n-slack', name: 'Notify CS', type: 'n8n-nodes-base.slack', typeVersion: 2.3, position: [100, 0],
      },
      {
        parameters: { sendTo: 'a@x.co', subject: 'Handoff', message: 'Here it is' },
        id: 'n-gmail', name: 'Email AE', type: 'n8n-nodes-base.gmail', typeVersion: 2.1, position: [200, 0],
      },
      { parameters: { title: 'Doc' }, id: 'n-docs', name: 'Make Doc', type: 'n8n-nodes-base.googleDocs', typeVersion: 2, position: [300, 0] },
    ],
    connections: { Manual: { main: [[{ node: 'Notify CS', type: 'main', index: 0 }, { node: 'Email AE', type: 'main', index: 0 }, { node: 'Make Doc', type: 'main', index: 0 }]] } },
  })
  const slack = imported.graph.nodes.find((node) => node.id === 'n-slack') as NodeOf<'tool'>
  assert.equal(slack.type, 'tool')
  assert.equal(slack.data.connectionId, 'nango:slack')
  assert.equal(slack.data.toolName, 'slack_post_message')
  assert.deepEqual(JSON.parse(slack.data.args ?? '{}'), { channel: 'C0123', text: '{{trigger.input.msg}}' })

  const gmail = imported.graph.nodes.find((node) => node.id === 'n-gmail') as NodeOf<'tool'>
  assert.equal(gmail.type, 'tool')
  assert.equal(gmail.data.connectionId, 'nango:gmail')
  assert.equal(gmail.data.toolName, 'gmail_send_email')
  assert.deepEqual(JSON.parse(gmail.data.args ?? '{}'), { to: 'a@x.co', subject: 'Handoff', body: 'Here it is' })

  // googleDocs has no native capability — still an honest stub.
  assert.ok(imported.stubbedNodes.some((stub) => stub.originalType === 'n8n-nodes-base.googleDocs'))
  assert.equal(imported.stubbedNodes.some((stub) => stub.originalType.includes('slack')), false)
})

test('gap 5: multi-trigger workflows split into one flow per trigger', () => {
  const imported = fromN8nWorkflow({
    name: 'Deal Handoff',
    nodes: [
      { parameters: { path: 'sf' }, id: 'n-sf', name: 'SF Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0] },
      { parameters: { path: 'slash' }, id: 'n-slash', name: 'Slash Command', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 200] },
      { parameters: { respondWith: 'text', responseBody: 'ok' }, id: 'n-ack', name: 'Ack SF', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [100, 0] },
      { parameters: { jsCode: 'return items' }, id: 'n-parse', name: 'Parse', type: 'n8n-nodes-base.code', typeVersion: 2, position: [200, 100] },
      { parameters: { method: 'GET', url: 'https://api.example.com/deal' }, id: 'n-fetch', name: 'Fetch Deal', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [300, 100] },
    ],
    connections: {
      'SF Webhook': { main: [[{ node: 'Ack SF', type: 'main', index: 0 }]] },
      'Ack SF': { main: [[{ node: 'Parse', type: 'main', index: 0 }]] },
      'Slash Command': { main: [[{ node: 'Parse', type: 'main', index: 0 }]] },
      Parse: { main: [[{ node: 'Fetch Deal', type: 'main', index: 0 }]] },
    },
  })
  // Primary flow: first trigger + its reachable chain (shared tail included).
  assert.equal(imported.name, 'Deal Handoff')
  assert.equal(imported.trigger.type, 'webhook')
  const primaryTypes = imported.graph.nodes.map((node) => node.type).sort()
  assert.deepEqual(primaryTypes, ['code', 'http', 'respondWebhook', 'trigger'])
  // Sibling flow for the second trigger, with the shared tail DUPLICATED.
  assert.equal(imported.additionalFlows?.length, 1)
  const sibling = imported.additionalFlows![0]
  assert.equal(sibling.name, 'Deal Handoff — Slash Command')
  assert.equal(sibling.trigger.type, 'webhook')
  assert.deepEqual(sibling.graph.nodes.map((node) => node.type).sort(), ['code', 'http', 'trigger'])
  // The old merge warning is gone; the split is announced instead.
  assert.equal(imported.warnings.some((warning) => warning.includes('merged into one')), false)
  assert.ok(imported.warnings.some((warning) => warning.includes('split')))
})

test('gap 1: shared credentials group steps and prefill vault auth', () => {
  const imported = fromN8nWorkflow({
    nodes: [
      { parameters: {}, id: 'n-t', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
      {
        parameters: { method: 'GET', url: '=https://api.gong.io/v2/calls', authentication: 'predefinedCredentialType', nodeCredentialType: 'gongApi' },
        id: 'n-a', name: 'List calls', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [100, 0],
      },
      {
        parameters: { method: 'GET', url: 'https://api.gong.io/v2/transcript', authentication: 'predefinedCredentialType', nodeCredentialType: 'gongApi' },
        id: 'n-b', name: 'Get transcript', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [200, 0],
      },
      {
        parameters: { method: 'GET', url: 'https://sf.example.com/opp', authentication: 'predefinedCredentialType', nodeCredentialType: 'salesforceOAuth2Api' },
        id: 'n-c', name: 'Get opp', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [300, 0],
      },
    ],
    connections: {},
  })
  // API-key credentials group for vault binding; user-grant OAuth types the
  // runtime can serve from Nango map to predefined-connection auth instead.
  const groups = imported.credentialGroups ?? []
  assert.equal(groups.length, 1)
  const gong = groups.find((group) => group.sourceType === 'gongApi')
  assert.deepEqual(gong?.nodeIds.sort(), ['n-a', 'n-b'])
  const stepA = imported.graph.nodes.find((node) => node.id === 'n-a') as NodeOf<'http'>
  assert.equal(stepA.data.authMode, 'generic')
  assert.equal(stepA.data.url, 'https://api.gong.io/v2/calls')
  const salesforce = imported.graph.nodes.find((node) => node.id === 'n-c') as NodeOf<'http'>
  assert.equal(salesforce.data.authMode, 'predefined')
  assert.equal(salesforce.data.connectionId, 'nango:salesforce')
})

test('sheets and salesforce map to native tools; slackTrigger becomes a slack trigger', () => {
  const imported = fromN8nWorkflow({
    nodes: [
      { parameters: { trigger: ['app_mention', 'message'] }, id: 'n-t', name: 'On Slack mention', type: 'n8n-nodes-base.slackTrigger', typeVersion: 1, position: [0, 0] },
      {
        parameters: {
          operation: 'read',
          documentId: { __rl: true, mode: 'id', value: 'sheet-123' },
          sheetName: { __rl: true, mode: 'list', value: 'gid=0', cachedResultName: 'Leads' },
        },
        id: 'n-read', name: 'Read leads', type: 'n8n-nodes-base.googleSheets', typeVersion: 4.5, position: [100, 0],
      },
      {
        parameters: { resource: 'lead', operation: 'create' },
        id: 'n-sf', name: 'Create lead', type: 'n8n-nodes-base.salesforce', typeVersion: 2, position: [200, 0],
      },
    ],
    connections: {
      'On Slack mention': { main: [[{ node: 'Read leads', type: 'main', index: 0 }]] },
      'Read leads': { main: [[{ node: 'Create lead', type: 'main', index: 0 }]] },
    },
  })
  assert.deepEqual(imported.trigger, { type: 'slack', events: ['mention', 'channel_message'] })
  const read = imported.graph.nodes.find((node) => node.id === 'n-read') as NodeOf<'tool'>
  assert.equal(read.type, 'tool')
  assert.equal(read.data.connectionId, 'nango:sheets')
  assert.equal(read.data.toolName, 'sheets_get_values')
  assert.deepEqual(JSON.parse(read.data.args ?? '{}'), { spreadsheet_id: 'sheet-123', range: 'Leads' })
  const create = imported.graph.nodes.find((node) => node.id === 'n-sf') as NodeOf<'tool'>
  assert.equal(create.type, 'tool')
  assert.equal(create.data.connectionId, 'nango:salesforce')
  assert.equal(create.data.toolName, 'salesforce_create_record')
  assert.equal(imported.stubbedNodes.length, 0)
})

test('switch expression mode builds indexed cases; numeric fallback wires the default branch', () => {
  const imported = fromN8nWorkflow({
    nodes: [
      { parameters: {}, id: 'n-t', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
      {
        parameters: { mode: 'expression', numberOutputs: 2, output: '={{ $json.route }}', options: { fallbackOutput: 1 } },
        id: 'n-sw', name: 'Route', type: 'n8n-nodes-base.switch', typeVersion: 3.2, position: [100, 0],
      },
      { parameters: {}, id: 'n-a', name: 'Path A', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [200, -50] },
      { parameters: { amount: 1, unit: 'seconds' }, id: 'n-w1', name: 'Wait A', type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [300, -50] },
      { parameters: { amount: 2, unit: 'seconds' }, id: 'n-w2', name: 'Wait B', type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [300, 50] },
    ],
    connections: {
      Manual: { main: [[{ node: 'Route', type: 'main', index: 0 }]] },
      Route: {
        main: [
          [{ node: 'Path A', type: 'main', index: 0 }],
          [{ node: 'Wait B', type: 'main', index: 0 }],
        ],
      },
      'Path A': { main: [[{ node: 'Wait A', type: 'main', index: 0 }]] },
    },
  })
  const route = imported.graph.nodes.find((node) => node.id === 'n-sw') as NodeOf<'switch'>
  assert.equal(route.data.cases.length, 2)
  assert.deepEqual(route.data.cases.map((entry) => entry.right), ['0', '1'])
  // Numeric fallbackOutput 1 → unmatched items follow default to case-1's target.
  const defaultEdge = imported.graph.edges.find((edge) => edge.source === 'n-sw' && edge.branch === 'default')
  const caseOneEdge = imported.graph.edges.find((edge) => edge.source === 'n-sw' && edge.branch === 'case-1')
  assert.ok(defaultEdge && caseOneEdge)
  assert.equal(defaultEdge?.target, caseOneEdge?.target)
})

test('merge nodes become generated join code (append and combineByPosition)', async () => {
  const imported = fromN8nWorkflow({
    nodes: [
      { parameters: {}, id: 'n-t', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
      { parameters: { assignments: { assignments: [{ name: 'a', value: '1' }] } }, id: 'n-l', name: 'Left', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [100, -50] },
      { parameters: { assignments: { assignments: [{ name: 'b', value: '2' }] } }, id: 'n-r', name: 'Right', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [100, 50] },
      { parameters: { mode: 'combine', combineBy: 'combineByPosition' }, id: 'n-m', name: 'Join', type: 'n8n-nodes-base.merge', typeVersion: 3.2, position: [200, 0] },
    ],
    connections: {
      Manual: { main: [[{ node: 'Left', type: 'main', index: 0 }, { node: 'Right', type: 'main', index: 0 }]] },
      Left: { main: [[{ node: 'Join', type: 'main', index: 0 }]] },
      Right: { main: [[{ node: 'Join', type: 'main', index: 1 }]] },
    },
  })
  const join = imported.graph.nodes.find((node) => node.id === 'n-m') as NodeOf<'code'>
  assert.equal(join.type, 'code', 'merge should become a code join, not be dropped')
  // Both fan-in edges survive (the code step reads both parents' outputs).
  assert.equal(imported.graph.edges.filter((edge) => edge.target === 'n-m').length, 2)
  const merged = await runGenerated(join.data.code, [[{ a: 1 }, { a: 2 }], [{ b: 9 }]])
  assert.deepEqual(merged, [{ a: 1, b: 9 }, { a: 2 }])
})

test('whole-string computed expressions extract into generated code steps', () => {
  const imported = fromN8nWorkflow({
    nodes: [
      { parameters: {}, id: 'n-t', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
      { parameters: { assignments: { assignments: [{ name: 'user', value: 'ada' }] } }, id: 'n-s', name: 'Set', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [100, 0] },
      {
        parameters: { method: 'POST', url: 'https://api.example.com/x', sendBody: true, jsonBody: '={{ JSON.stringify({ who: $json.user.toUpperCase() }) }}' },
        id: 'n-h', name: 'Send', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [200, 0],
      },
    ],
    connections: {
      Manual: { main: [[{ node: 'Set', type: 'main', index: 0 }]] },
      Set: { main: [[{ node: 'Send', type: 'main', index: 0 }]] },
    },
  })
  const http = imported.graph.nodes.find((node) => node.id === 'n-h') as NodeOf<'http'>
  // $json made the step item-scoped; the computed expression moved into a
  // per-item code step and the field is the computed item itself.
  assert.equal(http.data.forEachItem, true)
  assert.equal(http.data.body, '{{item}}')
  const extracted = imported.graph.nodes.find((node) => node.type === 'code' && node.id.includes('expr')) as NodeOf<'code'>
  assert.ok(extracted, 'expected an extracted expression code step')
  assert.ok(extracted.data.code.includes('JSON.stringify'))
  assert.ok(extracted.data.code.includes('items.map'))
  // Wired between predecessor and the http step.
  const pairs = imported.graph.edges.map((edge) => [edge.source, edge.target])
  assert.ok(pairs.some(([source, target]) => source === 'n-s' && target === extracted.id))
  assert.ok(pairs.some(([source, target]) => source === extracted.id && target === 'n-h'))
})

test('continueErrorOutput branches absorb into an error shield', () => {
  const imported = fromN8nWorkflow({
    nodes: [
      { parameters: {}, id: 'n-t', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
      {
        parameters: { method: 'GET', url: 'https://api.example.com/risky' },
        id: 'n-risky', name: 'Risky call', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [100, 0],
        onError: 'continueErrorOutput',
      },
      { parameters: { amount: 1, unit: 'seconds' }, id: 'n-next', name: 'Continue', type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [200, -50] },
      { parameters: { errorMessage: 'it broke' }, id: 'n-alert', name: 'Alert', type: 'n8n-nodes-base.stopAndError', typeVersion: 1, position: [200, 50] },
    ],
    connections: {
      Manual: { main: [[{ node: 'Risky call', type: 'main', index: 0 }]] },
      'Risky call': {
        main: [
          [{ node: 'Continue', type: 'main', index: 0 }],
          [{ node: 'Alert', type: 'main', index: 0 }],
        ],
      },
    },
  })
  const shield = imported.graph.nodes.find((node) => node.type === 'errorShield') as NodeOf<'errorShield'>
  assert.ok(shield, 'expected an errorShield node')
  assert.deepEqual(shield.data.body, ['n-risky'])
  assert.deepEqual(shield.data.fallback, ['n-alert'])
  const pairs = imported.graph.edges.map((edge) => [edge.source, edge.target])
  assert.ok(pairs.some(([source, target]) => source === 'trigger' && target === shield.id))
  assert.ok(pairs.some(([source, target]) => source === shield.id && target === 'n-next'))
})

test('n8n file responses set binary responseType; python code gets the _input shim', () => {
  const imported = fromN8nWorkflow({
    nodes: [
      { parameters: {}, id: 'n-t', name: 'Manual', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
      {
        parameters: { method: 'GET', url: 'https://files.example.com/report.pdf', options: { response: { response: { responseFormat: 'file' } } } },
        id: 'n-dl', name: 'Download', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [100, 0],
      },
      {
        parameters: { language: 'python', pythonCode: 'rows = _input.all()\nreturn [{"n": len(rows)}]' },
        id: 'n-py', name: 'Py', type: 'n8n-nodes-base.code', typeVersion: 2, position: [200, 0],
      },
    ],
    connections: {
      Manual: { main: [[{ node: 'Download', type: 'main', index: 0 }]] },
      Download: { main: [[{ node: 'Py', type: 'main', index: 0 }]] },
    },
  })
  const download = imported.graph.nodes.find((node) => node.id === 'n-dl') as NodeOf<'http'>
  assert.equal(download.data.responseType, 'binary')
  const py = imported.graph.nodes.find((node) => node.id === 'n-py') as NodeOf<'code'>
  assert.ok(py.data.code.includes('class _SublimeInput'), 'expected the python _input shim')
  assert.ok(py.data.code.includes('rows = _input.all()'))
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
