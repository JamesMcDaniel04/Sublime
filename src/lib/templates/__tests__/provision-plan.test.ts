import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rewriteGraphAgentRefs } from '../provision-plan'
import type { FlowGraph } from '@/lib/flows/graph'

const g: FlowGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
    { id: 'a', type: 'agent', data: { agentId: 'ref-one', input: 'x' } },
    { id: 't', type: 'tool', data: { connectionId: 'native:slack', toolName: 'post_message', args: '{}' } },
  ],
  edges: [{ id: 'e', source: 'trigger', target: 'a' }],
}

test('rewrites matching agent refs, leaves other nodes untouched, does not mutate input', () => {
  const out = rewriteGraphAgentRefs(g, { 'ref-one': 'agent_123' })
  const agent = out.nodes.find((n) => n.id === 'a')!
  assert.equal((agent as any).data.agentId, 'agent_123')
  assert.equal((g.nodes[1] as any).data.agentId, 'ref-one', 'input graph unchanged')
  assert.equal((out.nodes.find((n) => n.id === 't') as any).data.toolName, 'post_message')
})

test('throws on an unresolved agent ref', () => {
  assert.throws(() => rewriteGraphAgentRefs(g, {}), /unresolved agent/i)
})
