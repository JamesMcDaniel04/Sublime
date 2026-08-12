import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toPortableFlow, toPortableAgent, PORTABLE_AGENT_FORMAT, PORTABLE_FORMAT } from '../portable'
import { toAgentInstructions, toInstructions } from '../instructions'
import { toN8nWorkflow } from '../n8n'
import { toWorkatoRecipe } from '../workato'
import { toPowerAutomateFlow } from '../power-automate'
import type { FlowGraph } from '@/lib/flows/graph'

const AT = '2026-07-15T00:00:00.000Z'

// trigger → (Fetch CRM, Enrich Lead) → Summarize   (a real fan-in)
const graph: FlowGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'webhook' } } },
    { id: 'crm', type: 'http', data: { label: 'Fetch CRM', method: 'GET', url: 'https://api/crm', headers: '{"authorization":"Bearer SUPER_SECRET"}' } },
    { id: 'enrich', type: 'http', data: { label: 'Enrich Lead', method: 'GET', url: 'https://api/enrich', cookie: 'session=SECRET_COOKIE' } },
    { id: 'agent', type: 'agent', data: { label: 'Summarize', agentId: 'agt_1' } },
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'crm' },
    { id: 'e1', source: 'trigger', target: 'enrich' },
    { id: 'e2', source: 'crm', target: 'agent' },
    { id: 'e3', source: 'enrich', target: 'agent' },
  ],
  layout: { crm: { x: 10, y: 20 } },
}

const flow = {
  name: 'Lead brief',
  description: 'Gather then summarize',
  trigger: { type: 'webhook', webhookSecretHash: 'HASHED_SECRET', webhookSecretEnc: 'v1:AAA:BBB:CCC' },
  graph,
}
const agents = [{ id: 'agt_1', title: 'Summarizer', instructions: 'Summarize the lead.', goal: 'Brief sales', model: 'gpt-x', integrations: ['slack'] }]

const portable = () => toPortableFlow(flow, agents, AT)

// ── Safety: an export leaves the platform ───────────────────────────────────

test('NEVER exports the webhook secret hash or ciphertext', () => {
  const json = JSON.stringify(portable())
  assert.equal(json.includes('HASHED_SECRET'), false)
  assert.equal(json.includes('webhookSecretHash'), false)
  assert.equal(json.includes('webhookSecretEnc'), false)
  assert.equal(json.includes('v1:AAA'), false)
  // …but the trigger itself still travels.
  assert.equal((portable().flow.trigger as { type?: string }).type, 'webhook')
})

test('NEVER exports Authorization headers or cookies typed into HTTP steps', () => {
  const json = JSON.stringify(portable())
  assert.equal(json.includes('SUPER_SECRET'), false, 'bearer token must be redacted')
  assert.equal(json.includes('SECRET_COOKIE'), false, 'cookie must be redacted')
  // The step itself survives — only the credential is stripped.
  assert.equal(json.includes('https://api/crm'), true)
})

test('NEVER exports a credential hidden in the URL, query, body or tool args', () => {
  // The places my first pass MISSED: redacting Authorization headers alone is
  // not enough, because a token is just as often in the URL or the payload.
  const sneaky: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'u', type: 'http', data: { label: 'URL key', method: 'GET', url: 'https://api/x?api_key=URL_SECRET&page=2' } },
      { id: 'b', type: 'http', data: { label: 'Basic auth', method: 'GET', url: 'https://joe:BASIC_SECRET@api/x' } },
      { id: 'q', type: 'http', data: { label: 'Query field', method: 'GET', url: 'https://api/x', query: '{"access_token":"QUERY_SECRET"}' } },
      { id: 'p', type: 'http', data: { label: 'Body auth', method: 'POST', url: 'https://api/x', body: '{"client_secret":"BODY_SECRET","q":"leads"}' } },
      { id: 't', type: 'tool', data: { label: 'Tool', connectionId: 'c1', toolName: 'send', args: '{"token":"TOOL_SECRET","text":"hi"}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'u' }],
  }
  const doc = toPortableFlow({ ...flow, graph: sneaky }, agents, AT)
  const everywhere = [JSON.stringify(doc), JSON.stringify(toN8nWorkflow(doc)), toInstructions(doc)].join('\n')
  for (const secret of ['URL_SECRET', 'BASIC_SECRET', 'QUERY_SECRET', 'BODY_SECRET', 'TOOL_SECRET']) {
    assert.equal(everywhere.includes(secret), false, `leaked ${secret}`)
  }
  // …while the steps stay rebuildable.
  assert.equal(everywhere.includes('page=2'), true, 'non-credential query params survive')
  assert.equal(everywhere.includes('leads'), true, 'the real body payload survives')
})

