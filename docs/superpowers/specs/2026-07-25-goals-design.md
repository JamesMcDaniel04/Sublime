# Goals: Targets, Metric Tracking, and Goal-Oriented Recommendations — Design

**Date:** 2026-07-25
**Status:** Approved (design review with James, 2026-07-25)

## Problem

Sublime is capable but general: nothing anchors the recommendation engine, template
catalogue, or home assistant to what the user is actually trying to achieve. Users
think in targets — ARR, MRR, CARR, revenue, sales quota, savings — tracked in tools
like Stripe, HubSpot, Salesforce, and spreadsheets. The platform should let a user
declare a goal, bind it to the tool that holds the source-of-truth number, track the
metric over time, detect when the goal is at risk, and recommend a concrete action —
either something the user should do or something Sublime can do via a flow or agent
template. Goals become the highest-authority evidence source the intelligence
subsystem has: declared intent, not inferred intent.

## Decisions (settled in design review)

1. **Both org-level and personal goals.** Org goals take priority. A personal goal
   may link to an org goal it supports (quota → ARR target); recommendations for the
   individual are scored against both, org weight first.
2. **Native metric connectors**, not agent-powered collection: deterministic
   scheduled fetches, zero token cost, testable. v1 sources: **Stripe, HubSpot,
   Salesforce, Google Sheets**, plus manual entry.
3. **Goal-aware intelligence layer** depth for v1: goals feed the *existing*
   recommendation pipeline and template ranking; no surface is rebuilt. Full
   reorientation (goal context in every agent prompt, onboarding rebuild) is
   explicitly out of scope.
4. **Architecture: goal spine + metric subsystem** — first-class `Goal` /
   `GoalMetric` / `MetricDatapoint` models, a `src/lib/metrics/` connector registry
   modeled on the `ActivitySource` pattern, evaluation as pure math on the cron
   tick, recommendations emitted into `UserSuggestion` / `AgentMemory`.
5. **Proof layer** — the product claim is *"the only AI that can prove ROI from
   day 1."* Attribution is captured at the moment of adoption (accepting a
   goal-sourced suggestion links the provisioned automation to the goal), and the
   Goals tab reports impact in three honesty tiers: measured, estimated,
   correlated.

## Data model

Three new Prisma models. House conventions apply: uuid PKs, `organizationId
@db.Uuid` with `onDelete: Cascade`, `@@map("snake_case")`, `@db.Timestamptz(6)`,
String status unions documented in comments, org back-relations so
`teardownOrganization` stays complete. All tenant queries org-scoped
(tenant-guard); personal goals additionally owner-filtered.

### `Goal`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | uuid | |
| `organizationId` | uuid FK | cascade |
| `ownerUserId` | uuid FK, nullable | **null = org goal; set = personal goal** (visible only to owner) |
| `parentGoalId` | uuid self-FK, nullable | personal → org rollup link; `onDelete: SetNull` |
| `name`, `description` | String / String? | |
| `kind` | String | `'arr' \| 'mrr' \| 'carr' \| 'revenue' \| 'quota' \| 'savings' \| 'custom_kpi'` |
| `direction` | String | `'increase' \| 'decrease'` (savings count down) |
| `unit` | String | `'usd' \| 'count' \| 'percent'` |
| `startValue` | Decimal | baseline captured at creation (wizard preview fetch) |
| `targetValue` | Decimal | |
| `startAt`, `targetDate` | Timestamptz | |
| `status` | String | `'active' \| 'paused' \| 'achieved' \| 'missed' \| 'archived'` |
| `riskLevel` | String | `'on_track' \| 'at_risk' \| 'off_track' \| 'no_data'` — **persisted so transitions are detectable**; only a transition emits a recommendation |
| `lastEvaluatedAt` | Timestamptz? | |
| `createdByUserId` | uuid FK | |
| timestamps | | |

### `GoalMetric` — binding to the source of truth

One per goal in v1 (schema permits more later).

