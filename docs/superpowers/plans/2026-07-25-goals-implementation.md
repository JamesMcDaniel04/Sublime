# Goals (Targets, Metric Tracking, Proof Layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** First-class org/personal goals with native metric sync (Stripe, HubSpot, Salesforce, Google Sheets), deterministic pace/risk evaluation on the cron tick, risk-transition recommendations through the existing suggestion pipeline, a day-1 ROI proof layer, and a `/goals` surface.

**Architecture:** New Prisma spine (`Goal`, `GoalMetric`, `MetricDatapoint`, `GoalContribution`) + a `src/lib/metrics/` connector registry modeled on `ActivitySource`. A pure evaluator (`src/lib/goals/evaluate.ts`) runs after each metric refresh inside `/api/cron/dispatch`; only risk **transitions** emit a `UserSuggestion` (new kind `'goal_action'`). Impact is computed on read by joining `FlowRun`/`AgentExecution` through `GoalContribution` links. Spec: `docs/superpowers/specs/2026-07-25-goals-design.md`.

**Tech Stack:** Next.js App Router, Prisma/Postgres, node:test + tsx, Nango proxy / native Google proxy / credential vault, Tailwind + shadcn-style ui primitives.

## Global Constraints

- Every org-scoped query goes through `prisma` with `organizationId` in the `where` (tenant guard); cross-org sweeps use `systemPrisma` with a one-line justification comment ending in `(CRON_SECRET-gated).` or equivalent.
- New models: cuid ids, `organizationId String @db.Uuid` + `onDelete: Cascade` relation, `@@map("snake_case")`, `@db.Timestamptz(6)` timestamps, String status unions documented with `//` comments. Numeric metric values use `Float` (schema has zero `Decimal` usage).
- Every new `withAuthenticatedApi` **GET** route MUST be registered in `src/app/api/__tests__/route-smoke.test.ts` (`cases` array, name format `GET /api/<path>`) or CI fails.
- API routes: `export const runtime = 'nodejs'`, `withAuthenticatedApi(async (request, auth) => …)`, zod `.parse(await request.json().catch(() => ({})))`, `throw new ApiError(msg, status, 'CODE')`, return plain `{ success: true, … }`.
- Connectors never throw across the cron tick: failures land on `GoalMetric.lastError`.
- Personal goals (`ownerUserId` set) are visible ONLY to their owner: every read filter is `OR: [{ ownerUserId: null }, { ownerUserId: auth.dbUser.id }]`.
- UI: lucide icons, `Card`/`Badge`/`Button`/`StatTile` from `src/components/ui`, status via semantic tokens (`success`/`warning`/`destructive`) always paired with an icon + label (never color alone), single-series charts need no legend, text wears text tokens never series color.
- Tests: `node:test` + `assert/strict`, colocated `__tests__/`, run via `npm test`. DB-touching tests gate on `TEST_DATABASE_URL` (see `goals-e2e` task and `.claude/skills/verify/SKILL.md`).
- Goal kinds: `'arr' | 'mrr' | 'carr' | 'revenue' | 'quota' | 'savings' | 'custom_kpi'`. Risk levels: `'on_track' | 'at_risk' | 'off_track' | 'no_data'`. Metric sources: `'stripe' | 'hubspot' | 'salesforce' | 'google_sheets' | 'manual'`.
- Commit after every task with a conventional-commit message ending in the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.

**Spec deviations locked in here (spec updated separately):** org-goal recommendations also go through `UserSuggestion` (addressed to the goal's creator) + an org-wide `notify()` — `AgentMemory.agentId` is a required FK to `AgentTask`, so the spec's "org goal → AgentMemory" is not implementable without a fake agent. `UserSuggestion` gains a `metadata Json` column to carry `{ goalId, seedKey }`. Existing `suggestion_accepted`/`suggestion_dismissed` event kinds are reused (with `context.goalId`) instead of new goal-specific ones.

---

### Task 1: Prisma spine — Goal, GoalMetric, MetricDatapoint, GoalContribution

**Files:**
- Modify: `prisma/schema.prisma` (append 4 models; add back-relations to `Organization` and `User`; add `metadata` to `UserSuggestion`)

**Interfaces:**
- Produces: Prisma client models `goal`, `goalMetric`, `metricDatapoint`, `goalContribution`; `UserSuggestion.metadata: Json`. All four new models auto-enroll in the tenant guard (required `organizationId`).

- [ ] **Step 1: Append the four models to `prisma/schema.prisma`**

```prisma
/// A measurable target. ownerUserId null = org goal (visible to the whole
/// org); set = personal goal (visible only to its owner). A personal goal may
/// name the org goal it supports via parentGoalId (recommendation context and
/// rollup display — never an auto-sum). riskLevel is PERSISTED so the
/// evaluator can detect transitions: only a transition emits a suggestion.
model Goal {
  id              String    @id @default(cuid())
  organizationId  String    @db.Uuid
  ownerUserId     String?
  parentGoalId    String?
  name            String
  description     String?   @db.Text
  kind            String // 'arr' | 'mrr' | 'carr' | 'revenue' | 'quota' | 'savings' | 'custom_kpi'
  direction       String    @default("increase") // 'increase' | 'decrease' (savings count down)
  unit            String    @default("usd") // 'usd' | 'count' | 'percent'
  startValue      Float
  targetValue     Float
  startAt         DateTime  @default(now()) @db.Timestamptz(6)
  targetDate      DateTime  @db.Timestamptz(6)
  status          String    @default("active") // 'active' | 'paused' | 'achieved' | 'missed' | 'archived'
  riskLevel       String    @default("no_data") // 'on_track' | 'at_risk' | 'off_track' | 'no_data'
  lastEvaluatedAt DateTime? @db.Timestamptz(6)
  createdByUserId String?
  createdAt       DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt       DateTime  @updatedAt @db.Timestamptz(6)

  organization  Organization       @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  owner         User?              @relation(fields: [ownerUserId], references: [id], onDelete: Cascade)
  parent        Goal?              @relation("GoalRollup", fields: [parentGoalId], references: [id], onDelete: SetNull)
  children      Goal[]             @relation("GoalRollup")
  metrics       GoalMetric[]
  contributions GoalContribution[]

  @@index([organizationId, status])
  @@index([organizationId, ownerUserId, status])
  @@map("goals")
}

/// Binding of a goal to its source-of-truth number. Exactly one per goal in
/// v1 (the @@unique enforces it; drop to allow multi-metric later).
/// connectionRef: 'credential:<id>' (stripe) | 'nango:<connectionId>' |
/// 'google:<googleOAuthConnectionId>' | null (manual). A stale or erroring
/// metric is itself a goal-risk signal (riskLevel 'no_data').
model GoalMetric {
  id                   String    @id @default(cuid())
  organizationId       String    @db.Uuid
  goalId               String    @unique
  source               String // 'stripe' | 'hubspot' | 'salesforce' | 'google_sheets' | 'manual'
  metricKey            String // e.g. 'stripe.mrr' | 'hubspot.pipeline_value' | 'sheets.range'
  connectionRef        String?
  config               Json      @default("{}")
  refreshIntervalHours Int       @default(24)
  lastSyncAt           DateTime? @db.Timestamptz(6)
  lastError            String?   @db.Text
  createdAt            DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt            DateTime  @updatedAt @db.Timestamptz(6)

  organization Organization      @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  goal         Goal              @relation(fields: [goalId], references: [id], onDelete: Cascade)
  datapoints   MetricDatapoint[]

  @@index([organizationId, source])
  @@map("goal_metrics")
}

/// Time-series reading. bucketKey is the UTC day 'YYYY-MM-DD' of capturedAt —
/// re-syncs upsert on (goalMetricId, bucketKey) and never double-write (the
/// activity-ledger dedupe discipline).
model MetricDatapoint {
  id             String   @id @default(cuid())
  organizationId String   @db.Uuid
  goalMetricId   String
  value          Float
  capturedAt     DateTime @db.Timestamptz(6)
  bucketKey      String
  origin         String   @default("sync") // 'sync' | 'manual' | 'backfill'
  createdAt      DateTime @default(now()) @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  goalMetric   GoalMetric   @relation(fields: [goalMetricId], references: [id], onDelete: Cascade)

  @@unique([goalMetricId, bucketKey])
  @@index([organizationId, goalMetricId, capturedAt])
  @@map("metric_datapoints")
}

/// Attribution link (proof layer): an automation that exists — or was
/// enlisted — to advance a goal. Created automatically when a goal suggestion
/// is provisioned, or manually from the goal page. Impact is computed by
/// joining FlowRun/AgentExecution through these links; runs that started
/// before createdAt never count.
model GoalContribution {
  id                          String   @id @default(cuid())
  organizationId              String   @db.Uuid
  goalId                      String
  resourceType                String // 'flow' | 'agent'
  resourceId                  String
  origin                      String // 'suggestion' | 'manual'
  estimatedMinutesSavedPerRun Int      @default(30)
  createdAt                   DateTime @default(now()) @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  goal         Goal         @relation(fields: [goalId], references: [id], onDelete: Cascade)

  @@unique([goalId, resourceType, resourceId])
  @@index([organizationId, goalId])
  @@map("goal_contributions")
}
```

- [ ] **Step 2: Add back-relations**

In `model Organization`, append to the relations block (after `persona OrganizationPersona?`):

```prisma
  goals                     Goal[]
  goalMetrics               GoalMetric[]
  metricDatapoints          MetricDatapoint[]
  goalContributions         GoalContribution[]
```

In `model User`, append to its relations block:

```prisma
  goals Goal[]
```

In `model UserSuggestion`, add after `evidence`:

```prisma
  /// Kind-specific payload. goal_action: { goalId, seedKey } — the goal that
  /// triggered it and the catalogue template the accept deploys.
  metadata           Json     @default("{}")
```

- [ ] **Step 3: Create the migration**

Run: `npm run db:migrate -- --name goals_spine`
Expected: migration `2026…_goals_spine` created and applied; `prisma generate` regenerates the client.

- [ ] **Step 4: Typecheck + existing tests**

Run: `npm run typecheck && npm test`
Expected: PASS (nothing consumes the models yet; tenant guard derives the new models from DMMF automatically).

- [ ] **Step 5: Commit**

```bash
git add prisma
git commit -m "feat(goals): prisma spine — Goal, GoalMetric, MetricDatapoint, GoalContribution"
```

---

### Task 2: Pure evaluator — pace, projection, risk, settlement

**Files:**
- Create: `src/lib/goals/evaluate.ts`
- Test: `src/lib/goals/__tests__/evaluate.test.ts`

**Interfaces:**
- Produces:
  - `type GoalRiskLevel = 'on_track' | 'at_risk' | 'off_track' | 'no_data'`
  - `interface EvalGoal { direction: 'increase' | 'decrease'; startValue: number; targetValue: number; startAt: Date; targetDate: Date }`
  - `interface EvalPoint { value: number; capturedAt: Date }`
  - `interface Evaluation { currentValue: number | null; progress: number | null; expectedProgress: number; projectedValue: number | null; riskLevel: GoalRiskLevel }`
  - `evaluateGoal(goal: EvalGoal, points: EvalPoint[], now: Date, staleAfterMs: number): Evaluation` (points may arrive unsorted; the function sorts ascending by capturedAt)
  - `settleStatus(goal: EvalGoal, evaluation: Evaluation, now: Date): 'achieved' | 'missed' | null` — non-null only when `now > targetDate`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/goals/__tests__/evaluate.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateGoal, settleStatus, type EvalGoal } from '../evaluate'

const DAY = 24 * 60 * 60 * 1000
const STALE = 2 * DAY
const t0 = new Date('2026-01-01T00:00:00Z')
const day = (n: number) => new Date(t0.getTime() + n * DAY)

const goal: EvalGoal = {
  direction: 'increase',
  startValue: 100,
  targetValue: 200,
  startAt: t0,
  targetDate: day(100),
}
const pt = (n: number, value: number) => ({ value, capturedAt: day(n) })

test('no datapoints → no_data', () => {
  const e = evaluateGoal(goal, [], day(10), STALE)
  assert.equal(e.riskLevel, 'no_data')
  assert.equal(e.currentValue, null)
  assert.equal(e.progress, null)
})

test('stale series → no_data', () => {
  const e = evaluateGoal(goal, [pt(1, 150)], day(10), STALE)
  assert.equal(e.riskLevel, 'no_data')
})

test('on pace → on_track', () => {
  // Day 50 of 100, value 150 = exactly 50% progress vs 50% expected.
  const e = evaluateGoal(goal, [pt(0, 100), pt(49, 150)], day(50), STALE)
  assert.equal(e.riskLevel, 'on_track')
  assert.equal(e.currentValue, 150)
  assert.ok(Math.abs((e.progress ?? 0) - 0.5) < 0.01)
})

test('day-one goal with a baseline point → on_track (nothing expected yet)', () => {
  const e = evaluateGoal(goal, [pt(0, 100)], day(0), STALE)
  assert.equal(e.riskLevel, 'on_track')
})

test('graded shortfall → at_risk between 75% and 95% of pace', () => {
  // Day 50: expected 0.5. Progress 0.4 = 80% of pace.
  const e = evaluateGoal(goal, [pt(0, 100), pt(49, 140)], day(50), STALE)
  assert.equal(e.riskLevel, 'at_risk')
})

test('below 75% of pace → off_track', () => {
  // Day 50: progress 0.2 = 40% of pace.
  const e = evaluateGoal(goal, [pt(0, 100), pt(49, 120)], day(50), STALE)
  assert.equal(e.riskLevel, 'off_track')
})

test('projection clearing the target rescues a behind-pace goal', () => {
  // Behind pace at day 50 (progress 0.4) but accelerating: regression over
  // the last points projects past 200 by day 100.
  const points = [pt(40, 100), pt(45, 118), pt(49, 140)]
  const e = evaluateGoal(goal, points, day(50), STALE)
  assert.ok((e.projectedValue ?? 0) >= 200)
  assert.equal(e.riskLevel, 'on_track')
})

test('decreasing goal (savings): falling value is progress', () => {
  const savings: EvalGoal = { ...goal, direction: 'decrease', startValue: 1000, targetValue: 600 }
  // Day 50: value 800 = 50% of the 1000→600 span vs 50% expected.
  const e = evaluateGoal(savings, [pt(0, 1000), pt(49, 800)], day(50), STALE)
  assert.equal(e.riskLevel, 'on_track')
  assert.ok(Math.abs((e.progress ?? 0) - 0.5) < 0.01)
})

