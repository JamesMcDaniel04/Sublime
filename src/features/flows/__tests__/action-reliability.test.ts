import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowActionRetries, flowActionTimeoutMs, runWithRetries, withTimeout, shouldRetryAfterTimeout } from '../action-reliability'

test('flow action reliability clamps retries and timeouts', () => {
  assert.equal(flowActionRetries(8), 5)
  assert.equal(flowActionRetries(-2), 0)
  assert.equal(flowActionRetries('2'), 0)
  assert.equal(flowActionTimeoutMs(10), 1000)
  assert.equal(flowActionTimeoutMs(999999), 120000)
  assert.equal(flowActionTimeoutMs('30'), undefined)
})

test('runWithRetries retries failed attempts before succeeding', async () => {
  let attempts = 0
  const result = await runWithRetries(async () => {
    attempts += 1
    if (attempts < 3) throw new Error('temporary failure')
    return 'ok'
  }, { retries: 2, retryDelayMs: 0 })
  assert.equal(result, 'ok')
  assert.equal(attempts, 3)
})

test('withTimeout surfaces the timeout message', async () => {
  await assert.rejects(
    withTimeout(new Promise((resolve) => setTimeout(() => resolve('late'), 30)), 1, 'tool timed out'),
    /tool timed out/,
  )
})

test('only http steps may retry after a timeout — agent/tool executions stay live when abandoned', () => {
  assert.equal(shouldRetryAfterTimeout('agent'), false)
  assert.equal(shouldRetryAfterTimeout('tool'), false)
  assert.equal(shouldRetryAfterTimeout('http'), true)
})

test('runWithRetries with retryOnTimeout=false fails on the first timeout without a second attempt', async () => {
  let attempts = 0
  await assert.rejects(
    runWithRetries(
      async () => {
        attempts += 1
        // Never resolves: simulates an abandoned live call (no lingering timer).
        return new Promise<string>(() => {})
      },
      { retries: 3, timeoutMs: 1000, timeoutMessage: 'call timed out', retryDelayMs: 0, retryOnTimeout: false },
    ),
    /call timed out/,
  )
  assert.equal(attempts, 1)
})

test('runWithRetries with retryOnTimeout=false still retries hard errors', async () => {
  let attempts = 0
  const result = await runWithRetries(
    async () => {
      attempts += 1
      if (attempts < 2) throw new Error('temporary failure')
      return 'ok'
    },
    { retries: 2, timeoutMs: 5000, retryDelayMs: 0, retryOnTimeout: false },
  )
  assert.equal(result, 'ok')
  assert.equal(attempts, 2)
})

test('an explicit retry classifier blocks unknown hard errors', async () => {
  let attempts = 0
  await assert.rejects(runWithRetries(async () => {
    attempts += 1
    throw new Error('invalid credentials')
  }, { retries: 5, retryDelayMs: 0, shouldRetry: () => false }), /invalid credentials/)
  assert.equal(attempts, 1)
})
