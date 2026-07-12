import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinBranchOutputs } from '../join'

const entries = [
  { key: 'n1', output: { a: 1 }, label: 'first' },
  { key: 'n2', output: { b: 2 }, label: 'second' },
]

test('unset strategy = back-compat keyed object by branch-head id', () => {
  assert.deepEqual(joinBranchOutputs(entries), { n1: { a: 1 }, n2: { b: 2 } })
})

test('array = outputs in branch order', () => {
  assert.deepEqual(joinBranchOutputs(entries, 'array'), [{ a: 1 }, { b: 2 }])
})

test('object = keyed by label, falling back to the branch key when unlabelled', () => {
  assert.deepEqual(joinBranchOutputs(entries, 'object'), { first: { a: 1 }, second: { b: 2 } })
  assert.deepEqual(joinBranchOutputs([{ key: 'n1', output: 1 }], 'object'), { n1: 1 })
})

test('merge = shallow-merge branch objects (non-objects ignored)', () => {
  assert.deepEqual(joinBranchOutputs([...entries, { key: 'n3', output: 'x' }], 'merge'), { a: 1, b: 2 })
})
