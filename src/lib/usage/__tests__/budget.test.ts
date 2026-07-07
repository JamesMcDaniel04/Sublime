import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { tokenLimitForTier, TIER_MONTHLY_TOKEN_LIMITS } from '../budget'

const ORIGINAL = { ...process.env }
beforeEach(() => {
  process.env = { ...ORIGINAL }
  delete process.env.AGENT_MONTHLY_TOKEN_LIMIT
})

test('tier limit applies when no env override', () => {
  assert.equal(tokenLimitForTier('sales_ai'), TIER_MONTHLY_TOKEN_LIMITS.sales_ai)
})

test('unknown or null tier is unlimited without env', () => {
  assert.equal(tokenLimitForTier(null), 0)
  assert.equal(tokenLimitForTier('mystery'), 0)
})

test('env override alone applies when tier has no limit', () => {
  process.env.AGENT_MONTHLY_TOKEN_LIMIT = '5000'
  assert.equal(tokenLimitForTier(null), 5000)
})

test('with both set, the more permissive ceiling wins', () => {
  process.env.AGENT_MONTHLY_TOKEN_LIMIT = '1000'
  assert.equal(tokenLimitForTier('sales_ai'), TIER_MONTHLY_TOKEN_LIMITS.sales_ai)
  process.env.AGENT_MONTHLY_TOKEN_LIMIT = String(TIER_MONTHLY_TOKEN_LIMITS.sales_ai + 1)
  assert.equal(tokenLimitForTier('sales_ai'), TIER_MONTHLY_TOKEN_LIMITS.sales_ai + 1)
})
