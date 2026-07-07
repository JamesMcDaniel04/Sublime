import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isProviderAvailabilityError, structuredProviderOrder } from '../model-runner'

test('qwen default prefers qwen, falls back to claude', () => {
  assert.deepEqual(
    structuredProviderOrder({ defaultModel: 'qwen-3.7', qwen: true, anthropic: true }),
    ['qwen', 'claude'],
  )
})

test('claude default prefers claude', () => {
  assert.deepEqual(
    structuredProviderOrder({ defaultModel: 'claude-opus-4-8', qwen: true, anthropic: true }),
    ['claude', 'qwen'],
  )
})

test('only configured providers appear', () => {
  assert.deepEqual(
    structuredProviderOrder({ defaultModel: 'qwen-3.7', qwen: false, anthropic: true }),
    ['claude'],
  )
  assert.deepEqual(structuredProviderOrder({ defaultModel: 'qwen-3.7', qwen: false, anthropic: false }), [])
})

test('quota/auth/overload errors are availability failures; schema errors are not', () => {
  assert.equal(isProviderAvailabilityError({ status: 429 }), true) // quota exhausted
  assert.equal(isProviderAvailabilityError({ status: 401 }), true) // bad key
  assert.equal(isProviderAvailabilityError({ status: 529 }), true) // overloaded
  assert.equal(isProviderAvailabilityError({ status: 400 }), false) // our schema/request bug
  assert.equal(isProviderAvailabilityError(new Error('parse failed')), false)
  assert.equal(isProviderAvailabilityError(null), false)
})
