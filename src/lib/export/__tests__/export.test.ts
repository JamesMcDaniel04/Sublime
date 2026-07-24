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
  trigger: { type: 'webhook', webhookSecretHash: 'HASHED_SECRET' },
  graph,
}
const agents = [{ id: 'agt_1', title: 'Summarizer', instructions: 'Summarize the lead.', goal: 'Brief sales', model: 'gpt-x', integrations: ['slack'] }]

const portable = () => toPortableFlow(flow, agents, AT)

// ── Safety: an export leaves the platform ───────────────────────────────────

test('NEVER exports the webhook secret hash', () => {
  const json = JSON.stringify(portable())
  assert.equal(json.includes('HASHED_SECRET'), false)
  assert.equal(json.includes('webhookSecretHash'), false)
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
