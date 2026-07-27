# GA4 Metric Adapter — Design

**Date:** 2026-07-27
**Status:** Approved for planning

**Sub-project 3** of the "goals leverage AI" arc declared in
`2026-07-26-goal-recovery-plans-design.md`. That arc named three new metric
adapters — GA4, accounting, delivery — each with its own spec. This spec covers
**GA4 only**; the other two are blocked on provider onboarding and are recorded
in `docs/superpowers/notes/2026-07-27-blocked-metric-adapters.md`.

Arc state:

| Sub-project | State |
| --- | --- |
| 1. AI recovery plans | Shipped |
| 2. Goal-aligned agent catalogue (slices 0–2) | Shipped, `8021f7e`..`4e5cc1a` |
| 3a. GA4 metric adapter | **This spec** |
| 3b. Accounting adapter (QuickBooks/Xero) | Blocked — no connection path |
| 3c. Delivery adapter (Linear/Jira) | Blocked — no connection path |

## Problem

Two marketing goal templates measure things GA4 owns, and neither can read them:

- `marketing-org-organic-traffic` — "Organic sessions this month, read from
  analytics or a sheet." Sources: `google_sheets`, `url`, `postgres`.
- `marketing-personal-conversion-rate` — "Conversions as a percentage of visits
  on your pages." Sources: `google_sheets`, `url`, `postgres`.

Both currently route the user to copy a number into a spreadsheet. The goals
product's whole premise is that a system of record should feed the number
automatically.

## Why this is small

The connection path already exists end to end; only the adapter is missing.

- `google-analytics` is a defined OAuth service with the `analytics.readonly`
  scope (`src/lib/google/oauth.ts`), deliberately chosen as a *sensitive* rather
  than *restricted* scope so verification skips Google's annual CASA assessment.
- `src/lib/google/proxy.ts` already routes `/v1beta/properties` to
  `analyticsdata.googleapis.com` (the GA4 Data API) and `/v1beta/accountSummaries`
  to `analyticsadmin.googleapis.com` (the Admin API, for property discovery).
- The service is listed in `/api/nango/integrations`, so it already appears in
  the integrations UI, and `google-oauth-routes.test.ts` covers its OAuth routes.

What remains is one adapter file, one discovery route, and registration.

## Decision summary (from brainstorming)

- **Scope:** GA4 only. The other two adapters get a notes document, not a spec.
- **Date window:** encoded in the metric key, not in `config`.
- **Property id:** a picker populated from `accountSummaries`, not free text.

## Why the window lives in the metric key

Every existing adapter reads a point-in-time value — Stripe MRR, a Sheets cell, a
HubSpot pipeline sum. GA4 metrics are inherently windowed: "sessions" is
meaningless without a date range.

The adapter cannot infer that range. `MetricSourceContext` carries
`organizationId`, `userId`, `connectionRef` and `config` — it never receives the
goal, so it cannot read the goal's `recurrence`. The window must therefore live
in the metric key or in `config`.

Putting it in the key means the choice is visible at binding time and forever
after on the goal dashboard: "Sessions (last 28 days)" paired with a quarterly
goal is a mismatch a user can see. A `config.window` dropdown would be invisible
once set, and would add a second GA4-specific field to the wizard.

## The adapter

New `src/lib/metrics/sources/google-analytics.ts`, following
`google-sheets.ts` exactly: a `makeGoogleAnalyticsMetricSource(proxyOverride?:
NangoProxy)` factory so tests inject a fake proxy, plus a default instance
`googleAnalyticsMetricSource` for the registry.

Source id: `google_analytics` (snake_case, matching `google_sheets`).

### Metrics

| Metric key | Label | Unit | GA4 metric | Window |
| --- | --- | --- | --- | --- |
| `ga4.sessions_28d` | Sessions (last 28 days) | count | `sessions` | `28daysAgo` → `yesterday` |
| `ga4.sessions_mtd` | Sessions (month to date) | count | `sessions` | 1st of month → `yesterday` |
| `ga4.active_users_28d` | Active users (last 28 days) | count | `activeUsers` | `28daysAgo` → `yesterday` |
| `ga4.new_users_mtd` | New users (month to date) | count | `newUsers` | 1st of month → `yesterday` |
| `ga4.key_events_mtd` | Key events (month to date) | count | `keyEvents` | 1st of month → `yesterday` |
| `ga4.conversion_rate_28d` | Session conversion rate (last 28 days) | percent | `sessionConversionRate` | `28daysAgo` → `yesterday` |

**Windows end at `yesterday`, never `today`.** GA4 has processing latency and the
current day's row is always partial, so including it would make every reading dip
below the true value and produce a sawtooth series.

Month-to-date start is computed as the first day of the current **UTC** month, matching
`bucketKeyFor`'s UTC day convention so a reading never lands in a neighbouring bucket.

### `availableMetrics(goalKind)`

- `custom_kpi` → all six
- `lead_gen` → `ga4.key_events_mtd`, `ga4.new_users_mtd`
- everything else (`revenue`, `arr`, `mrr`, `quota`, `savings`) → `[]`

GA4 traffic is not revenue. Offering sessions against an ARR goal invites a
binding that produces a confidently wrong number, which is worse than no source.

### `fetchValue`

```text
POST /v1beta/properties/{propertyId}:runReport
{ dateRanges: [{ startDate, endDate }], metrics: [{ name }] }
```

