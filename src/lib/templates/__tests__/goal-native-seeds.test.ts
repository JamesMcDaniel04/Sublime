import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GOAL_METRIC_COLLECTOR_KEY,
  GOAL_NATIVE_SEEDS,
  GOAL_PACE_AUDITOR_KEY,
  GOAL_PERIOD_CLOSE_KEY,
} from '@/lib/templates/goal-native-seeds'
import { SEED_CATALOGUE, getSeedByKey } from '@/lib/templates/catalogue'

test('the three goal-native seeds are in the catalogue and resolvable by key', () => {
  assert.equal(GOAL_NATIVE_SEEDS.length, 3)
  for (const key of [GOAL_PACE_AUDITOR_KEY, GOAL_METRIC_COLLECTOR_KEY, GOAL_PERIOD_CLOSE_KEY]) {
    assert.ok(getSeedByKey(key), `${key} is not resolvable through the catalogue`)
  }
})

test('goal-native seeds activate the goals plane through integrations', () => {
  for (const seed of GOAL_NATIVE_SEEDS) {
    assert.ok(
      (seed.integrations ?? []).includes('goals'),
      `${seed.seedKey} must list 'goals' in integrations to activate the plane`,
    )
  }
})

test('NO seed anywhere requires goals — it has no connection to make', () => {
  // The sublime-goals descriptor is available: () => true and is scoped by
  // GoalContribution, not credentials. Listing it in requiredIntegrations would
  // make readiness() report 'connect' forever against an unconnectable tool.
  for (const seed of SEED_CATALOGUE) {
    assert.ok(
      !seed.requiredIntegrations.includes('goals'),
      `${seed.seedKey} must not require 'goals'`,
    )
  }
})

test('the metric collector is always deployable', () => {
  const collector = getSeedByKey(GOAL_METRIC_COLLECTOR_KEY)!
  // Delivery-exempt: its output is a datapoint on the goal, not a message, so
  // normalizeDelivery must leave it alone. This is what keeps "every goal has
  // something deployable with zero integrations" true.
  assert.equal(collector.deliversToGoal, true)
  assert.deepEqual(collector.requiredIntegrations, [])
})

test('goal-native seeds are department-agnostic', () => {
  // Their tools are the goals plane plus glue (slack/gmail/http), which
  // departmentsForTools treats as no department signal. Claiming a real
  // department would assert domain expertise no tool backs, and the
  // catalogue's anchor invariant rejects it.
  for (const seed of GOAL_NATIVE_SEEDS) {
    assert.deepEqual(seed.departments, ['general'], `${seed.seedKey} should be general`)
  }
})

test('the two posting agents DO normalize to a Slack delivery integration', () => {
  for (const key of [GOAL_PACE_AUDITOR_KEY, GOAL_PERIOD_CLOSE_KEY]) {
    const seed = getSeedByKey(key)!
    assert.ok(
      seed.requiredIntegrations.includes('slack'),
      `${key} posts messages and must carry a delivery integration`,
    )
  }
})

test('the delivery exemption stays minimal — exactly one seed uses it', () => {
  const exempt = SEED_CATALOGUE.filter((seed) => seed.deliversToGoal)
  assert.deepEqual(exempt.map((seed) => seed.seedKey), [GOAL_METRIC_COLLECTOR_KEY])
})

test('goal-native seeds are scheduled, not manual — they must run on their own', () => {
  for (const seed of GOAL_NATIVE_SEEDS) {
    assert.equal(seed.trigger?.type, 'schedule', `${seed.seedKey} must be scheduled`)
    assert.equal(seed.trigger?.schedule?.isActive, true)
  }
})
