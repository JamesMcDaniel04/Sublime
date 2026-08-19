import { test } from 'node:test'
import assert from 'node:assert/strict'
import { probeWithDeadline } from '../readiness'

const never = () => new Promise<void>(() => {})

test('a healthy probe reports ok with its latency', async () => {
  const result = await probeWithDeadline(async () => {}, 500)
  assert.equal(result.ok, true)
  assert.equal(typeof result.ms, 'number')
})

// The incident: the pool was exhausted, so `SELECT 1` blocked on a checkout that
// takes 60s to give up. Without a deadline the probe cannot answer a liveness
// question — it either hangs until the platform kills it or wins a lucky slot
// and reports healthy while every real request fails.
test('a probe that hangs past its deadline reports unhealthy rather than waiting', async () => {
  const started = Date.now()
  const result = await probeWithDeadline(never, 80)
  const elapsed = Date.now() - started
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /timed out/i)
  assert.ok(elapsed < 1000, `probe must return on its own deadline, took ${elapsed}ms`)
})

test('the deadline is reported so an operator can tell a timeout from a refusal', async () => {
  const result = await probeWithDeadline(never, 60)
  assert.match(result.error ?? '', /60/, 'the error names the deadline it exceeded')
})

test('a probe that throws reports the failure, not a timeout', async () => {
  const result = await probeWithDeadline(async () => { throw new Error('connection refused') }, 500)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'connection refused')
})

// A slow-but-alive dependency must not be declared dead on a transient blip
// shorter than the deadline.
test('work that finishes inside the deadline still counts as healthy', async () => {
  const result = await probeWithDeadline(() => new Promise((resolve) => setTimeout(resolve, 30)), 300)
  assert.equal(result.ok, true)
})