test('NEVER exports the generic auth option inline on an HTTP step', () => {
  // Regression: the generic `auth` option stores the credential INLINE in the
  // graph (password/token/value). It was added to the persisted-run-row
  // redactor and missed here, so every export target shipped the plaintext
  // token while the export's own `requirements` claimed credentials were
  // stripped. Both paths now share redactHttpAuthOption.
  const inlineAuth: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'bear', type: 'http', data: { label: 'Bearer', method: 'GET', url: 'https://api/x', auth: { type: 'bearer', token: 'BEARER_SECRET' } } },
      { id: 'basic', type: 'http', data: { label: 'Basic', method: 'GET', url: 'https://api/y', auth: { type: 'basic', username: 'joe', password: 'PASSWORD_SECRET' } } },
      { id: 'hdr', type: 'http', data: { label: 'Header key', method: 'GET', url: 'https://api/z', auth: { type: 'header', name: 'X-Api-Key', value: 'HEADER_SECRET' } } },
      { id: 'qry', type: 'http', data: { label: 'Query key', method: 'GET', url: 'https://api/w', auth: { type: 'query', name: 'api_key', value: 'QUERY_AUTH_SECRET' } } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'bear' }],
  }
  const doc = toPortableFlow({ ...flow, graph: inlineAuth }, agents, AT)
  // Every target converts the same portable doc — assert on all five so a
  // future per-target path can't reintroduce the leak.
  const everywhere = [
    JSON.stringify(doc),
    JSON.stringify(toN8nWorkflow(doc)),
    JSON.stringify(toWorkatoRecipe(doc)),
    JSON.stringify(toPowerAutomateFlow(doc)),
    toInstructions(doc),
  ].join('\n')
  for (const secret of ['BEARER_SECRET', 'PASSWORD_SECRET', 'HEADER_SECRET', 'QUERY_AUTH_SECRET']) {
    assert.equal(everywhere.includes(secret), false, `leaked ${secret}`)
  }
  // …while the step stays rebuildable: scheme, username and key NAMES are not
  // secrets, and the importer needs them to know what to re-enter.
  assert.equal(everywhere.includes('joe'), true, 'basic-auth username survives')
  assert.equal(everywhere.includes('X-Api-Key'), true, 'custom header name survives')
})

test('secrets stay out of the n8n and instructions targets too', () => {
  const doc = portable()
  const n8n = JSON.stringify(toN8nWorkflow(doc))
  const md = toInstructions(doc)
  for (const secret of ['SUPER_SECRET', 'SECRET_COOKIE', 'HASHED_SECRET']) {
    assert.equal(n8n.includes(secret), false, `n8n export leaked ${secret}`)
    assert.equal(md.includes(secret), false, `instructions leaked ${secret}`)
  }
})

// ── Credentials NEVER travel — there is no opt-in ───────────────────────────

test('the portable document has no credentials block and no way to ask for one', () => {
  const doc = portable()
  assert.equal('credentials' in doc, false)
  assert.equal('containsCredentials' in doc, false)
  // toPortableFlow takes no options — a fourth argument is not an opt-in.
  assert.equal(toPortableFlow.length, 3)
})

