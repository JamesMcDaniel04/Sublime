/**
 * The NDV must MOUNT for every node type shape we throw at it. Typecheck can't
 * catch a body that crashes on absent optional data, and a config surface that
 * throws is worse than a rough one — it strands the user with no way to edit
 * the step.
 */
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup } from '@testing-library/react'
import { NodeDetailView } from '../node-detail-view'
import type { FlowNode } from '@/lib/flows/graph'

afterEach(() => cleanup())

const NODES = [
  { id: 'n1', type: 'http', data: { method: 'GET', url: 'https://api/x' } },
  { id: 'n2', type: 'tool', data: { connectionId: '', toolName: '' } },
  { id: 'n3', type: 'condition', data: { clauses: [] } },
  { id: 'n4', type: 'stop', data: {} },
] as FlowNode[]

const baseProps = {
  agents: [],
  toolCatalog: [],
  dataFields: [],
  lastOutput: undefined,
  onChange: () => {},
  onClose: () => {},
}

for (const node of NODES) {
  test(`mounts for a ${node.type} node`, () => {
    const { container, getByText } = render(<NodeDetailView node={node} {...baseProps} />)
    assert.ok(container.firstChild, 'rendered nothing')
    getByText('Parameters')
  })
}

test('closes on Escape', () => {
  let closed = false
  render(<NodeDetailView node={NODES[3]} {...baseProps} onClose={() => { closed = true }} />)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  assert.equal(closed, true)
})
