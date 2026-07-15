import assert from 'node:assert/strict'
import test from 'node:test'
import { serializeFlow } from '../serialize'

const base = {
  id: 'flow-1',
  name: 'Primary flow',
  description: '',
  status: 'ACTIVE',
  trigger: { type: 'manual' },
  graph: { nodes: [], edges: [] },
  publishedGraph: { nodes: [], edges: [] },
  version: 2,
  visibility: 'private',
  createdAt: new Date('2026-07-15T00:00:00Z'),
  updatedAt: new Date('2026-07-15T00:00:00Z'),
}

test('serializes the configured error handler and clean publish state', () => {
  const flow = serializeFlow({ ...base, metadata: { errorFlowId: 'handler-1' } })
  assert.equal(flow.errorFlowId, 'handler-1')
  assert.equal(flow.unpublishedChanges, false)
})

test('marks a changed draft as unpublished and ignores malformed handler metadata', () => {
  const flow = serializeFlow({ ...base, graph: { nodes: [{ id: 'trigger', type: 'trigger', data: {} }], edges: [] }, metadata: { errorFlowId: 42 } })
  assert.equal(flow.errorFlowId, null)
  assert.equal(flow.unpublishedChanges, true)
})
