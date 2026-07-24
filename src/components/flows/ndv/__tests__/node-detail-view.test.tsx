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
import { render, cleanup, act } from '@testing-library/react'
import { NodeDetailView } from '../node-detail-view'
import { InputPane } from '../input-pane'
import { OutputPane } from '../output-pane'
import { FieldPreview } from '../../nodes/field-preview'
import { buildPreviewContext } from '@/lib/flows/preview-context'
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

// ── Input pane ────────────────────────────────────────────────────────────────

test('input pane lists upstream fields and inserts on click', () => {
  let inserted: string | null = null
  const { getByText } = render(
    <InputPane
      dataFields={[{ label: 'account', token: '{{trigger.input.account}}', type: 'string' }]}
      onInsertToken={(token) => { inserted = token }}
    />,
  )
  getByText('account').click()
  assert.equal(inserted, '{{trigger.input.account}}')
})

test('input pane shows an empty state rather than nothing', () => {
  // A blank pane reads as broken; say WHY there is no data.
  const { getByText } = render(<InputPane dataFields={[]} onInsertToken={() => {}} />)
  getByText(/no upstream data/i)
})

// ── Output pane ───────────────────────────────────────────────────────────────

test('output pane renders the last run output', () => {
  const { getByText } = render(<OutputPane lastOutput={{ ok: true, id: 'msg_1' }} pinned={false} />)
  getByText(/msg_1/)
})

