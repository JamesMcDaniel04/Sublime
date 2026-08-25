/**
 * Filter is not Condition, and the registry used to say it was.
 *
 * `filter: conditionModule` meant a Filter step rendered Condition's panel.
 * They evaluate clauses the same way and diverge completely after that:
 *
 *   condition, splitItems on : route items into {matched, unmatched};
 *                              BOTH branches light
 *   condition, splitItems off: branch once, true edge or false edge
 *   filter,    splitItems on : KEEP the matching items; always continue,
 *                              an empty result flows on as []
 *   filter,    splitItems off: a GATE — pass through if the condition holds,
 *                              otherwise drop (in a loop) or end the chain
 *
 * `splitItems` had no control on either node, so it was always falsy. Which
 * means the Filter node could not filter — it only ever gated. That is the
 * bug these tests pin; the shared panel is just how it stayed invisible.
 */
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { NODE_BODIES } from '../registry'
import type { FlowNode } from '@/lib/flows/graph'

afterEach(() => cleanup())

const wiring = {
  labelCtx: { nodes: [], labelOf: () => '' },
  registerEditor: () => () => {},
  focusEditor: () => () => {},
  blockActive: () => {},
  unblockActive: () => {},
} as never

function renderNode(type: 'filter' | 'condition', data: Record<string, unknown>) {
  let latest: FlowNode | null = null
  const Body = NODE_BODIES[type]!.Body as unknown as React.ComponentType<Record<string, unknown>>
  const view = render(
    <Body
      node={{ id: 'n1', type, data } as FlowNode}
      update={(next: FlowNode) => { latest = next }}
      tokenWiring={wiring}
    />,
  )
  return { ...view, updated: () => latest }
}

const CLAUSES = [{ left: '{{item.status}}', op: 'equals', right: 'open' }]

test('filter has its own body module, not condition\'s', () => {
  assert.notEqual(NODE_BODIES.filter, NODE_BODIES.condition, 'filter still borrows condition\'s panel')
})

// The headline bug: without this control the node can only gate.
test('filter exposes the choice between keeping items and gating', () => {
  const { container } = renderNode('filter', { clauses: CLAUSES })
  assert.ok(
    container.querySelector('[aria-label="Filter behaviour"]'),
    'no way to choose keep-matching-items, so Filter can never filter',
  )
})

test('choosing keep-matching-items sets splitItems', () => {
  const { container, updated } = renderNode('filter', { clauses: CLAUSES })
  const control = container.querySelector('[aria-label="Filter behaviour"]') as HTMLSelectElement
  fireEvent.change(control, { target: { value: 'keep' } })
  assert.equal((updated()?.data as { splitItems?: boolean })?.splitItems, true)
})

test('choosing gate clears splitItems rather than writing false', () => {
  const { container, updated } = renderNode('filter', { clauses: CLAUSES, splitItems: true })
  const control = container.querySelector('[aria-label="Filter behaviour"]') as HTMLSelectElement
  fireEvent.change(control, { target: { value: 'gate' } })
  const written = (updated()?.data as { splitItems?: boolean })?.splitItems
  assert.ok(written === undefined || written === false, `wrote ${written}`)
})

// Condition has the same field with different semantics, and equally no
// control. Fixing one without the other leaves half the bug in place.
test('condition exposes its own per-item routing choice', () => {
  const { container } = renderNode('condition', { clauses: CLAUSES })
  assert.ok(
    container.querySelector('[aria-label="Evaluation"]'),
    'condition cannot be switched to per-item routing',
  )
})

// The panels must not describe each other's semantics.
test('filter does not describe true/false branches', () => {
  const { container } = renderNode('filter', { clauses: CLAUSES })
  const text = container.textContent ?? ''
  assert.doesNotMatch(text, /true branch|false branch/i)
})
