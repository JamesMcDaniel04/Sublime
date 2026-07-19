import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Plan } from '@prisma/client'
import {
  limitsForPlan,
  monthlyTokenAllowance,
  tokensToCredits,
  formatLimit,
  TOKENS_PER_CREDIT,
  UNLIMITED,
} from '../limits'

test('trial workspaces get exactly Individual-shaped limits', () => {
  const trial = limitsForPlan(Plan.TRIAL)
  const individual = limitsForPlan(Plan.STARTER)
  assert.deepEqual(
    { ...trial, label: individual.label },
    individual,
  )
  assert.equal(trial.maxAgents, 5)
  assert.equal(trial.maxFlows, 5)
  assert.equal(trial.maxIntegrations, 5)
  assert.equal(trial.monthlyCredits, 10_000)
  assert.equal(trial.seats, 1)
})

test('team plan: 5 seats, 50k credits, 25 agents/flows, unlimited integrations', () => {
  const team = limitsForPlan(Plan.PROFESSIONAL)
  assert.equal(team.seats, 5)
  assert.equal(team.monthlyCredits, 50_000)
  assert.equal(team.maxAgents, 25)
  assert.equal(team.maxFlows, 25)
  assert.equal(team.maxIntegrations, UNLIMITED)
})

test('business plan: 25 seats, 250k credits, unlimited agents/flows/integrations', () => {
  const business = limitsForPlan(Plan.BUSINESS)
  assert.equal(business.seats, 25)
  assert.equal(business.monthlyCredits, 250_000)
  assert.equal(business.maxAgents, UNLIMITED)
  assert.equal(business.maxFlows, UNLIMITED)
  assert.equal(business.maxIntegrations, UNLIMITED)
})

test('token allowance converts credits at 1,000 tokens per credit', () => {
  assert.equal(monthlyTokenAllowance(Plan.STARTER), 10_000 * TOKENS_PER_CREDIT)
  assert.equal(monthlyTokenAllowance(Plan.PROFESSIONAL), 50_000 * TOKENS_PER_CREDIT)
  assert.equal(monthlyTokenAllowance(Plan.BUSINESS), 250_000 * TOKENS_PER_CREDIT)
  assert.equal(monthlyTokenAllowance(Plan.ENTERPRISE), UNLIMITED)
})

test('tokensToCredits rounds up and clamps negatives', () => {
  assert.equal(tokensToCredits(0), 0)
  assert.equal(tokensToCredits(1), 1)
  assert.equal(tokensToCredits(1000), 1)
  assert.equal(tokensToCredits(1001), 2)
  assert.equal(tokensToCredits(-50), 0)
})

test('formatLimit renders Infinity as Unlimited', () => {
  assert.equal(formatLimit(5), '5')
  assert.equal(formatLimit(UNLIMITED), 'Unlimited')
})
