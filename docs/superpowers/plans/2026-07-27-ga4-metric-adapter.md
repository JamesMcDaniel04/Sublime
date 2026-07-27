# GA4 Metric Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a goal read its number straight from Google Analytics 4 instead of a spreadsheet someone updates by hand.

**Architecture:** One new `MetricSource` adapter following `google-sheets.ts` exactly — a factory taking an injectable `NangoProxy` so tests need no network, plus a default instance for the registry. The GA4 connection already exists (OAuth service, scopes, proxy routing, integrations UI), so the remaining work is the adapter, a property-discovery route, a wizard field, and registration.

**Tech Stack:** TypeScript, Next.js App Router, GA4 Data API v1beta, Google OAuth via `googleProxy`, `node:test` + `node:assert/strict` via `tsx`, React Testing Library.

**Spec:** `docs/superpowers/specs/2026-07-27-ga4-metric-adapter-design.md`

## Global Constraints

- Source id is `google_analytics` (snake_case, matching `google_sheets`). The Google OAuth **service** is `google-analytics` (hyphen) — these are different strings and both appear; do not conflate them.
- Windows end at **`yesterday`**, never `today` — GA4's current day is always partial.
- Month-to-date starts at the first day of the current **UTC** month, matching `bucketKeyFor`'s UTC convention.
- Percent values are stored as **fractions (0–1)**. `sessionConversionRate` already returns a fraction and passes through **unscaled**.
- `availableMetrics`: `custom_kpi` → all six; `lead_gen` → `ga4.key_events_mtd` + `ga4.new_users_mtd`; every other kind → `[]`.
- `'goals'`-style rule applies here too: never swallow the upstream error. `googleProxy` already surfaces Google's body verbatim; let it propagate.
- Run one test file: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <path>`
- Full suite: `npm test`. Typecheck: `npx tsc --noEmit -p tsconfig.json`. Lint: `npx eslint <paths>`.
- Baseline before this plan: 1922 tests, 1900 pass, 22 skipped, 0 fail.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/metrics/sources/google-analytics.ts` (create) | The adapter: metric table, window computation, `runReport` call. |
| `src/lib/metrics/__tests__/google-analytics.test.ts` (create) | Adapter behaviour against an injected proxy. |
| `src/lib/metrics/registry.ts` (modify) | Register the source. |
| `src/lib/goals/metric-sources.ts` (modify) | Add to the `METRIC_SOURCES` union. |
| `src/components/goals/source-labels.ts` (modify) | Label, hint, icon slug. |
| `src/lib/metrics/available-sources.ts` (modify) | Surface the connection as a pickable option. |
| `src/app/api/goals/metrics/preview/route.ts` (modify) | Add to the hard-coded preview enum. |
| `src/lib/goals/goal-templates.ts` (modify) | Rank it first on the two marketing templates. |
| `src/app/api/goals/metrics/ga4/properties/route.ts` (create) | Property discovery from `accountSummaries`. |
| `src/components/goals/metric-binding-fields.tsx` (modify) | Property picker + binding validation. |
| `src/components/goals/goal-template-detail.tsx` (modify) | The percent sample-data fix. |

---

### Task 1: The adapter

**Files:**
- Create: `src/lib/metrics/sources/google-analytics.ts`
- Test: `src/lib/metrics/__tests__/google-analytics.test.ts`

**Interfaces:**
- Consumes: `googleProxy` (`@/lib/google/proxy`), `NangoProxy` (`@/lib/nango/delivery`), `MetricSource`/`MetricDescriptor`/`MetricReading`/`MetricSourceContext`/`refId` (`../types`)
- Produces:
  - `makeGoogleAnalyticsMetricSource(proxyOverride?: NangoProxy, nowFn?: () => Date): MetricSource`
  - `googleAnalyticsMetricSource: MetricSource` (default instance, `source === 'google_analytics'`)
  - `GA4_METRICS: MetricDescriptor[]` — the six descriptors, exported so registration tests can assert against them

- [ ] **Step 1: Write the failing test**

Create `src/lib/metrics/__tests__/google-analytics.test.ts`:

