import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn, type RunActionFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

// Reproduces the reported Slack-node bug: a tool (Slack) node references the
// previous agent by the friendly label the builder shows on token chips, i.e.
// `{{Previous Agent.output.message}}` rather than the id-keyed
// `{{step.<id>.output.message}}`. Before the fix the label root resolved to
// nothing and the posted args came out as `{ query: "" }`.
test('a tool node resolves a prior agent step referenced by its display label', async () => {
  const seenArgs: unknown[] = []
  const runAgent: RunAgentFn = async () => ({ output: { message: 'Hello from the agent' } })
  const runAction: RunActionFn = async (node) => {
    seenArgs.push(node.config.args)
    return { output: 'posted' }
  }
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n7', type: 'agent', data: { agentId: '', prompt: 'Draft it', input: '{{trigger.input}}', label: 'Previous Agent' } },
      { id: 'n9', type: 'tool', data: { connectionId: 'conn-1', toolName: 'slack_post_message', args: '{\n  "query": "{{Previous Agent.output.message}}"\n}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n7' },
      { id: 'e1', source: 'n7', target: 'n9' },
    ],
  }
  await interpretFlow(graph, 'go', { runAgent, runAction })
  assert.deepEqual(seenArgs[0], { query: 'Hello from the agent' })
})

// An agent node with no explicit label falls back to the agent's title, so a
// reference by that title still resolves (execute-flow passes the enriched map;
// here we pass stepLabels directly to model that path).
test('an unlabeled agent node resolves by its agent title', async () => {
  const seenArgs: unknown[] = []
  const runAgent: RunAgentFn = async () => ({ output: 'the report body' })
  const runAction: RunActionFn = async (node) => {
    seenArgs.push(node.config.args)
    return { output: 'posted' }
  }
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n2', type: 'agent', data: { agentId: 'agent-1', input: '{{trigger.input}}' } },
      { id: 'n3', type: 'tool', data: { connectionId: 'c', toolName: 'slack_post_message', args: '{"text":"{{Upsell Engine.output}}"}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'n2' },
      { id: 'e1', source: 'n2', target: 'n3' },
    ],
  }
  await interpretFlow(graph, 'go', { runAgent, runAction, stepLabels: { n2: 'Upsell Engine' } })
  assert.deepEqual(seenArgs[0], { text: 'the report body' })
})
