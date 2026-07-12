import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

test('inline agent passes prompt + model + resolved input to the adapter', async () => {
  const seen: { agentId: string; prompt?: string; model?: string; input: string }[] = []
  const runAgent: RunAgentFn = async (node) => {
    seen.push({ agentId: node.agentId, prompt: node.prompt, model: node.model, input: node.input })
    return { output: 'classified' }
  }
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: '', prompt: 'Classify: {{trigger.input}}', model: 'claude-haiku-4-5', input: '{{trigger.input}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'a' }],
  }
  const result = await interpretFlow(graph, 'a refund request', { runAgent })
  assert.equal(result.output, 'classified')
  assert.equal(seen[0].agentId, '')
  assert.equal(seen[0].prompt, 'Classify: a refund request')
  assert.equal(seen[0].model, 'claude-haiku-4-5')
})

test('saved agent (agentId set) does NOT pass a prompt', async () => {
  const seen: { prompt?: string }[] = []
  const runAgent: RunAgentFn = async (node) => { seen.push({ prompt: node.prompt }); return { output: 'ok' } }
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'agent', data: { agentId: 'agent-1', prompt: 'ignored', input: 'x' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'a' }],
  }
  await interpretFlow(graph, 'x', { runAgent })
  assert.equal(seen[0].prompt, undefined)
})
