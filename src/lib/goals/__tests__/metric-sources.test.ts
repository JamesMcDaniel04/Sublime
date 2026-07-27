import assert from 'node:assert/strict'
import test from 'node:test'
import { METRIC_SOURCES, NO_CONNECTION_SOURCES } from '../metric-sources'
import { SOURCE_ICON_SLUGS, SOURCE_LABELS } from '@/components/goals/source-labels'

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

test('every metric source has a logo decision, and no slug is orphaned', () => {
  for (const source of METRIC_SOURCES) {
    assert.ok(
      source in SOURCE_ICON_SLUGS,
      `${source} has no SOURCE_ICON_SLUGS entry`,
    )
  }
  for (const key of Object.keys(SOURCE_ICON_SLUGS)) {
    assert.ok(
      (METRIC_SOURCES as readonly string[]).includes(key),
      `SOURCE_ICON_SLUGS has orphaned key ${key}`,
    )
  }
})

test('only the sources with no vendor behind them opt out of a logo', () => {
  const unbranded = Object.entries(SOURCE_ICON_SLUGS)
    .filter(([, slug]) => slug === null)
    .map(([source]) => source)
    .sort()
  // url fetches an arbitrary page and manual is the user typing the number, so
  // neither has a brand mark. Every other source must resolve to one — a null
  // here would silently render a glyph where a company logo belongs.
  assert.deepEqual(unbranded, ['manual', 'url'])
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
