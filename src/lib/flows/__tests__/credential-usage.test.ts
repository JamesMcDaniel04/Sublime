/**
 * The credentials tab on the Flows page is only trustworthy if the collector
 * reports exactly what execution would use. These tests pin the collector to
 * the executor's semantics (execute-flow.ts http auth-mode selection and the
 * tool plane id scheme): a ref the executor would ignore must not appear, and
 * a ref it would use must never be dropped.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectFlowCredentialRefs } from '@/lib/flows/credential-usage'

const flow = (id: string, nodes: unknown[], moreGraphs: unknown[][] = []) => ({
  id,
  name: `Flow ${id}`,
  graphs: [{ nodes, edges: [] }, ...moreGraphs.map((extra) => ({ nodes: extra, edges: [] }))],
})

const toolNode = (connectionId: string) => ({ id: `t-${connectionId}`, type: 'tool', data: { connectionId, toolName: 'x' } })

test('tool nodes report their connection across planes; subflow and template refs are not credentials', () => {
  const refs = collectFlowCredentialRefs([
    flow('f1', [
      toolNode('cmabc123mcprow'),
      toolNode('nango:gmail'),
      toolNode('native:granola'),
      toolNode('postgres:pg1'),
      toolNode('flow:other-flow'),
      toolNode('template:Linear MCP'),
    ]),
  ])
  assert.deepEqual(
    [...refs.connections.keys()].sort(),
    ['cmabc123mcprow', 'nango:gmail', 'native:granola', 'postgres:pg1'],
  )
  assert.equal(refs.credentials.size, 0)
})

test('http generic auth reports the vault credential, not the connection', () => {
  const refs = collectFlowCredentialRefs([
    flow('f1', [
      { id: 'h1', type: 'http', data: { url: 'https://api.example.com', authMode: 'generic', credentialId: 'cred1', connectionId: 'nango:slack' } },
    ]),
  ])
  assert.deepEqual([...refs.credentials.keys()], ['cred1'])
  assert.equal(refs.connections.size, 0)
})

test('http predefined auth reports the connection', () => {
  const refs = collectFlowCredentialRefs([
    flow('f1', [
      { id: 'h1', type: 'http', data: { url: 'https://api.example.com', authMode: 'predefined', connectionId: 'nango:salesforce' } },
    ]),
  ])
  assert.deepEqual([...refs.connections.keys()], ['nango:salesforce'])
  assert.equal(refs.credentials.size, 0)
})

test('http authMode none reports nothing even when ids linger in the node', () => {
  const refs = collectFlowCredentialRefs([
    flow('f1', [
      { id: 'h1', type: 'http', data: { url: 'https://api.example.com', authMode: 'none', credentialId: 'cred1', connectionId: 'nango:slack' } },
    ]),
  ])
  assert.equal(refs.connections.size, 0)
  assert.equal(refs.credentials.size, 0)
})

test('pre-vault http nodes without authMode infer from whichever field is populated', () => {
  // connectionId wins when both are set and no mode is stored — the executor's
  // exact tie-break (useGeneric requires connectionId to be empty).
  const refs = collectFlowCredentialRefs([
    flow('f1', [
      { id: 'h1', type: 'http', data: { url: 'https://a.example.com', credentialId: 'cred1' } },
      { id: 'h2', type: 'http', data: { url: 'https://b.example.com', connectionId: 'nango:gmail' } },
      { id: 'h3', type: 'http', data: { url: 'https://c.example.com', credentialId: 'cred2', connectionId: 'nango:gmail' } },
    ]),
  ])
  assert.deepEqual([...refs.credentials.keys()], ['cred1'])
  assert.deepEqual([...refs.connections.keys()], ['nango:gmail'])
})

test('one ref used by several flows lists each flow once, even across draft and published graphs', () => {
  const refs = collectFlowCredentialRefs([
    // Same connection in the draft AND published graph of f1 — one usage entry.
    flow('f1', [toolNode('nango:gmail')], [[toolNode('nango:gmail')]]),
    flow('f2', [toolNode('nango:gmail')]),
  ])
  const flows = refs.connections.get('nango:gmail')
  assert.deepEqual(flows?.map((entry) => entry.id), ['f1', 'f2'])
})

test('malformed graphs and empty ids are skipped without throwing', () => {
  const refs = collectFlowCredentialRefs([
    { id: 'f1', name: 'Broken', graphs: [null, 'not a graph', { nodes: 'nope' }, { nodes: [{ type: 'tool', data: { connectionId: '  ' } }, { type: 'http' }, null] }] },
  ])
  assert.equal(refs.connections.size, 0)
  assert.equal(refs.credentials.size, 0)
})
