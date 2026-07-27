import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_DATAPOINT_ORIGIN,
  AGENT_WRITABLE_SOURCES,
  assertCapturedAt,
  canWriteDatapoint,
  writeRefusalMessage,
} from '@/lib/goals/agent-tool-policy'
import { METRIC_SOURCES } from '@/lib/goals/metric-sources'

test('only AI/human-owned sources are writable, and the allowlist is a real subset', () => {
  for (const source of ['manual', 'slack_assisted', 'gmail_assisted']) {
    assert.equal(canWriteDatapoint(source), true, `${source} should be writable`)
  }
  for (const source of ['stripe', 'hubspot', 'salesforce', 'google_sheets', 'postgres', 'url']) {
    assert.equal(canWriteDatapoint(source), false, `${source} must never be writable`)
  }
  // Guards against a future metric source silently defaulting into the allowlist.
  for (const source of AGENT_WRITABLE_SOURCES) {
    assert.ok(
      (METRIC_SOURCES as readonly string[]).includes(source),
      `${source} is not a real metric source`,
    )
  }
})

test('agent writes are pinned to the existing assisted origin', () => {
  // The value is consumed by goals-port.ts, which needs a database to test.
  // Pinning it here is the regression guard: changing it to 'agent' or 'sync'
  // would silently break the UI's existing "AI-read" labeling.
  assert.equal(AGENT_DATAPOINT_ORIGIN, 'assisted')
})

test('the refusal names the owning system so the model does not retry blindly', () => {
  const message = writeRefusalMessage('stripe')
  assert.match(message, /Stripe/)
  assert.match(message, /Report the number in your output instead/)
  // An unmapped source still produces a usable sentence rather than "undefined".
  assert.match(writeRefusalMessage('mystery_source'), /mystery_source/)
})

test('capturedAt refuses the future and anything pre-dating the goal', () => {
  const now = new Date('2026-07-27T12:00:00Z')
  const created = new Date('2026-07-01T00:00:00Z')

  assert.doesNotThrow(() => assertCapturedAt(new Date('2026-07-20T09:00:00Z'), created, now))
  assert.doesNotThrow(() => assertCapturedAt(now, created, now))

  assert.throws(
    () => assertCapturedAt(new Date('2026-07-28T00:00:00Z'), created, now),
    /future/,
  )
  assert.throws(
    () => assertCapturedAt(new Date('2026-06-30T23:59:00Z'), created, now),
    /pre-date/,
  )
  assert.throws(() => assertCapturedAt(new Date('nonsense'), created, now), /valid date/)
})
