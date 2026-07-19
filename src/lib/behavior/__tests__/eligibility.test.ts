import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPatternEligible, MIN_OCCURRENCES, MIN_SPAN_DAYS, LEARNING_PERIOD_DAYS, MAX_STALE_DAYS } from '@/lib/behavior/eligibility'

const day = 24 * 60 * 60 * 1000
const now = new Date('2026-07-17T12:00:00Z')
const daysAgo = (d: number) => new Date(now.getTime() - d * day)
const good = { occurrenceCount: 3, firstSeenAt: daysAgo(10), lastSeenAt: daysAgo(1), status: 'open' }
const learnedUser = daysAgo(30) // first event 30 days ago — past learning period

test('constants are the spec values', () => {
  assert.equal(MIN_OCCURRENCES, 3)
  assert.equal(MIN_SPAN_DAYS, 7)
  assert.equal(LEARNING_PERIOD_DAYS, 7)
})

test('a 3x/10-day open pattern for a learned user is eligible', () => {
  assert.equal(isPatternEligible(good, learnedUser, now), true)
})

test('below occurrence threshold is ineligible', () => {
  assert.equal(isPatternEligible({ ...good, occurrenceCount: 2 }, learnedUser, now), false)
})

test('a burst (span < 7 days) is ineligible — one busy day is not a routine', () => {
  assert.equal(isPatternEligible({ ...good, firstSeenAt: daysAgo(2) }, learnedUser, now), false)
})

test('user inside the 7-day learning period gets NOTHING, even a strong pattern', () => {
  assert.equal(isPatternEligible(good, daysAgo(3), now), false)
})

test('unknown first-event date means still learning', () => {
  assert.equal(isPatternEligible(good, null, now), false)
})

test('dismissed patterns are never eligible', () => {
  assert.equal(isPatternEligible({ ...good, status: 'dismissed' }, learnedUser, now), false)
})

test('boundaries are inclusive: exactly 3 occurrences over exactly 7 days, learning period exactly over', () => {
  const boundary = { occurrenceCount: 3, firstSeenAt: daysAgo(7), lastSeenAt: now, status: 'open' }
  assert.equal(isPatternEligible(boundary, daysAgo(7), now), true)
})

test('staleness: a routine not observed in MAX_STALE_DAYS is no longer a routine', () => {
  assert.equal(MAX_STALE_DAYS, 30)
  const stale = { occurrenceCount: 12, firstSeenAt: daysAgo(180), lastSeenAt: daysAgo(31), status: 'open' }
  assert.equal(isPatternEligible(stale, learnedUser, now), false)
  const fresh = { ...stale, lastSeenAt: daysAgo(29) }
  assert.equal(isPatternEligible(fresh, learnedUser, now), true)
})

test('expired patterns are never eligible', () => {
  assert.equal(isPatternEligible({ ...good, status: 'expired' }, learnedUser, now), false)
})

test('capability_gap: occurrence/span minimums bypassed (evidence is absence), staleness kept', () => {
  const gap = { kind: 'capability_gap', occurrenceCount: 1, firstSeenAt: daysAgo(40), lastSeenAt: daysAgo(0), status: 'open' }
  assert.equal(isPatternEligible(gap, learnedUser, now), true)
  // A gap row not re-observed by recent mining runs goes stale like anything else.
  assert.equal(isPatternEligible({ ...gap, lastSeenAt: daysAgo(31) }, learnedUser, now), false)
  // Learning period still applies: no gap-nagging in week one.
  assert.equal(isPatternEligible(gap, daysAgo(3), now), false)
})

test('tool_correlation: needs MIN_CORRELATION_SESSIONS occurrences, not the generic 3', () => {
  const corr = { kind: 'tool_correlation', occurrenceCount: 4, firstSeenAt: daysAgo(20), lastSeenAt: daysAgo(1), status: 'open' }
  assert.equal(isPatternEligible(corr, learnedUser, now), false)
  assert.equal(isPatternEligible({ ...corr, occurrenceCount: 5 }, learnedUser, now), true)
})

