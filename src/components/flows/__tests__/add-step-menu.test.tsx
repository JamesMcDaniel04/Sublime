import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToString } from 'react-dom/server'
import { AddStepMenu } from '../add-step-menu'

test('AddStepMenu renders a Radix dropdown trigger with the default label', () => {
  const html = renderToString(<AddStepMenu onPick={() => undefined} />)
  assert.match(html, /Add a step/)
  assert.match(html, /aria-haspopup="menu"/)
})

test('AddStepMenu accepts a custom label', () => {
  const html = renderToString(<AddStepMenu label="Add to branch" onPick={() => undefined} />)
  assert.match(html, /Add to branch/)
})