test('single datapoint → no projection, but progress computes', () => {
  const e = evaluateGoal(goal, [pt(49, 150)], day(50), STALE)
  assert.equal(e.projectedValue, null)
  assert.ok(Math.abs((e.progress ?? 0) - 0.5) < 0.01)
})

test('unsorted input is sorted internally', () => {
  const e = evaluateGoal(goal, [pt(49, 150), pt(0, 100)], day(50), STALE)
  assert.equal(e.currentValue, 150)
})

test('degenerate span (target === start) → no_data, no crash', () => {
  const degenerate: EvalGoal = { ...goal, targetValue: 100 }
  const e = evaluateGoal(degenerate, [pt(1, 100)], day(2), STALE)
  assert.equal(e.riskLevel, 'no_data')
})

test('settlement: past deadline, progress >= 1 → achieved', () => {
  const e = evaluateGoal(goal, [pt(99, 205)], day(101), STALE)
  assert.equal(settleStatus(goal, e, day(101)), 'achieved')
})

test('settlement: past deadline, short → missed', () => {
  const e = evaluateGoal(goal, [pt(99, 150)], day(101), STALE)
  assert.equal(settleStatus(goal, e, day(101)), 'missed')
})

test('no settlement before the deadline', () => {
  const e = evaluateGoal(goal, [pt(49, 150)], day(50), STALE)
  assert.equal(settleStatus(goal, e, day(50)), null)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/evaluate.test.ts`
Expected: FAIL — cannot find module `../evaluate`.

- [ ] **Step 3: Implement**

```ts
// src/lib/goals/evaluate.ts
/**
 * Pure goal evaluation: progress vs linear pace, least-squares projection,
 * graded risk. Zero I/O, zero tokens — unit-tested exhaustively so the cron
 * tick and the API can both trust it.
 *
 * Risk grading: on_track at >= 95% of expected pace OR when the projection
 * clears the target; at_risk down to 75% of pace; off_track below. A stale or
 * empty series is 'no_data' — a metric nobody is reading must not look
 * healthy (same principle as connection verification).
 */
export type GoalRiskLevel = 'on_track' | 'at_risk' | 'off_track' | 'no_data'

export interface EvalGoal {
  direction: 'increase' | 'decrease'
  startValue: number
  targetValue: number
  startAt: Date
  targetDate: Date
}

export interface EvalPoint {
  value: number
  capturedAt: Date
}

export interface Evaluation {
  currentValue: number | null
  /** Fraction of the start→target span covered. Direction-agnostic: for
   *  decreasing goals the span is negative and the ratio stays positive. */
  progress: number | null
  /** Linear expected progress in [0, 1] for `now`. */
  expectedProgress: number
  /** Least-squares projection of the value at targetDate; null with < 2 points. */
  projectedValue: number | null
  riskLevel: GoalRiskLevel
}

const ON_TRACK_PACE_RATIO = 0.95
const AT_RISK_PACE_RATIO = 0.75

export function evaluateGoal(goal: EvalGoal, points: EvalPoint[], now: Date, staleAfterMs: number): Evaluation {
  const span = goal.targetValue - goal.startValue
  const sorted = [...points].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime())
  const latest = sorted.at(-1) ?? null

  const elapsed = now.getTime() - goal.startAt.getTime()
  const total = goal.targetDate.getTime() - goal.startAt.getTime()
  const expectedProgress = total <= 0 ? 1 : Math.min(1, Math.max(0, elapsed / total))

  if (!latest || span === 0) {
    return { currentValue: latest?.value ?? null, progress: null, expectedProgress, projectedValue: null, riskLevel: 'no_data' }
  }
  if (now.getTime() - latest.capturedAt.getTime() > staleAfterMs) {
    const progress = (latest.value - goal.startValue) / span
    return { currentValue: latest.value, progress, expectedProgress, projectedValue: null, riskLevel: 'no_data' }
  }

  const progress = (latest.value - goal.startValue) / span
  const projectedValue = project(sorted, goal.targetDate)
  const projectedProgress = projectedValue === null ? null : (projectedValue - goal.startValue) / span

  let riskLevel: GoalRiskLevel
  if (progress >= 1) riskLevel = 'on_track'
  else if (expectedProgress === 0) riskLevel = 'on_track' // day one: nothing expected yet
  else if (progress >= ON_TRACK_PACE_RATIO * expectedProgress) riskLevel = 'on_track'
  else if (projectedProgress !== null && projectedProgress >= 1) riskLevel = 'on_track'
  else if (progress >= AT_RISK_PACE_RATIO * expectedProgress) riskLevel = 'at_risk'
  else riskLevel = 'off_track'

  return { currentValue: latest.value, progress, expectedProgress, projectedValue, riskLevel }
}

/** Ordinary least squares over (ms, value); evaluated at targetDate. */
function project(sorted: EvalPoint[], targetDate: Date): number | null {
  if (sorted.length < 2) return null
  const xs = sorted.map((p) => p.capturedAt.getTime())
  const ys = sorted.map((p) => p.value)
  const n = xs.length
  const meanX = xs.reduce((a, b) => a + b, 0) / n
  const meanY = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - meanX) * (ys[i] - meanY)
    sxx += (xs[i] - meanX) ** 2
  }
  if (sxx === 0) return null // all points share one timestamp
  const slope = sxy / sxx
  return meanY + slope * (targetDate.getTime() - meanX)
}

/** Past-deadline settlement; null while the goal is still live. */
export function settleStatus(goal: EvalGoal, evaluation: Evaluation, now: Date): 'achieved' | 'missed' | null {
  if (now.getTime() <= goal.targetDate.getTime()) return null
  return (evaluation.progress ?? 0) >= 1 ? 'achieved' : 'missed'
}
```

- [ ] **Step 4: Run tests**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/evaluate.test.ts`
Expected: all PASS. (If the projection-rescue test fails, check the regression window — it uses ALL provided points; the test feeds only accelerating recent points on purpose.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/goals
git commit -m "feat(goals): pure evaluator — pace, least-squares projection, graded risk, settlement"
```

---

### Task 3: Metric source registry + Stripe adapter

**Files:**
- Create: `src/lib/metrics/types.ts`, `src/lib/metrics/registry.ts`, `src/lib/metrics/sources/stripe.ts`
- Test: `src/lib/metrics/__tests__/stripe.test.ts`

**Interfaces:**
- Produces:
  - `interface MetricSourceContext { organizationId: string; connectionRef: string | null; config: Record<string, unknown> }`
  - `interface MetricReading { value: number; asOf: Date }`
  - `interface MetricDescriptor { key: string; label: string; unit: 'usd' | 'count' | 'percent' }`
  - `interface MetricSource { source: string; availableMetrics(goalKind: string): MetricDescriptor[]; fetchValue(ctx: MetricSourceContext, metricKey: string): Promise<MetricReading> }`
  - `getMetricSource(source: string): MetricSource | null`, `listMetricSources(): MetricSource[]`
  - `makeStripeMetricSource(fetchImpl?: typeof fetch): MetricSource` + singleton `stripeMetricSource`
- Consumes: `credentialScope`/`decryptCredentialConfig` from `@/lib/credentials` (Task 1's vault rows hold the Stripe key as a `bearer` credential; `connectionRef = 'credential:<id>'`).

- [ ] **Step 1: Write `types.ts` and `registry.ts`**

```ts
// src/lib/metrics/types.ts
/** Metric source registry (goals spec) — the ActivitySource pattern applied
 *  to point-in-time readings instead of event streams. Adapters never hold
 *  raw tokens beyond the call. */
export interface MetricSourceContext {
  organizationId: string
  /** 'credential:<id>' | 'nango:<connectionId>' | 'google:<id>' | null */
  connectionRef: string | null
  config: Record<string, unknown>
}

export interface MetricReading {
  value: number
  asOf: Date
}

export interface MetricDescriptor {
  key: string
  label: string
  unit: 'usd' | 'count' | 'percent'
}

export interface MetricSource {
  source: string
  availableMetrics(goalKind: string): MetricDescriptor[]
  fetchValue(ctx: MetricSourceContext, metricKey: string): Promise<MetricReading>
}

/** 'credential:abc' → 'abc'; throws on plane mismatch so a misfiled binding
 *  fails loudly at fetch time, not silently with someone else's connection. */
export function refId(connectionRef: string | null, plane: 'credential' | 'nango' | 'google'): string {
  const prefix = `${plane}:`
  if (!connectionRef || !connectionRef.startsWith(prefix)) {
    throw new Error(`Metric binding expected a ${plane} connection, got '${connectionRef ?? 'none'}'`)
  }
  return connectionRef.slice(prefix.length)
}
```

```ts
// src/lib/metrics/registry.ts
import type { MetricSource } from './types'
import { stripeMetricSource } from './sources/stripe'
import { hubspotMetricSource } from './sources/hubspot'
import { salesforceMetricSource } from './sources/salesforce'
import { googleSheetsMetricSource } from './sources/google-sheets'

const SOURCES: Record<string, MetricSource> = {
  [stripeMetricSource.source]: stripeMetricSource,
  [hubspotMetricSource.source]: hubspotMetricSource,
  [salesforceMetricSource.source]: salesforceMetricSource,
  [googleSheetsMetricSource.source]: googleSheetsMetricSource,
}

export function getMetricSource(source: string): MetricSource | null {
  return SOURCES[source] ?? null
}

export function listMetricSources(): MetricSource[] {
  return Object.values(SOURCES)
}
```

(Registry won't compile until Tasks 4–5 add the other adapters — within this task, temporarily register only `stripeMetricSource` and add the rest in their tasks.)

- [ ] **Step 2: Write the failing Stripe adapter test**

```ts
// src/lib/metrics/__tests__/stripe.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeMrrCents, type StripeSubscription } from '../sources/stripe'

const sub = (items: Array<{ unit_amount: number; interval: string; interval_count?: number; quantity?: number }>): StripeSubscription => ({
  items: {
    data: items.map((i) => ({
      quantity: i.quantity ?? 1,
      price: { unit_amount: i.unit_amount, recurring: { interval: i.interval, interval_count: i.interval_count ?? 1 } },
    })),
  },
})

test('monthly price counts at face value', () => {
  assert.equal(computeMrrCents([sub([{ unit_amount: 5000, interval: 'month' }])]), 5000)
})

test('annual price is normalized to monthly', () => {
  assert.equal(computeMrrCents([sub([{ unit_amount: 120000, interval: 'year' }])]), 10000)
})

test('quantity and interval_count multiply/divide', () => {
  // 3 seats × $50/quarter (interval_count 3 months) = 3 × 5000 / 3 = 5000
  assert.equal(computeMrrCents([sub([{ unit_amount: 5000, interval: 'month', interval_count: 3, quantity: 3 }])]), 5000)
})

test('weekly and daily intervals are normalized', () => {
  assert.equal(Math.round(computeMrrCents([sub([{ unit_amount: 1000, interval: 'week' }])])), Math.round(1000 * (365.25 / 84)))
  assert.equal(Math.round(computeMrrCents([sub([{ unit_amount: 100, interval: 'day' }])])), Math.round(100 * (365.25 / 12)))
})

test('null unit_amount (metered/tiered) is skipped, not NaN', () => {
  const metered = { items: { data: [{ quantity: 1, price: { unit_amount: null, recurring: { interval: 'month', interval_count: 1 } } }] } }
  assert.equal(computeMrrCents([metered as unknown as StripeSubscription]), 0)
})
```

- [ ] **Step 3: Run to verify failure**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/metrics/__tests__/stripe.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the Stripe adapter**

```ts
// src/lib/metrics/sources/stripe.ts
/**
 * Stripe metric source. Auth: an org-vault Credential (type 'bearer' or
 * 'apiKeyHeader') holding a restricted Stripe secret key with read access to
 * Subscriptions — connectionRef 'credential:<id>'. MRR is computed from
 * active subscriptions (Stripe exposes no MRR endpoint); ARR = MRR × 12.
 */
import { prisma } from '@/lib/prisma'
import { credentialScope } from '@/lib/credentials/resolve'
import { decryptCredentialConfig } from '@/lib/credentials/config'
import type { MetricDescriptor, MetricReading, MetricSource, MetricSourceContext } from '../types'
import { refId } from '../types'

const PAGE_SIZE = 100
const MAX_PAGES = 10
const CALL_TIMEOUT_MS = 30_000

export type StripeSubscription = {
  items: { data: Array<{ quantity?: number; price: { unit_amount: number | null; recurring: { interval: string; interval_count: number } | null } }> }
}

/** Months per interval unit, on a 365.25-day year. */
const MONTHS: Record<string, number> = { month: 1, year: 12, week: 84 / 365.25, day: 12 / 365.25 }

/** Pure: MRR in cents from active subscriptions. Metered prices (null
 *  unit_amount) and unknown intervals are skipped, never NaN. */
export function computeMrrCents(subscriptions: StripeSubscription[]): number {
  let cents = 0
  for (const subscription of subscriptions) {
    for (const item of subscription.items.data) {
      const { price } = item
      if (price.unit_amount === null || !price.recurring) continue
      const months = MONTHS[price.recurring.interval]
      if (!months) continue
      cents += (price.unit_amount * (item.quantity ?? 1)) / (months * price.recurring.interval_count)
    }
  }
  return cents
}

const METRICS: MetricDescriptor[] = [
  { key: 'stripe.mrr', label: 'MRR (active subscriptions)', unit: 'usd' },
  { key: 'stripe.arr', label: 'ARR (MRR × 12)', unit: 'usd' },
  { key: 'stripe.active_subscriptions', label: 'Active subscriptions', unit: 'count' },
]

async function stripeKey(ctx: MetricSourceContext): Promise<string> {
  const id = refId(ctx.connectionRef, 'credential')
  const cred = await prisma.credential.findFirst({ where: { id, ...credentialScope(ctx.organizationId) } })
  if (!cred) throw new Error('Stripe credential is unavailable — check Settings → Credentials.')
  const dec = decryptCredentialConfig(cred.type, cred.authConfig) as { token?: string; key?: string }
  const key = dec.token ?? dec.key
  if (!key) throw new Error('Stripe credential holds no secret key.')
  return key
}

export function makeStripeMetricSource(fetchImpl: typeof fetch = fetch): MetricSource {
  async function listActiveSubscriptions(key: string): Promise<StripeSubscription[]> {
    const all: StripeSubscription[] = []
    let startingAfter: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL('https://api.stripe.com/v1/subscriptions')
      url.searchParams.set('status', 'active')
      url.searchParams.set('limit', String(PAGE_SIZE))
      if (startingAfter) url.searchParams.set('starting_after', startingAfter)
      const response = await fetchImpl(url.toString(), {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`Stripe API ${response.status}: ${(await response.text()).slice(0, 200)}`)
      const body = (await response.json()) as { data: Array<StripeSubscription & { id: string }>; has_more: boolean }
      all.push(...body.data)
      if (!body.has_more || body.data.length === 0) break
      startingAfter = body.data[body.data.length - 1].id
    }
    return all
  }

  return {
    source: 'stripe',
    availableMetrics(goalKind) {
      if (goalKind === 'custom_kpi' || goalKind === 'savings') return METRICS
      return goalKind === 'quota' ? [] : METRICS
    },
    async fetchValue(ctx, metricKey): Promise<MetricReading> {
      const key = await stripeKey(ctx)
      const subscriptions = await listActiveSubscriptions(key)
      const asOf = new Date()
      if (metricKey === 'stripe.active_subscriptions') return { value: subscriptions.length, asOf }
      const mrr = computeMrrCents(subscriptions) / 100
      if (metricKey === 'stripe.mrr') return { value: mrr, asOf }
      if (metricKey === 'stripe.arr') return { value: mrr * 12, asOf }
      throw new Error(`Unknown Stripe metric '${metricKey}'`)
    },
  }
}

export const stripeMetricSource = makeStripeMetricSource()
```

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/metrics/__tests__/stripe.test.ts && npm run typecheck`
Expected: PASS.

```bash
git add src/lib/metrics
git commit -m "feat(goals): metric source registry + Stripe adapter (MRR/ARR from active subscriptions)"
```

---

### Task 4: HubSpot + Salesforce adapters (Nango proxy)

**Files:**
- Create: `src/lib/metrics/sources/hubspot.ts`, `src/lib/metrics/sources/salesforce.ts`
- Modify: `src/lib/metrics/registry.ts` (register both)
- Test: `src/lib/metrics/__tests__/crm-sources.test.ts`

**Interfaces:**
- Produces: `makeHubspotMetricSource(proxyOverride?: NangoProxy)`, `makeSalesforceMetricSource(proxyOverride?: NangoProxy)` + singletons `hubspotMetricSource`, `salesforceMetricSource`.
- Consumes: `NangoProxy` type + `getNangoClient` (mirror `src/lib/activity/sources/hubspot.ts`'s `defaultProxy()`/`withTimeout` verbatim); `connectionRef = 'nango:<connectionId>'` resolved via `prisma.nangoConnection.findFirst({ where: { organizationId, connectionId } })`.
- Metric keys + config: `hubspot.pipeline_value` / `hubspot.closed_won` and `salesforce.pipeline_value` / `salesforce.closed_won`; `config.periodStartIso?: string` (closed-won window start; default Jan 1 of the current UTC year).

- [ ] **Step 1: Write the failing tests** — both adapters take an injectable proxy, so the tests feed canned pages and assert summing + pagination + filter payloads:

```ts
// src/lib/metrics/__tests__/crm-sources.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeHubspotMetricSource } from '../sources/hubspot'
import { makeSalesforceMetricSource } from '../sources/salesforce'
import type { NangoProxy } from '@/lib/nango/delivery'

// Both adapters resolve the connection row first; inject that too.
const connection = { connectionId: 'conn-1', providerConfigKey: 'hubspot' }
const ctx = { organizationId: 'org-1', connectionRef: 'nango:conn-1', config: {} }

test('hubspot pipeline_value sums open deal amounts across pages', async () => {
  const pages = [
    { results: [{ properties: { amount: '1000' } }, { properties: { amount: '250.50' } }], paging: { next: { after: 'p2' } } },
    { results: [{ properties: { amount: '749.50' } }] },
  ]
  let call = 0
  const proxy: NangoProxy = async (args) => {
    const body = args.data as { filterGroups?: unknown[] }
    assert.ok(Array.isArray(body.filterGroups), 'open-deal filter present')
    return { data: pages[call++] }
  }
  const source = makeHubspotMetricSource(proxy, async () => connection)
  const reading = await source.fetchValue(ctx, 'hubspot.pipeline_value')
  assert.equal(reading.value, 2000)
  assert.equal(call, 2)
})

test('hubspot closed_won filters by closedate >= periodStart', async () => {
  let sentFilters: unknown
  const proxy: NangoProxy = async (args) => {
    sentFilters = (args.data as { filterGroups: unknown }).filterGroups
    return { data: { results: [{ properties: { amount: '5000' } }] } }
  }
  const source = makeHubspotMetricSource(proxy, async () => connection)
  const reading = await source.fetchValue(
    { ...ctx, config: { periodStartIso: '2026-01-01T00:00:00Z' } },
    'hubspot.closed_won',
  )
  assert.equal(reading.value, 5000)
  assert.match(JSON.stringify(sentFilters), /closedate/)
})

test('salesforce pipeline_value reads the SOQL aggregate', async () => {
  let soql = ''
  const proxy: NangoProxy = async (args) => {
    soql = String((args.params as Record<string, unknown>).q)
    return { data: { records: [{ total: 41250 }] } }
  }
  const source = makeSalesforceMetricSource(proxy, async () => ({ ...connection, providerConfigKey: 'salesforce' }))
  const reading = await source.fetchValue({ ...ctx, connectionRef: 'nango:conn-1' }, 'salesforce.pipeline_value')
  assert.equal(reading.value, 41250)
  assert.match(soql, /IsClosed = false/)
})

test('salesforce closed_won: null aggregate (no rows) reads as 0', async () => {
  const proxy: NangoProxy = async () => ({ data: { records: [{ total: null }] } })
  const source = makeSalesforceMetricSource(proxy, async () => ({ ...connection, providerConfigKey: 'salesforce' }))
  const reading = await source.fetchValue(ctx, 'salesforce.closed_won')
  assert.equal(reading.value, 0)
})
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement both adapters.** Shared shape (shown for HubSpot; Salesforce differs only in the query layer):

```ts
// src/lib/metrics/sources/hubspot.ts
/** HubSpot metric source: deal-amount aggregates via the Nango proxy.
 *  pipeline_value = sum of open deals' amount; closed_won = sum of won deals
 *  with closedate >= config.periodStartIso (default: Jan 1 this UTC year). */
import { prisma } from '@/lib/prisma'
import { getNangoClient } from '@/lib/nango/client'
import type { NangoProxy } from '@/lib/nango/delivery'
import type { MetricDescriptor, MetricReading, MetricSource, MetricSourceContext } from '../types'
import { refId } from '../types'

const PAGE_SIZE = 100
const MAX_PAGES = 10
const CALL_TIMEOUT_MS = 30_000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer)) as Promise<T>
}

