import test from 'node:test'
import assert from 'node:assert/strict'
import { findRuleCandidates } from '../work-signals'

const skipped = (signals: Record<string, unknown>, reason = 'too_early') => ({
  disposition: 'skipped' as const,
  skipReason: reason,
  signals,
})
const used = (signals: Record<string, unknown>) => ({
  disposition: 'used' as const,
  skipReason: null,
  signals,
})

test('finds the split that separates skipped from used', () => {
  const rows = [
    skipped({ daysCold: 4 }),
    skipped({ daysCold: 9 }),
    skipped({ daysCold: 11 }),
    skipped({ daysCold: 8 }),
    skipped({ daysCold: 12 }),
    used({ daysCold: 21 }),
    used({ daysCold: 30 }),
    used({ daysCold: 45 }),
  ]
  const candidates = findRuleCandidates(rows)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].signal, 'daysCold')
  assert.equal(candidates[0].skippedCount, 5)
  assert.equal(candidates[0].totalCount, 5, 'the band holds only the skipped side')
  assert.match(candidates[0].statement, /under/i)
  assert.equal(candidates[0].topSkipReason, 'too_early')
})

test('a signal that does not separate yields no rule', () => {
  // Skipped and used are interleaved — no split is clean enough.
  const rows = [
    skipped({ daysCold: 5 }),
    used({ daysCold: 6 }),
    skipped({ daysCold: 7 }),
    used({ daysCold: 8 }),
    skipped({ daysCold: 9 }),
    used({ daysCold: 10 }),
    skipped({ daysCold: 11 }),
    used({ daysCold: 12 }),
  ]
  assert.deepEqual(findRuleCandidates(rows), [])
})

test('a band below MIN_RULE_SAMPLE never becomes a rule', () => {
  // 4 skipped, cleanly separated — but one bad week must not invent a rule.
  const rows = [
    skipped({ daysCold: 2 }),
    skipped({ daysCold: 3 }),
    skipped({ daysCold: 4 }),
    skipped({ daysCold: 5 }),
    used({ daysCold: 40 }),
    used({ daysCold: 50 }),
  ]
  assert.deepEqual(findRuleCandidates(rows), [])
})

test('a band below MIN_SKIP_RATE never becomes a rule', () => {
  // 5 in the band but only 3 skipped = 0.6 — a rule should be nearly always right.
  const rows = [
    skipped({ daysCold: 1 }),
    skipped({ daysCold: 2 }),
    skipped({ daysCold: 3 }),
    used({ daysCold: 4 }),
    used({ daysCold: 5 }),
    used({ daysCold: 40 }),
    used({ daysCold: 50 }),
    used({ daysCold: 60 }),
  ]
  assert.deepEqual(findRuleCandidates(rows), [])
})

test('categorical signals count per value', () => {
  const rows = [
    skipped({ stage: 'prospecting' }, 'not_relevant'),
    skipped({ stage: 'prospecting' }, 'not_relevant'),
    skipped({ stage: 'prospecting' }, 'not_relevant'),
    skipped({ stage: 'prospecting' }, 'wrong_contact'),
    skipped({ stage: 'prospecting' }, 'not_relevant'),
    used({ stage: 'negotiation' }),
    used({ stage: 'negotiation' }),
  ]
  const candidates = findRuleCandidates(rows)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].signal, 'stage')
  assert.match(candidates[0].statement, /prospecting/)
  assert.equal(candidates[0].topSkipReason, 'not_relevant', 'the most common reason wins')
})

test('rows with no signals are ignored without throwing', () => {
  const rows = [
    { disposition: 'skipped' as const, skipReason: 'too_early', signals: null },
    { disposition: 'used' as const, skipReason: null, signals: {} },
  ]
  assert.deepEqual(findRuleCandidates(rows), [])
})

test('non-numeric, non-string signal values are ignored', () => {
  // Nested objects and arrays are not something a statement can describe.
  const rows = Array.from({ length: 6 }, () => skipped({ nested: { a: 1 }, list: [1, 2], ok: 3 }))
  const signals = findRuleCandidates(rows).map((candidate) => candidate.signal)
  assert.equal(signals.includes('nested'), false)
  assert.equal(signals.includes('list'), false)
})

test('pending rows never count as evidence', () => {
  // Only a settled human decision is evidence. `pending` means nobody looked,
  // and treating silence as rejection would teach the agent to stop producing
  // simply because the queue is backed up.
  const rows = [
    ...Array.from({ length: 6 }, () => ({
      disposition: 'pending' as const,
      skipReason: null,
      signals: { daysCold: 3 },
    })),
    used({ daysCold: 40 }),
  ]
  assert.deepEqual(findRuleCandidates(rows), [])
})

test('several separating signals each yield a candidate', () => {
  const rows = [
    ...Array.from({ length: 5 }, () => skipped({ daysCold: 3, contacts: 1 })),
    used({ daysCold: 40, contacts: 5 }),
    used({ daysCold: 50, contacts: 6 }),
  ]
  const signals = findRuleCandidates(rows)
    .map((candidate) => candidate.signal)
    .sort()
  assert.deepEqual(signals, ['contacts', 'daysCold'])
})

test('a signal arriving as both a number and a string is skipped, not compared across types', () => {
  const rows = [
    ...Array.from({ length: 4 }, () => skipped({ stage: 'prospecting' })),
    skipped({ stage: 3 }),
    used({ stage: 'negotiation' }),
  ]
  assert.deepEqual(findRuleCandidates(rows), [])
})