test('peer_practice: gates like a gap — miner thresholds own the occurrence rule', () => {
  const peer = { kind: 'peer_practice', occurrenceCount: 3, firstSeenAt: daysAgo(20), lastSeenAt: daysAgo(0), status: 'open' }
  assert.equal(isPatternEligible(peer, learnedUser, now), true)
  assert.equal(isPatternEligible({ ...peer, lastSeenAt: daysAgo(31) }, learnedUser, now), false) // decays
  assert.equal(isPatternEligible(peer, daysAgo(3), now), false) // learning period still applies
})

test('archetype_gap: gates like a gap — staleness and learning period only', () => {
  const arch = { kind: 'archetype_gap', occurrenceCount: 12, firstSeenAt: daysAgo(2), lastSeenAt: daysAgo(0), status: 'open' }
  assert.equal(isPatternEligible(arch, learnedUser, now), true)
  assert.equal(isPatternEligible({ ...arch, lastSeenAt: daysAgo(31) }, learnedUser, now), false)
  assert.equal(isPatternEligible(arch, daysAgo(3), now), false)
})

test('outcome weights at the gate: rejected kinds suppressed, adopted kinds ranked first', async () => {
  const { listEligiblePatterns } = await import('@/lib/behavior/eligibility')
  const pattern = (slug: string, kind: string, occurrenceCount: number) => ({
    slug, kind, summary: `s:${slug}`, occurrenceCount,
    firstSeenAt: daysAgo(20), lastSeenAt: daysAgo(1), status: 'open', evidence: ['e1'],
  })
  const db = {
    userPattern: {
      findMany: async () => [
        pattern('seq:a>>b', 'sequence', 4),
        pattern('toolcorr:x+y', 'tool_correlation', 99),
        pattern('gap:dormant:z', 'capability_gap', 1),
      ],
    },
    userEvent: { findFirst: async () => ({ occurredAt: daysAgo(30) }) },
    userSuggestion: {
      findMany: async () => [
        // tool_correlation rejected twice → weight -2 → suppressed
        { title: 't1', status: 'dismissed', kind: 'new_flow', flowId: null, updatedAt: daysAgo(5), sourcePatternSlugs: ['toolcorr:x+y'] },
        { title: 't2', status: 'dismissed', kind: 'new_flow', flowId: null, updatedAt: daysAgo(10), sourcePatternSlugs: ['toolcorr:x+q'] },
        // sequence adopted → weight +2 → ranked above the gap despite ties
        { title: 't3', status: 'accepted', kind: 'new_flow', flowId: 'f-1', updatedAt: daysAgo(20), sourcePatternSlugs: ['seq:a>>b'] },
      ],
    },
    flow: { findMany: async () => [{ id: 'f-1', status: 'ACTIVE', publishedGraph: null }] },
  }
  const result = await listEligiblePatterns('org-1', 'u-1', db as never)
  assert.deepEqual(result.map((p) => p.kind), ['sequence', 'capability_gap'])
})

test('outcome-weights load failure degrades to unweighted gating, not an empty list', async () => {
  const { listEligiblePatterns } = await import('@/lib/behavior/eligibility')
  const db = {
    userPattern: {
      findMany: async () => [{
        slug: 'seq:a>>b', kind: 'sequence', summary: 's', occurrenceCount: 4,
        firstSeenAt: daysAgo(20), lastSeenAt: daysAgo(1), status: 'open', evidence: [],
      }],
    },
    userEvent: { findFirst: async () => ({ occurredAt: daysAgo(30) }) },
    userSuggestion: { findMany: async () => { throw new Error('db down') } },
    flow: { findMany: async () => [] },
  }
  const result = await listEligiblePatterns('org-1', 'u-1', db as never)
  assert.equal(result.length, 1)
})
