import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapEventToSignal, SIGNAL_TYPES } from '../map'

test('maps each documented SalesAI event type', () => {
  for (const type of SIGNAL_TYPES) {
    const mapped = mapEventToSignal({ type, id: `evt_${type}`, data: {} })
    assert.ok(mapped, `${type} should map`)
    assert.equal(mapped!.type, type)
    assert.equal(mapped!.dedupeKey, `evt_${type}`)
  }
})

test('extracts entity references from common payload shapes', () => {
  const mapped = mapEventToSignal({
    type: 'deal.risk_detected',
    id: 'evt_9',
    data: {
      opportunity_id: 'opp-1',
      account_id: 'acct-2',
      stakeholder_id: 'stk-3',
      url: 'https://app.people.ai/deals/opp-1',
      risk_level: 'high',
    },
  })
  assert.equal(mapped!.opportunityId, 'opp-1')
  assert.equal(mapped!.accountId, 'acct-2')
  assert.equal(mapped!.stakeholderId, 'stk-3')
  assert.equal(mapped!.provenanceUrl, 'https://app.people.ai/deals/opp-1')
})

test('nested/flat key variants are tolerated', () => {
  const mapped = mapEventToSignal({
    event: 'stakeholder.engagement_changed',
    event_id: 'evt_10',
    opportunityId: 'opp-x',
    accountId: 'acct-y',
    link: 'https://app.people.ai/x',
  })
  assert.equal(mapped!.type, 'stakeholder.engagement_changed')
  assert.equal(mapped!.dedupeKey, 'evt_10')
  assert.equal(mapped!.opportunityId, 'opp-x')
  assert.equal(mapped!.accountId, 'acct-y')
  assert.equal(mapped!.provenanceUrl, 'https://app.people.ai/x')
})

test('unknown event types return null', () => {
  assert.equal(mapEventToSignal({ type: 'unrelated.event', id: 'e' }), null)
  assert.equal(mapEventToSignal({}), null)
})

test('missing event id falls back to a stable content hash', () => {
  const payload = { type: 'forecast.updated', data: { period: 'Q3' } }
  const a = mapEventToSignal({ ...payload })
  const b = mapEventToSignal({ ...payload })
  assert.ok(a!.dedupeKey.startsWith('sha256:'))
  assert.equal(a!.dedupeKey, b!.dedupeKey, 'same content ⇒ same dedupe key')
})
