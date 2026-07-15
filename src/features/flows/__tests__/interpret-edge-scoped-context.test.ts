/**
 * Edge-scoped context (DAG engine ①, slice 1): a node's {{upstream}} is its
 * transitive graph-ancestors — the sources actually wired into it — not every
 * step that happened to run. This is what makes "API-1 feeds Agent-A only" real.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn, type RunActionFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

const apiAction: RunActionFn = async (node) => {
  const url = String((node.config as { url?: unknown }).url ?? '')
  if (url.includes('alpha')) return { output: { ok: true, body: 'ALPHA_DATA' } }
  if (url.includes('beta')) return { output: { ok: true, body: 'BETA_DATA' } }
  return { output: { ok: true, body: 'OTHER' } }
}

function capturingAgents() {
  const seen: Record<string, string> = {}
  const runAgent: RunAgentFn = async (node) => {
    seen[node.id] = node.input
    return { output: `done:${node.id}` }
  }
  return { runAgent, seen }
}

test('an agent sees ONLY the API wired into it, not a sibling API on another path', async () => {
  // trigger → alpha → agentA   (agentA must see ALPHA only)
  // trigger → beta  → agentB   (agentB must see BETA only)
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'alpha', type: 'http', data: { label: 'Alpha API', method: 'GET', url: 'https://api/alpha' } },
      { id: 'agentA', type: 'agent', data: { agentId: 'a' } },
      { id: 'beta', type: 'http', data: { label: 'Beta API', method: 'GET', url: 'https://api/beta' } },
      { id: 'agentB', type: 'agent', data: { agentId: 'b' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'alpha' },
      { id: 'e1', source: 'alpha', target: 'agentA' },
      { id: 'e2', source: 'agentA', target: 'beta' },
      { id: 'e3', source: 'beta', target: 'agentB' },
    ],
  }
  const { runAgent, seen } = capturingAgents()
  await interpretFlow(graph, 'go', { runAgent, runAction: apiAction })

  // agentA is wired downstream of alpha only — beta runs LATER, so it must not leak.
  assert.match(seen.agentA ?? '', /ALPHA_DATA/)
  assert.doesNotMatch(seen.agentA ?? '', /BETA_DATA/)
  // agentB's ancestors include alpha, agentA AND beta (they're all on its path).
  assert.match(seen.agentB ?? '', /BETA_DATA/)
  assert.match(seen.agentB ?? '', /ALPHA_DATA/)
})

test('ancestors exclude a node on a divergent path (selective routing)', async () => {
  // A fan-out the linear walker can't traverse today, but ancestry is still the
  // contract the scheduler will honor: agentB's ancestors are {beta}, never alpha.
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'alpha', type: 'http', data: { label: 'Alpha API', method: 'GET', url: 'https://api/alpha' } },
      { id: 'beta', type: 'http', data: { label: 'Beta API', method: 'GET', url: 'https://api/beta' } },
      { id: 'agentB', type: 'agent', data: { agentId: 'b' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'beta' },
      { id: 'e1', source: 'beta', target: 'agentB' },
      // `alpha` hangs off the trigger on its own path — never an ancestor of agentB.
      { id: 'e2', source: 'trigger', target: 'alpha' },
    ],
  }
  const { runAgent, seen } = capturingAgents()
  await interpretFlow(graph, 'go', { runAgent, runAction: apiAction })
  assert.match(seen.agentB ?? '', /BETA_DATA/)
  assert.doesNotMatch(seen.agentB ?? '', /ALPHA_DATA/)
})

test('regression: a linear chain still aggregates every prior step (ancestors == all prior)', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'alpha', type: 'http', data: { label: 'Alpha API', method: 'GET', url: 'https://api/alpha' } },
      { id: 'beta', type: 'http', data: { label: 'Beta API', method: 'GET', url: 'https://api/beta' } },
      { id: 'agent', type: 'agent', data: { agentId: 'a' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'alpha' },
      { id: 'e1', source: 'alpha', target: 'beta' },
      { id: 'e2', source: 'beta', target: 'agent' },
    ],
  }
  const { runAgent, seen } = capturingAgents()
  await interpretFlow(graph, 'go', { runAgent, runAction: apiAction })
  assert.match(seen.agent ?? '', /ALPHA_DATA/)
  assert.match(seen.agent ?? '', /BETA_DATA/)
})
