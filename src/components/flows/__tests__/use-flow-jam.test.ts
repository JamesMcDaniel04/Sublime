import { test } from 'node:test'
import assert from 'node:assert/strict'
import { jamCursorColor } from '../use-flow-jam'

test('jam cursor colors are stable per teammate', () => {
  assert.equal(jamCursorColor('user-1'), jamCursorColor('user-1'))
  assert.notEqual(jamCursorColor('user-1'), jamCursorColor('user-2'))
})
