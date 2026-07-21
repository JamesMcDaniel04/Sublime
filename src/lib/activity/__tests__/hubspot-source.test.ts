import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hubspotDealActivity } from '../sources/hubspot'
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

test('sweep covers exactly the incremental sources with no live event path', () => {
  // Slack must stay out (webhooks already ingest live events — a sync would
  // double-route them); the three webhook-less sources must all be in.
  assert.deepEqual([...sweepSources()].sort((a, b) => a.localeCompare(b)), ['github', 'google_calendar', 'hubspot'])
})
