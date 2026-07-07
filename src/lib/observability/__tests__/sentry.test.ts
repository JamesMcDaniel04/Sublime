import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { captureError, setErrorReporter, resetErrorReporter } from '../sentry'

beforeEach(() => resetErrorReporter())

test('captureError without a DSN or reporter is a safe no-op', () => {
  delete process.env.SENTRY_DSN
  assert.doesNotThrow(() => captureError(new Error('boom'), { path: '/api/x' }))
})

test('captureError forwards to an injected reporter with context', () => {
  const seen: Array<{ error: unknown; context?: Record<string, unknown> }> = []
  setErrorReporter((error, context) => seen.push({ error, context }))
  const failure = new Error('kaput')
  captureError(failure, { path: '/api/agents' })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].error, failure)
  assert.equal(seen[0].context?.path, '/api/agents')
})

test('a throwing reporter never breaks the caller', () => {
  setErrorReporter(() => {
    throw new Error('reporter exploded')
  })
  assert.doesNotThrow(() => captureError(new Error('original')))
})
