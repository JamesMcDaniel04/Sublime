/**
 * The raw JSON pane is the ONLY way to map upstream data now that the field
 * tree is gone. If a path is computed wrong the user writes a token that
 * silently resolves to nothing at run time, so paths are asserted exactly.
 */
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { JsonTokenView } from '../json-token-view'

afterEach(() => cleanup())

const VALUE = {
  trigger: { email: 'a@b.co', count: 2 },
  previousNodes: { http_1: { items: [{ id: 'x1' }], ok: true } },
}

const tokenOf = (container: HTMLElement, path: string) =>
  container.querySelector(`[data-token="{{${path}}}"]`) as HTMLElement | null

test('a nested leaf click emits its full dotted path', () => {
  let inserted: string | null = null
  const { container } = render(<JsonTokenView value={VALUE} onInsertToken={(t) => { inserted = t }} />)
  const leaf = tokenOf(container, 'trigger.email')
  assert.ok(leaf, 'trigger.email is not clickable')
  fireEvent.click(leaf)
  assert.equal(inserted, '{{trigger.email}}')
})

test('array members are addressed by index', () => {
  let inserted: string | null = null
  const { container } = render(<JsonTokenView value={VALUE} onInsertToken={(t) => { inserted = t }} />)
  const leaf = tokenOf(container, 'previousNodes.http_1.items.0.id')
  assert.ok(leaf, 'array member path is wrong')
  fireEvent.click(leaf)
  assert.equal(inserted, '{{previousNodes.http_1.items.0.id}}')
})

test('a container key is itself insertable — whole objects are mappable', () => {
  let inserted: string | null = null
  const { container } = render(<JsonTokenView value={VALUE} onInsertToken={(t) => { inserted = t }} />)
  const key = tokenOf(container, 'previousNodes.http_1')
  assert.ok(key, 'object key is not clickable')
  fireEvent.click(key)
  assert.equal(inserted, '{{previousNodes.http_1}}')
})

test('a leaf drags its braced token as text/plain', () => {
  const { container } = render(<JsonTokenView value={VALUE} onInsertToken={() => {}} />)
  const leaf = tokenOf(container, 'trigger.count')!
  assert.equal(leaf.getAttribute('draggable'), 'true')
  let dragged: string | null = null
  fireEvent.dragStart(leaf, {
    dataTransfer: { setData: (_type: string, value: string) => { dragged = value }, effectAllowed: '' },
  })
  assert.equal(dragged, '{{trigger.count}}')
})

test('booleans, numbers and null all render and are clickable', () => {
  const { container } = render(<JsonTokenView value={{ a: null, b: false, c: 0 }} onInsertToken={() => {}} />)
  for (const path of ['a', 'b', 'c']) assert.ok(tokenOf(container, path), `${path} is not clickable`)
})

test('an empty object renders without crashing', () => {
  const { container } = render(<JsonTokenView value={{}} onInsertToken={() => {}} />)
  assert.ok(container.firstChild)
})
