import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GA4_METRICS,
  makeGoogleAnalyticsMetricSource,
} from '@/lib/metrics/sources/google-analytics'
import type { NangoProxyArgs } from '@/lib/nango/delivery'

const NOW = new Date('2026-07-27T12:00:00Z')
const ctx = {
  organizationId: 'org-1',
  userId: 'user-1',
  connectionRef: 'google:conn-1',
  config: { propertyId: '493820104' },
}

/** Captures the request and replies with a one-row GA4 report. */
function fakeProxy(value = '12345') {
  const calls: NangoProxyArgs[] = []
  const proxy = async (args: NangoProxyArgs) => {
    calls.push(args)
    return { data: { rows: [{ metricValues: [{ value }] }] } }
  }
  return { calls, proxy }
}

const body = (args: NangoProxyArgs) =>
  args.data as {
    dateRanges: Array<{ startDate: string; endDate: string }>
    metrics: Array<{ name: string }>
  }

test('every metric key maps to its documented GA4 metric name', async () => {
  const expected: Record<string, string> = {
    'ga4.sessions_28d': 'sessions',
    'ga4.sessions_mtd': 'sessions',
    'ga4.active_users_28d': 'activeUsers',
    'ga4.new_users_mtd': 'newUsers',
    'ga4.key_events_mtd': 'keyEvents',
    'ga4.key_event_rate_28d': 'sessionKeyEventRate',
  }
  for (const [key, metricName] of Object.entries(expected)) {
    const { calls, proxy } = fakeProxy()
    const source = makeGoogleAnalyticsMetricSource(proxy, () => NOW)
    await source.fetchValue(ctx, key)
    assert.equal(body(calls[0]).metrics[0].name, metricName, key)
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[0].endpoint, '/v1beta/properties/493820104:runReport')
  }
})

test('28-day windows run to yesterday, never today', async () => {
  const { calls, proxy } = fakeProxy()
  const source = makeGoogleAnalyticsMetricSource(proxy, () => NOW)
  await source.fetchValue(ctx, 'ga4.sessions_28d')
  assert.deepEqual(body(calls[0]).dateRanges[0], {
    startDate: '28daysAgo',
    endDate: 'yesterday',
  })
})

test('month-to-date starts on the UTC first of the month and ends yesterday', async () => {
  const { calls, proxy } = fakeProxy()
  const source = makeGoogleAnalyticsMetricSource(proxy, () => NOW)
  await source.fetchValue(ctx, 'ga4.sessions_mtd')
  assert.deepEqual(body(calls[0]).dateRanges[0], {
    startDate: '2026-07-01',
    endDate: 'yesterday',
  })
})

test('no metric ever asks GA4 for today, whose row is always partial', async () => {
  for (const metric of GA4_METRICS) {
    const { calls, proxy } = fakeProxy()
    const source = makeGoogleAnalyticsMetricSource(proxy, () => NOW)
    await source.fetchValue(ctx, metric.key)
    const range = body(calls[0]).dateRanges[0]
    assert.notEqual(range.endDate, 'today', `${metric.key} must not include today`)
  }
})

test('on the first of the month, month-to-date is zero without calling GA4', async () => {
  // Every completed day of this month: none. Asking GA4 for 2026-08-01 through
  // yesterday (2026-07-31) would be an inverted range and a 400.
  const firstOfMonth = new Date('2026-08-01T09:00:00Z')
  const { calls, proxy } = fakeProxy()
  const source = makeGoogleAnalyticsMetricSource(proxy, () => firstOfMonth)
  const reading = await source.fetchValue(ctx, 'ga4.sessions_mtd')
  assert.equal(reading.value, 0)
  assert.equal(calls.length, 0, 'must not issue an inverted date range')
})

test('the key event rate passes through as a fraction, unscaled', async () => {
  // fmtValue multiplies percents by 100 for display, so Sublime stores 0-1.
  // GA4 already returns a fraction; scaling here would render 431%.
  const { proxy } = fakeProxy('0.0431')
  const source = makeGoogleAnalyticsMetricSource(proxy, () => NOW)
  const reading = await source.fetchValue(ctx, 'ga4.key_event_rate_28d')
  assert.equal(reading.value, 0.0431)
})

test('a binding with no propertyId fails before any network call', async () => {
  const { calls, proxy } = fakeProxy()
  const source = makeGoogleAnalyticsMetricSource(proxy, () => NOW)
  await assert.rejects(
    () => source.fetchValue({ ...ctx, config: {} }, 'ga4.sessions_28d'),
    /property/i,
  )
  assert.equal(calls.length, 0)
})

test('an unknown metric key is rejected by name', async () => {
  const { proxy } = fakeProxy()
  const source = makeGoogleAnalyticsMetricSource(proxy, () => NOW)
  await assert.rejects(() => source.fetchValue(ctx, 'ga4.bounce_rate'), /ga4\.bounce_rate/)
})

test('an empty report throws rather than silently reading zero', async () => {
  const proxy = async () => ({ data: { rows: [] } })
  const source = makeGoogleAnalyticsMetricSource(proxy, () => NOW)
  await assert.rejects(() => source.fetchValue(ctx, 'ga4.sessions_28d'), /no data/i)
})

test('goal kinds that GA4 cannot measure are offered nothing', () => {
  const source = makeGoogleAnalyticsMetricSource(async () => ({ data: {} }), () => NOW)
  assert.equal(source.availableMetrics('custom_kpi').length, 6)
  assert.deepEqual(
    source.availableMetrics('lead_gen').map((metric) => metric.key).sort(),
    ['ga4.key_events_mtd', 'ga4.new_users_mtd'],
  )
  for (const kind of ['revenue', 'arr', 'mrr', 'quota', 'savings']) {
    assert.deepEqual(source.availableMetrics(kind), [], `${kind} must offer no GA4 metric`)
  }
})

test('the key event rate is the only percent metric', () => {
  const percent = GA4_METRICS.filter((metric) => metric.unit === 'percent')
  assert.deepEqual(percent.map((metric) => metric.key), ['ga4.key_event_rate_28d'])
})
