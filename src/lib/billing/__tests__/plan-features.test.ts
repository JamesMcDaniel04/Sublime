import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Plan } from '@/generated/prisma/client'
import { planFeatureBullets } from '../plan-features'
import { PLAN_LIMITS } from '../limits'

const bulletsFor = (plan: Plan) => planFeatureBullets(plan).join(' | ')

// The defect: the pricing grid was a hardcoded list that never read the limits
// it advertises, so the page could promise "5 agents" while the enforcer
// allowed 50 — with nothing failing when they drifted apart.
test('every advertised number comes from the limit the app actually enforces', () => {
  for (const plan of [Plan.STARTER, Plan.PROFESSIONAL, Plan.BUSINESS] as const) {
    const limits = PLAN_LIMITS[plan]
    const text = bulletsFor(plan)
    assert.match(text, new RegExp(limits.monthlyCredits.toLocaleString('en-US')), `${plan} credits`)
    if (Number.isFinite(limits.maxAgents)) {
      assert.match(text, new RegExp(`${limits.maxAgents} agents`), `${plan} agents`)
    }
  }
})

test('Individual advertises exactly what Individual enforces', () => {
  const text = bulletsFor(Plan.STARTER)
  assert.match(text, /1 seat included/)
  assert.match(text, /10,000 credits/)
  assert.match(text, /5 agents · 5 flows/)
  assert.match(text, /1 core specialist area/)
})

test('Team advertises the seats, caps and areas Team enforces', () => {
  const text = bulletsFor(Plan.PROFESSIONAL)
  assert.match(text, /10 seats included/)
  assert.match(text, /50,000 credits/)
  assert.match(text, /25 agents · 25 flows/)
  assert.match(text, /Every core specialist area/)
})

test('an unlimited cap reads as unlimited rather than as Infinity', () => {
  const text = bulletsFor(Plan.BUSINESS)
  assert.match(text, /Unlimited agents & flows/)
  assert.ok(!text.includes('Infinity'), 'a raw Infinity must never reach the pricing page')
})

test('Enterprise advertises unlimited usage without printing a number', () => {
  const text = bulletsFor(Plan.ENTERPRISE)
  assert.match(text, /Unlimited/)
  assert.ok(!/\d,\d{3} credits/.test(text), 'no finite credit figure on an unlimited plan')
})

// Capabilities are entitlements, not numbers; they belong in the same list so
// the matrix and the marketing copy cannot disagree either.
test('plan-gated capabilities are advertised only where they are granted', () => {
  assert.ok(!/activity history/i.test(bulletsFor(Plan.STARTER)), 'Individual does not get history')
  assert.match(bulletsFor(Plan.PROFESSIONAL), /history/i)
  assert.match(bulletsFor(Plan.ENTERPRISE), /Zero data retention/i)
  assert.ok(!/Zero data retention/i.test(bulletsFor(Plan.BUSINESS)), 'retention is Enterprise-only')
})

test('every plan produces a non-empty, de-duplicated bullet list', () => {
  for (const plan of Object.values(Plan)) {
    const bullets = planFeatureBullets(plan)
    assert.ok(bullets.length >= 4, `${plan} needs a real feature list`)
    assert.equal(new Set(bullets).size, bullets.length, `${plan} repeats a bullet`)
  }
})