test('every runnable target ships the fill-me-in placeholder, never a secret', () => {
  const doc = portable()
  const outputs = [
    JSON.stringify(toN8nWorkflow(doc, { triggerBaseUrl: 'https://app.example' })),
    JSON.stringify(toWorkatoRecipe(doc, { triggerBaseUrl: 'https://app.example' })),
    JSON.stringify(toPowerAutomateFlow(doc, { triggerBaseUrl: 'https://app.example' })),
  ]
  for (const out of outputs) {
    assert.equal(out.includes('REPLACE_WITH_TRIGGER_SECRET'), true, 'runnable agent call needs the placeholder')
  }
})

test('vault credentialId and internal connectionId never leave the workspace', () => {
  const refs: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      {
        id: 'h', type: 'http',
        data: { label: 'Vaulted', method: 'GET', url: 'https://api/x', authMode: 'generic', credentialType: 'bearer', credentialId: 'cmdinternalcuid123' },
      },
      { id: 'h2', type: 'http', data: { label: 'Connected', method: 'GET', url: 'https://api/y', authMode: 'predefined', connectionId: 'cmdconncuid456' } },
      { id: 'h3', type: 'http', data: { label: 'Portable', method: 'GET', url: 'https://api/z', authMode: 'predefined', connectionId: 'nango:salesforce' } },
      { id: 't', type: 'tool', data: { label: 'Tool', connectionId: 'cmdtoolcuid789', toolName: 'send' } },
      { id: 't2', type: 'tool', data: { label: 'Native tool', connectionId: 'native:slack', toolName: 'send' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'h' }],
  }
  const doc = toPortableFlow({ ...flow, graph: refs }, agents, AT)
  const json = JSON.stringify(doc)
  assert.equal(json.includes('cmdinternalcuid123'), false, 'credentialId leaked')
  assert.equal(json.includes('cmdconncuid456'), false, 'http connectionId leaked')
  assert.equal(json.includes('cmdtoolcuid789'), false, 'tool connectionId leaked')
  // Portable ids are the documented exception — the importer rebinds them.
  assert.equal(json.includes('nango:salesforce'), true)
  assert.equal(json.includes('native:slack'), true)
  // The non-secret editor hint survives so the importer knows what to attach.
  assert.equal(json.includes('credentialType'), true)
})

// ── Portable ────────────────────────────────────────────────────────────────

test('inlines referenced agents so the export stands alone', () => {
  const doc = portable()
  assert.equal(doc.format, PORTABLE_FORMAT)
  assert.equal(doc.agents.length, 1)
  assert.equal(doc.agents[0].instructions, 'Summarize the lead.')
  assert.equal(doc.agents[0].ref, 'agt_1', 'keeps the ref the agent step uses')
})

test('states what must be reconnected rather than failing silently later', () => {
  const doc = portable()
  const text = doc.requirements.join(' ')
  assert.match(text, /credentials are redacted on export/i)
  assert.match(text, /URL user:pass|api_key\/token\/secret/i, 'names WHERE credentials were stripped, so nothing is a surprise')
  assert.match(text, /slack/i, 'the agent tools that must be connected are named')
})

test('a missing agent becomes a stated requirement, not a broken export', () => {
  const doc = toPortableFlow(flow, [], AT)
  assert.equal(doc.agents.length, 0)
  assert.match(doc.requirements.join(' '), /agt_1/)
})

// ── n8n ─────────────────────────────────────────────────────────────────────

test('n8n: fan-in survives — both APIs connect into the one agent node', () => {
  const workflow = toN8nWorkflow(portable())
  assert.deepEqual(workflow.connections['Fetch CRM'].main[0], [{ node: 'Summarize', type: 'main', index: 0 }])
  assert.deepEqual(workflow.connections['Enrich Lead'].main[0], [{ node: 'Summarize', type: 'main', index: 0 }])
  assert.equal(workflow.nodes.filter((node) => node.name === 'Summarize').length, 1, 'the join is ONE node')
})

