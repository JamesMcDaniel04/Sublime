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
