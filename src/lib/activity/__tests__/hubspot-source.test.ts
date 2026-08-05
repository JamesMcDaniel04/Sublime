import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hubspotDealActivity, hubspotStageChangeActivities } from '../sources/hubspot'
import { sweepSources } from '../incremental-sync'

const deal = {
  id: 'deal_42',
  properties: {
    dealname: 'Acme expansion',
    dealstage: 'qualifiedtobuy',
    createdate: '2026-07-01T12:00:00Z',
    hubspot_owner_id: 'owner_7',
  },
}

test('normalizes a deal: owner actor, stage context, stable dedupe key', () => {
  const activity = hubspotDealActivity(deal)
  assert.ok(activity)
  assert.equal(activity.source, 'hubspot')
  assert.equal(activity.action, 'created_deal')
  assert.equal(activity.actorRef, 'owner_7')
  assert.equal(activity.entityRef, 'deal_42')
  assert.equal(activity.entityName, 'Acme expansion')
  assert.deepEqual(activity.businessContext, { stage: 'qualifiedtobuy' })
  assert.equal(activity.dedupeKey, 'hubspot:deal:deal_42')
  assert.equal(activity.occurredAt.toISOString(), '2026-07-01T12:00:00.000Z')
})

test('ownerless deals fall back to unknown; id-less or dateless deals are dropped', () => {
  const ownerless = hubspotDealActivity({ ...deal, properties: { ...deal.properties, hubspot_owner_id: undefined } })
  assert.equal(ownerless?.actorRef, 'unknown')
  assert.equal(hubspotDealActivity({ ...deal, id: undefined }), null)
  assert.equal(hubspotDealActivity({ ...deal, properties: { ...deal.properties, createdate: 'garbage' } }), null)
})

const dealWithHistory = {
  id: 'deal_42',
  properties: {
    dealname: 'Acme expansion',
    dealstage: 'closedwon',
    createdate: '2026-07-01T12:00:00Z',
    hubspot_owner_id: 'owner_7',
  },
  propertiesWithHistory: {
    // HubSpot returns newest first.
    dealstage: [
      { value: 'closedwon', timestamp: '1785542400000' }, // 2026-08-01
      { value: 'contractsent', timestamp: '1785456000000' }, // 2026-07-31
      { value: 'qualifiedtobuy', timestamp: '1785369600000' }, // 2026-07-30
    ],
  },
}

test('stage history becomes transitions carrying previousState', () => {
  const events = hubspotStageChangeActivities(dealWithHistory)
  // 3 history entries = 2 transitions; the oldest entry is the initial stage.
  assert.equal(events.length, 2)

  const [newest, older] = events
  assert.equal(newest.action, 'deal_stage_changed')
  assert.equal(newest.entityType, 'deal')
  assert.equal(newest.entityRef, 'deal_42')
  assert.equal(newest.actorRef, 'owner_7')
  assert.deepEqual(newest.previousState, { stage: 'contractsent' })
  assert.deepEqual(newest.newState, { stage: 'closedwon' })
  assert.equal(newest.occurredAt.toISOString(), '2026-08-01T00:00:00.000Z')
  assert.equal(newest.dedupeKey, 'hubspot:deal:deal_42:stage:1785542400000')

  assert.deepEqual(older.previousState, { stage: 'qualifiedtobuy' })
  assert.deepEqual(older.newState, { stage: 'contractsent' })
})

test('stage history edge cases: single entry, absent history, bad timestamps', () => {
  // One entry is the initial stage, not a transition.
  assert.deepEqual(
    hubspotStageChangeActivities({
      ...dealWithHistory,
      propertiesWithHistory: { dealstage: [{ value: 'appointmentscheduled', timestamp: '1785369600000' }] },
    }),
    [],
  )
  assert.deepEqual(hubspotStageChangeActivities({ ...dealWithHistory, propertiesWithHistory: undefined }), [])
  assert.deepEqual(hubspotStageChangeActivities({ ...dealWithHistory, id: undefined }), [])
  // A malformed timestamp drops only the transition it belongs to.
  const partial = hubspotStageChangeActivities({
    ...dealWithHistory,
    propertiesWithHistory: {
      dealstage: [
        { value: 'closedwon', timestamp: 'garbage' },
        { value: 'contractsent', timestamp: '1785456000000' },
        { value: 'qualifiedtobuy', timestamp: '1785369600000' },
      ],
    },
  })
  assert.equal(partial.length, 1)
  assert.deepEqual(partial[0].newState, { stage: 'contractsent' })
})

test('sweep covers exactly the incremental sources with no live event path', () => {
  // Slack must stay out (webhooks already ingest live events — a sync would
  // double-route them); the webhook-less sources must all be in.
  assert.deepEqual(
    [...sweepSources()].sort((a, b) => a.localeCompare(b)),
    ['github', 'google_calendar', 'granola', 'hubspot'],
  )
})
