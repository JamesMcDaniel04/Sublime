import { test } from 'node:test'
import assert from 'node:assert/strict'
import { jamCursorColor, normalizeJamCursor } from '../use-flow-jam'

test('normalizeJamCursor clamps pointer coordinates to the shared viewport', () => {
  assert.deepEqual(normalizeJamCursor(0.25, 0.75), { x: 0.25, y: 0.75 })
  assert.deepEqual(normalizeJamCursor(-2, 3), { x: 0, y: 1 })
})

test('jam cursor colors are stable per teammate', () => {
  assert.equal(jamCursorColor('user-1'), jamCursorColor('user-1'))
  assert.notEqual(jamCursorColor('user-1'), jamCursorColor('user-2'))
})
