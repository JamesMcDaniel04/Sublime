import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coerceFieldValue, resolveInputParams, bindOutputFields } from '../io-nodes'

test('coerceFieldValue coerces per type at the boundary', () => {
  assert.deepEqual(coerceFieldValue('number', '42'), { value: 42 })
  assert.deepEqual(coerceFieldValue('boolean', 'true'), { value: true })
  assert.deepEqual(coerceFieldValue('boolean', false), { value: false })
  assert.deepEqual(coerceFieldValue('object', '{"a":1}'), { value: { a: 1 } })
  assert.deepEqual(coerceFieldValue('array', '[1,2]'), { value: [1, 2] })
  assert.deepEqual(coerceFieldValue('string', 7), { value: '7' })
  assert.ok('error' in coerceFieldValue('number', 'abc'))
  assert.ok('error' in coerceFieldValue('object', '[1]'))
})

test('resolveInputParams applies precedence user > webhook > default', () => {
  const params = [
    { name: 'a', type: 'string' as const },
    { name: 'b', type: 'string' as const },
    { name: 'c', type: 'number' as const, default: '5' },
  ]
  const res = resolveInputParams(params, { user: { a: 'U' }, webhook: { a: 'W', b: 'W' } })
  assert.ok('values' in res)
  assert.deepEqual(res.values, { a: 'U', b: 'W', c: 5 })
})

test('resolveInputParams coerces to declared type and errors on required-missing', () => {
  assert.deepEqual(
    resolveInputParams([{ name: 'n', type: 'number' as const }], { user: { n: '10' } }),
    { values: { n: 10 } },
  )
  const missing = resolveInputParams([{ name: 'x', type: 'string' as const, required: true }], { user: {} })
  assert.ok('error' in missing)
  // optional + no value + no default => omitted, not errored
  assert.deepEqual(resolveInputParams([{ name: 'y', type: 'string' as const }], { user: {} }), { values: {} })
})

test('bindOutputFields binds and coerces from a resolver', () => {
  const resolve = (t: string) => ({ '{{step.n.output.score}}': '91', '{{step.n.output.tags}}': '["a"]' } as Record<string, unknown>)[t]
  const res = bindOutputFields(
    [{ name: 'score', type: 'number', value: '{{step.n.output.score}}' }, { name: 'tags', type: 'array', value: '{{step.n.output.tags}}' }],
    resolve,
  )
  assert.deepEqual(res, { output: { score: 91, tags: ['a'] } })
})