```ts
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
    'ga4.conversion_rate_28d': 'sessionConversionRate',
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

test('the conversion rate passes through as a fraction, unscaled', async () => {
  // fmtValue multiplies percents by 100 for display, so Sublime stores 0-1.
  // GA4 already returns a fraction; scaling here would render 431%.
  const { proxy } = fakeProxy('0.0431')
  const source = makeGoogleAnalyticsMetricSource(proxy, () => NOW)
  const reading = await source.fetchValue(ctx, 'ga4.conversion_rate_28d')
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
  await assert.rejects(
    () => source.fetchValue(ctx, 'ga4.bounce_rate'),
    /ga4\.bounce_rate/,
  )
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

test('the conversion rate is the only percent metric', () => {
  const percent = GA4_METRICS.filter((metric) => metric.unit === 'percent')
  assert.deepEqual(percent.map((metric) => metric.key), ['ga4.conversion_rate_28d'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/metrics/__tests__/google-analytics.test.ts`
Expected: FAIL — cannot find module `@/lib/metrics/sources/google-analytics`

- [ ] **Step 3: Write the implementation**

Create `src/lib/metrics/sources/google-analytics.ts`:

```ts
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
    key: 'ga4.conversion_rate_28d',
    label: 'Session conversion rate (last 28 days)',
    unit: 'percent',
    apiName: 'sessionConversionRate',
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/metrics/__tests__/google-analytics.test.ts`
Expected: PASS — 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/metrics/sources/google-analytics.ts src/lib/metrics/__tests__/google-analytics.test.ts
git commit -m "feat(goals): add the GA4 metric adapter"
```

---

### Task 2: Registration

**Files:**
- Modify: `src/lib/metrics/registry.ts`
- Modify: `src/lib/goals/metric-sources.ts`
- Modify: `src/components/goals/source-labels.ts`
- Modify: `src/lib/metrics/available-sources.ts`
- Modify: `src/app/api/goals/metrics/preview/route.ts`
- Modify: `src/lib/goals/goal-templates.ts`
- Test: `src/lib/metrics/__tests__/ga4-registration.test.ts`

**Interfaces:**
- Consumes: `googleAnalyticsMetricSource`, `GA4_METRICS` (Task 1)
- Produces: `'google_analytics'` as a member of `METRIC_SOURCES`, resolvable through `getMetricSource`

- [ ] **Step 1: Write the failing test**

Create `src/lib/metrics/__tests__/ga4-registration.test.ts`:

```ts
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

