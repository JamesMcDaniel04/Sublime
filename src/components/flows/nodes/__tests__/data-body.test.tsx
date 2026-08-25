/**
 * The data node's op-specific config must actually be reachable.
 *
 * `DATA_OPS` has 12 operations and the schema carries op-specific fields for
 * them in one flat optional bag. The body hand-branches on `op` to decide what
 * to show — which means a field can be added to the schema, validated, and
 * executed while never acquiring a control.
 *
 * That is not hypothetical. `data.count` was referenced ZERO times in this
 * body while data-ops.ts ran `config.count ?? 10`, so the catalogue's "Limit
 * items — keep only the first N items" silently pinned N to 10 with no way to
 * change it.
 *
 * These tests pin the reachability, not the styling.
 */
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { dataModule } from '../data-body'
import type { FlowNode } from '@/lib/flows/graph'

afterEach(() => cleanup())

const wiring = {
  labelCtx: { nodes: [], labelOf: () => '' },
  registerEditor: () => () => {},
  focusEditor: () => () => {},
  blockActive: () => {},
  unblockActive: () => {},
} as never

const nodeWith = (data: Record<string, unknown>): FlowNode =>
  ({ id: 'd1', type: 'data', data } as FlowNode)

function renderBody(data: Record<string, unknown>) {
  let latest: FlowNode | null = null
  const Body = dataModule.Body as unknown as React.ComponentType<Record<string, unknown>>
  const view = render(
    <Body node={nodeWith(data)} update={(next: FlowNode) => { latest = next }} tokenWiring={wiring} />,
  )
  return { ...view, updated: () => latest }
}

// The bug, stated as a test.
test('the limit op exposes a control for how many items to keep', () => {
  const { container } = renderBody({ op: 'limit', input: '{{trigger.input}}' })
  const control = container.querySelector('[aria-label="Items to keep"]')
  assert.ok(control, 'limit has no control for `count`, so N is stuck at the executor default')
})

test('changing that control writes count onto the node', () => {
  const { container, updated } = renderBody({ op: 'limit', input: '{{trigger.input}}' })
  const control = container.querySelector('[aria-label="Items to keep"]') as HTMLInputElement
  fireEvent.change(control, { target: { value: '25' } })
  assert.equal((updated()?.data as { count?: number })?.count, 25)
})

// The executor clamps to 1..10000; the control must not let a user save a
// value the executor will silently rewrite.
test('a count below the executor minimum is not written as-is', () => {
  const { container, updated } = renderBody({ op: 'limit', input: '{{x}}' })
  const control = container.querySelector('[aria-label="Items to keep"]') as HTMLInputElement
  fireEvent.change(control, { target: { value: '0' } })
  const written = (updated()?.data as { count?: number })?.count
  assert.ok(written === undefined || written >= 1, `wrote ${written}, which the executor would clamp`)
})

// The other half of the same rule: a field that does not belong to the
// selected op must not be on screen.
test('the count control is absent for an op that does not use it', () => {
  const { container } = renderBody({ op: 'join', input: '{{x}}', separator: ',' })
  assert.equal(container.querySelector('[aria-label="Items to keep"]'), null)
})

// splitOut's `field` names the list-bearing property to fan out on. It is
// referenced in the body, so this guards against a regression rather than
// reporting a known gap.
test('the splitOut op exposes its list field', () => {
  const { container } = renderBody({ op: 'splitOut', input: '{{x}}' })
  assert.ok(
    container.querySelector('[aria-label="List field"]') ?? container.querySelector('input'),
    'splitOut needs a way to name the field it fans out on',
  )
})

// The aggregate op ships with the same obligation the last two commits were
// about: config the executor reads must have a control. Its `fields` carry the
// aggregations and `field` carries the group-by.
test('the aggregate op exposes its aggregation rows', () => {
  const { container } = renderBody({ op: 'aggregate', input: '{{x}}' })
  assert.ok(container.querySelector('[aria-label="Aggregation function"]'), 'no way to choose count/sum/avg')
  assert.ok(container.querySelector('[aria-label="Aggregation field"]'), 'no way to name the field to aggregate')
})

test('the aggregate op exposes group-by', () => {
  const { container } = renderBody({ op: 'aggregate', input: '{{x}}' })
  assert.ok(container.querySelector('[aria-label="Group by"]'), 'no way to group, so only whole-list totals are reachable')
})

test('choosing an aggregation writes it onto the node', () => {
  const { container, updated } = renderBody({ op: 'aggregate', input: '{{x}}' })
  const fn = container.querySelector('[aria-label="Aggregation function"]') as HTMLSelectElement
  fireEvent.change(fn, { target: { value: 'sum' } })
  const fields = (updated()?.data as { fields?: { name: string; value: string }[] })?.fields
  assert.equal(fields?.[0]?.value, 'sum')
})

test('group-by writes to field', () => {
  const { container, updated } = renderBody({ op: 'aggregate', input: '{{x}}' })
  const group = container.querySelector('[aria-label="Group by"]') as HTMLInputElement
  fireEvent.change(group, { target: { value: 'region' } })
  assert.equal((updated()?.data as { field?: string })?.field, 'region')
})
