import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advancedParamKeys, advancedParamsSetCount } from '../advanced-params'
import type { FlowNode } from '../graph'

test('each node type declares its advanced keys', () => {
  assert.deepEqual(advancedParamKeys('agent'), ['onError', 'retries', 'timeoutMs', 'disabled', 'mockOutput'])
  assert.deepEqual(advancedParamKeys('tool'), ['onError', 'retries', 'timeoutMs', 'disabled', 'mockOutput'])
  assert.deepEqual(advancedParamKeys('http'), ['bodyMode', 'responseType', 'failOnHttpError', 'onError', 'retries', 'retryDelayMs', 'timeoutMs', 'followRedirects', 'maxRedirects', 'disabled', 'mockOutput'])
  assert.deepEqual(advancedParamKeys('loop'), ['concurrency'])
  assert.deepEqual(advancedParamKeys('trigger'), [])
})

test('advancedParamsSetCount counts only explicitly-set params', () => {
  const bare: FlowNode = { id: 'n1', type: 'http', data: { method: 'POST', url: 'https://x.test' } }
  assert.equal(advancedParamsSetCount(bare), 0)
  const tuned: FlowNode = {
    id: 'n2',
    type: 'http',
    data: { method: 'GET', url: 'https://x.test', retries: 2, failOnHttpError: false },
  }
  assert.equal(advancedParamsSetCount(tuned), 2)
})
