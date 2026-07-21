import { test } from 'node:test'
import assert from 'node:assert/strict'
import { googleCalendarActivity } from '../sources/google-calendar'

const base = {
  id: 'evt_1',
  status: 'confirmed',
  summary: 'Weekly pipeline review with the sales team and a very long tail that should get truncated'.padEnd(260, 'x'),
  organizer: { email: 'maya@acme.com', displayName: 'Maya' },
  start: { dateTime: '2026-07-14T15:00:00Z' },
  attendees: [
    { email: 'maya@acme.com', responseStatus: 'accepted' },
    { email: 'sam@acme.com', responseStatus: 'needsAction' },
    { email: 'room-4@resource.calendar.google.com', resource: true },
    { email: 'declined@acme.com', responseStatus: 'declined' },
  ],
}

test('normalizes a held meeting: organizer actor, filtered attendees, capped title', () => {
  const activity = googleCalendarActivity(base)
  assert.ok(activity)
  assert.equal(activity.source, 'google_calendar')
  assert.equal(activity.action, 'held_meeting')
  assert.equal(activity.actorRef, 'maya@acme.com')
  assert.equal(activity.entityRef, 'evt_1')
  assert.equal(activity.entityName?.length, 200)
  // Rooms and decliners are not participants in the observed meeting.
  assert.deepEqual(activity.participants, ['maya@acme.com', 'sam@acme.com'])
  assert.equal((activity.businessContext as { attendeeCount: number }).attendeeCount, 2)
  assert.equal(activity.dedupeKey, 'gcal:event:evt_1')
  assert.equal(activity.occurredAt.toISOString(), '2026-07-14T15:00:00.000Z')
})

test('cancelled, id-less, timeless, and organizer-less events are dropped', () => {
  assert.equal(googleCalendarActivity({ ...base, status: 'cancelled' }), null)
  assert.equal(googleCalendarActivity({ ...base, id: undefined }), null)
  assert.equal(googleCalendarActivity({ ...base, start: undefined }), null)
  assert.equal(googleCalendarActivity({ ...base, organizer: undefined, creator: undefined }), null)
})

test('all-day events use the date form and flag allDay', () => {
  const activity = googleCalendarActivity({ ...base, start: { date: '2026-07-14' } })
  assert.ok(activity)
  assert.equal((activity.businessContext as { allDay: boolean }).allDay, true)
})

test('creator email is the actor fallback when organizer is absent', () => {
  const activity = googleCalendarActivity({ ...base, organizer: undefined, creator: { email: 'sam@acme.com' } })
  assert.ok(activity)
  assert.equal(activity.actorRef, 'sam@acme.com')
})
