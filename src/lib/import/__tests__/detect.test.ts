import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectFlowImportFormat } from '../detect'

test('detects a sublime.flow portable document', () => {
  assert.equal(detectFlowImportFormat({ format: 'sublime.flow', version: 1, flow: {} }), 'sublime-portable')
})

test('detects a sublime.agent document (so the route can give a targeted error)', () => {
  assert.equal(detectFlowImportFormat({ format: 'sublime.agent', version: 1 }), 'sublime-agent')
})

test('detects an n8n workflow by nodes + connections', () => {
  assert.equal(detectFlowImportFormat({ name: 'wf', nodes: [], connections: {} }), 'n8n')
})

test('detects the builder bare download by a top-level graph', () => {
  assert.equal(
    detectFlowImportFormat({ name: 'My flow', version: 3, graph: { nodes: [], edges: [] } }),
    'sublime-download',
  )
})

test('n8n wins over download when both keys exist (n8n has no top-level graph)', () => {
  assert.equal(detectFlowImportFormat({ nodes: [], connections: {}, graph: { nodes: [], edges: [] } }), 'n8n')
})

test('rejects junk', () => {
  assert.equal(detectFlowImportFormat(null), null)
  assert.equal(detectFlowImportFormat('[]'), null)
  assert.equal(detectFlowImportFormat({ hello: 'world' }), null)
  assert.equal(detectFlowImportFormat({ graph: { nodes: 'no' } }), null)
})
