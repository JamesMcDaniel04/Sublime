/**
 * The HTTP step card's cURL import and generic-auth controls, driven through
 * the same real controlled loop as the URL editor tests.
 */
import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React, { useState } from 'react'
import { render, act, cleanup, fireEvent } from '@testing-library/react'
import { NodeDetailView } from '../ndv/node-detail-view'
import { updateNode } from '@/lib/flows/mutate'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'

const httpNode = (): FlowNode => ({ id: 'h1', type: 'http', data: { method: 'POST', url: '', bodyMode: 'json', body: '' } }) as FlowNode

function CardHarness({ capture }: { capture: (n: FlowNode) => void }) {
  const [graph, setGraph] = useState<FlowGraph>({ nodes: [httpNode()], edges: [] } as FlowGraph)
  const node = graph.nodes.find((n) => n.id === 'h1') as FlowNode
  capture(node)
  // The param body moved from the card into the Node Detail View — same body
  // module, new host. The harness drives the same real controlled loop.
  return React.createElement(NodeDetailView, {
    node, agents: [], toolCatalog: [], dataFields: [], lastOutput: undefined,
    onChange: (n: FlowNode) => setGraph((g) => updateNode(g, n)), onClose: () => {},
  })
}

test('importing a cURL command fills the http step config', () => {
  let latest: FlowNode | null = null
  const { container } = render(React.createElement(CardHarness, { capture: (n) => { latest = n } }))
  const toggle = container.querySelector('[aria-label="Import cURL"]') as HTMLElement
  assert.ok(toggle, 'Import cURL button renders')
  act(() => { fireEvent.click(toggle) })
  const textarea = container.querySelector('[aria-label="cURL command"]') as HTMLTextAreaElement
  assert.ok(textarea, 'cURL textarea renders')
  act(() => {
    fireEvent.change(textarea, { target: { value: "curl -X PUT 'https://api.example.com/x' -H 'X-K: v' --data '{\"a\":1}'" } })
  })
  act(() => { fireEvent.click(container.querySelector('[aria-label="Apply cURL import"]') as HTMLElement) })
  const data = (latest as unknown as { data: Record<string, unknown> }).data
  assert.equal(data.method, 'PUT')
  assert.equal(data.url, 'https://api.example.com/x')
  assert.equal(data.body, '{"a":1}')
  assert.equal(data.bodyMode, 'json')
  assert.deepEqual(JSON.parse(String(data.headers)), { 'X-K': 'v' })
  cleanup()
})

test('an invalid cURL command shows an error and leaves the node unchanged', () => {
  let latest: FlowNode | null = null
  const { container } = render(React.createElement(CardHarness, { capture: (n) => { latest = n } }))
  act(() => { fireEvent.click(container.querySelector('[aria-label="Import cURL"]') as HTMLElement) })
  act(() => {
    fireEvent.change(container.querySelector('[aria-label="cURL command"]') as HTMLTextAreaElement, { target: { value: 'wget https://x.com' } })
  })
  act(() => { fireEvent.click(container.querySelector('[aria-label="Apply cURL import"]') as HTMLElement) })
  assert.match(container.textContent ?? '', /starts with `?curl`?/i)
  assert.equal((latest as unknown as { data: { url: string } }).data.url, '')
  cleanup()
})

test('choosing a generic auth type stores it on the node and switching to none clears it', () => {
  let latest: FlowNode | null = null
  const { container } = render(React.createElement(CardHarness, { capture: (n) => { latest = n } }))
  const select = container.querySelector('[aria-label="Generic auth type"]') as HTMLSelectElement
  assert.ok(select, 'generic auth select renders')
  act(() => { fireEvent.change(select, { target: { value: 'basic' } }) })
  let data = (latest as unknown as { data: { auth?: { type?: string } } }).data
  assert.equal(data.auth?.type, 'basic')
  act(() => { fireEvent.change(container.querySelector('[aria-label="Generic auth type"]') as HTMLSelectElement, { target: { value: '' } }) })
  data = (latest as unknown as { data: { auth?: { type?: string } } }).data
  assert.equal(data.auth, undefined)
  cleanup()
})
