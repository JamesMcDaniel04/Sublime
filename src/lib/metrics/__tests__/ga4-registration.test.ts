import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getMetricSource } from '@/lib/metrics/registry'
import { METRIC_SOURCES, NO_CONNECTION_SOURCES } from '@/lib/goals/metric-sources'
import { SOURCE_ICON_SLUGS, SOURCE_LABELS } from '@/components/goals/source-labels'
import { GOAL_TEMPLATES } from '@/lib/goals/goal-templates'

test('google_analytics is a registered, resolvable metric source', () => {
  assert.ok((METRIC_SOURCES as readonly string[]).includes('google_analytics'))
  assert.equal(getMetricSource('google_analytics')?.source, 'google_analytics')
})

test('it presents as a real branded source, not a connection-free one', () => {
  assert.equal(SOURCE_LABELS.google_analytics, 'Google Analytics')
  assert.equal(SOURCE_ICON_SLUGS.google_analytics, 'googleanalytics')
  // It needs a Google OAuth connection, so it must not be treated as one of the
  // connection-free sources the wizard lets you pick with nothing set up.
  assert.equal(NO_CONNECTION_SOURCES.has('google_analytics'), false)
})

// One GA4-first template survives the action-motion catalogue rework on
// purpose — a wired connector with nothing in the gallery preferring it would
// be effectively invisible. See the comment on the template itself.
test('a GA4-shaped marketing template still prefers it', () => {
  for (const key of ['marketing-org-organic-traffic']) {
    const template = GOAL_TEMPLATES.find((candidate) => candidate.key === key)!
    assert.equal(
      template.sources[0],
      'google_analytics',
      `${key} should rank Google Analytics first`,
    )
  }
})
