/**
 * The Add-step picker must offer every editable node type that has an editor —
 * transform/filter/input/output had icon+tone entries but no rows, so they
 * were only insertable via the stack canvas dropdown or raw JSON.
 */
import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, act, cleanup, fireEvent } from '@testing-library/react'
import { FlowPicker } from '../flow-picker'
import type { StepType } from '@/lib/flows/mutate'

test('transform, filter, input, and output are insertable from the picker', (t) => {
  t.after(cleanup)
  const cases: Array<[label: string, type: StepType]> = [
    ['Set fields', 'transform'],
    ['Filter', 'filter'],
    ['Input', 'input'],
    ['Output', 'output'],
  ]
  for (const [label, type] of cases) {
    let picked: StepType | null = null
    const { container, unmount } = render(React.createElement(FlowPicker, {
      mode: 'action', agents: [], toolCatalog: [],
      onPick: (stepType: StepType) => { picked = stepType },
      onPickTrigger: () => {}, onClose: () => {},
    }))
    const search = container.querySelector('input') as HTMLInputElement
    act(() => { fireEvent.change(search, { target: { value: label } }) })
    const row = [...container.querySelectorAll('button span')].find((el) => el.textContent === label)
    assert.ok(row, `the picker offers a "${label}" row`)
    act(() => { fireEvent.click(row!.closest('button') as HTMLElement) })
    assert.equal(picked, type, `picking "${label}" inserts a ${type} step`)
    unmount()
  }
})
