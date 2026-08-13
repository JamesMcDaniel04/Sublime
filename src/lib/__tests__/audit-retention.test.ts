import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AUDIT_RETENTION_FLOOR_DAYS, auditRetentionDays } from '../audit'

test('audit retention defaults to a year, well past the operational sweeps', () => {
  assert.equal(auditRetentionDays(undefined), 365)
})

test('an explicit longer retention is honoured', () => {
  assert.equal(auditRetentionDays('730'), 730)
})

test('retention below the floor is raised to it, not obeyed', () => {
  // A typo'd env var must not be able to quietly shred the compliance record
  // that the rest of this work exists to produce.
  assert.equal(auditRetentionDays('7'), AUDIT_RETENTION_FLOOR_DAYS)
  assert.equal(auditRetentionDays('0'), AUDIT_RETENTION_FLOOR_DAYS)
})

test('a negative or unparseable value falls back to the default rather than deleting everything', () => {
  assert.equal(auditRetentionDays('-1'), AUDIT_RETENTION_FLOOR_DAYS)
  assert.equal(auditRetentionDays('not-a-number'), 365)
  assert.equal(auditRetentionDays(''), 365)
})