test('n8n: fan-out from the trigger maps to two connections', () => {
  const workflow = toN8nWorkflow(portable())
  assert.equal(workflow.connections.trigger.main[0].length, 2)
})

test('n8n: an HTTP step maps to a real httpRequest node with method + url', () => {
  const node = toN8nWorkflow(portable()).nodes.find((candidate) => candidate.name === 'Fetch CRM')!
  assert.equal(node.type, 'n8n-nodes-base.httpRequest')
  assert.equal(node.parameters.url, 'https://api/crm')
  assert.equal(node.parameters.method, 'GET')
})

test('n8n: an agent becomes a visible placeholder carrying its instructions', () => {
  const node = toN8nWorkflow(portable()).nodes.find((candidate) => candidate.name === 'Summarize')!
  // Without a trigger URL, n8n has no agent equivalent — the work must be
  // visible, never silently dropped.
  assert.equal(node.type, 'n8n-nodes-base.noOp')
  assert.match(node.notes ?? '', /Summarize the lead\./)
})

test('n8n: with a trigger URL, an agent exports as a RUNNABLE HTTP Request node', () => {
  const node = toN8nWorkflow(portable(), { triggerBaseUrl: 'https://app.example.com' })
    .nodes.find((candidate) => candidate.name === 'Summarize')!
  assert.equal(node.type, 'n8n-nodes-base.httpRequest')
  assert.equal(node.parameters.method, 'POST')
  assert.equal(node.parameters.url, 'https://app.example.com/api/agents/agt_1/trigger')
  // The secret is NEVER exported — only a fill-me-in placeholder header.
  assert.match(JSON.stringify(node.parameters), /REPLACE_WITH_TRIGGER_SECRET/)
  assert.match(node.notes ?? '', /Summarize the lead\./, 'instructions still travel')
})

test('n8n: duplicate step names are disambiguated (connections are keyed by NAME)', () => {
  const dup: FlowGraph = {
    nodes: [
      { id: 'a', type: 'http', data: { label: 'Call', method: 'GET', url: 'https://x/1' } },
      { id: 'b', type: 'http', data: { label: 'Call', method: 'GET', url: 'https://x/2' } },
    ],
    edges: [{ id: 'e', source: 'a', target: 'b' }],
  }
  const workflow = toN8nWorkflow(toPortableFlow({ ...flow, graph: dup }, agents, AT))
  assert.deepEqual(workflow.nodes.map((node) => node.name), ['Call', 'Call (2)'])
  assert.deepEqual(workflow.connections.Call.main[0], [{ node: 'Call (2)', type: 'main', index: 0 }])
})

test('n8n: canvas layout carries over so the import looks like the original', () => {
  const node = toN8nWorkflow(portable()).nodes.find((candidate) => candidate.name === 'Fetch CRM')!
  assert.deepEqual(node.position, [10, 20])
})

// ── Instructions ────────────────────────────────────────────────────────────

// ── Agent-level export ──────────────────────────────────────────────────────

test('an agent exports standalone with its instructions and tool requirements', () => {
  const doc = toPortableAgent(agents[0], AT)
  assert.equal(doc.format, PORTABLE_AGENT_FORMAT)
  assert.equal(doc.agent.instructions, 'Summarize the lead.')
  assert.equal(doc.agent.model, 'gpt-x')
  assert.match(doc.requirements.join(' '), /slack/i, 'its tools must be reconnected')
})

test('an agent with no tools needs nothing reconnected', () => {
  const doc = toPortableAgent({ id: 'a', title: 'Plain', instructions: 'Do it.' }, AT)
  assert.deepEqual(doc.requirements, [])
  assert.deepEqual(doc.agent.integrations, [])
})

