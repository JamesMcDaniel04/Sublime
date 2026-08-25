/**
 * Turning a flow into a reusable template payload, and back.
 *
 * Two things must hold, and both are the kind that fail silently:
 *
 *  1. NO CREDENTIALS. A template is read by other people in the workspace and,
 *     if published, by other workspaces. It is an export in every meaningful
 *     sense, so it goes through the export sanitizer rather than a second one
 *     that could drift from it.
 *  2. NO DANGLING AGENT REFERENCES. A raw graph carries `agentId` row ids from
 *     the SAVING workspace. Stored as-is they are meaningless anywhere else and
 *     dangle the moment the agent is deleted — the template would produce a
 *     flow whose agent steps point at nothing. The portable form inlines the
 *     agents instead.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowTemplatePayload, flowTemplateGraph } from '../flow-template'
import type { FlowGraph } from '@/lib/flows/graph'

const AGENT_ID = 'agent-row-id-in-this-workspace'

const graph = {
  nodes: [
    { id: 'n1', type: 'trigger', position: { x: 0, y: 0 }, data: { triggerType: 'manual' } },
    {
      id: 'n2',
      type: 'http',
      position: { x: 0, y: 100 },
      data: {
        url: 'https://api.example.com/things?api_key=SUPER-SECRET-QUERY',
        method: 'GET',
        // A STRING, not an array — graph.ts declares `headers: z.string()`,
        // and 'fields' mode is a UI affordance over the same JSON. An array
        // fixture here would be silently dropped by graph validation and the
        // credential assertions would pass without exercising anything.
        headers: '{"Authorization":"Bearer SUPER-SECRET-TOKEN"}',
        credentialId: 'vault-credential-row-id',
      },
    },
    { id: 'n3', type: 'agent', position: { x: 0, y: 200 }, data: { agentId: AGENT_ID } },
    { id: 'n4', type: 'tool', position: { x: 0, y: 300 }, data: { connectionId: 'nango:slack', toolName: 'post_message' } },
  ],
  edges: [
    { id: 'e1', source: 'n1', target: 'n2' },
    { id: 'e2', source: 'n2', target: 'n3' },
    { id: 'e3', source: 'n3', target: 'n4' },
  ],
} as unknown as FlowGraph

const flow = {
  name: 'Revenue digest',
  description: 'Posts a digest',
  trigger: { type: 'signal', webhookSecretHash: 'HASHED-WEBHOOK-SECRET' },
  graph,
}

const agents = [{ id: AGENT_ID, title: 'Summarizer', instructions: 'Summarize the payload.', model: 'claude-sonnet-5' }]

const serialized = () => JSON.stringify(flowTemplatePayload(flow, agents, '2026-08-24T00:00:00.000Z'))

test('the stored payload carries no bearer token', () => {
  assert.doesNotMatch(serialized(), /SUPER-SECRET-TOKEN/)
})

test('the stored payload carries no credential-shaped query value', () => {
  assert.doesNotMatch(serialized(), /SUPER-SECRET-QUERY/)
})

test('the stored payload carries no vault credential id', () => {
  assert.doesNotMatch(serialized(), /vault-credential-row-id/)
})

// A webhook secret hash is still a secret: it is the verifier for that trigger.
test('the stored payload carries no webhook secret hash', () => {
  assert.doesNotMatch(serialized(), /HASHED-WEBHOOK-SECRET/)
})

// The reason this stores a portable doc rather than a graph.
test('the referenced agent is inlined, not left as a row id', () => {
  const payload = flowTemplatePayload(flow, agents, '2026-08-24T00:00:00.000Z')
  assert.equal(payload.agents.length, 1)
  assert.equal(payload.agents[0].instructions, 'Summarize the payload.')
})

// The restored form must carry everything the caller needs to REMAP the agent
// ref to a row in the importing workspace. The ref itself stays as-is (it is
// an opaque id, not a credential); what matters is that the agent it points to
// travels with it, so materialization has something to create.
test('the restored form carries the agents needed to remap every agent step', () => {
  const restored = flowTemplateGraph(flowTemplatePayload(flow, agents, '2026-08-24T00:00:00.000Z'))
  const agentNode = restored!.graph.nodes.find((node) => node.type === 'agent')
  const ref = (agentNode?.data as { agentId?: string })?.agentId
  assert.ok(ref, 'the agent step kept a ref to remap')
  assert.ok(
    restored!.agentsToCreate.some((agent) => (agent as { ref?: string }).ref === ref),
    'every agent ref in the graph has a matching inlined agent',
  )
})

// Portable plane ids are the whole point: they resolve to the IMPORTING
// workspace's own connection at provision time.
test('a portable nango connection id survives, because it re-resolves per workspace', () => {
  assert.match(serialized(), /nango:slack/)
})

test('the step topology survives the round trip', () => {
  const restored = flowTemplateGraph(flowTemplatePayload(flow, agents, '2026-08-24T00:00:00.000Z'))
  assert.equal(restored!.graph.nodes.length, 4)
  assert.equal(restored!.graph.edges.length, 3)
})

test('a payload that is not a portable document is rejected rather than half-imported', () => {
  assert.equal(flowTemplateGraph({ nope: true }), null)
  assert.equal(flowTemplateGraph(null), null)
})