function defaultProxy(): NangoProxy {
  const nango = getNangoClient()
  return (args) => withTimeout(nango.proxy(args as never) as Promise<{ data: unknown }>, CALL_TIMEOUT_MS, `HubSpot ${args.endpoint}`)
}

type Connection = { connectionId: string; providerConfigKey: string }
type ResolveConnection = (ctx: MetricSourceContext) => Promise<Connection | null>

const defaultResolve: ResolveConnection = async (ctx) => {
  const connectionId = refId(ctx.connectionRef, 'nango')
  return prisma.nangoConnection.findFirst({
    where: { organizationId: ctx.organizationId, connectionId },
    select: { connectionId: true, providerConfigKey: true },
  })
}

function defaultPeriodStart(config: Record<string, unknown>): string {
  if (typeof config.periodStartIso === 'string') return config.periodStartIso
  return `${new Date().getUTCFullYear()}-01-01T00:00:00Z`
}

const METRICS: MetricDescriptor[] = [
  { key: 'hubspot.pipeline_value', label: 'Open pipeline value', unit: 'usd' },
  { key: 'hubspot.closed_won', label: 'Closed-won revenue (period)', unit: 'usd' },
]

export function makeHubspotMetricSource(proxyOverride?: NangoProxy, resolveOverride?: ResolveConnection): MetricSource {
  return {
    source: 'hubspot',
    availableMetrics: () => METRICS,
    async fetchValue(ctx, metricKey): Promise<MetricReading> {
      const connection = await (resolveOverride ?? defaultResolve)(ctx)
      if (!connection) throw new Error('HubSpot connection not found — reconnect it in Integrations.')
      const proxy = proxyOverride ?? defaultProxy()

      const filters =
        metricKey === 'hubspot.closed_won'
          ? [
              { propertyName: 'hs_is_closed_won', operator: 'EQ', value: 'true' },
              { propertyName: 'closedate', operator: 'GTE', value: String(Date.parse(defaultPeriodStart(ctx.config))) },
            ]
          : [{ propertyName: 'hs_is_closed', operator: 'EQ', value: 'false' }]

      let total = 0
      let after: string | undefined
      for (let page = 0; page < MAX_PAGES; page++) {
        const response = await proxy({
          method: 'POST',
          endpoint: '/crm/v3/objects/deals/search',
          connectionId: connection.connectionId,
          providerConfigKey: connection.providerConfigKey,
          data: { limit: PAGE_SIZE, ...(after ? { after } : {}), properties: ['amount'], filterGroups: [{ filters }] },
        })
        const data = response.data as { results?: Array<{ properties?: { amount?: string | null } }>; paging?: { next?: { after?: unknown } } }
        for (const deal of data.results ?? []) {
          const amount = Number(deal.properties?.amount)
          if (Number.isFinite(amount)) total += amount
        }
        after = typeof data.paging?.next?.after === 'string' ? data.paging.next.after : undefined
        if (!after) break
      }
      return { value: total, asOf: new Date() }
    },
  }
}

export const hubspotMetricSource = makeHubspotMetricSource()
```

```ts
// src/lib/metrics/sources/salesforce.ts
/** Salesforce metric source: SOQL SUM(Amount) aggregates via the Nango proxy. */
import { prisma } from '@/lib/prisma'
import { getNangoClient } from '@/lib/nango/client'
import type { NangoProxy } from '@/lib/nango/delivery'
import type { MetricDescriptor, MetricReading, MetricSource, MetricSourceContext } from '../types'
import { refId } from '../types'

const CALL_TIMEOUT_MS = 30_000
const API_VERSION = 'v58.0'

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer)) as Promise<T>
}

function defaultProxy(): NangoProxy {
  const nango = getNangoClient()
  return (args) => withTimeout(nango.proxy(args as never) as Promise<{ data: unknown }>, CALL_TIMEOUT_MS, `Salesforce ${args.endpoint}`)
}

type Connection = { connectionId: string; providerConfigKey: string }
type ResolveConnection = (ctx: MetricSourceContext) => Promise<Connection | null>

const defaultResolve: ResolveConnection = async (ctx) => {
  const connectionId = refId(ctx.connectionRef, 'nango')
  return prisma.nangoConnection.findFirst({
    where: { organizationId: ctx.organizationId, connectionId },
    select: { connectionId: true, providerConfigKey: true },
  })
}

/** SOQL date literal (YYYY-MM-DD) from config.periodStartIso. */
function periodStartDate(config: Record<string, unknown>): string {
  const iso = typeof config.periodStartIso === 'string' ? config.periodStartIso : `${new Date().getUTCFullYear()}-01-01T00:00:00Z`
  return iso.slice(0, 10)
}

const METRICS: MetricDescriptor[] = [
  { key: 'salesforce.pipeline_value', label: 'Open pipeline value', unit: 'usd' },
  { key: 'salesforce.closed_won', label: 'Closed-won revenue (period)', unit: 'usd' },
]

export function makeSalesforceMetricSource(proxyOverride?: NangoProxy, resolveOverride?: ResolveConnection): MetricSource {
  return {
    source: 'salesforce',
    availableMetrics: () => METRICS,
    async fetchValue(ctx, metricKey): Promise<MetricReading> {
      const connection = await (resolveOverride ?? defaultResolve)(ctx)
      if (!connection) throw new Error('Salesforce connection not found — reconnect it in Integrations.')
      const proxy = proxyOverride ?? defaultProxy()
      const soql =
        metricKey === 'salesforce.closed_won'
          ? `SELECT SUM(Amount) total FROM Opportunity WHERE IsWon = true AND CloseDate >= ${periodStartDate(ctx.config)}`
          : 'SELECT SUM(Amount) total FROM Opportunity WHERE IsClosed = false'
      const response = await proxy({
        method: 'GET',
        endpoint: `/services/data/${API_VERSION}/query`,
        connectionId: connection.connectionId,
        providerConfigKey: connection.providerConfigKey,
        params: { q: soql },
      })
      const data = response.data as { records?: Array<{ total?: number | null }> }
      return { value: data.records?.[0]?.total ?? 0, asOf: new Date() }
    },
  }
}

export const salesforceMetricSource = makeSalesforceMetricSource()
```

Update `registry.ts` to import + register both.

- [ ] **Step 4: Run tests + typecheck** — `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/metrics/__tests__/crm-sources.test.ts && npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `git add src/lib/metrics && git commit -m "feat(goals): HubSpot + Salesforce metric adapters via Nango proxy"`

---

### Task 5: Google Sheets adapter

**Files:**
- Create: `src/lib/metrics/sources/google-sheets.ts`
- Modify: `src/lib/metrics/registry.ts` (register)
- Test: `src/lib/metrics/__tests__/google-sheets.test.ts`

**Interfaces:**
- Produces: `makeGoogleSheetsMetricSource(proxyOverride?: NangoProxy)` + singleton `googleSheetsMetricSource`; pure `parseSheetNumber(values: unknown): number | null` (exported for tests).
- Consumes: `googleProxy({ organizationId, connectionId })` from `@/lib/google/proxy` — `connectionId` is the **`GoogleOAuthConnection.id`**, so `connectionRef = 'google:<googleOAuthConnectionId>'`; `sheetsGetValues` from `@/lib/nango/delivery`. `config: { spreadsheetId: string; range: string }`, `metricKey = 'sheets.range'`.

- [ ] **Step 1: Failing tests** — cover `parseSheetNumber`: `[['$41,203.50']] → 41203.5`, `[['1 234,56']] → 1234.56` is NOT required (US format only), `[[]] → null`, `[['n/a']] → null`, first numeric cell wins across a multi-cell range, plain numbers pass through. Plus one `fetchValue` test with an injected proxy asserting the endpoint contains the encoded spreadsheetId/range and the reading value.

