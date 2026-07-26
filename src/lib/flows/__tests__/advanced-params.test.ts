import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advancedParamKeys, advancedParamsSetCount } from '../advanced-params'
import type { FlowNode } from '../graph'

test('each node type declares its advanced keys', () => {
  assert.deepEqual(advancedParamKeys('agent'), ['includeUpstream', 'onError', 'retries', 'timeoutMs', 'disabled', 'mockOutput'])
  assert.deepEqual(advancedParamKeys('tool'), ['excludeFromContext', 'onError', 'retries', 'timeoutMs', 'disabled', 'mockOutput'])
  assert.deepEqual(advancedParamKeys('loop'), ['concurrency'])
  assert.deepEqual(advancedParamKeys('trigger'), [])
})

test('the http node opts out — it owns an n8n-style Options panel instead', () => {
  // Two panels over the same node meant two `bodyMode` selects with different
  // option sets, and the advanced one silently rewrote a GraphQL body to JSON.
  assert.deepEqual(advancedParamKeys('http'), [])
})

test('advancedParamsSetCount counts only explicitly-set params', () => {
  const bare: FlowNode = { id: 'n1', type: 'tool', data: { connectionId: 'c1', toolName: 'send' } }
  assert.equal(advancedParamsSetCount(bare), 0)
  const tuned: FlowNode = {
    id: 'n2',
    type: 'tool',
    data: { connectionId: 'c1', toolName: 'send', retries: 2, timeoutMs: 5000 },
  }
  assert.equal(advancedParamsSetCount(tuned), 2)
})
