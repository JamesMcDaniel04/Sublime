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

test('container children are not top-level cards (their container owns them)', () => {
  const withLoop: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'loop', type: 'loop', data: { over: '{{trigger.input}}', body: ['inner'] } },
      { id: 'inner', type: 'agent', data: { agentId: 'a' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'loop' }],
  }
  const { container } = render(React.createElement(DagCanvas, { ...props, graph: withLoop } as never))
  // trigger + loop only — `inner` renders nested INSIDE the loop card.
  assert.equal(container.querySelectorAll('.react-flow__node').length, 2)
})
