/**
 * Workato + Power Automate: the two "impedance mismatch" targets.
 *
 * The property that matters is honesty about loss — Power Automate CAN express
 * fan-in (runAfter), Workato cannot (a recipe is linear). Neither may silently
 * drop a step or a merge.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toPortableFlow } from '../portable'
import { toWorkatoRecipe } from '../workato'
import { toPowerAutomateFlow } from '../power-automate'
import { topoOrder } from '../order'
import type { FlowGraph } from '@/lib/flows/graph'

const AT = '2026-07-15T00:00:00.000Z'

// trigger → (Fetch CRM, Enrich Lead) → Summarize  — a genuine fan-in
const graph: FlowGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: {} },
    { id: 'crm', type: 'http', data: { label: 'Fetch CRM', method: 'GET', url: 'https://api/crm' } },
    { id: 'enrich', type: 'http', data: { label: 'Enrich Lead', method: 'GET', url: 'https://api/enrich' } },
    { id: 'agent', type: 'agent', data: { label: 'Summarize', agentId: 'agt_1' } },
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'crm' },
    { id: 'e1', source: 'trigger', target: 'enrich' },
    { id: 'e2', source: 'crm', target: 'agent' },
    { id: 'e3', source: 'enrich', target: 'agent' },
  ],
}
const agents = [{ id: 'agt_1', title: 'Summarizer', instructions: 'Summarize the lead.', model: 'gpt-x', integrations: [] }]
const portable = () => toPortableFlow({ name: 'Lead brief', description: 'd', trigger: { type: 'manual' }, graph }, agents, AT)

// ── Ordering ────────────────────────────────────────────────────────────────

test('topoOrder puts every step after the steps that feed it', () => {
  const order = topoOrder(graph.nodes, graph.edges).map((node) => node.id)
  assert.ok(order.indexOf('crm') < order.indexOf('agent'))
  assert.ok(order.indexOf('enrich') < order.indexOf('agent'))
  assert.equal(order[0], 'trigger')
  assert.equal(order.length, 4, 'no step is lost')
})

test('topoOrder keeps cyclic nodes instead of dropping them', () => {
  const cyclic: FlowGraph = {
    nodes: [{ id: 'a', type: 'agent', data: { agentId: 'x' } }, { id: 'b', type: 'agent', data: { agentId: 'y' } }],
    edges: [{ id: 'e1', source: 'a', target: 'b' }, { id: 'e2', source: 'b', target: 'a' }],
  }
  // An export must never silently lose a step, even from a graph the engine rejects.
  assert.equal(topoOrder(cyclic.nodes, cyclic.edges).length, 2)
})

// ── Workato (linear — lossy, and says so) ───────────────────────────────────

test('workato: emits every step in dependency order', () => {
  const recipe = toWorkatoRecipe(portable())
  const order = recipe.code.map((step) => step.as)
  assert.equal(recipe.code.length, 4)
  assert.ok(order.indexOf('crm') < order.indexOf('agent'))
  assert.deepEqual(recipe.code.map((step) => step.number), [1, 2, 3, 4], 'numbered sequentially')
  assert.equal(recipe.code[0].keyword, 'trigger')
})

test('workato: DECLARES the merge it cannot represent', () => {
  const recipe = toWorkatoRecipe(portable())
  // A recipe is a tree: this fan-in is genuinely lost, so it must be stated
  // rather than flattened into a plausible-looking lie.
  assert.match(recipe.description, /recipes are linear/i)
  assert.match(recipe.description, /Summarize.*fed by.*Fetch CRM.*Enrich Lead/s)
  const summarize = recipe.code.find((step) => step.as === 'agent')!
  assert.match(summarize.description, /merges several inputs/i)
  assert.match(summarize.description, /Summarize the lead\./, 'agent instructions still travel')
})

// ── Power Automate (runAfter — fan-in survives) ──────────────────────────────

test('power automate: fan-in SURVIVES via runAfter', () => {
  const flow = toPowerAutomateFlow(portable())
  const summarize = flow.definition.actions.Summarize
  assert.ok(summarize, 'the agent step exports as an action')
  // The reason this target beats Workato: dependencies are first-class.
  assert.deepEqual(summarize.runAfter, { Fetch_CRM: ['Succeeded'], Enrich_Lead: ['Succeeded'] })
})

test('power automate: trigger dependencies are implicit, not fake actions', () => {
  const flow = toPowerAutomateFlow(portable())
  assert.deepEqual(flow.definition.actions.Fetch_CRM.runAfter, {}, 'runs straight off the trigger')
  assert.equal(flow.definition.actions.trigger, undefined, 'the trigger is not an action')
  assert.ok(flow.definition.triggers.manual, 'it is a trigger')
})

test('power automate: an HTTP step maps to a real Http action', () => {
  const action = toPowerAutomateFlow(portable()).definition.actions.Fetch_CRM
  assert.equal(action.type, 'Http')
  assert.equal(action.inputs.uri, 'https://api/crm')
  assert.equal(action.inputs.method, 'GET')
})

test('power automate: an agent carries its instructions instead of vanishing', () => {
  const action = toPowerAutomateFlow(portable()).definition.actions.Summarize
  assert.equal(action.type, 'Compose')
  assert.match(action.description ?? '', /no equivalent/i)
  assert.match(action.description ?? '', /Summarize the lead\./)
})

test('power automate: action names are sanitized and de-duplicated', () => {
  const messy: FlowGraph = {
    nodes: [
      { id: 'a', type: 'http', data: { label: 'Call API!', method: 'GET', url: 'https://x/1' } },
      { id: 'b', type: 'http', data: { label: 'Call API?', method: 'GET', url: 'https://x/2' } },
    ],
    edges: [{ id: 'e', source: 'a', target: 'b' }],
  }
  const flow = toPowerAutomateFlow(toPortableFlow({ name: 'n', graph: messy }, [], AT))
  const names = Object.keys(flow.definition.actions)
  // Both sanitize to "Call_API" — a collision would silently merge their runAfter wiring.
  assert.deepEqual(names.sort(), ['Call_API', 'Call_API_2'])
  assert.deepEqual(flow.definition.actions.Call_API_2.runAfter, { Call_API: ['Succeeded'] })
})