| Field | Type | Notes |
| --- | --- | --- |
| `goalId` | uuid FK | cascade |
| `organizationId` | uuid FK | cascade |
| `source` | String | `'stripe' \| 'hubspot' \| 'salesforce' \| 'google_sheets' \| 'manual'` |
| `metricKey` | String | e.g. `stripe.mrr`, `hubspot.pipeline_value`, `salesforce.closed_won`, `sheets.range` |
| `connectionRef` | String? | credential id (Stripe), Nango connection id, or Google connection id; null for manual |
| `config` | Json | sheet id + A1 range, pipeline/stage filter, currency, period |
| `refreshIntervalHours` | Int | default 24 |
| `lastSyncAt`, `lastError` | Timestamptz? / String? | a stale/erroring metric is itself a goal-risk signal |

### `MetricDatapoint` — the time series

| Field | Type | Notes |
| --- | --- | --- |
| `goalMetricId` | uuid FK | cascade |
| `organizationId` | uuid FK | cascade |
| `value` | Decimal | |
| `capturedAt` | Timestamptz | |
| `bucketKey` | String | day bucket (`YYYY-MM-DD`); `@@unique([goalMetricId, bucketKey])` — re-syncs upsert, never double-write (activity-ledger dedupe discipline) |
| `origin` | String | `'sync' \| 'manual' \| 'backfill'` |

### `GoalContribution` — the attribution link (proof layer)

Created automatically when a goal-sourced suggestion is accepted and provisioned,
or manually when a user links an existing automation to a goal.

| Field | Type | Notes |
| --- | --- | --- |
| `goalId` | uuid FK | cascade |
| `organizationId` | uuid FK | cascade |
| `resourceType` | String | `'flow' \| 'agent'` |
| `resourceId` | uuid | the linked Flow / AgentTask |
| `origin` | String | `'suggestion'` (accepted goal recommendation) \| `'manual'` (linked from goal detail) |
| `estimatedMinutesSavedPerRun` | Int | seeded from the template's `estimatedMinutesSaved` tag; editable per link |
| `createdAt` | Timestamptz | attribution starts here — runs before link time never count |

No per-run impact rows: impact is computed by joining `FlowRun` /
`AgentExecution` (completed, after link time) through the contribution links.
Run counts and token costs already exist on those tables.

### Behavioral events

New `UserEvent` kinds in `src/lib/behavior/record-event.ts`: `goal_created`,
`goal_off_track`, `goal_achieved`, `goal_suggestion_accepted`,
`goal_suggestion_dismissed`, `goal_contribution_linked`. References only, never
values — consistent with the existing privacy contract.

## Metric connectors & sync

New module `src/lib/metrics/` mirroring `src/lib/activity/registry.ts`:

```ts
interface MetricSource {
  source: 'stripe' | 'hubspot' | 'salesforce' | 'google_sheets'
  availableMetrics(goalKind: GoalKind): MetricDescriptor[]
  fetchValue(binding: GoalMetricBinding): Promise<{ value: number; asOf: Date }>
}
```

- **Stripe** (`stripe.ts`) — the one new connection type. API key lives in the
  org-scoped **credential vault** (`Credential`, redacted-on-read) with
  `ConnectionVerification` health. Metrics: MRR computed from active
  subscriptions, ARR derived (MRR × 12), net revenue for the goal period.
- **HubSpot / Salesforce** (`hubspot.ts`, `salesforce.ts`) — through existing
  Nango connections. Metrics: open pipeline value, closed-won in period, quota
  attainment (sum of deal/opportunity amounts filtered by stage + close date from
  `config`).
- **Google Sheets** (`google-sheets.ts`) — native Google OAuth (already live).
  User supplies spreadsheet + A1 range; first numeric cell of the range is the
  reading. Universal escape hatch for savings targets and custom KPIs.
- **Manual** — datapoint entry from the goal detail page; also the fallback while
  a source is erroring.

**Cadence:** `refreshGoalMetrics()` joins the best-effort steps in
`/api/cron/dispatch` (15-minute tick), alongside `runBehaviorIntelligence()`.
Each metric refreshes only when `lastSyncAt` is older than its
`refreshIntervalHours` (default daily). Failures are captured per-metric on
`lastError` — never thrown across the tick. After each successful refresh the
evaluator runs for that goal.

## Evaluation — pure math, zero tokens

`src/lib/goals/evaluate.ts`, pure and unit-tested:

- **Progress:** `(current − start) / (target − start)`, inverted for
  `direction: 'decrease'`.
- **Pace:** linear expected progress from `startAt` to `targetDate`; rendered as
  the pace line on charts.
