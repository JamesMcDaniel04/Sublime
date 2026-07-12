import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldPersistInterpreterStep } from '../run-step-persistence'

test('shouldPersistInterpreterStep skips adapter-persisted executable steps', () => {
  assert.equal(shouldPersistInterpreterStep('agent'), false)
  assert.equal(shouldPersistInterpreterStep('tool'), false)
  assert.equal(shouldPersistInterpreterStep('http'), false)
  assert.equal(shouldPersistInterpreterStep('subflow'), false)
})

test('shouldPersistInterpreterStep keeps container and control outcomes', () => {
  assert.equal(shouldPersistInterpreterStep('loop'), true)
  assert.equal(shouldPersistInterpreterStep('condition'), true)
  assert.equal(shouldPersistInterpreterStep('stop'), true)
  assert.equal(shouldPersistInterpreterStep(undefined), true)
})
