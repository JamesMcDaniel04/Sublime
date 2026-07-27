/**
 * A click used to select a node, which rendered a side panel whose only real
 * content was a button that opened the real config surface. One click now
 * goes straight there.
 */
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { StepCard } from '../step-card'
import type { FlowNode } from '@/lib/flows/graph'

afterEach(() => cleanup())

const NODE = { id: 'h1', type: 'http', data: { method: 'GET', url: 'https://api/x' } } as FlowNode

const root = (container: HTMLElement) => container.querySelector('[role="button"]') as HTMLElement

test('a single click opens the node', () => {
  let opened = false
  const { container } = render(
    <StepCard node={NODE} title="Http" selected={false} labelCtx={{} as never}
      onChange={() => {}} onClick={() => {}} onOpen={() => { opened = true }} />,
  )
  fireEvent.click(root(container))
  assert.equal(opened, true, 'a single click did not open the node')
})

test('without an open handler a click still reports the click', () => {
  let clicked = false
  const { container } = render(
    <StepCard node={NODE} title="Http" selected={false} labelCtx={{} as never}
      onChange={() => {}} onClick={() => { clicked = true }} />,
  )
  fireEvent.click(root(container))
  assert.equal(clicked, true)
})
