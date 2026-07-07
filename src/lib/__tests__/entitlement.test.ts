import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateEntitlement, entitlementFresh, ENTITLEMENT_TTL_MS, salesAiNativeMode } from '../entitlement'

const ORIGINAL_ENV = { ...process.env }
beforeEach(() => {
  process.env = { ...ORIGINAL_ENV }
  delete process.env.PEOPLE_AI_SERVICE_CLIENT_ID
  delete process.env.PEOPLE_AI_SERVICE_CLIENT_SECRET
})

test('salesAiNativeMode: true only when both service credentials are set', () => {
  assert.equal(salesAiNativeMode(), false)
  process.env.PEOPLE_AI_SERVICE_CLIENT_ID = 'id'
  assert.equal(salesAiNativeMode(), false)
  process.env.PEOPLE_AI_SERVICE_CLIENT_SECRET = 'secret'
  assert.equal(salesAiNativeMode(), true)
})

test('org with an active Sales AI connection is entitled', () => {
  const result = evaluateEntitlement({
    peopleAiTeamId: 'team-1',
    connections: [{ status: 'active', membershipId: 'm-1', teamId: 'team-1' }],
  })
  assert.equal(result.entitled, true)
  assert.equal(result.tier, 'sales_ai')
  assert.equal(result.status, 'entitled')
})

test('org with no connections is not entitled', () => {
  const result = evaluateEntitlement({ peopleAiTeamId: null, connections: [] })
  assert.equal(result.entitled, false)
  assert.equal(result.status, 'unentitled')
})

test('org whose only connections failed refresh is not entitled (license revoked)', () => {
  const result = evaluateEntitlement({
    peopleAiTeamId: 'team-1',
    connections: [
      { status: 'refresh_failed', membershipId: 'm-1', teamId: 'team-1' },
      { status: 'revoked', membershipId: 'm-2', teamId: 'team-1' },
    ],
  })
  assert.equal(result.entitled, false)
  assert.equal(result.status, 'unentitled')
})

test('connection without SalesAI context (no membership) does not entitle', () => {
  const result = evaluateEntitlement({
    peopleAiTeamId: null,
    connections: [{ status: 'active', membershipId: null, teamId: null }],
  })
  assert.equal(result.entitled, false)
})

test('entitlementFresh: fresh inside TTL, stale outside, never fresh when unknown', () => {
  const now = Date.now()
  assert.equal(entitlementFresh({ entitlementStatus: 'entitled', entitlementCheckedAt: new Date(now - 1000) }, now), true)
  assert.equal(entitlementFresh({ entitlementStatus: 'entitled', entitlementCheckedAt: new Date(now - ENTITLEMENT_TTL_MS - 1) }, now), false)
  assert.equal(entitlementFresh({ entitlementStatus: 'unknown', entitlementCheckedAt: new Date(now) }, now), false)
  assert.equal(entitlementFresh({ entitlementStatus: 'entitled', entitlementCheckedAt: null }, now), false)
})