```ts
// src/lib/metrics/__tests__/google-sheets.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeGoogleSheetsMetricSource, parseSheetNumber } from '../sources/google-sheets'
import type { NangoProxy } from '@/lib/nango/delivery'

test('parseSheetNumber strips currency/commas, first numeric wins, null when none', () => {
  assert.equal(parseSheetNumber([['$41,203.50']]), 41203.5)
  assert.equal(parseSheetNumber([['n/a', '17']]), 17)
  assert.equal(parseSheetNumber([[]]), null)
  assert.equal(parseSheetNumber([['total', 'n/a']]), null)
  assert.equal(parseSheetNumber([[1234]]), 1234)
})

test('fetchValue reads config.spreadsheetId/range through the proxy', async () => {
  let endpoint = ''
  const proxy: NangoProxy = async (args) => {
    endpoint = args.endpoint
    return { data: { values: [['$500']] } }
  }
  const source = makeGoogleSheetsMetricSource(proxy)
  const reading = await source.fetchValue(
    { organizationId: 'org-1', connectionRef: 'google:gc-1', config: { spreadsheetId: 'sheet-1', range: 'KPIs!B2' } },
    'sheets.range',
  )
  assert.equal(reading.value, 500)
  assert.match(endpoint, /sheet-1/)
  assert.match(endpoint, /KPIs/)
})
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

```ts
// src/lib/metrics/sources/google-sheets.ts
/** Google Sheets metric source — the universal escape hatch: a named A1 range
 *  is the reading. Native Google OAuth; connectionRef 'google:<id>' where id
 *  is the GoogleOAuthConnection row id (what googleProxy resolves). */
import { googleProxy } from '@/lib/google/proxy'
import { sheetsGetValues, type NangoProxy } from '@/lib/nango/delivery'
import type { MetricDescriptor, MetricReading, MetricSource, MetricSourceContext } from '../types'
import { refId } from '../types'

const METRICS: MetricDescriptor[] = [{ key: 'sheets.range', label: 'Cell value (A1 range)', unit: 'usd' }]

/** First parseable number in the range, reading row-major. US-format only:
 *  strips $, commas, spaces, and % (percent divides by 100). */
export function parseSheetNumber(values: unknown): number | null {
  if (!Array.isArray(values)) return null
  for (const row of values) {
    if (!Array.isArray(row)) continue
    for (const cell of row) {
      if (typeof cell === 'number' && Number.isFinite(cell)) return cell
      if (typeof cell !== 'string') continue
      const percent = cell.trim().endsWith('%')
      const cleaned = cell.replace(/[$,\s%]/g, '')
      if (cleaned === '') continue
      const parsed = Number(cleaned)
      if (Number.isFinite(parsed)) return percent ? parsed / 100 : parsed
    }
  }
  return null
}

export function makeGoogleSheetsMetricSource(proxyOverride?: NangoProxy): MetricSource {
  return {
    source: 'google_sheets',
    availableMetrics: () => METRICS,
    async fetchValue(ctx: MetricSourceContext, metricKey): Promise<MetricReading> {
      if (metricKey !== 'sheets.range') throw new Error(`Unknown Sheets metric '${metricKey}'`)
      const spreadsheetId = typeof ctx.config.spreadsheetId === 'string' ? ctx.config.spreadsheetId : ''
      const range = typeof ctx.config.range === 'string' ? ctx.config.range : ''
      if (!spreadsheetId || !range) throw new Error('Sheets binding needs a spreadsheetId and an A1 range.')
      const connectionId = refId(ctx.connectionRef, 'google')
      const proxy = proxyOverride ?? googleProxy({ organizationId: ctx.organizationId, connectionId })
      const data = await sheetsGetValues(
        { connectionId, providerConfigKey: 'google-sheet', provider: 'google-native', organizationId: ctx.organizationId, scope: 'org' },
        { spreadsheetId, range },
        proxy,
      )
      const value = parseSheetNumber((data as { values?: unknown })?.values)
      if (value === null) throw new Error(`No numeric value found in ${range}.`)
      return { value, asOf: new Date() }
    },
  }
}

export const googleSheetsMetricSource = makeGoogleSheetsMetricSource()
```

Register in `registry.ts`.

- [ ] **Step 4: Run tests + typecheck.** Expected: PASS.

- [ ] **Step 5: Commit** — `git add src/lib/metrics && git commit -m "feat(goals): Google Sheets metric adapter (A1 range as reading)"`

---

### Task 6: Catalogue goal tags — `goalKinds` + `estimatedMinutesSaved`

**Files:**
- Modify: `src/lib/templates/catalogue.ts` (extend `SeedTemplate`; tag seeds)
- Create: `src/lib/templates/goal-fit.ts`
- Test: `src/lib/templates/__tests__/goal-fit.test.ts`

**Interfaces:**
- Produces:
  - `SeedTemplate` gains `goalKinds?: string[]` and `estimatedMinutesSaved?: number` (per run)
  - `goalTemplatesFor(kind: string, seeds?: SeedTemplate[]): SeedTemplate[]` — pure filter, stable order preserved
- Consumes: `SEED_CATALOGUE`, `sortByAdoption`/`loadTemplateAdoptionScores` (used later by emission, not here).

- [ ] **Step 1: Failing test**

```ts
// src/lib/templates/__tests__/goal-fit.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { goalTemplatesFor } from '../goal-fit'
import { SEED_CATALOGUE } from '../catalogue'

test('every goal kind has at least one tagged template', () => {
  for (const kind of ['arr', 'mrr', 'revenue', 'quota'] as const) {
    assert.ok(goalTemplatesFor(kind).length >= 1, `no template tagged for goal kind '${kind}'`)
  }
})

test('tagged seeds carry a per-run time-saved estimate', () => {
  for (const seed of SEED_CATALOGUE.filter((s) => (s.goalKinds ?? []).length > 0)) {
    assert.ok((seed.estimatedMinutesSaved ?? 0) > 0, `${seed.seedKey} tagged for goals but has no estimatedMinutesSaved`)
  }
})

test('filter is exact and pure', () => {
  const seeds = [
    { seedKey: 'a', goalKinds: ['mrr'], estimatedMinutesSaved: 20 },
    { seedKey: 'b', goalKinds: ['quota'], estimatedMinutesSaved: 20 },
    { seedKey: 'c' },
  ] as never[]
  assert.deepEqual(goalTemplatesFor('quota', seeds).map((s) => (s as { seedKey: string }).seedKey), ['b'])
})
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** In `catalogue.ts` add to `SeedTemplate`:

```ts
  /** Goal kinds this recipe advances (goals spec). Drives off-track
   *  recommendations and the "Advances: <goal>" chip. */
  goalKinds?: string[]
  /** Estimated manual minutes one run replaces — seeds
   *  GoalContribution.estimatedMinutesSavedPerRun (proof layer). */
  estimatedMinutesSaved?: number
```

Create `goal-fit.ts`:

```ts
// src/lib/templates/goal-fit.ts
/** Pure goal→template matching. Order-in = order-out; ranking (adoption,
 *  readiness) is composed by callers, same as the other relevance sorts. */
import { SEED_CATALOGUE, type SeedTemplate } from './catalogue'

export function goalTemplatesFor(kind: string, seeds: SeedTemplate[] = SEED_CATALOGUE): SeedTemplate[] {
  return seeds.filter((seed) => (seed.goalKinds ?? []).includes(kind))
}
```

Tag sales/revenue-relevant seeds across `catalogue.ts` / `catalogue-expansion.ts` — minimum coverage: `arr`, `mrr`, `carr`, `revenue` on revenue/pipeline recipes; `quota` on the sales follow-up/pipeline recipes (e.g. `sales-discovery-followup-writer` gets `goalKinds: ['quota', 'revenue'], estimatedMinutesSaved: 25`). Pick honest per-seed minute estimates (15–45); the test only enforces presence > 0. `savings`/`custom_kpi` may have zero tagged seeds — emission falls back to a plain-action suggestion (Task 7).

- [ ] **Step 4: Run the new test + full `npm test` (catalogue is validated elsewhere) + typecheck.** Expected: PASS.

- [ ] **Step 5: Commit** — `git add src/lib/templates && git commit -m "feat(goals): catalogue goalKinds + estimatedMinutesSaved tags, goal-fit filter"`

---

### Task 7: Risk-transition recommendation emission

**Files:**
- Create: `src/lib/goals/emit-recommendation.ts`
- Modify: `src/lib/behavior/record-event.ts` (add kinds)
- Test: `src/lib/goals/__tests__/emit-recommendation.test.ts`

**Interfaces:**
- Produces:
  - `renderGoalEvidence(input: { name: string; unit: string; currentValue: number | null; targetValue: number; expectedValue: number; projectedValue: number | null; targetDate: Date }): string[]` — pure, the "why this exists" lines
  - `emitGoalRecommendation(goal: EmitGoal, evaluation: Evaluation, deps?: EmitDeps): Promise<{ emitted: boolean; reason?: string }>` where `EmitGoal = { id: string; organizationId: string; ownerUserId: string | null; createdByUserId: string | null; name: string; kind: string; unit: string; targetValue: number; targetDate: Date; startAt: Date; startValue: number }` and `EmitDeps` injects `{ findOpen, createSuggestion, notifyFn, adoptionScores, seeds }` for tests
- Consumes: `evaluateGoal`'s `Evaluation` (Task 2), `goalTemplatesFor` (Task 6), `sortByAdoption` + `loadTemplateAdoptionScores` (`@/lib/templates/adoption`), `notify` (`@/lib/notifications/service`), `prisma.userSuggestion`.
- New `USER_EVENT_KINDS`: `'goal_created', 'goal_off_track', 'goal_achieved', 'goal_contribution_linked'` (append to the array; accept/dismiss reuse the existing `suggestion_*` kinds with `context.goalId`).

- [ ] **Step 1: Failing tests**

```ts
// src/lib/goals/__tests__/emit-recommendation.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emitGoalRecommendation, renderGoalEvidence } from '../emit-recommendation'
import type { Evaluation } from '../evaluate'

const goal = {
  id: 'goal-1', organizationId: 'org-1', ownerUserId: null, createdByUserId: 'user-1',
  name: 'Q4 ARR target', kind: 'arr', unit: 'usd', targetValue: 2_000_000,
  targetDate: new Date('2026-12-31T00:00:00Z'), startAt: new Date('2026-07-01T00:00:00Z'), startValue: 1_200_000,
}
const offTrack: Evaluation = { currentValue: 1_300_000, progress: 0.125, expectedProgress: 0.5, projectedValue: 1_500_000, riskLevel: 'off_track' }

const seeds = [{ seedKey: 'pipeline-reviver', name: 'Pipeline Reviver', description: 'd', departments: ['sales'], requiredIntegrations: [], recommendedIntegrations: [], kind: 'flow', goalKinds: ['arr'], estimatedMinutesSaved: 30 }] as never[]

function deps(overrides: Record<string, unknown> = {}) {
  const calls: Record<string, unknown[]> = { create: [], notify: [] }
  return {
    calls,
    findOpen: async () => null,
    createSuggestion: async (data: unknown) => { calls.create.push(data); return { id: 'sug-1' } },
    notifyFn: async (input: unknown) => { calls.notify.push(input) },
    adoptionScores: async () => ({}),
    seeds,
    ...overrides,
  }
}

test('evidence lines cite value vs pace and projection vs target', () => {
  const lines = renderGoalEvidence({ name: goal.name, unit: 'usd', currentValue: 1_300_000, targetValue: 2_000_000, expectedValue: 1_600_000, projectedValue: 1_500_000, targetDate: goal.targetDate })
  assert.ok(lines.some((l) => l.includes('behind pace')))
  assert.ok(lines.some((l) => l.includes('projected')))
})

test('emits a goal_action suggestion with template metadata and notifies', async () => {
  const d = deps()
  const result = await emitGoalRecommendation(goal, offTrack, d as never)
  assert.equal(result.emitted, true)
  const created = d.calls.create[0] as { kind: string; userId: string; metadata: { goalId: string; seedKey: string | null } }
  assert.equal(created.kind, 'goal_action')
  assert.equal(created.userId, 'user-1') // org goal → creator
  assert.equal(created.metadata.goalId, 'goal-1')
  assert.equal(created.metadata.seedKey, 'pipeline-reviver')
  assert.equal(d.calls.notify.length, 1)
})

test('dedupe: an open goal suggestion for this goal blocks re-emission', async () => {
  const d = deps({ findOpen: async () => ({ id: 'sug-0' }) })
  const result = await emitGoalRecommendation(goal, offTrack, d as never)
  assert.equal(result.emitted, false)
  assert.equal(d.calls.create.length, 0)
})

test('no tagged template → plain-action suggestion (seedKey null), still emitted', async () => {
  const d = deps({ seeds: [] })
  const result = await emitGoalRecommendation({ ...goal, kind: 'savings' }, offTrack, d as never)
  assert.equal(result.emitted, true)
  const created = d.calls.create[0] as { metadata: { seedKey: string | null } }
  assert.equal(created.metadata.seedKey, null)
})

test('personal goal addresses the owner, not the creator', async () => {
  const d = deps()
  await emitGoalRecommendation({ ...goal, ownerUserId: 'user-9' }, offTrack, d as never)
  assert.equal((d.calls.create[0] as { userId: string }).userId, 'user-9')
})
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

```ts
// src/lib/goals/emit-recommendation.ts
/**
 * Risk-transition → recommendation. Called by the refresh tick ONLY when a
 * goal transitions into at_risk/off_track (persisted riskLevel makes the
 * transition detectable; steady-state shortfall never re-nags).
 *
 * Spec deviation (locked in the plan header): org goals also emit a
 * UserSuggestion — addressed to the goal's creator — because AgentMemory
 * requires an agentId FK. Org goals additionally notify org-wide.
 */
import { prisma } from '@/lib/prisma'
import { notify } from '@/lib/notifications/service'
import { loadTemplateAdoptionScores, sortByAdoption } from '@/lib/templates/adoption'
import { goalTemplatesFor } from '@/lib/templates/goal-fit'
import { SEED_CATALOGUE, type SeedTemplate } from '@/lib/templates/catalogue'
import type { Evaluation } from './evaluate'

export type EmitGoal = {
  id: string
  organizationId: string
  ownerUserId: string | null
  createdByUserId: string | null
  name: string
  kind: string
  unit: string
  targetValue: number
  targetDate: Date
  startAt: Date
  startValue: number
}

export type EmitDeps = {
  findOpen: (organizationId: string, goalId: string) => Promise<{ id: string } | null>
  createSuggestion: (data: Record<string, unknown>) => Promise<{ id: string }>
  notifyFn: typeof notify
  adoptionScores: typeof loadTemplateAdoptionScores
  seeds: SeedTemplate[]
}

const defaultDeps: EmitDeps = {
  findOpen: (organizationId, goalId) =>
    prisma.userSuggestion.findFirst({
      where: { organizationId, kind: 'goal_action', status: 'open', targetType: 'goal', targetId: goalId },
      select: { id: true },
    }),
  createSuggestion: (data) => prisma.userSuggestion.create({ data: data as never, select: { id: true } }),
  notifyFn: notify,
  adoptionScores: loadTemplateAdoptionScores,
  seeds: SEED_CATALOGUE,
}

