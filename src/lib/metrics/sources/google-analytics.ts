/**
 * Google Analytics 4 metric source — reports via the GA4 Data API through the
 * native Google OAuth plane. connectionRef is 'google:<id>' where id is the
 * GoogleOAuthConnection row id (what googleProxy resolves).
 *
 * Two GA4 particulars shape this adapter:
 *
 * 1. GA4 metrics are windowed — "sessions" means nothing without a date range —
 *    and MetricSourceContext never carries the goal, so the adapter cannot read
 *    the goal's recurrence. The window is therefore part of the metric KEY,
 *    which also makes it visible on the goal dashboard afterwards.
 * 2. GA4 processes data with a lag, so the current day's row is always partial.
 *    Every window ends at 'yesterday'; including today would make each reading
 *    dip below the true value and produce a sawtooth against the pace line.
 *
 * Metric names follow GA4's post-2024 vocabulary. Per the Data API changelog of
 * 2024-05-06, `conversions` was renamed `keyEvents` and `sessionConversionRate`
 * was renamed `sessionKeyEventRate`; the old names are deprecated. Our own
 * metric KEYS mirror that vocabulary so the label a user picks matches what
 * they see in the GA4 UI.
 * https://developers.google.com/analytics/devguides/reporting/data/v1/changelog
 */
import { googleProxy } from '@/lib/google/proxy'
import type { NangoProxy } from '@/lib/nango/delivery'
import type { MetricDescriptor, MetricReading, MetricSource, MetricSourceContext } from '../types'
import { refId } from '../types'

type Window = '28d' | 'mtd'

type Ga4Metric = MetricDescriptor & {
  /** The GA4 Data API metric name. */
  apiName: string
  window: Window
}

const GA4: Ga4Metric[] = [
  { key: 'ga4.sessions_28d', label: 'Sessions (last 28 days)', unit: 'count', apiName: 'sessions', window: '28d' },
  { key: 'ga4.sessions_mtd', label: 'Sessions (month to date)', unit: 'count', apiName: 'sessions', window: 'mtd' },
  { key: 'ga4.active_users_28d', label: 'Active users (last 28 days)', unit: 'count', apiName: 'activeUsers', window: '28d' },
  { key: 'ga4.new_users_mtd', label: 'New users (month to date)', unit: 'count', apiName: 'newUsers', window: 'mtd' },
  { key: 'ga4.key_events_mtd', label: 'Key events (month to date)', unit: 'count', apiName: 'keyEvents', window: 'mtd' },
  {
    key: 'ga4.key_event_rate_28d',
    label: 'Session key event rate (last 28 days)',
    unit: 'percent',
    apiName: 'sessionKeyEventRate',
    window: '28d',
  },
]

/** Public descriptors — the adapter's own metadata, without the API details. */
export const GA4_METRICS: MetricDescriptor[] = GA4.map(({ key, label, unit }) => ({ key, label, unit }))

/** GA4 metrics that answer "how many leads did we get". */
const LEAD_GEN_KEYS = new Set(['ga4.key_events_mtd', 'ga4.new_users_mtd'])

function utcFirstOfMonth(now: Date): string {
  const year = now.getUTCFullYear()
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `${year}-${month}-01`
}

/** UTC calendar day of `now` minus one, as YYYY-MM-DD. */
function utcYesterday(now: Date): string {
  return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

export function makeGoogleAnalyticsMetricSource(
  proxyOverride?: NangoProxy,
  nowFn: () => Date = () => new Date(),
): MetricSource {
  return {
    source: 'google_analytics',

    availableMetrics(goalKind) {
      if (goalKind === 'custom_kpi') return GA4_METRICS
      if (goalKind === 'lead_gen') return GA4_METRICS.filter((metric) => LEAD_GEN_KEYS.has(metric.key))
      // Sessions are not revenue. Offering GA4 against an ARR or quota goal
      // invites a binding that produces a confidently wrong number.
      return []
    },

    async fetchValue(ctx: MetricSourceContext, metricKey): Promise<MetricReading> {
      const metric = GA4.find((candidate) => candidate.key === metricKey)
      if (!metric) throw new Error(`Unknown Google Analytics metric '${metricKey}'`)

      const propertyId =
        typeof ctx.config.propertyId === 'string' ? ctx.config.propertyId.trim() : ''
      if (!propertyId) {
        throw new Error('Google Analytics binding needs a property to read from.')
      }

      const now = nowFn()
      const asOf = now

      let startDate: string
      if (metric.window === '28d') {
        startDate = '28daysAgo'
      } else {
        startDate = utcFirstOfMonth(now)
        // On the 1st, "month to date" over complete days only is genuinely
        // empty — and asking GA4 for an inverted range would be a 400.
        if (startDate > utcYesterday(now)) return { value: 0, asOf }
      }

      const connectionId = refId(ctx.connectionRef, 'google')
      const proxy =
        proxyOverride ?? googleProxy({ organizationId: ctx.organizationId, connectionId })

      const { data } = await proxy({
        method: 'POST',
        endpoint: `/v1beta/properties/${propertyId}:runReport`,
        connectionId,
        providerConfigKey: 'google-analytics',
        data: {
          dateRanges: [{ startDate, endDate: 'yesterday' }],
          metrics: [{ name: metric.apiName }],
        },
      })

      const raw = (data as { rows?: Array<{ metricValues?: Array<{ value?: string }> }> })
        ?.rows?.[0]?.metricValues?.[0]?.value
      const value = Number(raw)
      if (raw === undefined || !Number.isFinite(value)) {
        throw new Error(
          `Google Analytics returned no data for ${metric.label} on property ${propertyId}.`,
        )
      }
      // sessionConversionRate is already a fraction, and Sublime stores percents
      // as fractions (fmtValue multiplies by 100 to display). No scaling.
      return { value, asOf }
    },
  }
}

export const googleAnalyticsMetricSource = makeGoogleAnalyticsMetricSource()
