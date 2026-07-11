/**
 * Unit tests for the flow-builder canvas click-and-hold pan. The pan logic is
 * a pure DOM module (canvas-pan.ts) so it is testable without mounting the
 * builder page; the page only wires pointer events to it.
 */
import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startCanvasPan, PAN_INTERACTIVE_SELECTOR } from '../canvas-pan'

function fakeContainer(): HTMLElement {
  const el = document.createElement('div')
  // jsdom has no layout: back scrollTop with a plain writable property.
  Object.defineProperty(el, 'scrollTop', { value: 100, writable: true })
  document.body.appendChild(el)
  return el
}

test('left-button drag on the background scrolls the container', () => {
  const el = fakeContainer()
  const pan = startCanvasPan(el, { button: 0, clientY: 500, target: el })
  assert.ok(pan, 'expected a pan session to start')
  pan!.move(450) // drag up 50px → content follows the hand → scrollTop increases
  assert.equal(el.scrollTop, 150)
  pan!.move(560) // drag below the origin → scrolls back past the start
  assert.equal(el.scrollTop, 40)
  assert.equal(pan!.end().dragged, true)
})

test('sub-threshold movement stays a click (no scroll, not a drag)', () => {
  const el = fakeContainer()
  const pan = startCanvasPan(el, { button: 0, clientY: 500, target: el })!
  pan.move(498) // 2px < 3px threshold
  assert.equal(el.scrollTop, 100)
  assert.equal(pan.end().dragged, false)
})

test('non-left buttons and interactive targets never start a pan', () => {
  const el = fakeContainer()
  assert.equal(startCanvasPan(el, { button: 1, clientY: 0, target: el }), null)
  assert.equal(startCanvasPan(el, { button: 2, clientY: 0, target: el }), null)

  const button = document.createElement('button')
  el.appendChild(button)
  assert.equal(startCanvasPan(el, { button: 0, clientY: 0, target: button }), null)

  const card = document.createElement('div')
  card.setAttribute('data-node-id', 'n1')
  const inner = document.createElement('span')
  card.appendChild(inner)
  el.appendChild(card)
  assert.equal(startCanvasPan(el, { button: 0, clientY: 0, target: inner }), null, 'descendants of a step card are excluded')
})

test('the interactive selector covers the surfaces node interactions use', () => {
  for (const fragment of ['[data-node-id]', 'button', 'input', 'textarea', 'select']) {
    assert.ok(PAN_INTERACTIVE_SELECTOR.includes(fragment), `selector should include ${fragment}`)
  }
})
