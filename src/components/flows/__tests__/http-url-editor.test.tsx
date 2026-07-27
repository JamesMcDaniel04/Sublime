/**
 * Characterization tests for the HTTP step's URL field, driven through the
 * REAL controlled loop the flow builder uses (value down, onChange ->
 * updateNode -> re-render). These pin that the URL editor accepts and retains
 * typed/blurred input in the Node Detail View (which replaced the inline card
 * as the config surface) — the "won't
 * accept URLs" report could not be reproduced here, so this locks the input
 * path as correct and gives the reducer refactor (WS-R6 Phase 2) a safety net.
 */
import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React, { useState } from 'react'
import { render, act, cleanup } from '@testing-library/react'
import { NodeDetailView } from '../ndv/node-detail-view'
import { updateNode } from '@/lib/flows/mutate'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'

const win = () => (globalThis as unknown as { window: Window & typeof globalThis }).window
const httpNode = (): FlowNode => ({ id: 'h1', type: 'http', data: { method: 'POST', url: '', bodyMode: 'json', body: '' } }) as FlowNode

function typeInto(editor: HTMLElement, url: string) {
  for (let i = 1; i <= url.length; i++) {
    act(() => {
      editor.focus()
      editor.textContent = url.slice(0, i)
      editor.dispatchEvent(new (win() as unknown as { InputEvent: typeof InputEvent }).InputEvent('input', { bubbles: true }))
    })
  }
}

function CardHarness({ capture }: { capture: (n: FlowNode) => void }) {
  const [graph, setGraph] = useState<FlowGraph>({ nodes: [httpNode()], edges: [] } as FlowGraph)
  const node = graph.nodes.find((n) => n.id === 'h1') as FlowNode
  capture(node)
  // The param body moved from the card into the Node Detail View — same body
  // module, new host. The harness drives the same real controlled loop.
  return React.createElement(NodeDetailView, {
    node, agents: [], toolCatalog: [], lastOutput: undefined,
    onChange: (n: FlowNode) => setGraph((g) => updateNode(g, n)), onClose: () => {},
  })
}

test('NDV URL field accepts and retains a typed URL', () => {
  let latest: FlowNode | null = null
  const { container } = render(React.createElement(CardHarness, { capture: (n) => { latest = n } }))
  const editor = container.querySelector('[aria-label="URI"]') as HTMLElement
  assert.ok(editor, 'URI field renders')
  const url = 'https://api.example.com/webhook?a=b&c=d'
  typeInto(editor, url)
  assert.equal((container.querySelector('[aria-label="URI"]') as HTMLElement).textContent, url)
  assert.equal((latest as unknown as { data: { url: string } }).data.url, url)
  cleanup()
})

test('NDV URL survives a blur', () => {
  let latest: FlowNode | null = null
  const { container } = render(React.createElement(CardHarness, { capture: (n) => { latest = n } }))
  const editor = container.querySelector('[aria-label="URI"]') as HTMLElement
  const url = 'https://example.com/x'
  typeInto(editor, url)
  act(() => { editor.dispatchEvent(new (win()).Event('blur', { bubbles: true })) })
  assert.equal((container.querySelector('[aria-label="URI"]') as HTMLElement).textContent, url)
  assert.equal((latest as unknown as { data: { url: string } }).data.url, url)
  cleanup()
})

