/**
 * requiredFields, finally consumed. The registry knows which node.data keys a
 * step needs; this turns that into a straight answer to "why can't this run?"
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { missingRequiredFields } from '../missing-fields'
import { NODE_BODIES } from '../registry'
import type { FlowNode } from '@/lib/flows/graph'

test('reports an empty required string field', () => {
  const node = { id: 't', type: 'tool', data: { connectionId: '', toolName: '' } } as FlowNode
  assert.deepEqual(missingRequiredFields(node).sort(), ['connectionId', 'toolName'])
})

test('reports nothing once required fields are filled', () => {
  const node = { id: 't', type: 'tool', data: { connectionId: 'c1', toolName: 'send' } } as FlowNode
  assert.deepEqual(missingRequiredFields(node), [])
})

test('treats a whitespace-only value as missing', () => {
  const node = { id: 's', type: 'subflow', data: { flowId: '   ' } } as FlowNode
  assert.deepEqual(missingRequiredFields(node), ['flowId'])
})

test('treats an empty array as missing', () => {
  // A transform with zero fields, a parallel with zero branches: present but
  // useless, which is the case a plain null-check misses.
  const node = { id: 'x', type: 'transform', data: { fields: [] } } as unknown as FlowNode
  assert.deepEqual(missingRequiredFields(node), ['fields'])
})

test('a node type with no required fields never reports anything', () => {
  const node = { id: 'p', type: 'stop', data: {} } as FlowNode
  assert.deepEqual(missingRequiredFields(node), [])
})

test('a filled array is not missing', () => {
  const node = { id: 'x', type: 'transform', data: { fields: [{ name: 'a', value: 'b' }] } } as unknown as FlowNode
  assert.deepEqual(missingRequiredFields(node), [])
})

test('a non-empty object value counts as present', () => {
  // The trigger's required key is an object, not a string or array — the
  // fall-through branch must treat it as present rather than missing.
  const node = { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } } as FlowNode
  assert.deepEqual(missingRequiredFields(node), [])
})

test('every node type can be checked without throwing', () => {
  // Totality: a new node type must not crash the params pane.
  for (const type of Object.keys(NODE_BODIES)) {
    const node = { id: 'n', type, data: {} } as unknown as FlowNode
    assert.ok(Array.isArray(missingRequiredFields(node)), `${type} threw or returned a non-array`)
  }
})

test('an unknown node type reports nothing rather than throwing', () => {
  // Defensive: a graph from a newer schema version must not break the editor.
  const node = { id: 'n', type: 'notARealType', data: {} } as unknown as FlowNode
  assert.deepEqual(missingRequiredFields(node), [])
})
