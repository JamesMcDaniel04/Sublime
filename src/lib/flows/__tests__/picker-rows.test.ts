/**
 * Turning an arbitrary tool result into a small table the picker can render.
 *
 * The items come from a live connection, so nothing about their shape is
 * guaranteed: a Slack channel list is objects, a tags endpoint may be bare
 * strings, and a badly-behaved tool can return a mix. The picker must render
 * something useful for all of it rather than throwing inside a dropdown.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickerRows } from '../picker-rows'

test('objects become rows keyed by their own fields', () => {
  const { headers, rows } = pickerRows([
    { id: 'C1', name: 'general' },
    { id: 'C2', name: 'random' },
  ])
  assert.deepEqual(headers, ['id', 'name'])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].id, 'C1')
})

// A tool that returns ["a","b"] is common and must not render an empty table.
test('primitive items are wrapped under a value column', () => {
  const { headers, rows } = pickerRows(['alpha', 'beta'])
  assert.deepEqual(headers, ['value'])
  assert.equal(rows[0].value, 'alpha')
})

// Sparse results are normal: not every record carries every field.
test('headers are the union across items, so a field missing from the first row still shows', () => {
  const { headers } = pickerRows([{ id: 'A' }, { id: 'B', archived: true }])
  assert.deepEqual(headers, ['id', 'archived'])
})

// A wide record would blow out the panel; the picker needs an identifier and a
// label, not the whole payload.
test('headers are capped so a wide record cannot blow out the panel', () => {
  const wide = [Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`field${i}`, i]))]
  assert.ok(pickerRows(wide).headers.length <= 6)
})

test('nested values are stringified rather than rendered as [object Object]', () => {
  const { rows } = pickerRows([{ id: 'A', meta: { deep: 1 } }])
  assert.equal(rows[0].meta, '{"deep":1}')
})

test('null and undefined render as empty, not as the words null or undefined', () => {
  const { rows } = pickerRows([{ id: 'A', label: null }])
  assert.equal(rows[0].label, '')
})

test('an empty result is an empty table, not a crash', () => {
  assert.deepEqual(pickerRows([]), { headers: [], rows: [] })
})

// Mixed shapes are the pathological case — a tool returning both must still render.
test('a mix of objects and primitives renders both', () => {
  const { headers, rows } = pickerRows([{ id: 'A' }, 'loose'])
  assert.ok(headers.includes('id') && headers.includes('value'))
  assert.equal(rows[1].value, 'loose')
})