test('agent instructions render as a pasteable system prompt', () => {
  const md = toAgentInstructions(toPortableAgent(agents[0], AT))
  assert.match(md, /# Summarizer/)
  assert.match(md, /Summarize the lead\./)
  assert.match(md, /system prompt/i)
  assert.match(md, /Tools this agent expects[\s\S]*slack/)
})

test('instructions describe fan-in via "fed by", which a linear list cannot', () => {
  const md = toInstructions(portable())
  assert.match(md, /# Lead brief/)
  assert.match(md, /\*\*Fed by:\*\* "Fetch CRM" \+ "Enrich Lead"/, 'the merge is explicit')
  assert.match(md, /GET https:\/\/api\/crm/)
  assert.match(md, /Summarize the lead\./, 'agent instructions travel')
  assert.match(md, /Before this will run elsewhere/)
})

// ── Round 3: export fidelity — branches, params, reverse expressions ────────

const branchedGraph: FlowGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'webhook' } } },
    {
      id: 'gate', type: 'condition',
      data: { label: 'Qualified?', match: 'all', clauses: [{ left: '{{trigger.input.score}}', op: 'gt', right: '50' }] },
    },
    {
      id: 'route', type: 'switch',
      data: { label: 'Tier', cases: [
        { id: 'case-0', label: 'Gold', left: '{{trigger.input.tier}}', op: 'eq', right: 'gold' },
        { id: 'case-1', label: 'Silver', left: '{{trigger.input.tier}}', op: 'eq', right: 'silver' },
      ] },
    },
    { id: 'shape', type: 'transform', data: { label: 'Shape', fields: [{ name: 'team', value: '{{step.gate.output.team}}' }] } },
    { id: 'notify', type: 'http', data: { label: 'Notify', method: 'POST', url: 'https://api/notify', body: '{{js: step["shape"].team + "!"}}', headers: '{"x-region":"{{var.REGION}}"}' } },
    { id: 'fallback', type: 'http', data: { label: 'Fallback', method: 'GET', url: 'https://api/fallback' } },
    { id: 'end', type: 'stop', data: { label: 'End', reason: 'Unqualified' } },
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'gate' },
    { id: 'e1', source: 'gate', target: 'route', branch: 'true' },
    { id: 'e2', source: 'gate', target: 'end', branch: 'false' },
    { id: 'e3', source: 'route', target: 'shape', branch: 'case-0' },
    { id: 'e4', source: 'route', target: 'notify', branch: 'case-1' },
    { id: 'e5', source: 'route', target: 'fallback', branch: 'default' },
    { id: 'e6', source: 'shape', target: 'notify' },
  ],
  layout: {},
}

const branchedPortable = () => toPortableFlow({ name: 'Branched', description: '', trigger: { type: 'webhook' }, graph: branchedGraph }, [], AT)

test('export maps branches onto n8n output indexes instead of collapsing to 0', () => {
  const workflow = toN8nWorkflow(branchedPortable())
  const gate = workflow.connections['Qualified?']
  assert.equal(gate.main[0]?.[0]?.node, 'Tier')
  assert.equal(gate.main[1]?.[0]?.node, 'End')
  const route = workflow.connections['Tier']
  assert.equal(route.main[0]?.[0]?.node, 'Shape')
  assert.equal(route.main[1]?.[0]?.node, 'Notify')
  // default branch rides the extra fallback output.
  assert.equal(route.main[2]?.[0]?.node, 'Fallback')
})