test('the two GA4-shaped marketing templates prefer it', () => {
  for (const key of ['marketing-org-organic-traffic', 'marketing-personal-conversion-rate']) {
    const template = GOAL_TEMPLATES.find((candidate) => candidate.key === key)!
    assert.equal(
      template.sources[0],
      'google_analytics',
      `${key} should rank Google Analytics first`,
    )
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/metrics/__tests__/ga4-registration.test.ts`
Expected: FAIL — `METRIC_SOURCES` does not include `google_analytics`

- [ ] **Step 3: Register the source**

In `src/lib/goals/metric-sources.ts`, add to the `METRIC_SOURCES` array after `'google_sheets'`:

```ts
  'google_analytics',
```

In `src/lib/metrics/registry.ts`, add the import and the entry:

```ts
import { googleAnalyticsMetricSource } from './sources/google-analytics'
```

```ts
  [googleAnalyticsMetricSource.source]: googleAnalyticsMetricSource,
```

In `src/components/goals/source-labels.ts`, add to `SOURCE_LABELS`:

```ts
  google_analytics: 'Google Analytics',
```

to `SOURCE_HINTS`:

```ts
  google_analytics:
    'Reads sessions, users and key events straight from your GA4 property — no spreadsheet in between.',
```

and to `SOURCE_ICON_SLUGS`:

```ts
  google_analytics: 'googleanalytics',
```

`SOURCE_ICON_SLUGS` is typed `Record<MetricSource, string | null>`, so omitting this entry is a compile error — that is the invariant working.

In `src/app/api/goals/metrics/preview/route.ts`, add to the body-schema enum after `'google_sheets'`:

```ts
    'google_analytics',
```

This enum duplicates `METRIC_SOURCES`; without this line the wizard's step-3 preview rejects the new source with a Zod error and the binding can never be validated.

- [ ] **Step 4: Surface the connection as an option**

In `src/lib/metrics/available-sources.ts`:

Widen the Google connection query's service filter:

```ts
        service: { in: ['google-sheets', 'google-mail', 'google-analytics'] },
```

Add a filter beside the existing `sheetsConnections` / `gmailConnections`:

```ts
  const analyticsConnections = googleConnections.filter(
    (connection) => connection.service === 'google-analytics',
  )
```

Extend the `connections` ternary chain — add this branch immediately after the `gmail_assisted` branch and before the final `: []`:

```ts
              : name === 'google_analytics'
                ? analyticsConnections.map((connection) => ({
                    ref: `google:${connection.id}`,
                    label: connection.accountEmail,
                  }))
```

And add the source to the returned list, after `'google_sheets'`:

```ts
    'google_analytics',
```

- [ ] **Step 5: Rank it on the two marketing templates**

In `src/lib/goals/goal-templates.ts`:

`marketing-org-organic-traffic` — replace its sources line:

```ts
    sources: ['google_analytics', 'google_sheets', 'url', 'postgres'],
```

`marketing-personal-conversion-rate` — replace its sources line:

```ts
    sources: ['google_analytics', 'google_sheets', 'url', 'postgres'],
```

- [ ] **Step 6: Run tests**

Run:
```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
  src/lib/metrics/__tests__/ga4-registration.test.ts \
  src/lib/goals/__tests__/metric-sources.test.ts \
  src/lib/goals/__tests__/goal-templates.test.ts \
  src/lib/metrics/__tests__/source-options.test.ts
```
Expected: PASS. `metric-sources.test.ts` enforces label and icon-slug parity in both directions, and `goal-templates.test.ts` locks source validity — all must stay green.

- [ ] **Step 7: Typecheck and commit**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

```bash
git add src/lib/metrics/registry.ts src/lib/goals/metric-sources.ts src/components/goals/source-labels.ts src/lib/metrics/available-sources.ts src/app/api/goals/metrics/preview/route.ts src/lib/goals/goal-templates.ts src/lib/metrics/__tests__/ga4-registration.test.ts
git commit -m "feat(goals): register Google Analytics as a metric source"
```

---

### Task 3: Property discovery route

**Files:**
- Create: `src/app/api/goals/metrics/ga4/properties/route.ts`
- Test: `src/lib/metrics/__tests__/ga4-properties.test.ts`

**Interfaces:**
- Consumes: `googleProxy` (`@/lib/google/proxy`), `withAuthenticatedApi` (`@/lib/server/api-handler`)
- Produces:
  - `parseAccountSummaries(data: unknown): Array<{ propertyId: string; displayName: string }>` — exported from the route module so it is unit-testable without booting a request
  - `GET /api/goals/metrics/ga4/properties?connectionRef=google:<id>` → `{ success: true, properties }`

- [ ] **Step 1: Write the failing test**

Create `src/lib/metrics/__tests__/ga4-properties.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAccountSummaries } from '@/app/api/goals/metrics/ga4/properties/route'

test('flattens account summaries into pickable properties', () => {
  const properties = parseAccountSummaries({
    accountSummaries: [
      {
        displayName: 'Acme',
        propertySummaries: [
          { property: 'properties/493820104', displayName: 'Acme Marketing Site' },
          { property: 'properties/493820105', displayName: 'Acme Docs' },
        ],
      },
      {
        displayName: 'Side Project',
        propertySummaries: [{ property: 'properties/777', displayName: 'Blog' }],
      },
    ],
  })
  assert.deepEqual(properties, [
    { propertyId: '493820104', displayName: 'Acme Marketing Site' },
    { propertyId: '493820105', displayName: 'Acme Docs' },
    { propertyId: '777', displayName: 'Blog' },
  ])
})

test('an account with no properties contributes nothing', () => {
  const properties = parseAccountSummaries({
    accountSummaries: [{ displayName: 'Empty' }],
  })
  assert.deepEqual(properties, [])
})

test('malformed payloads yield an empty list rather than throwing', () => {
  // A picker that renders empty is recoverable; one that 500s is not.
  for (const payload of [null, undefined, {}, { accountSummaries: 'nope' }, []]) {
    assert.deepEqual(parseAccountSummaries(payload), [])
  }
})

test('a property with no display name falls back to its id', () => {
  const properties = parseAccountSummaries({
    accountSummaries: [{ propertySummaries: [{ property: 'properties/42' }] }],
  })
  assert.deepEqual(properties, [{ propertyId: '42', displayName: '42' }])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/metrics/__tests__/ga4-properties.test.ts`
Expected: FAIL — cannot find the route module

- [ ] **Step 3: Write the route**

Create `src/app/api/goals/metrics/ga4/properties/route.ts`:

```ts
/**
 * GA4 property discovery for the goal wizard. A numeric property id is not
 * something anyone can recite, so the binding field offers a named picker.
 *
 * Authorization is the proxy's: googleProxy resolves the token by
 * (organizationId, connectionId), so a ref belonging to another workspace
 * simply fails to resolve. Same boundary the preview route relies on.
 */
import { googleProxy } from '@/lib/google/proxy'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { refId } from '@/lib/metrics/types'

export const runtime = 'nodejs'

export type Ga4Property = { propertyId: string; displayName: string }

/** Flatten accountSummaries → properties. Tolerant by design: a picker that
 *  renders empty is recoverable, one that throws is not. */
export function parseAccountSummaries(data: unknown): Ga4Property[] {
  const summaries = (data as { accountSummaries?: unknown })?.accountSummaries
  if (!Array.isArray(summaries)) return []
  const properties: Ga4Property[] = []
  for (const summary of summaries) {
    const list = (summary as { propertySummaries?: unknown })?.propertySummaries
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      const resource = (entry as { property?: unknown })?.property
      if (typeof resource !== 'string') continue
      const propertyId = resource.split('/').pop() ?? ''
      if (!propertyId) continue
      const displayName = (entry as { displayName?: unknown })?.displayName
      properties.push({
        propertyId,
        displayName: typeof displayName === 'string' && displayName ? displayName : propertyId,
      })
    }
  }
  return properties
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  const connectionRef = request.nextUrl.searchParams.get('connectionRef')
  const connectionId = refId(connectionRef, 'google')
  const proxy = googleProxy({ organizationId: auth.organizationId, connectionId })
  try {
    const { data } = await proxy({
      method: 'GET',
      endpoint: '/v1beta/accountSummaries',
      connectionId,
      providerConfigKey: 'google-analytics',
    })
    return { success: true, properties: parseAccountSummaries(data) }
  } catch {
    // The wizard falls back to a manual id input on an empty list, so a failed
    // probe must not block goal creation.
    return { success: true, properties: [] as Ga4Property[] }
  }
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/metrics/__tests__/ga4-properties.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

```bash
git add src/app/api/goals/metrics/ga4/properties/route.ts src/lib/metrics/__tests__/ga4-properties.test.ts
git commit -m "feat(goals): discover GA4 properties for the binding picker"
```

---

### Task 4: Wizard property picker

**Files:**
- Modify: `src/components/goals/metric-binding-fields.tsx` (the `required` map in `metricBindingIssue`, and the per-source field blocks after the `google_sheets` block)
- Test: `src/components/goals/__tests__/ga4-binding-fields.test.ts`

**Interfaces:**
- Consumes: `Ga4Property` shape from Task 3 (`{ propertyId, displayName }`); `MetricBinding` (`../metric-binding-fields`)
- Produces: `config.propertyId` on a `google_analytics` binding

- [ ] **Step 1: Write the failing test**

Create `src/components/goals/__tests__/ga4-binding-fields.test.ts` — a plain
`.ts` file with no jsdom import, matching the existing
`metric-binding-ready.test.ts`: `metricBindingIssue` is a pure function, so
nothing renders.

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { metricBindingIssue, type MetricBinding } from '../metric-binding-fields'

const binding = (config: Record<string, unknown>): MetricBinding => ({
  label: 'Organic sessions',
  role: 'primary',
  source: 'google_analytics',
  metricKey: 'ga4.sessions_mtd',
  unit: 'count',
  connectionRef: 'google:conn-1',
  config,
})

test('a GA4 binding without a property is not ready to create', () => {
  const issue = metricBindingIssue(binding({}))
  assert.match(issue ?? '', /propert/i)
})

test('a GA4 binding with a property is ready', () => {
  assert.equal(metricBindingIssue(binding({ propertyId: '493820104' })), null)
})

test('whitespace is not a property id', () => {
  assert.match(metricBindingIssue(binding({ propertyId: '   ' })) ?? '', /propert/i)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/goals/__tests__/ga4-binding-fields.test.ts`
Expected: FAIL — `metricBindingIssue` returns `null` for a GA4 binding with no property

- [ ] **Step 3: Add the validation rule**

In `src/components/goals/metric-binding-fields.tsx`, add to the `required` map inside `metricBindingIssue`, after the `google_sheets` entry:

```ts
    google_analytics: [['propertyId', 'Pick the GA4 property for']],
```

- [ ] **Step 4: Add the picker field**

In the same file, add this block immediately after the `binding.source === 'google_sheets'` block. It loads properties when a connection is chosen, renders a `Select` when any come back, and falls back to a plain input otherwise so a user who knows their id is never blocked:

```tsx
      {binding.source === 'google_analytics' && (
        <Ga4PropertyField
          connectionRef={binding.connectionRef}
          value={text('propertyId')}
          onChange={(propertyId) => setConfig('propertyId', propertyId)}
        />
      )}
```

And add this component at the end of the file:

```tsx
/** GA4 property chooser. A numeric property id is not something anyone can
 *  recite, so offer names — but degrade to a raw input when discovery returns
 *  nothing, rather than blocking goal creation on a failed probe. */
function Ga4PropertyField({
  connectionRef,
  value,
  onChange,
}: {
  readonly connectionRef: string | null
  readonly value: string
  readonly onChange: (propertyId: string) => void
}) {
  const [properties, setProperties] = useState<Array<{ propertyId: string; displayName: string }>>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!connectionRef) return
    let cancelled = false
    setLoaded(false)
    fetch(`/api/goals/metrics/ga4/properties?connectionRef=${encodeURIComponent(connectionRef)}`)
      .then((response) => response.json())
      .then((body: { properties?: Array<{ propertyId: string; displayName: string }> }) => {
        if (cancelled) return
        setProperties(body.properties ?? [])
      })
      .catch(() => {
        if (!cancelled) setProperties([])
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [connectionRef])

  if (loaded && properties.length === 0) {
    return (
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="GA4 property id (493820104)"
        aria-label="GA4 property id"
      />
    )
  }

  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger aria-label="GA4 property">
        <SelectValue placeholder={loaded ? 'Choose a property' : 'Loading properties…'} />
      </SelectTrigger>
      <SelectContent>
        {properties.map((property) => (
          <SelectItem key={property.propertyId} value={property.propertyId}>
            {property.displayName}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
```

Add `useEffect` and `useState` to the file's React import if they are not already there.

- [ ] **Step 5: Run tests**

Run:
```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
  src/components/goals/__tests__/ga4-binding-fields.test.ts \
  src/components/goals/__tests__/metric-binding-ready.test.ts
```
Expected: PASS. `metric-binding-ready.test.ts` covers `metricBindingIssue` for the existing sources and must stay green.

- [ ] **Step 6: Typecheck, lint and commit**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npx eslint src/components/goals/metric-binding-fields.tsx src/components/goals/__tests__/ga4-binding-fields.test.ts
```
Expected: no output from either.

```bash
git add src/components/goals/metric-binding-fields.tsx src/components/goals/__tests__/ga4-binding-fields.test.ts
git commit -m "feat(goals): pick a GA4 property in the metric binding"
```

---

### Task 5: Percent sample-data fix

**Files:**
- Modify: `src/components/goals/goal-template-detail.tsx:29-33` (the `SAMPLE_TARGETS` constant)
- Test: `src/components/goals/__tests__/goal-template-agents-ui.test.tsx` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: nothing — a correctness fix

Percent values are stored as fractions: `fmtValue` renders `value * 100` with a
`%` suffix. `SAMPLE_TARGETS.percent` uses whole numbers, so the preview for any
percent-unit template renders "8500%".

- [ ] **Step 1: Write the failing test**

Append to `src/components/goals/__tests__/goal-template-agents-ui.test.tsx`:

```tsx
test('a percent template preview shows a believable percentage', () => {
  // fmtValue renders percent as value * 100, so SAMPLE_TARGETS must be
  // fractions. Whole numbers render "8500%".
  render(
    <GoalTemplateDetail
      template={goalTemplateByKey('sales-org-pipeline-coverage')!}
      sources={[]}
      sourcesFailed={false}
      onClose={() => {}}
    />,
  )
  const text = document.body.textContent ?? ''
  assert.ok(!/\d{4,}%/.test(text), `preview shows an implausible percentage: ${text.match(/\d+%/g)}`)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/goals/__tests__/goal-template-agents-ui.test.tsx`
Expected: FAIL — "preview shows an implausible percentage" listing values like `8500%`

- [ ] **Step 3: Fix the sample data**

In `src/components/goals/goal-template-detail.tsx`, change the `percent` entry of `SAMPLE_TARGETS`:

```ts
  percent: { start: 0.62, target: 0.85 },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/goals/__tests__/goal-template-agents-ui.test.tsx`
Expected: PASS — 3 tests

- [ ] **Step 5: Full suite, lint and commit**

Run: `npm test`
Expected: 0 failures. Baseline was 1922 tests / 1900 pass / 22 skipped; this plan adds 21 tests (10 + 3 + 4 + 3 + 1), so expect ~1943 total.

Run: `npx eslint src/components/goals/goal-template-detail.tsx`
Expected: no output.

```bash
git add src/components/goals/goal-template-detail.tsx src/components/goals/__tests__/goal-template-agents-ui.test.tsx
git commit -m "fix(goals): percent sample targets are fractions, not whole numbers"
```

---

## Verification

The adapter is fully unit-tested against an injected proxy, but nothing here
proves it works against real GA4. Before trusting it:

1. Connect Google Analytics in `/integrations` (the OAuth flow already exists).
2. Create a goal from `marketing-org-organic-traffic`, choose Google Analytics,
   pick a property, and select "Sessions (month to date)".
3. The wizard's step-3 preview calls the adapter for real — a value there is the
   end-to-end proof.

**Verify `keyEvents` specifically.** GA4 renamed *conversions* to *key events*,
and this plan assumes the Data API metric is `keyEvents`. If the preview for
"Key events (month to date)" returns a 400, read the error: `googleProxy`
surfaces Google's body verbatim, and GA4 names the metric it did not recognise.
Change `apiName` on that one entry accordingly — the metric key, label and tests
stay as they are.

## Known coverage limits

- No test exercises the real GA4 API. Metric names, response shape and the
  `keyEvents` rename are verified by the manual step above, not by CI.
- The `GET` handler in Task 3 is not tested; only its pure `parseAccountSummaries`
  helper is. Testing the handler would need a request harness and a fake Google
  connection.
- `Ga4PropertyField`'s fetch is not exercised in the component test, which covers
  `metricBindingIssue` only.

## Out of Scope

- The accounting (QuickBooks/Xero) and delivery (Linear/Jira) adapters — see
  `docs/superpowers/notes/2026-07-27-blocked-metric-adapters.md`
- GA4 dimensions or breakdowns (by channel, by landing page)
- GA4 revenue metrics — revenue belongs to the Stripe and CRM adapters
- Any change to recurrence, digest, recovery plans or agent bundles
