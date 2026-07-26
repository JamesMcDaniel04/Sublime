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

test('generic auth uses a reusable credential type and never writes inline secrets', () => {
  let latest: FlowNode | null = null
  const { container } = render(React.createElement(CardHarness, { capture: (n) => { latest = n } }))
  act(() => {
    fireEvent.change(container.querySelector('[aria-label="Authentication"]') as HTMLSelectElement, { target: { value: 'generic' } })
  })
  const select = container.querySelector('[aria-label="Generic auth type"]') as HTMLSelectElement
  assert.ok(select, 'generic auth select renders')
  act(() => { fireEvent.change(select, { target: { value: 'oauth2' } }) })
  let data = (latest as unknown as { data: { authMode?: string; credentialType?: string; auth?: unknown } }).data
  assert.equal(data.authMode, 'generic')
  assert.equal(data.credentialType, 'oauth2')
  assert.equal(data.auth, undefined)
  act(() => {
    fireEvent.change(container.querySelector('[aria-label="Authentication"]') as HTMLSelectElement, { target: { value: 'none' } })
  })
  data = (latest as unknown as { data: { authMode?: string; credentialType?: string } }).data
  assert.equal(data.authMode, 'none')
  assert.equal(data.credentialType, undefined)
  cleanup()
})

test('HTTP parameters expose n8n-style query, header, and body toggles', () => {
  let latest: FlowNode | null = null
  const { getByRole, getByLabelText } = render(React.createElement(CardHarness, { capture: (n) => { latest = n } }))

  act(() => { getByRole('switch', { name: 'Send Query Parameters' }).click() })
  assert.ok(getByLabelText('Query Parameters JSON'))
  act(() => { getByRole('switch', { name: 'Send Headers' }).click() })
  assert.ok(getByLabelText('Headers JSON'))
  act(() => { getByRole('switch', { name: 'Send Body' }).click() })

  const contentType = getByLabelText('Body Content Type') as HTMLSelectElement
  assert.deepEqual(Array.from(contentType.options).map((option) => option.text), [
    'JSON',
    'Raw',
    'GraphQL',
    'Form URL Encoded',
  ])
  act(() => { fireEvent.change(contentType, { target: { value: 'graphql' } }) })
  assert.ok(getByLabelText('GraphQL Query'))
  assert.ok(getByLabelText('GraphQL Variables JSON'))
  const data = (latest as unknown as { data: { sendQuery?: boolean; sendHeaders?: boolean; sendBody?: boolean; bodyMode?: string } }).data
  assert.equal(data.sendQuery, true)
  assert.equal(data.sendHeaders, true)
  assert.equal(data.sendBody, true)
  assert.equal(data.bodyMode, 'graphql')
  cleanup()
})

test('the credential setup opens a smaller editor for the selected auth method', () => {
  const { container, getByRole } = render(React.createElement(CardHarness, { capture: () => {} }))
  act(() => {
    fireEvent.change(container.querySelector('[aria-label="Authentication"]') as HTMLSelectElement, { target: { value: 'generic' } })
  })
  act(() => {
    fireEvent.change(container.querySelector('[aria-label="Generic auth type"]') as HTMLSelectElement, { target: { value: 'digest' } })
  })
  act(() => { getByRole('button', { name: /set up credential/i }).click() })
  assert.ok(document.querySelector('#cred-username'))
  assert.ok(document.querySelector('#cred-password'))
  assert.ok(document.querySelector('[role="dialog"]'))
  cleanup()
})
