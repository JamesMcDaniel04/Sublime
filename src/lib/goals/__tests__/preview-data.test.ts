import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPreviewDashboardData } from '../preview-data'

const base = {
  name: 'Quarterly revenue target',
  kind: 'arr' as const,
  direction: 'increase' as const,
  unit: 'usd' as const,
  startValue: 100_000,
  targetValue: 400_000,
  targetDate: null,
  recurrence: null,
  personal: false,
  metrics: [
    { label: 'Closed-won', role: 'primary' as const, unit: 'usd' as const, source: 'stripe', metricKey: 'net_revenue' },
  ],
}

test('returns one metric id per requested metric, matching the series ids', () => {
  const { data, metricIds } = buildPreviewDashboardData(base)
  assert.equal(metricIds.length, 1)
  assert.deepEqual(data.metrics.map((metric) => metric.id), metricIds)
  assert.equal(data.goal.metrics.length, 1)
  assert.equal(data.preview, true)
})

test('without a seed the series is empty — the Copilot preview contract', () => {
  const { data } = buildPreviewDashboardData(base)
  assert.deepEqual(data.metrics[0].datapoints, [])
})

test('with a seed the series is populated and deterministic', () => {
  const first = buildPreviewDashboardData({ ...base, seed: 'sales-org-quarterly-revenue' })
  const second = buildPreviewDashboardData({ ...base, seed: 'sales-org-quarterly-revenue' })
  assert.ok(first.data.metrics[0].datapoints.length > 5)
  assert.deepEqual(
    first.data.metrics[0].datapoints.map((point) => point.value),
    second.data.metrics[0].datapoints.map((point) => point.value),
  )
})

test('different seeds produce different series', () => {
  const a = buildPreviewDashboardData({ ...base, seed: 'seed-a' })
  const b = buildPreviewDashboardData({ ...base, seed: 'seed-b' })
  assert.notDeepEqual(
    a.data.metrics[0].datapoints.map((point) => point.value),
    b.data.metrics[0].datapoints.map((point) => point.value),
  )
})

test('a seeded increasing series stays between start and target', () => {
  const { data } = buildPreviewDashboardData({ ...base, seed: 'bounds' })
  for (const point of data.metrics[0].datapoints) {
    assert.ok(point.value >= base.startValue, `${point.value} below start`)
    assert.ok(point.value <= base.targetValue, `${point.value} above target`)
  }
})

test('a seeded decreasing series stays between target and start', () => {
  const { data } = buildPreviewDashboardData({
    ...base,
    direction: 'decrease',
    kind: 'kpi',
    startValue: 90_000,
    targetValue: 40_000,
    seed: 'down',
  })
  for (const point of data.metrics[0].datapoints) {
    assert.ok(point.value <= 90_000, `${point.value} above start`)
    assert.ok(point.value >= 40_000, `${point.value} below target`)
  }
})
