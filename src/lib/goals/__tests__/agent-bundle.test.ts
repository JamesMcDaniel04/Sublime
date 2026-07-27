import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleForGoal } from '@/lib/goals/agent-bundle'
import {
  GOAL_METRIC_COLLECTOR_KEY,
  GOAL_PACE_AUDITOR_KEY,
  GOAL_PERIOD_CLOSE_KEY,
} from '@/lib/templates/goal-native-seeds'

const keys = (entries: { seedKey: string }[]) => entries.map((entry) => entry.seedKey)

test('curated entries lead, then goal-native, and no fallback appears', () => {
  const bundle = bundleForGoal({
    templateKey: 'sales-org-pipeline-coverage',
    kind: 'custom_kpi',
    source: 'hubspot',
    recurrence: null,
  })
  const origins = bundle.map((entry) => entry.origin)
  assert.equal(origins[0], 'curated')
  assert.ok(!origins.includes('kind_match'), 'a curated template must not fall back')
  // Ordering: every curated entry precedes every goal_native entry.
  assert.equal(origins.lastIndexOf('curated') < origins.indexOf('goal_native'), true)
})

test('the pace auditor is offered for every goal', () => {
  const bundle = bundleForGoal({ templateKey: null, kind: 'custom_kpi', source: 'stripe' })
  assert.ok(keys(bundle).includes(GOAL_PACE_AUDITOR_KEY))
})

test('the metric collector is offered only where the write policy permits', () => {
  for (const source of ['manual', 'slack_assisted', 'gmail_assisted']) {
    const bundle = bundleForGoal({ templateKey: null, kind: 'custom_kpi', source })
    assert.ok(
      keys(bundle).includes(GOAL_METRIC_COLLECTOR_KEY),
      `collector should be offered for ${source}`,
    )
  }
  for (const source of ['stripe', 'hubspot', 'salesforce', 'google_sheets', 'postgres', 'url']) {
    const bundle = bundleForGoal({ templateKey: null, kind: 'custom_kpi', source })
    assert.ok(
      !keys(bundle).includes(GOAL_METRIC_COLLECTOR_KEY),
      `collector must NOT be offered for ${source} — log_datapoint would refuse`,
    )
  }
})

test('an unknown source means pre-creation, so the collector is conditional not excluded', () => {
  const bundle = bundleForGoal({ templateKey: null, kind: 'custom_kpi', source: null })
  const collector = bundle.find((entry) => entry.seedKey === GOAL_METRIC_COLLECTOR_KEY)
  assert.ok(collector, 'collector should appear when the source is not yet chosen')
  assert.equal(collector.conditional, true)
})

test('the period close reporter needs a recurrence', () => {
  const recurring = bundleForGoal({
    templateKey: null,
    kind: 'revenue',
    source: 'stripe',
    recurrence: 'quarterly',
  })
  assert.ok(keys(recurring).includes(GOAL_PERIOD_CLOSE_KEY))

  const oneOff = bundleForGoal({
    templateKey: null,
    kind: 'revenue',
    source: 'stripe',
    recurrence: null,
  })
  assert.ok(!keys(oneOff).includes(GOAL_PERIOD_CLOSE_KEY))
})

test('fallback fires only when curation is empty or absent', () => {
  // marketing-personal-newsletter is curated as a deliberate [].
  const emptyCurated = bundleForGoal({
    templateKey: 'marketing-personal-newsletter',
    kind: 'lead_gen',
    source: 'google_sheets',
  })
  assert.ok(
    emptyCurated.some((entry) => entry.origin === 'kind_match'),
    'an empty curated list must fall back',
  )

  const noTemplate = bundleForGoal({ templateKey: null, kind: 'lead_gen', source: 'hubspot' })
  assert.ok(noTemplate.some((entry) => entry.origin === 'kind_match'))
})

test('an unknown templateKey degrades to the fallback rather than throwing', () => {
  const bundle = bundleForGoal({
    templateKey: 'deleted-template',
    kind: 'revenue',
    source: 'stripe',
  })
  assert.ok(bundle.length > 0)
  assert.ok(!bundle.some((entry) => entry.origin === 'curated'))
})

test('a deployed seed is marked, not dropped', () => {
  const bundle = bundleForGoal({
    templateKey: 'sales-org-pipeline-coverage',
    kind: 'custom_kpi',
    source: 'hubspot',
    deployedSeedKeys: ['sales-pipeline-hygiene-nudger'],
  })
  const entry = bundle.find((item) => item.seedKey === 'sales-pipeline-hygiene-nudger')
  assert.ok(entry, 'a deployed seed must still be listed')
  assert.equal(entry.deployed, true)
  assert.equal(bundle.filter((item) => item.deployed).length, 1)
})

test('a seed both curated and kind-matched appears once, as curated', () => {
  const bundle = bundleForGoal({
    templateKey: 'sales-org-quarterly-revenue',
    kind: 'revenue',
    source: 'stripe',
  })
  assert.equal(new Set(keys(bundle)).size, bundle.length, 'bundle contains a duplicate')
})
