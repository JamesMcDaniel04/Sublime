import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compositionCompleteness } from '../composition/completeness'

const required = ['new_arr', 'expansion_arr', 'contraction_arr', 'churned_arr']

test('all slots bound and healthy is complete', () => {
  const c = compositionCompleteness({
    required,
    present: required,
    stale: [],
    errored: [],
  })
  assert.equal(c.level, 'complete')
  assert.equal(c.boundPct, 100)
  assert.deepEqual(c.missing, [])
})

test('no slots bound is unbound', () => {
  const c = compositionCompleteness({
    required,
    present: [],
    stale: [],
    errored: [],
  })
  assert.equal(c.level, 'unbound')
  assert.equal(c.boundPct, 0)
  assert.equal(c.missing.length, 4)
})

test('some slots bound is partial and names the gaps', () => {
  const c = compositionCompleteness({
    required,
    present: ['new_arr', 'expansion_arr'],
    stale: [],
    errored: [],
  })
  assert.equal(c.level, 'partial')
  assert.equal(c.boundPct, 50)
  assert.deepEqual(c.missing.sort(), ['churned_arr', 'contraction_arr'])
})

test('a bound-but-stale slot keeps boundPct high yet is not complete', () => {
  // Bound and readable are different claims; staleness must not hide behind a
  // full bind count.
  const c = compositionCompleteness({
    required,
    present: required,
    stale: ['churned_arr'],
    errored: [],
  })
  assert.equal(c.boundPct, 100)
  assert.equal(c.level, 'partial')
  assert.deepEqual(c.stale, ['churned_arr'])
})

test('a bound-but-erroring slot is not complete', () => {
  const c = compositionCompleteness({
    required,
    present: required,
    stale: [],
    errored: ['new_arr'],
  })
  assert.equal(c.level, 'partial')
  assert.deepEqual(c.errored, ['new_arr'])
})

test('an empty required set is complete rather than unbound', () => {
  // Quota requires no component slots; it must not read as broken.
  const c = compositionCompleteness({
    required: [],
    present: [],
    stale: [],
    errored: [],
  })
  assert.equal(c.level, 'complete')
  assert.equal(c.boundPct, 100)
})

test('stale and errored entries outside required are ignored', () => {
  // An optional slot going stale is not the goal's problem.
  const c = compositionCompleteness({
    required,
    present: required,
    stale: ['customers_start'],
    errored: [],
  })
  assert.equal(c.level, 'complete')
  assert.deepEqual(c.stale, [])
})

test('present entries outside required do not inflate boundPct', () => {
  const c = compositionCompleteness({
    required,
    present: [...required, 'customers_start', 'customers_churned'],
    stale: [],
    errored: [],
  })
  assert.equal(c.boundPct, 100)
})
