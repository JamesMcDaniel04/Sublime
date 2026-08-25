/**
 * The generic renderer for declared params.
 *
 * One component walks a ParamSpec[] and renders what `visibleParams` says
 * applies, so a new field is a manifest entry rather than another hand-written
 * branch in a 200-line body.
 */
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { ParamFields } from '../param-fields'
import type { ParamSpec } from '@/lib/flows/node-params'

afterEach(() => cleanup())

const SPECS: ParamSpec[] = [
  { key: 'separator', label: 'Join with', control: 'text', placeholder: 'comma', showWhen: { op: ['join'] } },
  { key: 'count', label: 'Items to keep', control: 'number', min: 1, max: 100, showWhen: { op: ['limit'] } },
  { key: 'mode', label: 'Mode', control: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
  { key: 'schema', label: 'Schema', control: 'textarea', help: 'Optional.', showWhen: { op: ['parseJson'] } },
]

function renderFields(data: Record<string, unknown>) {
  let patched: Record<string, unknown> | null = null
  const view = render(
    <ParamFields specs={SPECS} data={data} nodeId="n1" onPatch={(next: Record<string, unknown>) => { patched = next }} />,
  )
  return { ...view, patched: () => patched }
}

test('only the params that apply to the current values render', () => {
  const { container } = renderFields({ op: 'limit' })
  assert.ok(container.querySelector('[aria-label="Items to keep"]'))
  assert.equal(container.querySelector('[aria-label="Join with"]'), null)
})

test('an unconditional param always renders', () => {
  const { container } = renderFields({ op: 'limit' })
  assert.ok(container.querySelector('[aria-label="Mode"]'))
})

test('editing a text param patches its key', () => {
  const { container, patched } = renderFields({ op: 'join' })
  fireEvent.change(container.querySelector('[aria-label="Join with"]') as HTMLInputElement, { target: { value: ';' } })
  assert.deepEqual(patched(), { separator: ';' })
})

// Clearing back to undefined, not '': the schema treats these as optional and
// an empty string is a value the executor would honour.
test('clearing a text param removes the key rather than storing an empty string', () => {
  const { container, patched } = renderFields({ op: 'join', separator: ';' })
  fireEvent.change(container.querySelector('[aria-label="Join with"]') as HTMLInputElement, { target: { value: '' } })
  assert.deepEqual(patched(), { separator: undefined })
})

test('a number param patches a number, not a string', () => {
  const { container, patched } = renderFields({ op: 'limit' })
  fireEvent.change(container.querySelector('[aria-label="Items to keep"]') as HTMLInputElement, { target: { value: '25' } })
  assert.equal((patched() as { count: unknown }).count, 25)
})

// The spec's bounds mirror the executor's clamp; the control must not write a
// value the run would silently rewrite.
test('a number below the declared minimum is not written', () => {
  const { container, patched } = renderFields({ op: 'limit' })
  fireEvent.change(container.querySelector('[aria-label="Items to keep"]') as HTMLInputElement, { target: { value: '0' } })
  const written = (patched() as { count?: number })?.count
  assert.ok(written === undefined || written >= 1, `wrote ${written}`)
})

test('a select renders its declared options', () => {
  const { container } = renderFields({ op: 'limit' })
  const select = container.querySelector('[aria-label="Mode"]') as HTMLSelectElement
  assert.deepEqual(Array.from(select.options).map((o) => o.value), ['a', 'b'])
})

test('help text renders when declared', () => {
  const { container } = renderFields({ op: 'parseJson' })
  assert.match(container.textContent ?? '', /Optional\./)
})

test('nothing renders when no param applies', () => {
  const { container } = render(
    <ParamFields specs={[SPECS[0]]} data={{ op: 'limit' }} nodeId="n1" onPatch={() => {}} />,
  )
  assert.equal(container.querySelector('input'), null)
})
