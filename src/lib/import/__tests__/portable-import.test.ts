import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '@/lib/flows/graph'
import { toPortableFlow } from '@/lib/export/portable'
import { fromDownloadedFlow, fromPortableFlow } from '../portable'
import { FlowImportError } from '../types'

const graph: FlowGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
    { id: 'ask', type: 'agent', data: { agentId: 'agent-1', input: 'hi' } },
  ],
  edges: [{ id: 'e1', source: 'trigger', target: 'ask' }],
}

test('round-trips a toPortableFlow export', () => {
  const doc = toPortableFlow(
    { name: 'Weekly recap', description: 'd', trigger: { type: 'manual' }, graph },
    [{ id: 'agent-1', title: 'Recapper', instructions: 'Write recaps', integrations: ['slack'] }],
    '2026-08-05T00:00:00.000Z',
  )
  const imported = fromPortableFlow(JSON.parse(JSON.stringify(doc)))
  assert.equal(imported.source, 'sublime-portable')
  assert.equal(imported.name, 'Weekly recap')
  assert.equal(imported.graph.nodes.length, 2)
  assert.equal(imported.agentsToCreate.length, 1)
  assert.equal(imported.agentsToCreate[0].ref, 'agent-1')
  // requirements travel as warnings so the UI can show them
  assert.ok(imported.warnings.length >= 1)
})

test('never imports credentials or webhook secrets', () => {
  const doc = {
    format: 'sublime.flow', version: 1, exportedAt: 'x',
    containsCredentials: true,
    credentials: { triggerSecret: 'LIVE' },
    flow: {
      name: 'hooked', description: '',
      trigger: { type: 'webhook', webhookSecretHash: 'h', webhookSecretEnc: 'enc' },
      graph: { nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'webhook', webhookSecretHash: 'h' } } }], edges: [] },
    },
    agents: [], requirements: [],
  }
  const imported = fromPortableFlow(doc)
  const trigger = imported.trigger as Record<string, unknown>
  assert.equal(trigger.webhookSecretHash, undefined)
  assert.equal(trigger.webhookSecretEnc, undefined)
  assert.equal(JSON.stringify(imported).includes('LIVE'), false)
})

test('rejects a portable doc whose graph fails the schema', () => {
  const doc = {
    format: 'sublime.flow', version: 1, exportedAt: 'x',
    flow: { name: 'bad', description: '', trigger: { type: 'manual' }, graph: { nodes: [{ id: 'x', type: 'nope', data: {} }], edges: [] } },
    agents: [], requirements: [],
  }
  assert.throws(() => fromPortableFlow(doc), (error: unknown) =>
    error instanceof FlowImportError && error.code === 'INVALID_GRAPH')
})

test('imports the builder bare download shape', () => {
  const imported = fromDownloadedFlow({ name: 'Plain', description: 'x', version: 4, graph, exportedAt: 'x' })
  assert.equal(imported.source, 'sublime-download')
  assert.equal(imported.name, 'Plain')
  assert.equal(imported.trigger.type, 'manual')
  assert.equal(imported.agentsToCreate.length, 0)
})

test('bare download without a name gets a fallback', () => {
  const imported = fromDownloadedFlow({ graph })
  assert.equal(imported.name, 'Imported flow')
})