- **Projection:** linear regression over the trailing window (default 30 days of
  datapoints) → projected value at `targetDate`.
- **Risk:** `on_track` if progress ≥ 95% of pace **or** projection ≥ target;
  `at_risk` below that down to 75% of pace; `off_track` below 75%;
  `no_data` when the series is empty or stale (> 2× refresh interval).

Evaluation writes `riskLevel` + `lastEvaluatedAt` on the Goal. **Only a
transition** (e.g. `on_track → at_risk`) emits a recommendation — steady-state
shortfall never re-nags (same discipline as one-open-`UserSuggestion`-per-user).

Org and personal goals evaluate independently against their own metrics. The
`parentGoalId` link is recommendation context and rollup *display*, not an
auto-sum — parent and child track different source systems and summing them
would fabricate a number nobody owns.

## Recommendation integration

Goals feed the existing pipeline; nothing parallel is built.

- **Risk transition on an org goal** → `AgentMemory` suggestion
  (`kind: 'suggestion'`, `sourceRef: 'goal:<id>'`) + `notify()` — the surface
  org-level workflow suggestions already use.
- **Risk transition on a personal goal** → `UserSuggestion` with new kind
  `'goal_action'` and rendered evidence lines (e.g. *"MRR $41.2k is $6.8k behind
  pace; projected $52k vs $60k target by Oct 31"*), flowing through the existing
  suggestion-approval dialog.
- **Action selection, deterministic first:** catalogue templates
  (`src/lib/templates/catalogue.ts`) gain a `goalKinds: GoalKind[]` tag. An
  off-track goal pulls matching templates ranked by existing relevance +
  adoption + outcome weights. When no tagged template fits, the existing LLM
  synthesis path (`suggest-workflows.ts` infrastructure, same once-daily gating)
  composes a custom draft flow. When automation can't help, the suggestion is a
  plain recommended user action. Accepting a template/flow suggestion is
  one-click provision (`provision-plan.ts`).
- **Org-priority scoring:** for a personal goal linked to an org goal, candidate
  actions are scored against both goals, org weight first; an action that
  conflicts with the org goal doesn't surface.
- **Template relevance** (`src/lib/templates/relevance.ts`): new tier boost for
  "advances an active goal", with an *"Advances: {goal name}"* chip on template
  cards.
- **Outcome feedback:** goal-sourced suggestions get their own lane in
  `eligibility.ts` / `outcome-weights.ts`, so repeated dismissals throttle them
  like any other pattern kind.
- **Home assistant:** compact goal-status strip (progress + risk badges) on the
  dashboard home; active goals join the assistant's grounding so chat answers
  are goal-aware.

## Proof layer — "AI impact" / ROI attribution

The product claim: *"Our AI is the only AI that can prove ROI from day 1."* What
makes it true from day 1 is that attribution is captured **at the moment of
adoption** — accepting a goal-sourced suggestion creates the `GoalContribution`
link as a side effect of provisioning — so every attributed run is born
attributed, and proof starts with the first run rather than waiting for metric
movement. The recommendation engine is the provenance chain: goal → risk
transition → suggestion → accepted → provisioned → attributed runs.

### Impact math (computed on read; `src/lib/goals/impact.ts`, pure + unit-tested)

Three honesty tiers, and **every number in the UI carries its tier** — this is
the rule that keeps the marketing claim defensible:

| Tier | Numbers | Source |
| --- | --- | --- |
| **Measured** | attributed runs completed, outputs produced, actual token cost of those runs | joins over `FlowRun` / `AgentExecution` through `GoalContribution`; usage accounting already exists per-execution |
| **Estimated** | hours saved = runs × `estimatedMinutesSavedPerRun`; labor value = hours × org labor rate; **ROI multiple** = labor value ÷ AI cost | labor rate from `Organization.settings.laborHourlyRate`, default 50 USD/hr, editable in settings |
| **Correlated** | pace-delta: goal pace in the window before the first contribution vs after ("closing the gap X% faster since AI started helping") | deterministic math over `MetricDatapoint`; labeled correlation, never claimed as causation |

Catalogue templates (`SeedTemplate`) gain an `estimatedMinutesSaved` field to
seed the per-link estimate.

### Proof-layer UI (on the Goals tab)

- **`/goals` AI Impact strip** at the top: actions completed, hours saved,
  dollar value, ROI multiple — org-wide, since day 1, tier-labeled.
- **`/goals/[id]` impact panel**: the same figures scoped to the goal, plus
  **event markers on the trendline** showing when attributed automations were
  adopted and ran — the visual "AI showed up here, line bent there" story.
- **Link existing automation**: goal detail page lets a user attach an existing
  flow/agent as a contribution (`origin: 'manual'`) with an editable per-run
  estimate.

## UI

- **Sidebar:** `Goals` entry (lucide `Target`) in the `navigation` array of
  `src/components/layout/sidebar.tsx`; `/goals` added to `APP_PREFIXES` in
  `src/components/layout/app-shell.tsx`.
- **`/goals` dashboard:** org goal cards (progress bar with pace marker,
  sparkline, risk badge), then a "My goals" section. Personal goals render only
  for their owner.
- **`/goals/[id]` detail:** time-series chart (actuals + pace line + projection),
  metric health, datapoint history with manual entry, recommendation history,
  child-goal rollup on org goals.
- **Create wizard, 3 steps:**
  1. Kind, target value, deadline, owner (org / personal) and optional org-goal
     link.
  2. Source tool — org's connected tools that can serve this goal kind; connect
     CTAs reuse existing surfaces (credential vault for Stripe, Nango / native
     Google OAuth for the rest).
  3. Metric binding with a **live preview fetch** ("Current value: $41,203 — use
     as baseline?") so misconfigured bindings die in the wizard, not on the
     chart.
- **Charting:** no chart library exists in the repo and the needs are one line
  chart plus sparklines — hand-rolled small SVG components, no new dependency.

## API

All under `src/app/api/goals/`, `withAuthenticatedApi`, tenant-guard compliant:

| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/goals` | GET, POST | list (org goals + caller's personal goals), create |
| `/api/goals/[id]` | GET, PATCH, DELETE | detail (with evaluation + series summary), edit, archive/delete |
| `/api/goals/[id]/datapoints` | GET, POST | series for charts; manual datapoint entry |
| `/api/goals/metrics/preview` | POST | wizard live fetch: given source + binding config, return current value |
| `/api/goals/[id]/contributions` | GET, POST, DELETE | list contributions with computed impact; link/unlink an existing flow/agent |
| `/api/goals/impact` | GET | org-wide AI Impact strip figures (tier-labeled) |

Every new authenticated GET is registered in the route-smoke coverage guard
(`src/app/api/__tests__/route-smoke.test.ts`) — CI fails otherwise, by design.

## Error handling

- Connector fetch failures: captured on `GoalMetric.lastError`, surfaced as
  metric-health on the dashboard and as `no_data` risk when stale — never thrown
  across the cron tick.
- Stripe key revoked / Nango connection broken: existing
  `ConnectionVerification` machinery marks the connection unhealthy; the goal
  page links to the reconnect surface.
- Wizard preview fetch failure returns the connector's error message inline —
  the goal cannot be created with a binding that has never returned a value
  (except `manual`).
- Evaluation is total: empty series → `no_data`, single datapoint → progress
  without projection, `targetDate` in the past → `missed`/`achieved` settlement.

## Testing

- Unit: evaluation math edges (decreasing goals, sparse series, day-one goals,
  past-deadline settlement), connector adapters against recorded fixtures,
  day-bucket dedupe on re-sync, org-priority action scoring.
- Impact math: runs-before-link excluded, ROI multiple with zero token cost,
  pace-delta with no pre-contribution window, estimate edits reflected without
  rewriting history.
- Route smoke: all new GETs registered in the coverage guard.
- `goals-e2e.test.ts` following the `behavior-e2e` pattern: seed org → create
  goal → inject datapoints below pace → run refresh/evaluate tick → assert
  exactly one suggestion emitted, and none on the second tick (transition
  dedupe).

## Out of scope (v1)

- Auto-summing child goals into parent progress.
- Multi-metric goals (schema permits; UI/evaluator handle one).
- Goal permissions beyond owner-private personal goals.
- Forecasting beyond linear projection.
- Full platform reorientation: goal context injected into every agent run's
  prompt, goal-filtered onboarding, goal chips on all pages.
- Additional native connectors (QuickBooks, Snowflake, etc.) — the
  `MetricSource` registry is the extension point.