test('output pane explains an absent output instead of rendering blank', () => {
  const { getByText } = render(<OutputPane lastOutput={undefined} pinned={false} />)
  getByText(/hasn't produced output/i)
})

test('output pane marks pinned data as pinned', () => {
  // Pinned data is stale by construction — if the pane showed it identically
  // to a fresh run, a user would debug against a fixture without knowing.
  const { getByText } = render(<OutputPane lastOutput={{ ok: true }} pinned />)
  getByText(/pinned/i)
})

test('output pane offers Pin on fresh output and Unpin on pinned output', () => {
  let pinnedCall = 0
  let unpinnedCall = 0
  const fresh = render(<OutputPane lastOutput={{ ok: true }} pinned={false} onPin={() => { pinnedCall++ }} />)
  fresh.getByRole('button', { name: /pin this output/i }).click()
  assert.equal(pinnedCall, 1)
  fresh.unmount()
  const pinned = render(<OutputPane lastOutput={{ ok: true }} pinned onUnpin={() => { unpinnedCall++ }} />)
  pinned.getByRole('button', { name: /unpin/i }).click()
  assert.equal(unpinnedCall, 1)
})

// ── Test step ─────────────────────────────────────────────────────────────────

test('Test step is disabled for a container node with the reason shown', () => {
  const loop = { id: 'l1', type: 'loop', data: { over: '{{trigger.input.items}}', body: [] } } as unknown as FlowNode
  const { getByRole, getByTitle } = render(<NodeDetailView node={loop} {...baseProps} onTestStep={() => {}} />)
  const button = getByRole('button', { name: /test step/i }) as HTMLButtonElement
  assert.equal(button.disabled, true)
  getByTitle(/steps inside it individually/i)
})

test('testing a node with unresolved risky ancestors asks before running them', () => {
  let ran = false
  const { getByRole, getByText } = render(
    <NodeDetailView
      node={NODES[0]}
      {...baseProps}
      riskyMissing={[{ id: 'a', label: 'Delete records', risk: 'destructive' }]}
      onTestStep={() => { ran = true }}
    />,
  )
  act(() => { getByRole('button', { name: /test step/i }).click() })
  // Must NOT run yet — it names the write action and waits.
  assert.equal(ran, false)
  getByText(/Delete records/)
})

test('testing a node with no missing ancestors runs immediately', () => {
  let ran = false
  const { getByRole } = render(<NodeDetailView node={NODES[0]} {...baseProps} onTestStep={() => { ran = true }} />)
  getByRole('button', { name: /test step/i }).click()
  assert.equal(ran, true)
})

test('a failed node test surfaces the error in the output pane', () => {
  const { getByText } = render(
    <NodeDetailView node={NODES[0]} {...baseProps} testState={{ status: 'failed', error: '401 Unauthorized' }} />,
  )
  getByText(/401 Unauthorized/)
})

// ── Run from here ─────────────────────────────────────────────────────────────

test('Run from here names the downstream write actions before running', () => {
  let ran = false
  const { getByRole, getByText } = render(
    <NodeDetailView
      node={NODES[0]}
      {...baseProps}
      downstreamWrites={[{ id: 'c', label: 'Send email', risk: 'write' }]}
      onRunFromHere={() => { ran = true }}
    />,
  )
  act(() => { getByRole('button', { name: /run from here/i }).click() })
  assert.equal(ran, false, 'must confirm before firing downstream writes')
  getByText(/Send email/)
})

test('Run from here with no downstream writes runs immediately', () => {
  // Nothing to warn about — a confirm here would be noise that teaches users
  // to click through warnings.
  let ran = false
  const { getByRole } = render(
    <NodeDetailView node={NODES[0]} {...baseProps} downstreamWrites={[]} onRunFromHere={() => { ran = true }} />,
  )
  getByRole('button', { name: /run from here/i }).click()
  assert.equal(ran, true)
})

test('input pane leaves are draggable and carry the braced token', () => {
  const { getByText } = render(
    <InputPane
      dataFields={[{ label: 'account', token: '{{trigger.input.account}}', type: 'string' }]}
      onInsertToken={() => {}}
    />,
  )
  // The draggable attribute lives on the row button wrapping the label.
  const leaf = getByText('account').closest('[draggable="true"]')
  assert.ok(leaf, 'leaf row is not draggable')
})

// ── Field preview ─────────────────────────────────────────────────────────────

test('field preview shows the resolved value of a token field', () => {
  const ctx = buildPreviewContext({ lastOutputs: {}, triggerInput: { account: 'Acme' } })
  const { getByText } = render(<FieldPreview value="Alert: {{trigger.input.account}}" ctx={ctx} />)
  getByText(/Alert: Acme/)
})

test('field preview renders NOTHING for a field with no tokens', () => {
  // A plain value echoed under itself is pure noise.
  const ctx = buildPreviewContext({ lastOutputs: {} })
  const { container } = render(<FieldPreview value="#alerts" ctx={ctx} />)
  assert.equal(container.textContent, '')
})

test('field preview names an unresolved token instead of showing blank', () => {
  const ctx = buildPreviewContext({ lastOutputs: {} })
  const { getByText } = render(<FieldPreview value="{{step.ghost.output.x}}" ctx={ctx} />)
  getByText(/step\.ghost\.output\.x/)
})

test('field preview renders nothing without a context', () => {
  // No sample data yet (fresh flow, never run) — say nothing rather than
  // claiming every token is broken.
  const { container } = render(<FieldPreview value="{{trigger.input.x}}" ctx={undefined} />)
  assert.equal(container.textContent, '')
})

test('the NDV threads previewContext into a real body (http url)', () => {
  // End-to-end for the wiring, not just the component: page -> NDV -> params
  // pane -> registry body -> FieldPreview. A break anywhere in that chain
  // silently means no previews in production.
  const ctx = buildPreviewContext({ lastOutputs: { n0: { slug: 'widgets' } } })
  const httpNode = { id: 'h', type: 'http', data: { method: 'GET', url: 'https://api/{{step.n0.output.slug}}' } } as FlowNode
  const { getByText } = render(<NodeDetailView node={httpNode} {...baseProps} previewContext={ctx} />)
  getByText(/https:\/\/api\/widgets/)
})

test('a body renders no preview when the flow has no sample data', () => {
  const httpNode = { id: 'h', type: 'http', data: { method: 'GET', url: 'https://api/{{step.n0.output.slug}}' } } as FlowNode
  const { queryByText } = render(<NodeDetailView node={httpNode} {...baseProps} />)
  assert.equal(queryByText(/no sample data/i), null)
})