through `googleProxy({ organizationId, connectionId })` where `connectionId =
refId(ctx.connectionRef, 'google')`. Reads
`data.rows[0].metricValues[0].value`, coerces with `Number`, and throws when the
report comes back empty or non-numeric.

A missing or non-numeric `config.propertyId` throws **before** any network call,
so a half-configured binding fails fast with a clear message.

### Percent convention

`fmtValue` multiplies percent values by 100 for display
(`src/components/goals/chart-math.ts`), so Sublime stores percents as
**fractions in 0–1**. GA4's `sessionConversionRate` already returns a fraction, so
it passes through **unscaled**. The adapter must not multiply it.

## Property picker

New `GET /api/goals/metrics/ga4/properties`:

- `withAuthenticatedApi`, taking a `connectionRef` query param (`google:<id>`).
- Authorization is the proxy's, not a separate check: `googleProxy({
  organizationId, connectionId })` resolves the token by
  `(organizationId, connectionId)`, so a ref belonging to another workspace
  simply fails to resolve. This is exactly how the preview route treats a
  binding — it passes `auth.organizationId` into the adapter and lets the
  connection lookup be the boundary.
- Calls `/v1beta/accountSummaries` through that proxy.
- Flattens `accountSummaries[].propertySummaries[]` to
  `{ propertyId, displayName }[]`, where `propertyId` is the numeric id parsed
  out of the API's `properties/{id}` resource name.
- Degrades to `{ success: true, properties: [] }` on upstream failure so the
  wizard renders an empty picker with a manual fallback rather than an error
  page.

`metric-binding-fields.tsx` renders a `Select` of those properties when the
source is `google_analytics`, storing `config.propertyId`. When the list comes
back empty, it falls back to a text input so a user who knows their id is never
blocked.

## Registration surface

| File | Change |
| --- | --- |
| `src/lib/metrics/registry.ts` | Register `googleAnalyticsMetricSource` |
| `src/lib/goals/metric-sources.ts` | Add `google_analytics` to `METRIC_SOURCES` |
| `src/components/goals/source-labels.ts` | `SOURCE_LABELS`, `SOURCE_HINTS`, and `SOURCE_ICON_SLUGS: 'googleanalytics'` |
| `src/lib/metrics/available-sources.ts` | Add `'google-analytics'` to the `googleOAuthConnection` service filter, add an `analyticsConnections` filter beside `sheetsConnections`/`gmailConnections`, and branch `connections` for the new source to `google:<id>` refs labelled by `accountEmail` |
| `src/app/api/goals/metrics/preview/route.ts` | Add `'google_analytics'` to the body-schema `z.enum` |
| `src/lib/goals/goal-templates.ts` | `google_analytics` first in the sources for `marketing-org-organic-traffic` and `marketing-personal-conversion-rate` |

`SOURCE_ICON_SLUGS` is keyed on the `MetricSource` union, so adding the source
without a logo decision is a compile error — the invariant slice 0 introduced
does its job here.

The `googleanalytics` Simple Icons slug was verified live during slice 0.

## Included fix: percent sample data

`SAMPLE_TARGETS.percent` in `goal-template-detail.tsx` is
`{ start: 62, target: 85 }`, but percent values are fractions, so the template
preview currently renders "6200%" against a target of "8500%". One line:
`{ start: 0.62, target: 0.85 }`.

Preview-only — sample data, never a real reading — but it is visibly wrong in the
dialog, and percent handling is exactly what this adapter touches.

## Testing

Adapter tests inject a fake `NangoProxy` and assert on the request it receives —
no network, no live GA4.

| Test | Asserts |
| --- | --- |
| Metric name mapping | Each of the six keys sends its documented GA4 metric name |
| Window bounds | 28-day metrics send `28daysAgo`→`yesterday`; MTD metrics send the UTC first-of-month→`yesterday` |
| Never today | No metric ever sends `today` as an end date |
| Missing property | A binding with no `propertyId` throws before the proxy is called |
| Unknown metric key | Throws, naming the key |
| Empty report | A report with no rows throws rather than returning 0 |
| Percent passthrough | `sessionConversionRate` of `0.0431` returns `0.0431`, not `4.31` |
| Goal-kind filtering | `custom_kpi` gets six, `lead_gen` gets two, `revenue` gets none |
| Registry parity | Existing `metric-sources.test.ts` label/slug parity covers the new source |

## Known risk

GA4 renamed *conversions* to *key events* in 2024, and the Data API metric name
changed with it. This spec uses `keyEvents`. The exact currently-accepted name
must be verified against a live property during implementation.

This fails safe: `googleProxy` already surfaces the upstream body verbatim
(`Google API POST /v1beta/... failed (400): <body>`), and GA4 returns a precise
"unknown metric" message. The adapter must not swallow or rewrite that error.

## Out of scope

- The accounting adapter (QuickBooks/Xero) and delivery adapter (Linear/Jira) —
  see the blocked-adapters note
- GA4 dimensions or breakdowns (by channel, by landing page) — a single scalar
  reading per metric is what a goal consumes
- GA4 revenue metrics (`purchaseRevenue` et al.) — revenue belongs to Stripe and
  the CRM adapters, which own the billing source of truth
- Any change to the recurrence, digest, recovery-plan or agent-bundle features