function fmt(value: number, unit: string): string {
  if (unit === 'usd') return `$${Math.round(value).toLocaleString('en-US')}`
  if (unit === 'percent') return `${(value * 100).toFixed(1)}%`
  return Math.round(value).toLocaleString('en-US')
}

/** Rendered "why this exists" lines — measured facts only. */
export function renderGoalEvidence(input: {
  name: string
  unit: string
  currentValue: number | null
  targetValue: number
  expectedValue: number
  projectedValue: number | null
  targetDate: Date
}): string[] {
  const lines: string[] = []
  const deadline = input.targetDate.toISOString().slice(0, 10)
  if (input.currentValue !== null) {
    const gap = input.expectedValue - input.currentValue
    lines.push(`${input.name}: ${fmt(input.currentValue, input.unit)} is ${fmt(Math.abs(gap), input.unit)} behind pace (${fmt(input.expectedValue, input.unit)} expected by today).`)
  }
  if (input.projectedValue !== null) {
    lines.push(`At the current rate you're projected to reach ${fmt(input.projectedValue, input.unit)} vs the ${fmt(input.targetValue, input.unit)} target by ${deadline}.`)
  }
  return lines
}

export async function emitGoalRecommendation(
  goal: EmitGoal,
  evaluation: Evaluation,
  deps: EmitDeps = defaultDeps,
): Promise<{ emitted: boolean; reason?: string }> {
  // Quietness: one open suggestion per goal at a time.
  if (await deps.findOpen(goal.organizationId, goal.id)) return { emitted: false, reason: 'pending-suggestion' }

  const recipient = goal.ownerUserId ?? goal.createdByUserId
  if (!recipient) return { emitted: false, reason: 'no-recipient' }

  // Deterministic action pick: tagged templates ranked by platform adoption.
  const candidates = goalTemplatesFor(goal.kind, deps.seeds)
  const scores = await deps.adoptionScores()
  const [best] = sortByAdoption(candidates, (seed) => `seed:${seed.seedKey}`, scores)

  const expectedValue = goal.startValue + evaluation.expectedProgress * (goal.targetValue - goal.startValue)
  const evidence = renderGoalEvidence({
    name: goal.name,
    unit: goal.unit,
    currentValue: evaluation.currentValue,
    targetValue: goal.targetValue,
    expectedValue,
    projectedValue: evaluation.projectedValue,
    targetDate: goal.targetDate,
  })

  const title = `${goal.name} is ${evaluation.riskLevel === 'off_track' ? 'off track' : 'at risk'}`
  const description = best
    ? `Deploy "${best.name}" to help close the gap — ${best.description}`
    : `Review the goal's inputs and recent trend, and consider what automation could accelerate it. Sublime found no ready-made template for this goal kind yet.`

  const suggestion = await deps.createSuggestion({
    organizationId: goal.organizationId,
    userId: recipient,
    kind: 'goal_action',
    title,
    description,
    targetType: 'goal',
    targetId: goal.id,
    evidence,
    metadata: { goalId: goal.id, seedKey: best?.seedKey ?? null },
  })

  // Personal goal → owner-only notification; org goal → org-wide bell too.
  await deps.notifyFn({
    organizationId: goal.organizationId,
    ...(goal.ownerUserId ? { userId: goal.ownerUserId } : {}),
    type: 'goal.risk',
    level: 'action',
    title,
    body: evidence[0] ?? description,
    link: `/goals/${goal.id}`,
  })

  return { emitted: true, reason: suggestion.id }
}
```

In `record-event.ts`, extend `USER_EVENT_KINDS`:

```ts
  'tool_call',
  'goal_created',
  'goal_off_track',
  'goal_achieved',
  'goal_contribution_linked',
] as const
```

Also add a `case` in `src/lib/notifications/notification-href.ts` mapping `type.startsWith('goal.')` → the notification's `link ?? '/goals'` (follow the existing switch shape in that file).

- [ ] **Step 4: Run tests + typecheck.** Expected: PASS.

- [ ] **Step 5: Commit** — `git add src/lib/goals src/lib/behavior src/lib/notifications && git commit -m "feat(goals): risk-transition emission into UserSuggestion (goal_action) + goal event kinds"`

---

### Task 8: Refresh tick + cron wiring + goals e2e test

**Files:**
- Create: `src/lib/goals/refresh.ts`
- Modify: `src/app/api/cron/dispatch/route.ts` (one best-effort leg)
- Test: `src/lib/goals/__tests__/goals-e2e.test.ts` (gated on `TEST_DATABASE_URL`, mirrors `behavior-e2e.test.ts` setup)

**Interfaces:**
- Produces: `refreshGoalMetrics(now?: Date, deps?: { fetchReading?: (source: string, ctx: MetricSourceContext, metricKey: string) => Promise<MetricReading> }): Promise<{ due: number; refreshed: number; failed: number; transitions: number }>` and `evaluateAndPersistGoal(goalId: string, organizationId: string, now?: Date): Promise<void>` (exported so the manual-datapoint route re-evaluates inline).
- Consumes: registry (`getMetricSource`), `evaluateGoal`/`settleStatus`, `emitGoalRecommendation`, `recordUserEvent`.

- [ ] **Step 1: Implement `refresh.ts`** (logic first here — the e2e test needs a DB, so the TDD loop runs against the seeded test DB in Step 2):

```ts
// src/lib/goals/refresh.ts
/**
 * Goal metric freshness + evaluation. Runs inside every /api/cron/dispatch
 * tick; per-metric throttling (refreshIntervalHours) supplies the real
 * cadence. Fetch failures land on GoalMetric.lastError — a failing source
 * must degrade one goal to 'no_data', never fail the tick.
 */
import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { recordUserEvent } from '@/lib/behavior/record-event'
import { getMetricSource } from '@/lib/metrics/registry'
import type { MetricReading, MetricSourceContext } from '@/lib/metrics/types'
import { evaluateGoal, settleStatus } from './evaluate'
import { emitGoalRecommendation } from './emit-recommendation'

const MAX_METRICS_PER_TICK = 200
const EVAL_WINDOW_POINTS = 400
const HOUR_MS = 60 * 60 * 1000

export function bucketKeyFor(date: Date): string {
  return date.toISOString().slice(0, 10)
}

type FetchReading = (source: string, ctx: MetricSourceContext, metricKey: string) => Promise<MetricReading>

const defaultFetch: FetchReading = (source, ctx, metricKey) => {
  const adapter = getMetricSource(source)
  if (!adapter) throw new Error(`No metric source registered for '${source}'`)
  return adapter.fetchValue(ctx, metricKey)
}

export async function refreshGoalMetrics(
  now: Date = new Date(),
  deps: { fetchReading?: FetchReading } = {},
): Promise<{ due: number; refreshed: number; failed: number; transitions: number }> {
  const fetchReading = deps.fetchReading ?? defaultFetch

  // systemPrisma: cross-org metric sweep, driven by the CRON_SECRET-gated tick.
  const due = await systemPrisma.goalMetric.findMany({
    where: {
      source: { not: 'manual' },
      goal: { status: 'active' },
      OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: new Date(now.getTime() - HOUR_MS) } }],
    },
    select: { id: true, organizationId: true, goalId: true, source: true, metricKey: true, connectionRef: true, config: true, refreshIntervalHours: true, lastSyncAt: true },
    take: MAX_METRICS_PER_TICK,
  })

  let refreshed = 0
  let failed = 0
  let transitions = 0
  for (const metric of due) {
    // Per-metric cadence: the query above pre-filters to >1h stale; honor the
    // metric's own interval here.
    if (metric.lastSyncAt && now.getTime() - metric.lastSyncAt.getTime() < metric.refreshIntervalHours * HOUR_MS) continue
    try {
      const reading = await fetchReading(metric.source, {
        organizationId: metric.organizationId,
        connectionRef: metric.connectionRef,
        config: (metric.config ?? {}) as Record<string, unknown>,
      }, metric.metricKey)
      await prisma.metricDatapoint.upsert({
        where: { goalMetricId_bucketKey: { goalMetricId: metric.id, bucketKey: bucketKeyFor(reading.asOf) } },
        create: { organizationId: metric.organizationId, goalMetricId: metric.id, value: reading.value, capturedAt: reading.asOf, bucketKey: bucketKeyFor(reading.asOf), origin: 'sync' },
        update: { value: reading.value, capturedAt: reading.asOf },
      })
      await prisma.goalMetric.update({ where: { id: metric.id, organizationId: metric.organizationId }, data: { lastSyncAt: now, lastError: null } })
      refreshed += 1
    } catch (error) {
      failed += 1
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
      await prisma.goalMetric
        .update({ where: { id: metric.id, organizationId: metric.organizationId }, data: { lastSyncAt: now, lastError: message } })
        .catch(() => undefined)
      apiLogger.warn('goals.refresh: metric fetch failed', { goalMetricId: metric.id, source: metric.source, error: message })
    }
    const changed = await evaluateAndPersistGoal(metric.goalId, metric.organizationId, now)
    if (changed) transitions += 1
  }
  return { due: due.length, refreshed, failed, transitions }
}

/** Re-evaluate one goal; persist riskLevel/status; emit on worsening
 *  transition. Returns true when riskLevel changed. Exported for the manual
 *  datapoint route. */
export async function evaluateAndPersistGoal(goalId: string, organizationId: string, now: Date = new Date()): Promise<boolean> {
  const goal = await prisma.goal.findFirst({
    where: { id: goalId, organizationId },
    include: {
      metrics: { select: { id: true, refreshIntervalHours: true } },
    },
  })
  if (!goal || goal.status === 'archived' || goal.status === 'paused') return false
  const metric = goal.metrics[0]
  const points = metric
    ? await prisma.metricDatapoint.findMany({
        where: { organizationId, goalMetricId: metric.id },
        orderBy: { capturedAt: 'asc' },
        take: EVAL_WINDOW_POINTS,
        select: { value: true, capturedAt: true },
      })
    : []
  const staleAfterMs = 2 * (metric?.refreshIntervalHours ?? 24) * HOUR_MS
  const evaluation = evaluateGoal(goal, points, now, staleAfterMs)
  const settled = settleStatus(goal, evaluation, now)

  const changed = evaluation.riskLevel !== goal.riskLevel
  await prisma.goal.update({
    where: { id: goal.id, organizationId },
    data: { riskLevel: evaluation.riskLevel, lastEvaluatedAt: now, ...(settled && goal.status === 'active' ? { status: settled } : {}) },
  })

  const recipient = goal.ownerUserId ?? goal.createdByUserId
  if (settled === 'achieved' && goal.status === 'active' && recipient) {
    await recordUserEvent({ organizationId, userId: recipient, kind: 'goal_achieved', resourceType: 'goal', resourceId: goal.id })
  }
  const worsened = changed && (evaluation.riskLevel === 'at_risk' || evaluation.riskLevel === 'off_track')
  if (worsened && goal.status === 'active' && !settled) {
    await emitGoalRecommendation(goal, evaluation)
    if (recipient) {
      await recordUserEvent({ organizationId, userId: recipient, kind: 'goal_off_track', resourceType: 'goal', resourceId: goal.id, context: { riskLevel: evaluation.riskLevel } })
    }
  }
  return changed
}
```

- [ ] **Step 2: Write + run the e2e test.** Copy the gating/seed shape from `src/app/api/__tests__/route-smoke.test.ts` (`seedTestOrg`, `installTestAuth`, dynamic imports inside `before()`), or `behavior-e2e.test.ts` if closer. Scenario:

```ts
// src/lib/goals/__tests__/goals-e2e.test.ts — gated: runs only with TEST_DATABASE_URL
// 1. seed org; create Goal (active, startValue 100 → targetValue 200,
//    startAt now-50d, targetDate now+50d) + GoalMetric (source 'stripe',
//    refreshIntervalHours 24, lastSyncAt null).
// 2. refreshGoalMetrics(now, { fetchReading: async () => ({ value: 120, asOf: now }) })
//    → assert: one MetricDatapoint upserted; goal.riskLevel === 'off_track'
//    (progress 0.2 vs expected 0.5); exactly ONE open UserSuggestion with
//    kind 'goal_action', targetId = goal.id; metadata.goalId matches.
// 3. Run refreshGoalMetrics again with the same reading and a now+25h clock
//    → assert: still exactly ONE suggestion (transition dedupe: riskLevel
//    unchanged emits nothing; the open suggestion also blocks).
// 4. Manual improvement: insert datapoints climbing to 190, run again with
//    now+50h → riskLevel 'on_track'; no new suggestion.
// 5. cleanup() from the seed helper.
```

Run: `TEST_DATABASE_URL=<throwaway> TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/goals-e2e.test.ts` (see `.claude/skills/verify/SKILL.md` for spinning up the throwaway Postgres). Expected: PASS.

- [ ] **Step 3: Wire the cron leg.** In `src/app/api/cron/dispatch/route.ts`, alongside the other best-effort legs (after the `runBehaviorIntelligence` fan-out):

```ts
    // Goal metric freshness + evaluation: per-metric throttling inside
    // (refreshIntervalHours); a failing source lands on GoalMetric.lastError
    // and degrades that goal to no_data — never fails the tick.
    void import('@/lib/goals/refresh')
      .then(({ refreshGoalMetrics }) => refreshGoalMetrics())
      .catch(() => undefined)
