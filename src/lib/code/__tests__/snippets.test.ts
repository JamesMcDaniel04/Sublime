/**
 * The default snippets the editor ships MUST run cleanly through the real
 * engines — a future wording tweak that breaks execution would otherwise
 * reach users as a broken starter experience.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CODE_SNIPPETS } from '@/lib/flows/code-snippets'
import { runJavaScript } from '../run-js'
import { runPython } from '../run-python'

const items = [{ id: 1 }, { id: 2 }]

test('the JavaScript starters run against object items', async () => {
  const all = await runJavaScript({ code: CODE_SNIPPETS.javascript.allItems, items })
  assert.deepEqual(all.ok && all.output, [{ id: 1, myNewField: 1 }, { id: 2, myNewField: 1 }])
  const each = await runJavaScript({ code: CODE_SNIPPETS.javascript.eachItem, items, item: items[0] })
  assert.deepEqual(each.ok && each.output, { id: 1, myNewField: 1 })
})

test('the Python starters run against object items', async () => {
  const all = await runPython({ code: CODE_SNIPPETS.python.allItems, items })
  assert.deepEqual(all.ok && all.output, [{ id: 1, my_new_field: 1 }, { id: 2, my_new_field: 1 }])
  const each = await runPython({ code: CODE_SNIPPETS.python.eachItem, items, item: items[0] })
  assert.deepEqual(each.ok && each.output, { id: 1, my_new_field: 1 })
})
