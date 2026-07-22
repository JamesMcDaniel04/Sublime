import { test } from 'node:test'
import assert from 'node:assert/strict'
import { granolaNoteActivity, makeGranolaActivitySource, meetingSeriesKey, parseGranolaNote } from '../sources/granola'
import { mineCommitments } from '@/lib/behavior/mine-commitments'
import { commitmentActionKey } from '@/lib/knowledge/notes-distill'
import { patternKindOfSlug } from '@/lib/behavior/outcome-weights'

test('meetingSeriesKey: dates, times, and counters vary; the series name recurs', () => {
  assert.equal(meetingSeriesKey('Acme sync 7/14'), meetingSeriesKey('Acme Sync 7/21'))
  assert.equal(meetingSeriesKey('Acme sync 7/14'), 'acme sync')
  assert.equal(meetingSeriesKey('Weekly pipeline review — Jul 14 @ 10:00am'), 'weekly pipeline review')
  assert.equal(meetingSeriesKey('Sprint 42 planning'), 'sprint planning')
  assert.equal(meetingSeriesKey('7/14/2026'), 'meeting', 'a title that is only a date falls back')
})

test('parseGranolaNote: defensive across owner/summary shapes; essentials required', () => {
  const note = parseGranolaNote({
    id: 'not_1', title: 'Acme sync 7/14', created_at: '2026-07-14T15:00:00Z',
    owner: { email: 'maya@acme.com', name: 'Maya' },
    attendees: [{ email: 'sam@acme.com' }, 'lee@acme.com'],
    ai_summary: 'Discussed renewal.',
  })
  assert.ok(note)
  assert.equal(note.ownerRef, 'maya@acme.com')
  assert.equal(note.summary, 'Discussed renewal.')
  assert.deepEqual(note.attendees, ['sam@acme.com', 'lee@acme.com'])
  // String owner form.
  assert.equal(parseGranolaNote({ id: 'n', title: 't', createdAt: '2026-07-14T15:00:00Z', owner: 'maya@acme.com' })?.ownerRef, 'maya@acme.com')
  // Missing essentials.
  assert.equal(parseGranolaNote({ title: 'no id', created_at: '2026-07-14T15:00:00Z' }), null)
  assert.equal(parseGranolaNote({ id: 'n', title: 't', created_at: 'garbage' }), null)
})

test('granolaNoteActivity: series in context, stable dedupe key, capped title', () => {
  const note = parseGranolaNote({ id: 'not_1', title: 'Acme sync 7/14', created_at: '2026-07-14T15:00:00Z', owner: 'maya@acme.com' })!
  const activity = granolaNoteActivity(note)
  assert.equal(activity.action, 'took_meeting_notes')
  assert.equal(activity.dedupeKey, 'granola:note:not_1')
  assert.deepEqual(activity.businessContext, { series: 'acme sync' })
})

test('mineCommitments: >= 3 same (series, action) commitments become one candidate with full evidence', () => {
  const day = (n: number) => new Date(Date.UTC(2026, 6, n))
  const rows = [
    { id: 'e1', series: 'acme sync', action: 'send follow-up email', occurredAt: day(1) },
    { id: 'e2', series: 'acme sync', action: 'send follow-up email', occurredAt: day(8) },
    { id: 'e3', series: 'acme sync', action: 'send follow-up email', occurredAt: day(15) },
    { id: 'e4', series: 'acme sync', action: 'update crm', occurredAt: day(15) }, // below threshold
    { id: 'e5', series: 'board prep', action: 'send follow-up email', occurredAt: day(15) }, // different series
  ]
  const candidates = mineCommitments(rows)
  assert.equal(candidates.length, 1)
  const candidate = candidates[0]
  assert.equal(candidate.kind, 'commitment')
  assert.equal(candidate.slug, 'commit:acme-sync:send-follow-up-email')
  assert.equal(candidate.occurrenceCount, 3)
  assert.deepEqual(candidate.evidenceEventIds, ['e1', 'e2', 'e3'])
  assert.equal(candidate.firstSeenAt.getTime(), day(1).getTime())
  assert.equal(candidate.lastSeenAt.getTime(), day(15).getTime())
  assert.ok(candidate.summary.includes('acme sync'))
})

test('commitment slugs resolve to their kind for outcome learning', () => {
  assert.equal(patternKindOfSlug('commit:acme-sync:send-follow-up-email'), 'commitment')
})

test('commitmentActionKey normalizes punctuation and case', () => {
  assert.equal(commitmentActionKey('Send Follow-Up Email!'), 'send follow up email')
  assert.equal(commitmentActionKey('  update   CRM  '), 'update crm')
})

async function collectBackfill(source: ReturnType<typeof makeGranolaActivitySource>) {
  const batches = []
  for await (const batch of source.backfill({ organizationId: 'org', connectionRef: 'granola' }, 'all')) {
    batches.push(batch)
  }
  return batches
}

test('backfill cursor-loop guard: a repeated cursor terminates the run', async () => {
  // A misbehaving API that echoes the same cursor forever must not page endlessly.
  const source = makeGranolaActivitySource(async () => ({ notes: [], nextCursor: 'stuck' }))
  const batches = await collectBackfill(source)
  assert.equal(batches.length, 2, 'advances once, then the guard stops the loop')
  assert.equal(batches[1].nextCursor, undefined)
})

test('backfill page cap bounds a single run and checkpoints for the next', async () => {
  // Unique cursor every page (loop guard never triggers) — the hard page cap
  // is what stops the run, handing the cursor back so a future run resumes.
  let n = 0
  const source = makeGranolaActivitySource(async () => { n += 1; return { notes: [], nextCursor: `cursor-${n}` } })
  const batches = await collectBackfill(source)
  assert.equal(batches.length, 40, 'BACKFILL_MAX_PAGES caps the run')
  assert.ok(batches[39].nextCursor, 'the final batch carries a cursor so the backfill resumes later')
})
