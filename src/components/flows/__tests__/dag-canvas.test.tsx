/**
 * Smoke test for the DAG canvas: it must actually MOUNT and render a card per
 * top-level node. Typecheck can't catch a bad import, a React Flow context
 * mistake, or a crash in the custom node — this can.
 */
import '@/test-support/jsdom-env'
import { installReactFlowLayout } from '@/test-support/react-flow-layout'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, act, cleanup } from '@testing-library/react'
import { DagCanvas } from '../dag-canvas'
import type { FlowGraph } from '@/lib/flows/graph'

// jsdom has no layout, and React Flow won't paint an edge between nodes it
// hasn't measured — this gives it just enough to do both.
installReactFlowLayout()

afterEach(() => cleanup())

/** Let the (async) ResizeObserver deliver measurements, then React Flow repaint. */
async function settleLayout() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

const graph: FlowGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: {} },
    { id: 'api1', type: 'http', data: { label: 'Fetch CRM', method: 'GET', url: 'https://api/crm' } },
    { id: 'api2', type: 'http', data: { label: 'Enrich Lead', method: 'GET', url: 'https://api/enrich' } },
    { id: 'agent', type: 'agent', data: { agentId: 'a', label: 'Summarize' } },
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'api1' },
    { id: 'e1', source: 'trigger', target: 'api2' },
    // Both APIs fan IN to the agent — the shape the stack canvas can't express.
    { id: 'e2', source: 'api1', target: 'agent' },
    { id: 'e3', source: 'api2', target: 'agent' },
  ],
}

const props = {
  graph,
  agents: [{ id: 'a', title: 'Summarizer' }],
  toolCatalog: [],
  labelOf: (node: { id: string }) => node.id,
  onSelect: () => {},
  onChangeNode: () => {},
  onChangeGraph: () => {},
  onAddNode: () => {},
  onReorderContainer: () => {},
  onAddContainerStep: () => {},
}

test('mounts a fan-in graph and renders a card per top-level node', () => {
  const { container } = render(React.createElement(DagCanvas, props as never))
  const rendered = container.querySelectorAll('.react-flow__node')
  assert.equal(rendered.length, 4, 'trigger + 2 APIs + agent all render')
})

test('paints a wire per edge — including BOTH fan-in wires into one agent', async () => {
  const { container } = render(React.createElement(DagCanvas, props as never))
  await settleLayout()
  // The shape the stack canvas cannot express: two APIs wired into one agent.
  assert.ok(container.querySelector('[data-id="e2"]'), 'api1 → agent wire is painted')
  assert.ok(container.querySelector('[data-id="e3"]'), 'api2 → agent wire is painted')
  assert.equal(container.querySelectorAll('.react-flow__edge').length, 4, 'all four wires render')
})

test('a node with two parents (fan-in) mounts once, not once per parent', () => {
  const { container } = render(React.createElement(DagCanvas, props as never))
  const agentCards = [...container.querySelectorAll('.react-flow__node')].filter((el) =>
    (el.getAttribute('data-id') ?? '') === 'agent',
  )
  assert.equal(agentCards.length, 1, 'the join renders as a single card despite two incoming wires')
})

const withLoop: FlowGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: {} },
    { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['inner'] } },
    { id: 'inner', type: 'agent', data: { agentId: 'a' } },
  ],
  edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
}

test('container children are not top-level widgets (their container owns them)', () => {
  const { container } = render(React.createElement(DagCanvas, { ...props, graph: withLoop } as never))
  // trigger + loop only — `inner` is edited inside the loop's config panel.
  assert.equal(container.querySelectorAll('.react-flow__node').length, 2)
})

test('clicking a widget asks to open that node (n8n: config lives in a panel)', () => {
  const opened: (string | null)[] = []
  const { container } = render(
    React.createElement(DagCanvas, { ...props, onSelect: (id: string | null) => opened.push(id) } as never),
  )
  const widget = [...container.querySelectorAll('.react-flow__node')]
    .find((el) => el.getAttribute('data-id') === 'agent')
    ?.querySelector('button') as HTMLButtonElement
  assert.ok(widget, 'the agent widget renders a clickable card')
  act(() => widget.click())
  assert.deepEqual(opened, ['agent'], 'clicking opens that node rather than editing inline')
})

test('the config panel opens for the selected node and is NOT rendered otherwise', () => {
  const closed = render(React.createElement(DagCanvas, props as never))
  assert.equal(closed.container.querySelector('aside'), null, 'no panel with nothing selected')
  cleanup()
  const open = render(React.createElement(DagCanvas, { ...props, selectedId: 'agent' } as never))
  assert.ok(open.container.querySelector('aside'), 'panel opens for the selected node')
})

test("a container's panel lists its children and offers add-a-step", () => {
  const { container } = render(
    React.createElement(DagCanvas, { ...props, graph: withLoop, selectedId: 'loop' } as never),
  )
  const panel = container.querySelector('aside')
  assert.ok(panel, 'the loop opens a config panel')
  assert.match(panel!.textContent ?? '', /Steps inside/, 'children are edited here, not on the canvas')
  assert.match(panel!.textContent ?? '', /Add a step/, 'nested steps can be added from the panel')
})

test('a container child selected on its own does not open a stray top-level panel', () => {
  const { container } = render(
    React.createElement(DagCanvas, { ...props, graph: withLoop, selectedId: 'inner' } as never),
  )
  // `inner` is contained — it is edited via the loop's panel, never its own.
  assert.equal(container.querySelector('aside'), null)
})