```

- [ ] **Step 4: Full `npm test` + typecheck.** Expected: PASS.

- [ ] **Step 5: Commit** — `git add src/lib/goals src/app/api/cron && git commit -m "feat(goals): metric refresh + evaluation on the cron tick, transition-gated emission"`

---

### Task 9: Proof-layer impact math

**Files:**
- Create: `src/lib/goals/impact.ts`
- Test: `src/lib/goals/__tests__/impact.test.ts`

**Interfaces:**
- Produces:
  - `interface ImpactTiers { measured: { runsCompleted: number; tokens: number }; estimated: { hoursSaved: number; laborValueUsd: number; aiCostUsd: number; roiMultiple: number | null; hourlyRateUsd: number }; correlated: { paceDeltaPct: number | null } }`
  - Pure: `computeImpact(inputs: { contributions: Array<{ estimatedMinutesSavedPerRun: number; runs: number; tokens: number }>; hourlyRateUsd: number; aiCostPerMTokensUsd: number; paceBefore: number | null; paceAfter: number | null }): ImpactTiers`
  - Pure: `paceDelta(points: EvalPoint[], splitAt: Date): { before: number | null; after: number | null }` — least-squares slope (value/day) each side of the first contribution; null when a side has < 2 points
  - DB: `goalImpact(organizationId: string, goalId: string): Promise<ImpactTiers>` and `orgImpact(organizationId: string): Promise<ImpactTiers & { goalsTracked: number; contributionsLinked: number }>`
- Consumes settings from `Organization.settings`: `laborHourlyRate` (default `50`), `aiCostPerMTokensUsd` (default `10`).
- **Join rules (verified against schema):** flow runs = `prisma.flowRun.count({ where: { organizationId, flowId: contribution.resourceId, status: 'succeeded', startedAt: { gt: contribution.createdAt } } })` (FlowRun has no token columns — flows contribute runs, not tokens). Agent runs = `prisma.agentExecution.findMany({ where: { organizationId, agentTaskId: contribution.resourceId, completedAt: { not: null }, error: null, startedAt: { gt: contribution.createdAt } }, select: { inputTokens: true, outputTokens: true } })` — runs + `inputTokens + outputTokens` summed.

- [ ] **Step 1: Failing tests for the pure parts**

```ts
// src/lib/goals/__tests__/impact.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeImpact, paceDelta } from '../impact'

const DAY = 24 * 60 * 60 * 1000
const t0 = new Date('2026-01-01T00:00:00Z')
const pt = (n: number, value: number) => ({ value, capturedAt: new Date(t0.getTime() + n * DAY) })

test('impact tiers: hours, labor value, ROI multiple', () => {
  const impact = computeImpact({
    contributions: [
      { estimatedMinutesSavedPerRun: 30, runs: 10, tokens: 2_000_000 },
      { estimatedMinutesSavedPerRun: 60, runs: 2, tokens: 0 },
    ],
    hourlyRateUsd: 50,
    aiCostPerMTokensUsd: 10,
    paceBefore: 1,
    paceAfter: 1.5,
  })
  assert.equal(impact.measured.runsCompleted, 12)
  assert.equal(impact.measured.tokens, 2_000_000)
  assert.equal(impact.estimated.hoursSaved, 7) // 300min + 120min = 7h
  assert.equal(impact.estimated.laborValueUsd, 350)
  assert.equal(impact.estimated.aiCostUsd, 20)
  assert.equal(impact.estimated.roiMultiple, 17.5)
  assert.equal(impact.correlated.paceDeltaPct, 50)
})

test('zero AI cost → roiMultiple null (never Infinity)', () => {
  const impact = computeImpact({ contributions: [{ estimatedMinutesSavedPerRun: 30, runs: 4, tokens: 0 }], hourlyRateUsd: 50, aiCostPerMTokensUsd: 10, paceBefore: null, paceAfter: null })
  assert.equal(impact.estimated.roiMultiple, null)
  assert.equal(impact.correlated.paceDeltaPct, null)
})

test('paceDelta splits the series at the first contribution', () => {
  // 1/day before day 10, 3/day after.
  const points = [pt(0, 100), pt(5, 105), pt(9, 109), pt(11, 115), pt(15, 127), pt(20, 142)]
  const { before, after } = paceDelta(points, new Date(t0.getTime() + 10 * DAY))
  assert.ok(Math.abs((before ?? 0) - 1) < 0.05)
  assert.ok(Math.abs((after ?? 0) - 3) < 0.05)
})

test('paceDelta: a side with fewer than 2 points is null', () => {
  const { before, after } = paceDelta([pt(11, 115), pt(15, 127)], new Date(t0.getTime() + 10 * DAY))
  assert.equal(before, null)
  assert.ok(after !== null)
})
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** — `computeImpact` and `paceDelta` pure; `goalImpact`/`orgImpact` assemble via the join rules above, reading org settings with defaults:

```ts
// src/lib/goals/impact.ts (structure; pure parts complete, loaders follow the join rules verbatim)
import { prisma } from '@/lib/prisma'
import type { EvalPoint } from './evaluate'

export interface ImpactTiers {
  measured: { runsCompleted: number; tokens: number }
  estimated: { hoursSaved: number; laborValueUsd: number; aiCostUsd: number; roiMultiple: number | null; hourlyRateUsd: number }
  correlated: { paceDeltaPct: number | null }
}

export function computeImpact(inputs: {
  contributions: Array<{ estimatedMinutesSavedPerRun: number; runs: number; tokens: number }>
  hourlyRateUsd: number
  aiCostPerMTokensUsd: number
  paceBefore: number | null
  paceAfter: number | null
}): ImpactTiers {
  const runsCompleted = inputs.contributions.reduce((sum, c) => sum + c.runs, 0)
  const tokens = inputs.contributions.reduce((sum, c) => sum + c.tokens, 0)
  const minutesSaved = inputs.contributions.reduce((sum, c) => sum + c.runs * c.estimatedMinutesSavedPerRun, 0)
  const hoursSaved = minutesSaved / 60
  const laborValueUsd = hoursSaved * inputs.hourlyRateUsd
  const aiCostUsd = (tokens / 1_000_000) * inputs.aiCostPerMTokensUsd
  const roiMultiple = aiCostUsd > 0 ? laborValueUsd / aiCostUsd : null
  const paceDeltaPct =
    inputs.paceBefore !== null && inputs.paceAfter !== null && inputs.paceBefore !== 0
      ? ((inputs.paceAfter - inputs.paceBefore) / Math.abs(inputs.paceBefore)) * 100
      : null
  return {
    measured: { runsCompleted, tokens },
    estimated: { hoursSaved, laborValueUsd, aiCostUsd, roiMultiple, hourlyRateUsd: inputs.hourlyRateUsd },
    correlated: { paceDeltaPct },
  }
}

/** Least-squares slope in value/day on each side of splitAt. */
export function paceDelta(points: EvalPoint[], splitAt: Date): { before: number | null; after: number | null } {
  const DAY = 24 * 60 * 60 * 1000
  const slope = (side: EvalPoint[]): number | null => {
    if (side.length < 2) return null
    const xs = side.map((p) => p.capturedAt.getTime() / DAY)
    const ys = side.map((p) => p.value)
    const n = xs.length
    const meanX = xs.reduce((a, b) => a + b, 0) / n
    const meanY = ys.reduce((a, b) => a + b, 0) / n
    let sxy = 0
    let sxx = 0
    for (let i = 0; i < n; i++) {
      sxy += (xs[i] - meanX) * (ys[i] - meanY)
      sxx += (xs[i] - meanX) ** 2
    }
    return sxx === 0 ? null : sxy / sxx
  }
  return {
    before: slope(points.filter((p) => p.capturedAt.getTime() < splitAt.getTime())),
    after: slope(points.filter((p) => p.capturedAt.getTime() >= splitAt.getTime())),
  }
}

function impactSettings(settings: unknown): { hourlyRateUsd: number; aiCostPerMTokensUsd: number } {
  const s = (settings ?? {}) as Record<string, unknown>
  return {
    hourlyRateUsd: typeof s.laborHourlyRate === 'number' && s.laborHourlyRate > 0 ? s.laborHourlyRate : 50,
    aiCostPerMTokensUsd: typeof s.aiCostPerMTokensUsd === 'number' && s.aiCostPerMTokensUsd > 0 ? s.aiCostPerMTokensUsd : 10,
  }
}

// goalImpact / orgImpact: load contributions (goal-scoped or org-wide), then
// per contribution apply the join rules from the task header (flowRun.count
// for flows; agentExecution runs + token sums for agents), assemble
// computeImpact inputs; paceDelta over the goal's datapoints split at the
// earliest contribution.createdAt (goalImpact only — orgImpact reports
// paceDeltaPct null and adds { goalsTracked, contributionsLinked }).
```

Write `goalImpact`/`orgImpact` fully (they are covered by the smoke tests + e2e; the pure math carries the unit tests).

- [ ] **Step 4: Run tests + typecheck.** Expected: PASS.

- [ ] **Step 5: Commit** — `git add src/lib/goals && git commit -m "feat(goals): proof-layer impact math — measured/estimated/correlated tiers"`

---

### Task 10: API — goals CRUD, detail, datapoints

**Files:**
- Create: `src/app/api/goals/route.ts`, `src/app/api/goals/[id]/route.ts`, `src/app/api/goals/[id]/datapoints/route.ts`
- Modify: `src/app/api/__tests__/route-smoke.test.ts` (register the GETs — done fully in Task 11 alongside the rest)

**Interfaces:**
- Produces (consumed by all UI tasks):
  - `GET /api/goals` → `{ success, goals: GoalSummary[] }` where `GoalSummary = { id, name, kind, direction, unit, startValue, targetValue, startAt, targetDate, status, riskLevel, personal: boolean, parentGoalId, metric: { source, metricKey, lastSyncAt, lastError } | null, currentValue: number | null, progress: number | null, expectedProgress: number, sparkline: Array<{ value, capturedAt }> }`
  - `POST /api/goals` (create), `GET/PATCH/DELETE /api/goals/[id]`, `GET/POST /api/goals/[id]/datapoints`
- Visibility rule everywhere: `OR: [{ ownerUserId: null }, { ownerUserId: auth.dbUser.id }]`.

- [ ] **Step 1: Implement `src/app/api/goals/route.ts`**

```ts
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordUserEvent } from '@/lib/behavior/record-event'
import { evaluateGoal } from '@/lib/goals/evaluate'
import { bucketKeyFor } from '@/lib/goals/refresh'

export const runtime = 'nodejs'

const GOAL_KINDS = ['arr', 'mrr', 'carr', 'revenue', 'quota', 'savings', 'custom_kpi'] as const
const METRIC_SOURCES = ['stripe', 'hubspot', 'salesforce', 'google_sheets', 'manual'] as const
const HOUR_MS = 60 * 60 * 1000
const SPARKLINE_POINTS = 30

const createSchema = z
  .object({
    name: z.string().min(1, 'Name the goal.').max(120),
    description: z.string().max(2000).optional(),
    kind: z.enum(GOAL_KINDS),
    direction: z.enum(['increase', 'decrease']).default('increase'),
    unit: z.enum(['usd', 'count', 'percent']).default('usd'),
    startValue: z.number().finite(),
    targetValue: z.number().finite(),
    targetDate: z.coerce.date(),
    personal: z.boolean().default(false),
    parentGoalId: z.string().optional(),
    metric: z.object({
      source: z.enum(METRIC_SOURCES),
      metricKey: z.string().min(1),
      connectionRef: z.string().nullable().optional(),
      config: z.record(z.string(), z.unknown()).default({}),
    }),
  })
  .refine((body) => body.targetValue !== body.startValue, { message: 'Target must differ from the baseline.' })
  .refine((body) => body.targetDate.getTime() > Date.now(), { message: 'Target date must be in the future.' })
  .refine((body) => body.metric.source === 'manual' || Boolean(body.metric.connectionRef), {
    message: 'Pick the connection this metric reads from.',
  })

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const goals = await prisma.goal.findMany({
    where: {
      organizationId: auth.organizationId,
      status: { not: 'archived' },
      OR: [{ ownerUserId: null }, { ownerUserId: auth.dbUser.id }],
    },
    orderBy: [{ ownerUserId: 'asc' }, { createdAt: 'desc' }],
    include: {
      metrics: {
        select: {
          source: true, metricKey: true, lastSyncAt: true, lastError: true, refreshIntervalHours: true,
          datapoints: { orderBy: { capturedAt: 'desc' }, take: SPARKLINE_POINTS, select: { value: true, capturedAt: true } },
        },
      },
    },
  })
  const now = new Date()
  return {
    success: true,
    goals: goals.map((goal) => {
      const metric = goal.metrics[0] ?? null
      const points = [...(metric?.datapoints ?? [])].reverse()
      const staleAfterMs = 2 * (metric?.refreshIntervalHours ?? 24) * HOUR_MS
      const evaluation = evaluateGoal(goal, points, now, staleAfterMs)
      return {
        id: goal.id, name: goal.name, kind: goal.kind, direction: goal.direction, unit: goal.unit,
        startValue: goal.startValue, targetValue: goal.targetValue, startAt: goal.startAt, targetDate: goal.targetDate,
        status: goal.status, riskLevel: goal.riskLevel, personal: goal.ownerUserId !== null, parentGoalId: goal.parentGoalId,
        metric: metric ? { source: metric.source, metricKey: metric.metricKey, lastSyncAt: metric.lastSyncAt, lastError: metric.lastError } : null,
        currentValue: evaluation.currentValue, progress: evaluation.progress, expectedProgress: evaluation.expectedProgress,
        sparkline: points,
      }
    }),
  }
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const input = createSchema.parse(await request.json().catch(() => ({})))

  if (input.parentGoalId) {
    const parent = await prisma.goal.findFirst({
      where: { id: input.parentGoalId, organizationId: auth.organizationId, ownerUserId: null },
      select: { id: true },
    })
    if (!parent) throw new ApiError('Linked org goal not found.', 404, 'PARENT_NOT_FOUND')
  }

  const now = new Date()
  const goal = await prisma.goal.create({
    data: {
      organizationId: auth.organizationId,
      ownerUserId: input.personal ? auth.dbUser.id : null,
      parentGoalId: input.parentGoalId ?? null,
      name: input.name,
      description: input.description ?? null,
      kind: input.kind,
      direction: input.direction,
      unit: input.unit,
      startValue: input.startValue,
      targetValue: input.targetValue,
      targetDate: input.targetDate,
      createdByUserId: auth.dbUser.id,
      metrics: {
        create: {
          organizationId: auth.organizationId,
          source: input.metric.source,
          metricKey: input.metric.metricKey,
          connectionRef: input.metric.connectionRef ?? null,
          config: input.metric.config as never,
        },
      },
    },
    include: { metrics: { select: { id: true } } },
  })

  // Baseline datapoint: the wizard's verified preview value, day-bucketed so
  // the first sync upserts over it cleanly.
  await prisma.metricDatapoint.create({
    data: {
      organizationId: auth.organizationId,
      goalMetricId: goal.metrics[0].id,
      value: input.startValue,
      capturedAt: now,
      bucketKey: bucketKeyFor(now),
      origin: 'backfill',
    },
  })
  await recordUserEvent({ organizationId: auth.organizationId, userId: auth.dbUser.id, kind: 'goal_created', resourceType: 'goal', resourceId: goal.id, context: { kind: input.kind, personal: input.personal } })
  return { success: true, goal: { id: goal.id } }
})
```

