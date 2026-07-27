/**
 * The HTTP step's Options panel and Send Body toggle, driven through the same
 * real controlled loop the other node tests use.
 *
 * These cover the two parity gaps that were invisible from unit tests: the
 * retired Advanced-parameters panel (which fought Body Content Type over
 * `bodyMode`) and the Send Body toggle being unusable on GET.
 */
import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React, { useState } from 'react'
import { render, act, cleanup, fireEvent } from '@testing-library/react'
import { NodeDetailView } from '../ndv/node-detail-view'
import { updateNode } from '@/lib/flows/mutate'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'

const httpNode = (data: Record<string, unknown> = {}): FlowNode =>
  ({ id: 'h1', type: 'http', data: { method: 'POST', url: 'https://api.example.com/x', ...data } }) as FlowNode

function Harness({ initial, capture }: { initial?: Record<string, unknown>; capture: (n: FlowNode) => void }) {
  const [graph, setGraph] = useState<FlowGraph>({ nodes: [httpNode(initial)], edges: [] } as FlowGraph)
  const node = graph.nodes.find((n) => n.id === 'h1') as FlowNode
  capture(node)
  return React.createElement(NodeDetailView, {
    node, agents: [], toolCatalog: [], lastOutput: undefined,
    onChange: (n: FlowNode) => setGraph((g) => updateNode(g, n)), onClose: () => {},
  })
}

const dataOf = (node: FlowNode | null) => (node as unknown as { data: Record<string, unknown> }).data

/** Options moved to the Settings tab — Parameters holds only what the step does. */
function openSettings(container: HTMLElement) {
  const tab = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Settings')
  act(() => { fireEvent.click(tab as HTMLElement) })
}

test('the retired Advanced parameters panel is gone from the http step', (t) => {
  t.after(cleanup)
  const { container } = render(React.createElement(Harness, { capture: () => {} }))
  assert.equal(container.textContent?.includes('Advanced parameters'), false)
  openSettings(container)
  assert.equal(container.textContent?.includes('Advanced parameters'), false)
  assert.ok(container.querySelector('[aria-label="Add option"]'), 'the n8n Options picker renders instead')
})

test('no second control can overwrite the chosen Body Content Type', (t) => {
  t.after(cleanup)
  const { container } = render(React.createElement(Harness, {
    initial: { sendBody: true, bodyMode: 'graphql', body: '{ me { id } }' },
    capture: () => {},
  }))
  const selects = [...container.querySelectorAll('select')]

  // Only one control names itself as the body-type owner, and it reflects the
  // stored value rather than rendering blank.
  const labelled = selects.filter((select) => /body content type/i.test(select.getAttribute('aria-label') ?? ''))
  assert.equal(labelled.length, 1)
  assert.equal((labelled[0] as HTMLSelectElement).value, 'graphql')

  // And no OTHER select is shaped like a body-type picker. The retired panel's
  // was json/text/none; Authentication (none/predefined/generic) and Specify
  // Body (json/fields) each share only one of those values, so requiring both
  // `json` AND a `text`/`none` sibling identifies a real duplicate without
  // flagging them.
  const strays = selects
    .filter((select) => select !== labelled[0])
    .map((select) => [...select.querySelectorAll('option')].map((option) => option.value))
    .filter((values) => values.includes('json') && (values.includes('text') || values.includes('none')))
  assert.deepEqual(strays, [], 'a second bodyMode control would silently rewrite the GraphQL body')
})

test('adding pagination from Options writes a usable default', (t) => {
  t.after(cleanup)
  let latest: FlowNode | null = null
  const { container } = render(React.createElement(Harness, { capture: (n) => { latest = n } }))
  openSettings(container)
  const add = container.querySelector('[aria-label="Add option"]') as HTMLSelectElement
  act(() => { fireEvent.change(add, { target: { value: 'pagination' } }) })

  assert.deepEqual(dataOf(latest).pagination, { mode: 'page', pageParam: 'page', startPage: 1, maxPages: 10 })
  assert.ok(container.querySelector('[aria-label="Pagination mode"]'), 'the pagination controls render once added')
})

test('cookie, batching, and retry status codes are reachable from Options', (t) => {
  t.after(cleanup)
  const { container } = render(React.createElement(Harness, { capture: () => {} }))
  openSettings(container)
  const add = container.querySelector('[aria-label="Add option"]') as HTMLSelectElement
  const offered = [...add.querySelectorAll('option')].map((option) => option.value)
  for (const key of ['cookie', 'batch', 'retryStatusCodes', 'pagination']) {
    assert.ok(offered.includes(key), `${key} should be offered`)
  }
  // bodyMode must NOT be here — Body Content Type owns it.
  assert.equal(offered.includes('bodyMode'), false)
})

test('removing an option clears it rather than leaving a default behind', (t) => {
  t.after(cleanup)
  let latest: FlowNode | null = null
  const { container } = render(React.createElement(Harness, { initial: { cookie: 'a=b' }, capture: (n) => { latest = n } }))
  openSettings(container)
  act(() => { fireEvent.click(container.querySelector('[aria-label="Remove Cookie"]') as HTMLElement) })
  assert.equal(dataOf(latest).cookie, undefined)
})

test('Send Body is operable on GET and warns that nothing will be sent', (t) => {
  t.after(cleanup)
  let latest: FlowNode | null = null
  const { container } = render(React.createElement(Harness, {
    initial: { method: 'GET' },
    capture: (n) => { latest = n },
  }))
  const toggle = container.querySelector('[aria-label="Send Body"]') as HTMLElement
  assert.ok(toggle, 'the toggle renders on GET')
  assert.equal(toggle.getAttribute('disabled'), null, 'and is not disabled')

  act(() => { fireEvent.click(toggle) })
  assert.equal(dataOf(latest).sendBody, true)
  assert.match(container.textContent ?? '', /GET requests cannot carry a body/)
})

test('a body configured on POST survives a switch to GET', (t) => {
  t.after(cleanup)
  let latest: FlowNode | null = null
  const { container } = render(React.createElement(Harness, {
    initial: { sendBody: true, bodyMode: 'json', body: '{"a":1}' },
    capture: (n) => { latest = n },
  }))
  act(() => { fireEvent.change(container.querySelector('[aria-label="Method"]') as HTMLSelectElement, { target: { value: 'GET' } }) })
  assert.equal(dataOf(latest).body, '{"a":1}', 'the body is kept, not silently discarded')
  assert.match(container.textContent ?? '', /cannot carry a body/)
})