test('export emits real if/switch/set/stop params with reverse-translated expressions', () => {
  const workflow = toN8nWorkflow(branchedPortable())
  const byName = new Map(workflow.nodes.map((node) => [node.name, node]))

  const gate = byName.get('Qualified?')!
  const conditions = (gate.parameters.conditions as { combinator: string; conditions: Array<Record<string, unknown>> })
  assert.equal(conditions.combinator, 'and')
  assert.equal(conditions.conditions[0].leftValue, '={{ $json.score }}')
  assert.deepEqual(conditions.conditions[0].operator, { type: 'number', operation: 'larger' })

  const route = byName.get('Tier')!
  const rules = (route.parameters.rules as { values: Array<{ outputKey: string; conditions: { conditions: Array<Record<string, unknown>> } }> }).values
  assert.equal(rules.length, 2)
  assert.equal(rules[0].outputKey, 'Gold')
  assert.equal(rules[1].conditions.conditions[0].rightValue, 'silver')
  assert.equal(route.parameters.fallbackOutput, 'extra')

  const shape = byName.get('Shape')!
  const assignments = (shape.parameters.assignments as { assignments: Array<Record<string, unknown>> }).assignments
  assert.equal(assignments[0].name, 'team')
  assert.equal(assignments[0].value, '={{ $node["Qualified?"].json.team }}')

  const end = byName.get('End')!
  assert.equal(end.type, 'n8n-nodes-base.stopAndError')
  assert.equal(end.parameters.errorMessage, 'Unqualified')

  const notify = byName.get('Notify')!
  assert.equal(notify.parameters.jsonBody, '={{ $node["Shape"].json.team + "!" }}')
  const headerParams = (notify.parameters.headerParameters as { parameters: Array<{ name: string; value: string }> }).parameters
  assert.deepEqual(headerParams[0], { name: 'x-region', value: '={{ $env.REGION }}' })
})

test('exported branched workflow round-trips through the importer with branches intact', async () => {
  const { fromN8nWorkflow } = await import('@/lib/import/n8n')
  const reimported = fromN8nWorkflow(JSON.parse(JSON.stringify(toN8nWorkflow(branchedPortable()))))
  const condition = reimported.graph.nodes.find((node) => node.type === 'condition')!
  const clauses = (condition.data as { clauses: Array<{ op: string; right: string }> }).clauses
  assert.equal(clauses[0].op, 'gt')
  assert.equal(clauses[0].right, '50')
  const conditionEdges = reimported.graph.edges.filter((edge) => edge.source === condition.id)
  assert.deepEqual(new Set(conditionEdges.map((edge) => edge.branch)), new Set(['true', 'false']))
  const sw = reimported.graph.nodes.find((node) => node.type === 'switch')!
  assert.equal((sw.data as { cases: unknown[] }).cases.length, 2)
})

test('deactivation round-trips through the n8n target', async () => {
  const withDisabled: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'webhook' } } },
      { id: 'off', type: 'http', data: { label: 'Off call', method: 'GET', url: 'https://api/x', disabled: true } },
      { id: 'gate', type: 'condition', data: { label: 'Gate', left: 'a', op: 'eq', right: 'a', disabled: true } },
      { id: 'on', type: 'http', data: { label: 'On call', method: 'GET', url: 'https://api/y' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'off' },
      { id: 'e1', source: 'off', target: 'gate' },
      { id: 'e2', source: 'gate', target: 'on', branch: 'true' },
    ],
  }
  const workflow = toN8nWorkflow(toPortableFlow({ ...flow, graph: withDisabled }, [], AT))
  const byName = new Map(workflow.nodes.map((node) => [node.name, node]))
  assert.equal((byName.get('Off call') as { disabled?: boolean }).disabled, true)
  assert.equal((byName.get('Gate') as { disabled?: boolean }).disabled, true)
  assert.equal((byName.get('On call') as { disabled?: boolean }).disabled, undefined)

  const { fromN8nWorkflow } = await import('@/lib/import/n8n')
  const reimported = fromN8nWorkflow(JSON.parse(JSON.stringify(workflow)))
  const nodes = reimported.graph.nodes
  const httpOff = nodes.find((node) => node.type === 'http' && (node.data as { label?: string }).label === 'Off call')
  const gate = nodes.find((node) => node.type === 'condition')
  const httpOn = nodes.find((node) => node.type === 'http' && (node.data as { label?: string }).label === 'On call')
  assert.equal((httpOff?.data as { disabled?: boolean }).disabled, true)
  assert.equal((gate?.data as { disabled?: boolean }).disabled, true, 'disabled now imports on condition nodes too')
  assert.equal((httpOn?.data as { disabled?: boolean }).disabled, undefined)
})