- [ ] **Step 2: Implement `src/app/api/goals/[id]/route.ts`** — GET returns the full detail (goal + evaluation + metric health + children rollup + series summary); PATCH edits `name/description/targetValue/targetDate/status` (zod partial, re-evaluate via `evaluateAndPersistGoal` after a target change); DELETE archives (`status: 'archived'`), never hard-deletes. All three load the row first with the visibility filter and `throw new ApiError('Goal not found', 404, 'GOAL_NOT_FOUND')` when absent. Children rollup: `prisma.goal.findMany({ where: { organizationId, parentGoalId: id, OR: [{ ownerUserId: null }, { ownerUserId: auth.dbUser.id }] }, select: { id, name, riskLevel, ownerUserId } })` — a child personal goal of ANOTHER user appears as `{ id: null, name: 'A teammate’s goal', riskLevel }` (count it, never name it — same k-anon spirit as peer practices; implement by mapping rows where `ownerUserId !== auth.dbUser.id && ownerUserId !== null`).

- [ ] **Step 3: Implement `src/app/api/goals/[id]/datapoints/route.ts`** — GET returns the full ascending series (`take: 400`) for the chart; POST (manual entry) validates `{ value: z.number().finite(), capturedAt: z.coerce.date().optional() }`, requires the goal visible to the caller, upserts on `(goalMetricId, bucketKey)` with `origin: 'manual'`, then `await evaluateAndPersistGoal(goalId, auth.organizationId)` so the risk badge is fresh on the next read. Manual-source goals are the primary users; sync-source goals accept manual points too (fallback while a source errors).

- [ ] **Step 4: Typecheck + run route-smoke** (`npm run typecheck && npm test`) — the smoke completeness test now FAILS listing the two new GET routes. That failure is expected until Task 11 registers them; if executing task-by-task with separate reviewers, register `goals` and `goals/[id]` + `goals/[id]/datapoints` cases NOW in `route-smoke.test.ts` (same format as Task 11) and let Task 11 add only its own.

- [ ] **Step 5: Commit** — `git add src/app/api/goals src/app/api/__tests__ && git commit -m "feat(goals): CRUD + datapoints API"`

---

### Task 11: API — preview, sources, contributions, impact, settings + smoke registration

**Files:**
- Create: `src/app/api/goals/metrics/preview/route.ts`, `src/app/api/goals/metrics/sources/route.ts`, `src/app/api/goals/[id]/contributions/route.ts`, `src/app/api/goals/impact/route.ts`, `src/app/api/goals/settings/route.ts`
- Modify: `src/app/api/__tests__/route-smoke.test.ts`

**Interfaces:**
- Produces:
  - `POST /api/goals/metrics/preview` `{ source, metricKey, connectionRef, config }` → `{ success, value, asOf }` (connector errors → `ApiError(message, 400, 'PREVIEW_FAILED')` so the wizard shows them inline)
  - `GET /api/goals/metrics/sources` → `{ success, sources: Array<{ source; metrics: MetricDescriptor[]; connections: Array<{ ref: string; label: string }> }> }` — the wizard's step-2 payload
  - `GET/POST/DELETE /api/goals/[id]/contributions` → list with per-link computed runs; POST `{ resourceType: 'flow' | 'agent', resourceId, estimatedMinutesSavedPerRun? }` (origin `'manual'`); DELETE `?contributionId=`
  - `GET /api/goals/impact` → `{ success, impact: ImpactTiers & { goalsTracked, contributionsLinked } }`
  - `PATCH /api/goals/settings` `{ laborHourlyRate?, aiCostPerMTokensUsd? }` → merges into `Organization.settings`

- [ ] **Step 1: Implement `preview`** — zod body mirroring Task 10's `metric` object (manual source rejected with `ApiError('Manual metrics have no preview', 400, 'NO_PREVIEW')`); `getMetricSource(source)` → `fetchValue`; wrap connector throws:

```ts
  try {
    const reading = await adapter.fetchValue({ organizationId: auth.organizationId, connectionRef: body.connectionRef ?? null, config: body.config }, body.metricKey)
    return { success: true, value: reading.value, asOf: reading.asOf }
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : 'Preview failed', 400, 'PREVIEW_FAILED', error)
  }
```

- [ ] **Step 2: Implement `sources`** — assemble per source:
  - `stripe`: `prisma.credential.findMany({ where: credentialScope(auth.organizationId, auth.dbUser.id), … })` filtered to `type IN ('bearer','apiKeyHeader')` → `ref: 'credential:<id>'`, label = credential name
  - `hubspot` / `salesforce`: `prisma.nangoConnection.findMany({ where: { organizationId, providerConfigKey: <provider>, status: 'connected' } })` → `ref: 'nango:<connectionId>'`
  - `google_sheets`: `prisma.googleOAuthConnection.findMany({ where: { organizationId, service: 'google-sheets', status: 'connected' } })` → `ref: 'google:<id>'`, label = accountEmail
  - `manual`: always present, `connections: []`
  Each source carries `getMetricSource(source)?.availableMetrics('custom_kpi') ?? [{ key: 'manual.value', label: 'Manually recorded value', unit: 'usd' }]`.

- [ ] **Step 3: Implement `contributions`, `impact`, `settings`.** Contributions GET joins run counts per link (reuse the Task 9 join rules); POST validates the resource exists in-org (`prisma.flow.findFirst` / `prisma.agentTask.findFirst`), creates with `origin: 'manual'`, records `goal_contribution_linked`; duplicate link → `ApiError('Already linked', 409, 'DUPLICATE_LINK')`. Impact GET = `orgImpact(auth.organizationId)`. Settings PATCH reads `settings`, spreads `{ ...existing, laborHourlyRate, aiCostPerMTokensUsd }` (validated `z.number().positive().max(10_000)` each, optional), updates the org row.

