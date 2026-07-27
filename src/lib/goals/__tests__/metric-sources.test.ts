import assert from 'node:assert/strict'
import test from 'node:test'
import { METRIC_SOURCES, NO_CONNECTION_SOURCES } from '../metric-sources'
import { SOURCE_LABELS } from '@/components/goals/source-labels'

test('every metric source has a user-facing label, and no label is orphaned', () => {
  for (const source of METRIC_SOURCES) {
    assert.ok(SOURCE_LABELS[source], `${source} has no SOURCE_LABELS entry`)
  }
  for (const key of Object.keys(SOURCE_LABELS)) {
    assert.ok(
      (METRIC_SOURCES as readonly string[]).includes(key),
      `SOURCE_LABELS has orphaned key ${key}`,
    )
  }
})

test('connection-free sources are a subset of the source union', () => {
  assert.ok(NO_CONNECTION_SOURCES.size > 0)
  for (const source of NO_CONNECTION_SOURCES) {
    assert.ok(
      (METRIC_SOURCES as readonly string[]).includes(source),
      `${source} is not a valid metric source`,
    )
  }
  assert.ok(NO_CONNECTION_SOURCES.has('manual'))
})
