import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveExecutionMode } from '../execution-mode'

const ORIGINAL = { ...process.env }
beforeEach(() => {
  process.env = { ...ORIGINAL }
})

test('production defaults to queue', () => {
  Object.assign(process.env, { NODE_ENV: 'production' })
  delete process.env.EXECUTION_MODE
  assert.equal(resolveExecutionMode(), 'queue')
})

test('development defaults to inline', () => {
  Object.assign(process.env, { NODE_ENV: 'development' })
  delete process.env.EXECUTION_MODE
  assert.equal(resolveExecutionMode(), 'inline')
})

test('explicit EXECUTION_MODE overrides the default', () => {
  Object.assign(process.env, { NODE_ENV: 'production' })
  process.env.EXECUTION_MODE = 'inline'
  assert.equal(resolveExecutionMode(), 'inline')
  process.env.EXECUTION_MODE = 'queue'
  Object.assign(process.env, { NODE_ENV: 'development' })
  assert.equal(resolveExecutionMode(), 'queue')
})
