/**
 * The Code node's NDV body — n8n's shape: Mode select, Language select, a
 * monospace editor seeded with default snippets, per-language hint text.
 *
 * The behaviour worth pinning: switching language or mode swaps the starter
 * snippet ONLY while the code is still an untouched default — a user's edits
 * must never be clobbered by a select change.
 */
import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React, { useState } from 'react'
import { render, act, cleanup, fireEvent } from '@testing-library/react'
import { NodeDetailView } from '../ndv/node-detail-view'
import { updateNode } from '@/lib/flows/mutate'
import { CODE_SNIPPETS } from '@/lib/flows/code-snippets'
import { flowGraphSchema, type FlowGraph, type FlowNode } from '@/lib/flows/graph'

const codeNode = (data: Record<string, unknown> = {}): FlowNode =>
  ({ id: 'c1', type: 'code', data: { language: 'javascript', mode: 'allItems', code: CODE_SNIPPETS.javascript.allItems, ...data } }) as FlowNode

function Harness({ initial, capture }: { initial?: Record<string, unknown>; capture: (n: FlowNode) => void }) {
  const [graph, setGraph] = useState<FlowGraph>({ nodes: [codeNode(initial)], edges: [] } as FlowGraph)
  const node = graph.nodes.find((n) => n.id === 'c1') as FlowNode
  capture(node)
  return React.createElement(NodeDetailView, {
    node, agents: [], toolCatalog: [], dataFields: [], lastOutput: undefined,
    onChange: (n: FlowNode) => setGraph((g) => updateNode(g, n)), onClose: () => {},
  })
}

const dataOf = (node: FlowNode | null) => (node as unknown as { data: Record<string, unknown> }).data

test('renders Mode, Language, and the code editor with the JS starter', (t) => {
  t.after(cleanup)
  const { container } = render(React.createElement(Harness, { capture: () => {} }))
  const mode = container.querySelector('[aria-label="Mode"]') as HTMLSelectElement
  const language = container.querySelector('[aria-label="Language"]') as HTMLSelectElement
  const editor = container.querySelector('[aria-label="Code"]') as HTMLTextAreaElement
  assert.ok(mode && language && editor, 'all three controls render')
  assert.deepEqual([...mode.querySelectorAll('option')].map((o) => o.textContent), ['Run Once for All Items', 'Run Once for Each Item'])
  assert.deepEqual([...language.querySelectorAll('option')].map((o) => o.textContent), ['JavaScript', 'Python'])
  assert.equal(editor.value, CODE_SNIPPETS.javascript.allItems)
})

test('switching language swaps an untouched default snippet', (t) => {
  t.after(cleanup)
  let latest: FlowNode | null = null
  const { container } = render(React.createElement(Harness, { capture: (n) => { latest = n } }))
  act(() => {
    fireEvent.change(container.querySelector('[aria-label="Language"]') as HTMLSelectElement, { target: { value: 'python' } })
  })
  assert.equal(dataOf(latest).language, 'python')
  assert.equal(dataOf(latest).code, CODE_SNIPPETS.python.allItems)
})

test('switching mode swaps an untouched default snippet', (t) => {
  t.after(cleanup)
  let latest: FlowNode | null = null
  const { container } = render(React.createElement(Harness, { capture: (n) => { latest = n } }))
  act(() => {
    fireEvent.change(container.querySelector('[aria-label="Mode"]') as HTMLSelectElement, { target: { value: 'eachItem' } })
  })
  assert.equal(dataOf(latest).code, CODE_SNIPPETS.javascript.eachItem)
})

test('a user-edited snippet is NEVER clobbered by a select change', (t) => {
  t.after(cleanup)
  let latest: FlowNode | null = null
  const { container } = render(React.createElement(Harness, {
    initial: { code: 'return myCustomThing()' },
    capture: (n) => { latest = n },
  }))
  act(() => {
    fireEvent.change(container.querySelector('[aria-label="Language"]') as HTMLSelectElement, { target: { value: 'python' } })
  })
  assert.equal(dataOf(latest).language, 'python')
  assert.equal(dataOf(latest).code, 'return myCustomThing()')
})

test('the hint text matches the selected language', (t) => {
  t.after(cleanup)
  const js = render(React.createElement(Harness, { capture: () => {} }))
  assert.match(js.container.textContent ?? '', /console\.log/)
  cleanup()
  const py = render(React.createElement(Harness, { initial: { language: 'python', code: CODE_SNIPPETS.python.allItems }, capture: () => {} }))
  assert.match(py.container.textContent ?? '', /print\(\)/)
})

test('everything the editor writes survives the graph schema parse', (t) => {
  t.after(cleanup)
  const data = {
    label: 'My code',
    language: 'python' as const,
    mode: 'eachItem' as const,
    code: 'return _item',
    input: '{{step.up.output}}',
    onError: 'continue' as const,
    retries: 1,
    timeoutMs: 20_000,
    excludeFromContext: true,
    disabled: false,
    mockOutput: { ok: 1 },
  }
  const parsed = flowGraphSchema.parse({ nodes: [{ id: 'c1', type: 'code', data }], edges: [] })
  assert.deepEqual(parsed.nodes[0].data, data)
})
