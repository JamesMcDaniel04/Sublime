/**
 * Child reordering used to live in the canvas side-panel that Task 6 deletes.
 * These tests are the contract that the capability survived the move.
 */
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { ContainerChildren } from '../container-children'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'

afterEach(() => cleanup())

const LOOP = { id: 'loop1', type: 'loop', data: { over: '{{trigger.input}}', body: ['a', 'b'] } } as FlowNode
const CHILD_A = { id: 'a', type: 'http', data: { method: 'GET', url: 'https://a' } } as FlowNode
const CHILD_B = { id: 'b', type: 'http', data: { method: 'GET', url: 'https://b' } } as FlowNode
const GRAPH = { nodes: [LOOP, CHILD_A, CHILD_B], edges: [] } as unknown as FlowGraph

const base = {
  node: LOOP,
  graph: GRAPH,
  labelOf: (node: FlowNode) => node.id.toUpperCase(),
  onChangeNode: () => {},
}

test('lists every child of the container', () => {
  const { getByText } = render(<ContainerChildren {...base} />)
  getByText('A')
  getByText('B')
})

test('dropping one child on a sibling reports the reorder', () => {
  let call: unknown = null
  const { getByTestId } = render(
    <ContainerChildren {...base} onReorderContainer={(...args) => { call = args }} />,
  )
  const target = getByTestId('container-child-b')
  fireEvent.dragOver(target, { dataTransfer: { getData: () => 'a', dropEffect: '' } })
  fireEvent.drop(target, { dataTransfer: { getData: () => 'a' } })
  assert.deepEqual(call, ['loop1', 0, 1, undefined])
})

test('a non-container node renders nothing', () => {
  const { container } = render(<ContainerChildren {...base} node={CHILD_A} />)
  assert.equal(container.firstChild, null)
})

test('clicking a child opens that child', () => {
  let opened: string | null = null
  const { getByText } = render(<ContainerChildren {...base} onOpenNode={(id) => { opened = id }} />)
  fireEvent.click(getByText('B'))
  assert.equal(opened, 'b')
})
