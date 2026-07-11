/**
 * Unit tests for the flow-builder canvas click-and-hold pan. The pan logic is
 * a pure module (canvas-pan.ts): a drag session reports 2D deltas that the
 * builder applies as a translate on the canvas plane — so panning works even
 * when the content doesn't overflow (nothing to scroll). The page only wires
 * pointer events.
 */
import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startCanvasPan, PAN_INTERACTIVE_SELECTOR } from '../canvas-pan'

test('left-button drag on the background reports 2D deltas (the plane follows the hand)', () => {
  const applied: Array<{ dx: number; dy: number }> = []
  const pan = startCanvasPan(
    { button: 0, clientX: 300, clientY: 500, target: document.body },
    (dx, dy) => applied.push({ dx, dy }),
  )
  assert.ok(pan, 'expected a pan session to start')
  pan!.move(250, 460) // hand moves left 50 / up 40 → plane follows
  assert.deepEqual(applied.at(-1), { dx: -50, dy: -40 })
  pan!.move(340, 560) // back past the origin, both axes
  assert.deepEqual(applied.at(-1), { dx: 40, dy: 60 })
  assert.equal(pan!.end().dragged, true)
})

test('sub-threshold movement stays a click (no deltas, not a drag)', () => {
  const applied: Array<{ dx: number; dy: number }> = []
  const pan = startCanvasPan(
    { button: 0, clientX: 300, clientY: 500, target: document.body },
    (dx, dy) => applied.push({ dx, dy }),
  )!
  pan.move(301, 502) // ~2px < 3px threshold
  assert.equal(applied.length, 0)
  assert.equal(pan.end().dragged, false)
})

test('non-left buttons and interactive targets never start a pan', () => {
  const noop = () => {}
  assert.equal(startCanvasPan({ button: 1, clientX: 0, clientY: 0, target: document.body }, noop), null)
  assert.equal(startCanvasPan({ button: 2, clientX: 0, clientY: 0, target: document.body }, noop), null)

  const button = document.createElement('button')
  document.body.appendChild(button)
  assert.equal(startCanvasPan({ button: 0, clientX: 0, clientY: 0, target: button }, noop), null)

  const card = document.createElement('div')
  card.setAttribute('data-node-id', 'n1')
  const inner = document.createElement('span')
  card.appendChild(inner)
  document.body.appendChild(card)
  assert.equal(
    startCanvasPan({ button: 0, clientX: 0, clientY: 0, target: inner }, noop),
    null,
    'descendants of a step card are excluded',
  )
})

test('the interactive selector covers the surfaces node interactions use', () => {
  for (const fragment of ['[data-node-id]', 'button', 'input', 'textarea', 'select']) {
    assert.ok(PAN_INTERACTIVE_SELECTOR.includes(fragment), `selector should include ${fragment}`)
  }
})