- [ ] **Step 4: Register ALL goals GETs in `route-smoke.test.ts`** (skip this step's duplicates if Task 10 already added its three):

```ts
    { name: 'GET /api/goals', run: async () => (await import('../goals/route')).GET(req('/api/goals')) },
    { name: 'GET /api/goals/impact', run: async () => (await import('../goals/impact/route')).GET(req('/api/goals/impact')) },
    { name: 'GET /api/goals/metrics/sources', run: async () => (await import('../goals/metrics/sources/route')).GET(req('/api/goals/metrics/sources')) },
    // Fail-closed [id] routes: unknown id 404s (< 500) — no seeding needed.
    { name: 'GET /api/goals/[id]', run: async () => (await import('../goals/[id]/route')).GET(req('/api/goals/no-such-id')) },
    { name: 'GET /api/goals/[id]/datapoints', run: async () => (await import('../goals/[id]/datapoints/route')).GET(req('/api/goals/no-such-id/datapoints')) },
    { name: 'GET /api/goals/[id]/contributions', run: async () => (await import('../goals/[id]/contributions/route')).GET(req('/api/goals/no-such-id/contributions')) },
```

(If any `[id]` handler reads `params` rather than parsing the path, follow the existing dynamic-route case shape in the file — check how `agents/[id]/memories` passes params and mirror it exactly.)

- [ ] **Step 5: Run `npm test` (route smoke + completeness) + typecheck. Expected: PASS. Commit** — `git add src/app/api && git commit -m "feat(goals): preview/sources/contributions/impact/settings API + smoke coverage"`

---

### Task 12: Provision-route attribution (accept = born attributed)

**Files:**
- Modify: `src/app/api/templates/provision/route.ts`
- Test: extends `src/lib/goals/__tests__/goals-e2e.test.ts` (or a focused new e2e case)

**Interfaces:**
- `bodySchema` gains: `goalId: z.string().optional()`, `suggestionId: z.string().optional()`.
- After a successful provision (the point where the flow/agent id is known and `recordUserEvent('template_used', …)` fires), when `goalId` is present:

```ts
  if (goalId) {
    const goal = await prisma.goal.findFirst({
      where: { id: goalId, organizationId, OR: [{ ownerUserId: null }, { ownerUserId: userId }] },
      select: { id: true },
    })
    if (goal) {
      await prisma.goalContribution.create({
        data: {
          organizationId,
          goalId: goal.id,
          resourceType: provisionedKind, // 'flow' | 'agent' — the deployed resource
          resourceId: provisionedId,
          origin: suggestionId ? 'suggestion' : 'manual',
          estimatedMinutesSavedPerRun: seed?.estimatedMinutesSaved ?? 30,
        },
      }).catch(() => undefined) // duplicate link (re-deploy) is fine — impact keeps the original createdAt
      await recordUserEvent({ organizationId, userId, kind: 'goal_contribution_linked', resourceType: provisionedKind, resourceId: provisionedId, context: { goalId: goal.id, origin: suggestionId ? 'suggestion' : 'manual' } })
    }
  }
  if (suggestionId) {
    await prisma.userSuggestion.updateMany({
      where: { id: suggestionId, organizationId, userId, kind: 'goal_action', status: 'open' },
      data: { status: 'accepted' },
    })
    await recordUserEvent({ organizationId, userId, kind: 'suggestion_accepted', resourceType: 'suggestion', resourceId: suggestionId, context: { goalId } })
  }
```

Read the route first: bind `provisionedKind`/`provisionedId` to the exact variables the handler already returns (the response body names the created resource — reuse those variables, do not re-query).

- [ ] **Steps:** (1) add schema fields + the block above wired to the real variable names → (2) e2e case: provision a seed with a seeded goal id → assert one `GoalContribution` row with `origin: 'suggestion'` when `suggestionId` passed and the suggestion flips to `accepted` → (3) `npm test` + typecheck → (4) commit `feat(goals): provision-time attribution — accepted goal suggestions are born attributed`.

---

### Task 13: App shell — sidebar entry, route prefix, client types

**Files:**
- Modify: `src/components/layout/sidebar.tsx`, `src/components/layout/app-shell.tsx`, `src/lib/types.ts`

- [ ] **Step 1:** In `sidebar.tsx`: add `Target` to the lucide import list; add `{ name: 'Goals', href: '/goals', icon: Target },` to `navigation` between Home and Agents (goal-first ordering is the point of the feature).
- [ ] **Step 2:** In `app-shell.tsx`: add `'/goals'` to `APP_PREFIXES`. Do NOT add it to `FULLSCREEN_ROUTES` — goals pages use the centered container.
- [ ] **Step 3:** In `src/lib/types.ts`, add the shared client shape (mirrors Task 10's `GoalSummary` exactly):

```ts
export interface GoalSummary {
  id: string
  name: string
  kind: 'arr' | 'mrr' | 'carr' | 'revenue' | 'quota' | 'savings' | 'custom_kpi'
  direction: 'increase' | 'decrease'
  unit: 'usd' | 'count' | 'percent'
  startValue: number
  targetValue: number
  startAt: string
  targetDate: string
  status: 'active' | 'paused' | 'achieved' | 'missed' | 'archived'
  riskLevel: 'on_track' | 'at_risk' | 'off_track' | 'no_data'
  personal: boolean
  parentGoalId: string | null
  metric: { source: string; metricKey: string; lastSyncAt: string | null; lastError: string | null } | null
  currentValue: number | null
  progress: number | null
  expectedProgress: number
  sparkline: Array<{ value: number; capturedAt: string }>
}
```

- [ ] **Step 4:** `npm run typecheck` → PASS. Visit `/goals` in `npm run dev` — sidebar entry renders, page 404s (built next task). Commit: `feat(goals): sidebar entry + /goals chrome + GoalSummary client type`.

---

### Task 14: Chart primitives — risk badge, progress bar with pace marker, sparkline, trend chart

**Files:**
- Create: `src/components/goals/goal-viz.tsx` (pure SVG/Tailwind primitives), `src/components/goals/chart-math.ts`
- Test: `src/components/goals/__tests__/chart-math.test.ts`

**Design rules (dataviz):** single-series line — no legend, the title names it; pace and projection are direct-labeled reference lines (dashed muted / dotted), not series; 2px line weight; text wears text tokens; risk states use semantic status tokens ALWAYS paired with icon + label; crosshair tooltip on the trend chart; grid recessive (`border/40`).

**Interfaces:**
- `chart-math.ts` (pure, tested): `scaleLinear(domain: [number, number], range: [number, number]): (v: number) => number`, `linePath(points: Array<{ x: number; y: number }>): string` (`M x y L x y …`), `niceTicks(min: number, max: number, count?: number): number[]`, `fmtValue(value: number, unit: string): string` (compact: `$41.2k`, `1.2M`, `12%`).
- `goal-viz.tsx`: `RiskBadge({ riskLevel })`, `GoalProgressBar({ progress, expectedProgress })`, `Sparkline({ points, width?, height? })`, `GoalTrendChart({ goal, points }: { goal: GoalSummary; points: Array<{ value: number; capturedAt: string }> })`.

- [ ] **Step 1: Failing tests for `chart-math.ts`** — `scaleLinear([0,100],[0,200])(50) === 100`; degenerate domain (min===max) maps to mid-range without NaN; `linePath` emits `M`/`L` with rounded coords and `''` for < 1 point; `niceTicks(0, 97)` returns round numbers spanning the domain; `fmtValue(41203.5,'usd') === '$41.2k'`, `fmtValue(0.12,'percent') === '12%'`, `fmtValue(1_200_000,'usd') === '$1.2M'`.
- [ ] **Step 2: Run to verify failure; implement `chart-math.ts`; run to PASS.**
- [ ] **Step 3: Implement `goal-viz.tsx`:**

```tsx
'use client'

import { AlertTriangle, CircleCheck, CircleHelp, TrendingDown } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import type { GoalSummary } from '@/lib/types'
import { fmtValue, linePath, niceTicks, scaleLinear } from './chart-math'

/** Status is never color alone: icon + label + semantic token. */
const RISK: Record<GoalSummary['riskLevel'], { label: string; icon: typeof CircleCheck; className: string }> = {
  on_track: { label: 'On track', icon: CircleCheck, className: 'text-success border-success/30 bg-success/10' },
  at_risk: { label: 'At risk', icon: AlertTriangle, className: 'text-warning border-warning/30 bg-warning/10' },
  off_track: { label: 'Off track', icon: TrendingDown, className: 'text-destructive border-destructive/30 bg-destructive/10' },
  no_data: { label: 'No data', icon: CircleHelp, className: 'text-muted-foreground border-border bg-muted' },
}

export function RiskBadge({ riskLevel }: { readonly riskLevel: GoalSummary['riskLevel'] }) {
  const { label, icon: Icon, className } = RISK[riskLevel]
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium', className)}>
      <Icon className="h-3 w-3" aria-hidden />
      {label}
    </span>
  )
}

/** Fill = actual progress; the tick mark = where pace says you should be. */
export function GoalProgressBar({ progress, expectedProgress }: { readonly progress: number | null; readonly expectedProgress: number }) {
  const pct = Math.min(1, Math.max(0, progress ?? 0)) * 100
  const pacePct = Math.min(1, Math.max(0, expectedProgress)) * 100
  return (
    <div className="relative h-1.5 w-full rounded-full bg-muted" role="img" aria-label={`Progress ${Math.round(pct)}%, pace ${Math.round(pacePct)}%`}>
      <div className="absolute inset-y-0 left-0 rounded-full bg-horizon-500" style={{ width: `${pct}%` }} />
      <div className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 rounded bg-foreground/60" style={{ left: `${pacePct}%` }} title="Expected pace" />
    </div>
  )
}

export function Sparkline({ points, width = 96, height = 28 }: { readonly points: Array<{ value: number; capturedAt: string }>; readonly width?: number; readonly height?: number }) {
  const d = useMemo(() => {
    if (points.length < 2) return ''
    const xs = points.map((p) => Date.parse(p.capturedAt))
    const ys = points.map((p) => p.value)
    const x = scaleLinear([Math.min(...xs), Math.max(...xs)], [2, width - 2])
    const y = scaleLinear([Math.min(...ys), Math.max(...ys)], [height - 2, 2])
    return linePath(points.map((p) => ({ x: x(Date.parse(p.capturedAt)), y: y(p.value) })))
  }, [points, width, height])
  if (!d) return null
  return (
    <svg width={width} height={height} aria-hidden className="text-horizon-500">
      <path d={d} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
```

`GoalTrendChart` (same file): responsive `viewBox="0 0 640 240"`, y-domain = min/max over series ∪ {startValue, targetValue}, `niceTicks` → horizontal gridlines `stroke-border/40` with `fmtValue` labels in `fill-muted-foreground text-[10px]`; **actuals** = 2px `text-horizon-500` path; **pace line** = straight segment (startAt, startValue) → (targetDate, targetValue), `stroke-muted-foreground` `strokeDasharray="6 4"`, direct-labeled `Pace` at its end; **projection** = segment from the last actual to (targetDate, projected y) computed client-side from the last ≤ 30 points with the same least-squares slope, `strokeDasharray="2 4"`, labeled `Projected`, rendered only when ≥ 2 points; **target** = 1px `stroke-success/60` horizontal rule labeled with `fmtValue(targetValue)`. Hover layer: transparent `<rect>` capturing `onMouseMove`, nearest-point lookup by x, `<line>` crosshair + 8px circle marker (2px `stroke-background` ring) + absolutely-positioned tooltip div (`bg-popover shadow-popover rounded-lg border px-2.5 py-1.5 text-xs`) showing date + `fmtValue`; `onMouseLeave` clears (`useState<number | null>` for the hovered index; `useId` for the clip path). Contribution markers: optional `markers?: Array<{ at: string; label: string }>` prop → 1px vertical `stroke-border` rules with a `▲` glyph at the baseline and the label in the tooltip when hovered (used by Task 17 for "AI showed up here").

- [ ] **Step 4:** `npm run typecheck` + chart-math tests PASS. Commit: `feat(goals): chart primitives — risk badge, pace progress bar, sparkline, trend chart`.

---

### Task 15: `/goals` dashboard page (impact strip + goal cards)

**Files:**
- Create: `src/app/goals/page.tsx`, `src/components/goals/impact-strip.tsx`, `src/components/goals/goal-card.tsx`

**Interfaces:**
- Consumes `GET /api/goals`, `GET /api/goals/impact`, `PATCH /api/goals/settings`; `GoalSummary`, `RiskBadge`, `GoalProgressBar`, `Sparkline`, `StatTile`, `EmptyState`, `PageHeader` (check `src/components/ui/page-header.tsx` props before use).

- [ ] **Step 1: `impact-strip.tsx`** — the day-1 ROI proof row. Four `StatTile`s: Actions completed (measured), Hours saved (estimated), Value created `$` (estimated), ROI multiple `×` (estimated, `—` when null). Tier labeling is non-negotiable: each tile's `hint` names its tier (`'measured'` / `'estimated · $50/hr'` / `'correlation'`). An `(edit)` affordance on the rate opens a small `Dialog` with two `Input`s POSTing `PATCH /api/goals/settings`, then refetches. Data: plain `fetch('/api/goals/impact', { cache: 'no-store' })` in the page, passed down as props.
- [ ] **Step 2: `goal-card.tsx`** — `Card variant="interactive"` linking to `/goals/[id]`: name + `RiskBadge` row; `fmtValue(currentValue)` large (`font-mono text-2xl font-bold`) with `of {fmtValue(targetValue)} by {date}` in muted; `GoalProgressBar`; `Sparkline` right-aligned; metric-health footnote when `metric.lastError` (`<AlertTriangle className="h-3 w-3" /> source failing — {lastError}` in `text-warning text-xs`) and a `Personal` `Badge variant="outline"` when `personal`.
- [ ] **Step 3: `page.tsx`** (`'use client'`) — three-state convention (`null` loading / empty / list): loads both endpoints in parallel on mount (plain fetch, `cache: 'no-store'`); header (`PageHeader` if its props fit, else the h1 pattern from the settings page) with a `Button` → `/goals/new`; `ImpactStrip`; "Organization goals" grid (`grid gap-4 sm:grid-cols-2 lg:grid-cols-3`) then "My goals" section when any `personal`; `EmptyState` (icon `Target`, copy "Set a goal and Sublime will track it, watch for risk, and recommend what to do about it.") with the create CTA when zero goals.
- [ ] **Step 4:** `npm run typecheck`; `npm run dev` → `/goals` renders the empty state. Commit: `feat(goals): /goals dashboard — AI impact strip + goal cards`.

---

### Task 16: Create wizard — `/goals/new`

**Files:**
- Create: `src/app/goals/new/page.tsx`

**Interfaces:**
- Consumes `GET /api/goals/metrics/sources`, `POST /api/goals/metrics/preview`, `POST /api/goals`, `GET /api/goals` (for the org-goal link picker).

- [ ] **Step 1: Implement the 3-step client page.** One component, `useState<Step>(1)`, a `WizardState` object, `Card` per step, `Button` back/next, `toast.error` on validation:
  - **Step 1 — Target.** Inputs: name; kind (`Select` of the 7 kinds with human labels: ARR / MRR / CARR / Revenue / Sales quota / Savings / Custom KPI — choosing `savings` flips `direction` to `decrease` and shows a note); target value (`Input type="number"` with unit `Select`); target date (`Input type="date"`, min tomorrow); scope toggle (`Switch`: Organization goal ↔ Personal goal); when personal, an optional `Select` of org goals (from `GET /api/goals`, `personal === false`) for `parentGoalId` labeled "Supports org goal".
  - **Step 2 — Source.** Radio-style `Card` list from `GET /api/goals/metrics/sources`: each source with its connections as a nested `Select` (auto-picked when exactly one); sources with zero connections render a muted card with a `Connect` link (`/integrations` for nango/google, `/integrations?tab=credentials` for Stripe) — visible but not selectable (sort, never hide). `manual` is always last: "I'll record values myself". Selecting a source sets `metricKey` from its first descriptor (a `Select` when several); `google_sheets` additionally shows `spreadsheetId` + `range` inputs feeding `config`.
  - **Step 3 — Verify.** Auto-fires the preview on mount (skip for manual): `POST /api/goals/metrics/preview`; while pending, `Skeleton`; on success show `Current value: {fmtValue(value, unit)}` with "Use as baseline" (default: sets `startValue = value`) or an override `Input`; on `PREVIEW_FAILED` render the connector's message in `text-destructive text-sm` with a Retry `Button` — **Create stays disabled until a preview succeeds or the source is manual** (manual shows a required baseline `Input`). Create → `POST /api/goals` → `router.push('/goals')` + `toast.success('Goal created — first sync lands within the hour.')`.
- [ ] **Step 2:** `npm run typecheck`; manual pass in `npm run dev`: create a manual-source goal end-to-end; verify a sourced goal blocks Create until preview passes. Commit: `feat(goals): 3-step create wizard with live metric preview`.

---

### Task 17: Goal detail — `/goals/[id]`

**Files:**
- Create: `src/app/goals/[id]/page.tsx`, `src/components/goals/contribution-panel.tsx`

**Interfaces:**
- Consumes `GET /api/goals/[id]`, `GET/POST /api/goals/[id]/datapoints`, `GET/POST/DELETE /api/goals/[id]/contributions`, `GoalTrendChart` (+ `markers` from contribution `createdAt`s), `RiskBadge`, `fmtValue`.

- [ ] **Step 1: `page.tsx`** — header: name, `RiskBadge`, kind `Badge`, target line (`{fmtValue(target)} by {date}`), Edit (dialog PATCHing name/target/date) and Archive (confirm dialog → DELETE, then `router.push('/goals')`). Body, top to bottom:
  1. `GoalTrendChart` in a `Card` with contribution markers ("AI showed up here").
  2. Impact panel: the goal-scoped tier figures from `GET /api/goals/[id]/contributions` response totals + `paceDeltaPct` rendered as "Closing the gap {x}% faster since AI started helping" (`text-success`) — hidden when null; every figure tier-labeled like the strip.
  3. `contribution-panel.tsx`: linked automations list (name, origin `Badge` 'suggested'/'linked', runs, est. minutes per run editable inline → PATCH is out of scope, use unlink+relink; unlink `X` → DELETE) + "Link automation" dialog listing org flows/agents (`GET /api/flows`, `GET /api/agents` — reuse the fetch shapes from `sidebar.tsx`'s snapshot or the flows page) POSTing to contributions.
  4. Datapoints `Table` (date, value, origin) with a "Record value" `Dialog` (`Input type="number"` + optional date) POSTing to datapoints, then refetching — the metric-health banner (`lastError`) sits above it with a reconnect link.
  5. Children rollup (org goals only): supporting personal goals as compact rows (name or "A teammate's goal", `RiskBadge`).
- [ ] **Step 2:** typecheck + manual pass (create → record datapoints → watch the chart/pace/risk respond; link a flow; verify markers). Commit: `feat(goals): goal detail — trend chart, impact panel, contributions, datapoints`.

---

### Task 18: Surface integration — home strip, suggestion dialog, template chips

**Files:**
- Create: `src/components/goals/goal-status-strip.tsx`
- Modify: `src/app/dashboard/home-assistant.tsx` (~line 594), `src/components/intelligence/suggestion-approval-dialog.tsx`, `src/components/templates/template-catalogue-card.tsx` (or wherever the card body renders — locate the seed card component first), `src/app/templates/page.tsx` or `src/components/templates/templates-explorer.tsx`

- [ ] **Step 1: `goal-status-strip.tsx`** — compact, dismiss-free: `getCachedJson<{ goals: GoalSummary[] }>('/api/goals', 60_000)`; renders nothing while loading, on error, or with zero goals (the home hero must not flash). Shows up to 3 org goals as pills — name, mini `GoalProgressBar` (60px), `RiskBadge` — each linking to its goal; wrapper mirrors `LearningProgressCard`'s rounded-2xl card shell. Mount directly under `<LearningProgressCard />` in `home-assistant.tsx`.
- [ ] **Step 2: Suggestion dialog `goal_action` support** — extend `OpenUserSuggestion` with `kind: 'new_flow' | 'enhancement' | 'goal_action'` and `metadata?: { goalId?: string; seedKey?: string | null }` (the GET already returns whatever the row holds — verify the route's `select` includes `metadata`; add it if not). In `act('accept')` for `goal_action`: when `metadata.seedKey` exists, first `POST /api/templates/provision` with `{ seedKey, goalId: metadata.goalId, suggestionId: suggestion.id, targetKind: undefined, activate: false }` (the provision route marks the suggestion accepted — Task 12 — so skip the user-suggestions POST in that branch and navigate to the provision response's flow/agent); when `seedKey` is null, fall through to the normal accept POST and route to `/goals/${metadata.goalId}`. Dismiss unchanged. Add an `acceptedDestination` case: `targetType === 'goal'` → `/goals/${targetId}`.
- [ ] **Step 3: Template chips** — in the templates explorer, fetch goals once (`getCachedJson('/api/goals')`); for each seed with `goalKinds` intersecting an active goal's kind, render `<Badge variant="secondary" className="text-indigo-500"><Target className="mr-1 h-3 w-3" />Advances: {goal.name}</Badge>` on the card. Composition unchanged — the chip is presentation only (goal-fit ranking already happens server-side at emission; catalogue-wide re-ranking stays out of v1 scope).
- [ ] **Step 4:** typecheck + manual pass (seed an off-track goal via manual datapoints → run `refreshGoalMetrics` in a script or wait for a dev tick → bell shows the notification → dialog deploys the template → contribution appears on the goal). Commit: `feat(goals): home goal strip, goal_action suggestions, template goal chips`.

---

### Task 19: Final verification + docs

- [ ] **Step 1:** `npm test` — full suite green, including route-smoke completeness and goals e2e (with `TEST_DATABASE_URL`).
- [ ] **Step 2:** `npm run check` (typecheck + lint + build) — green.
- [ ] **Step 3:** Update `ARCHITECTURE.md`: one paragraph under Core Data noting the goals spine (Goal/GoalMetric/MetricDatapoint/GoalContribution), the metric registry (`src/lib/metrics/`), the cron leg, and the transition-gated emission rule. Update the spec's org-goal emission paragraph to match the locked deviation (UserSuggestion + org-wide notify, not AgentMemory).
- [ ] **Step 4:** Commit: `docs(goals): architecture notes + spec deviation reconciliation`.

---

## Self-review notes (already applied)

- **Spec coverage:** data model → T1; connectors → T3–5; evaluation → T2; cron → T8; recommendations → T6–7; org-priority scoring is satisfied in v1 by parent-link context + org-goal notify (full dual-scoring deferred — recorded as out-of-scope in the spec); proof layer → T9, T11, T12, T15, T17; UI → T13–18; API + smoke → T10–11; teardown cascades via FK → T1.
- **Type consistency:** `Evaluation`/`EvalPoint` (T2) consumed by T8/T9/T10; `MetricSourceContext`/`MetricReading` (T3) consumed by T4/T5/T8/T11; `GoalSummary` (T10) mirrored in T13 and consumed by T14–18; `metadata { goalId, seedKey }` written in T7, read in T18, accepted in T12.
- **Known judgment calls for implementers:** HubSpot `hs_is_closed`/`hs_is_closed_won` property names should be verified against the connected portal on first real fetch (the adapter test pins the filter shape, not HubSpot's property vocabulary); `PageHeader` props must be checked before use (T15); the provision route's internal variable names (T12) must be read, not assumed.


