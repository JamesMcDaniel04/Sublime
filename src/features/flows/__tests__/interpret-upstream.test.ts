import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn, type RunActionFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

// Per-node API output keyed by the (resolved) url set on each http node.
const apiAction: RunActionFn = async (node) => {
  const url = String((node.config as { url?: unknown }).url ?? '')
  if (url.includes('crm')) return { output: { ok: true, body: { name: 'Acme', tier: 'gold' } } }
  if (url.includes('enrich')) return { output: { ok: true, body: { score: 87 } } }
  if (url.includes('fail')) return { error: 'HTTP 500: boom' }
  return { output: { ok: true } }
}

// Capture exactly what the agent received as its input.
function capturingAgent() {
  const seen: { input?: string } = {}
  const runAgent: RunAgentFn = async (node) => {
    seen.input = node.input
    return { output: 'done' }
  }
  return { runAgent, seen }
}

// trigger → http(Fetch CRM) → http(Enrich Lead) → agent. The agent uses its
// DEFAULT node input ({{trigger.input}}) unless `agentData.input` overrides it —
// the common "saved agent placed after some API steps" shape.
const chain = (agentData: Record<string, unknown> = {}, crmExtra: Record<string, unknown> = {}): FlowGraph => ({
  nodes: [
    { id: 'trigger', type: 'trigger', data: {} },
    { id: 'crm', type: 'http', data: { label: 'Fetch CRM', method: 'GET', url: 'https://api/crm', ...crmExtra } },
    { id: 'enrich', type: 'http', data: { label: 'Enrich Lead', method: 'GET', url: 'https://api/enrich' } },
    { id: 'agent', type: 'agent', data: { agentId: 'x', ...agentData } },
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'crm' },
    { id: 'e1', source: 'crm', target: 'enrich' },
    { id: 'e2', source: 'enrich', target: 'agent' },
  ],
})

test('a default-input agent auto-receives aggregated upstream API data with zero wiring', async () => {
  const { runAgent, seen } = capturingAgent()
  const result = await interpretFlow(chain(), 'go', { runAgent, runAction: apiAction })
  assert.equal(result.status, 'succeeded')
  assert.match(seen.input ?? '', /Upstream data:/)
  assert.match(seen.input ?? '', /Fetch CRM/)
  assert.match(seen.input ?? '', /Acme/)
  assert.match(seen.input ?? '', /Enrich Lead/)
  assert.match(seen.input ?? '', /87/)
})

test('a hand-customized agent input is left exactly as authored (no auto-append)', async () => {
  const { runAgent, seen } = capturingAgent()
  await interpretFlow(chain({ input: 'Only my instruction.' }), 'go', { runAgent, runAction: apiAction })
  assert.match(seen.input ?? '', /Only my instruction\./)
  assert.doesNotMatch(seen.input ?? '', /Upstream data:/)
  assert.doesNotMatch(seen.input ?? '', /Acme/)
})

test('includeUpstream:true forces the aggregate even for a customized input', async () => {
  const { runAgent, seen } = capturingAgent()
  await interpretFlow(chain({ input: 'Only my instruction.', includeUpstream: true }), 'go', { runAgent, runAction: apiAction })
  assert.match(seen.input ?? '', /Only my instruction\./)
  assert.match(seen.input ?? '', /Acme/)
})

test('includeUpstream:false opts a default-input agent out', async () => {
  const { runAgent, seen } = capturingAgent()
  await interpretFlow(chain({ includeUpstream: false }), 'go', { runAgent, runAction: apiAction })
  assert.doesNotMatch(seen.input ?? '', /Upstream data:/)
  assert.doesNotMatch(seen.input ?? '', /Acme/)
})

test('an explicit {{upstream}} reference is respected, not double-appended', async () => {
  const { runAgent, seen } = capturingAgent()
  await interpretFlow(chain({ input: 'Context: {{upstream}}' }), 'go', { runAgent, runAction: apiAction })
  assert.match(seen.input ?? '', /Acme/) // resolved from the explicit token
  assert.doesNotMatch(seen.input ?? '', /Upstream data:/) // no auto-append header
})

test('excludeFromContext drops that node from the aggregate', async () => {
  const { runAgent, seen } = capturingAgent()
  await interpretFlow(chain({}, { excludeFromContext: true }), 'go', { runAgent, runAction: apiAction })
  assert.doesNotMatch(seen.input ?? '', /Acme/) // CRM excluded
  assert.match(seen.input ?? '', /Enrich Lead/) // Enrich still aggregated
})

test('a failed-and-continued API node is captured as a structured failure', async () => {
  const { runAgent, seen } = capturingAgent()
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'fail', type: 'http', data: { label: 'Risky API', method: 'GET', url: 'https://api/fail', onError: 'continue' } },
      { id: 'agent', type: 'agent', data: { agentId: 'x' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'fail' },
      { id: 'e1', source: 'fail', target: 'agent' },
    ],
  }
  const result = await interpretFlow(graph, 'go', { runAgent, runAction: apiAction })
  assert.equal(result.status, 'succeeded') // the flow continued past the failure
  assert.match(seen.input ?? '', /Risky API/)
  assert.match(seen.input ?? '', /"ok":false/)
  assert.match(seen.input ?? '', /boom/)
})
