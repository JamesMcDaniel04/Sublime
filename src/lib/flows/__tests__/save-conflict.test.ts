import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasSaveConflict } from '../save-conflict'

test('no baseUpdatedAt (legacy caller) never conflicts', () => {
  assert.equal(hasSaveConflict(new Date('2026-07-11T10:00:00.000Z'), undefined), false)
})

test('matching baseUpdatedAt does not conflict', () => {
  const at = new Date('2026-07-11T10:00:00.123Z')
  assert.equal(hasSaveConflict(at, at.toISOString()), false)
})

test('stale baseUpdatedAt conflicts (someone saved since this client loaded)', () => {
  assert.equal(hasSaveConflict(new Date('2026-07-11T10:05:00.000Z'), '2026-07-11T10:00:00.000Z'), true)
})

test('unparseable baseUpdatedAt conflicts (fail closed, never clobber)', () => {
  assert.equal(hasSaveConflict(new Date(), 'not-a-date'), true)
})
