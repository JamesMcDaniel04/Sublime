# Home Goals-in-Flight Mini Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Home page's RecentFlows strip with a 3-goal mini tracker showing MOVED / SPENT / TIME / VALUE per goal, fed by a flat batched impact endpoint.

**Architecture:** A new `goalImpactBatch` loader in `src/lib/goals/impact.ts` runs exactly 3 queries regardless of goal count (contributions, flow runs, agent executions) and buckets rows per contribution in JS through the existing pure stat functions. A capped `GET /api/goals/impact/batch` route filters ids through `goalReadWhere`. A pure `src/lib/goals/tracked.ts` module handles selection + formatting; `goals-in-flight.tsx` renders it in place of `recent-flows.tsx` (which is deleted).

**Tech Stack:** Next.js App Router (route handlers), Prisma, node:test (`npm test`, tsx runner), Tailwind.

**Spec:** `docs/superpowers/specs/2026-08-13-home-goal-tracker-design.md` (amended 2026-08-14)

## Global Constraints

- Branch: `feat/run-traces` (this plan and the traces plan share it; commit per task).
- Test runner: `npm test` runs every `src/**/__tests__/*.test.ts(x)` via tsx + node:test. Route tests needing Postgres follow the repo's `TEST_DATABASE_URL`-guarded pattern (inert without it) — see `src/app/api/goals/__tests__/work-route.test.ts` for the harness idiom.
- Ids cap on the batch route is **3**; more is a 400.
- Invisible goals are **silently dropped** (absent from the response), never 403.
- MOVED on percent goals renders **percentage points** (`−1.2pp`), colored by direction agreement, not sign.
- The strip renders **only** under the all-goals lens (`scope === ALL_SCOPE`).
- No changes to `goalImpact`, `orgImpact`, or `/api/goals/impact`.
- Every file must compile under the repo's ESLint/a11y ratchet (`npm run lint` must not add new warnings).

---

### Task 1: Pure batch bucketing + `goalImpactBatch` loader

**Files:**
- Modify: `src/lib/goals/impact.ts` (append after `goalImpact`, ~line 248)
- Test: `src/lib/goals/__tests__/impact.test.ts` (extend)

**Interfaces:**
- Consumes: existing `flowRunStatsOf`, `agentRunStatsOf`, `computeImpact`, `impactSettings` (module-private, same file), `ImpactTiers` — all already in `impact.ts`.
- Produces:
  - `bucketBatchStats(contributions: BatchContribution[], flowRuns: BatchFlowRun[], agentRuns: BatchAgentRun[]): Map<string, BatchStats[]>` (exported, pure)
  - `goalImpactBatch(organizationId: string, goalIds: string[]): Promise<Map<string, ImpactTiers>>` (exported)
  - Exported row types: `BatchContribution = { goalId: string; resourceType: string; resourceId: string; estimatedMinutesSavedPerRun: number; createdAt: Date }`, `BatchFlowRun = { flowId: string; startedAt: Date; finishedAt: Date | null }`, `BatchAgentRun = { agentTaskId: string | null; startedAt: Date; inputTokens: number; outputTokens: number; executionTime: number | null }`, `BatchStats = { estimatedMinutesSavedPerRun: number; runs: number; tokens: number; measuredRunSeconds: { total: number; avg: number | null } }`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/goals/__tests__/impact.test.ts` (it already imports from `../impact`; extend the import list):

```ts
import { bucketBatchStats } from '../impact'

test('bucketBatchStats re-applies each contribution own createdAt cutoff', () => {
  const contributions = [
    { goalId: 'g1', resourceType: 'flow', resourceId: 'f1', estimatedMinutesSavedPerRun: 30, createdAt: new Date('2026-08-10T00:00:00Z') },
    { goalId: 'g2', resourceType: 'flow', resourceId: 'f1', estimatedMinutesSavedPerRun: 15, createdAt: new Date('2026-08-01T00:00:00Z') },
  ]
  // Run on 08-05: after g2's cutoff, BEFORE g1's — must count for g2 only,
  // even though the SQL batch cutoff (min createdAt = 08-01) admitted it.
  const flowRuns = [
    { flowId: 'f1', startedAt: new Date('2026-08-05T00:00:00Z'), finishedAt: new Date('2026-08-05T00:01:00Z') },
    { flowId: 'f1', startedAt: new Date('2026-08-11T00:00:00Z'), finishedAt: new Date('2026-08-11T00:02:00Z') },
  ]
  const buckets = bucketBatchStats(contributions, flowRuns, [])
  assert.equal(buckets.get('g1')![0].runs, 1)
  assert.equal(buckets.get('g2')![0].runs, 2)
})

test('bucketBatchStats: unfinished flow runs are excluded, agent tokens summed', () => {
  const contributions = [
    { goalId: 'g1', resourceType: 'flow', resourceId: 'f1', estimatedMinutesSavedPerRun: 30, createdAt: new Date('2026-08-01T00:00:00Z') },
    { goalId: 'g1', resourceType: 'agent', resourceId: 'a1', estimatedMinutesSavedPerRun: 10, createdAt: new Date('2026-08-01T00:00:00Z') },
  ]
  const flowRuns = [{ flowId: 'f1', startedAt: new Date('2026-08-02T00:00:00Z'), finishedAt: null }]
  const agentRuns = [
    { agentTaskId: 'a1', startedAt: new Date('2026-08-02T00:00:00Z'), inputTokens: 1000, outputTokens: 500, executionTime: 4000 },
    { agentTaskId: 'other', startedAt: new Date('2026-08-02T00:00:00Z'), inputTokens: 9, outputTokens: 9, executionTime: 9 },
  ]
  const buckets = bucketBatchStats(contributions, flowRuns, agentRuns)
  const [flowStats, agentStats] = buckets.get('g1')!
  assert.equal(flowStats.runs, 0) // no finishedAt → unmeasurable → excluded
  assert.equal(agentStats.runs, 1)
  assert.equal(agentStats.tokens, 1500)
  assert.equal(agentStats.measuredRunSeconds.total, 4)
})

test('bucketBatchStats: goal with no contributions is absent from the map', () => {
  assert.equal(bucketBatchStats([], [], []).size, 0)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/lib/goals/__tests__/impact.test.ts`
Expected: FAIL — `bucketBatchStats` is not exported.

- [ ] **Step 3: Implement in `src/lib/goals/impact.ts`**

Append after `goalImpact` (before `orgImpact`):

```ts
export type BatchContribution = {
  goalId: string
  resourceType: string
  resourceId: string
  estimatedMinutesSavedPerRun: number
  createdAt: Date
}
export type BatchFlowRun = { flowId: string; startedAt: Date; finishedAt: Date | null }
export type BatchAgentRun = {
  agentTaskId: string | null
  startedAt: Date
  inputTokens: number
  outputTokens: number
  executionTime: number | null
}
export type BatchStats = ContributionRunStats & { estimatedMinutesSavedPerRun: number }

/**
 * Pure half of the batch loader: bucket pre-fetched run rows per contribution.
 * The SQL cutoff is the EARLIEST contribution createdAt (one query per store),
 * so each contribution's own `startedAt > createdAt` must be re-applied here —
 * a run older than its contribution must not count toward that goal.
 * Duration/measurability rules stay in flowRunStatsOf / agentRunStatsOf.
 */
export function bucketBatchStats(
  contributions: BatchContribution[],
  flowRuns: BatchFlowRun[],
  agentRuns: BatchAgentRun[],
): Map<string, BatchStats[]> {
  const buckets = new Map<string, BatchStats[]>()
  for (const contribution of contributions) {
    const stats =
      contribution.resourceType === 'flow'
        ? flowRunStatsOf(
            flowRuns.filter(
              (run) => run.flowId === contribution.resourceId && run.startedAt > contribution.createdAt,
            ),
          )
        : contribution.resourceType === 'agent'
          ? agentRunStatsOf(
              agentRuns.filter(
                (run) => run.agentTaskId === contribution.resourceId && run.startedAt > contribution.createdAt,
              ),
            )
          : { runs: 0, tokens: 0, measuredRunSeconds: { total: 0, avg: null } }
    const list = buckets.get(contribution.goalId) ?? []
    list.push({ estimatedMinutesSavedPerRun: contribution.estimatedMinutesSavedPerRun, ...stats })
    buckets.set(contribution.goalId, list)
  }
  return buckets
}

/**
 * Batched per-goal impact for the Home strip: flat 3 queries total regardless
 * of goal/contribution count (vs goalImpact's per-contribution loads). No
 * pace tier, no datapoint reads. Goals with no contributions get the zero
 * shape (present, never absent) so the client needn't special-case.
 */
export async function goalImpactBatch(
  organizationId: string,
  goalIds: string[],
): Promise<Map<string, ImpactTiers>> {
  const result = new Map<string, ImpactTiers>()
  if (goalIds.length === 0) return result
  const [contributions, settings] = await Promise.all([
    prisma.goalContribution.findMany({
      where: { organizationId, goalId: { in: goalIds } },
      select: {
        goalId: true,
        resourceType: true,
        resourceId: true,
        estimatedMinutesSavedPerRun: true,
        createdAt: true,
      },
    }),
    settingsFor(organizationId),
  ])
  const flowContributions = contributions.filter((c) => c.resourceType === 'flow')
  const agentContributions = contributions.filter((c) => c.resourceType === 'agent')
  const minCreatedAt = (rows: { createdAt: Date }[]) =>
    rows.reduce((min, row) => (row.createdAt < min ? row.createdAt : min), rows[0]!.createdAt)
  const [flowRuns, agentRuns] = await Promise.all([
    flowContributions.length
      ? prisma.flowRun.findMany({
          where: {
            organizationId,
            flowId: { in: [...new Set(flowContributions.map((c) => c.resourceId))] },
            status: 'succeeded',
            startedAt: { gt: minCreatedAt(flowContributions) },
          },
          select: { flowId: true, startedAt: true, finishedAt: true },
        })
      : [],
    agentContributions.length
      ? prisma.agentExecution.findMany({
          where: {
            organizationId,
            agentTaskId: { in: [...new Set(agentContributions.map((c) => c.resourceId))] },
            completedAt: { not: null },
            error: null,
            startedAt: { gt: minCreatedAt(agentContributions) },
          },
          select: {
            agentTaskId: true,
            startedAt: true,
            inputTokens: true,
            outputTokens: true,
            executionTime: true,
          },
        })
      : [],
  ])
  const buckets = bucketBatchStats(contributions, flowRuns, agentRuns)
  for (const goalId of goalIds) {
    result.set(
      goalId,
      computeImpact({
        contributions: buckets.get(goalId) ?? [],
        ...settings,
        paceBefore: null,
        paceAfter: null,
      }),
    )
  }
  return result
}
```

Note: the where-clauses mirror `contributionRunStats` exactly (`status: 'succeeded'` for flows; `completedAt not null, error null` for agents) — same measurability discipline, one place per rule.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/lib/goals/__tests__/impact.test.ts`
Expected: PASS (all existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/goals/impact.ts src/lib/goals/__tests__/impact.test.ts
git commit -m "feat(goals): batched per-goal impact loader (flat 3 queries)"
```

---

### Task 2: `GET /api/goals/impact/batch` route

**Files:**
- Create: `src/app/api/goals/impact/batch/route.ts`
- Test: `src/app/api/goals/__tests__/impact-batch-route.pg.test.ts`

**Interfaces:**
- Consumes: `goalImpactBatch` (Task 1), `goalReadWhere` from `@/lib/server/goal-scope`, `withAuthenticatedApi` from `@/lib/server/api-handler` (handler gets `(request, auth)` with `auth.organizationId`, `auth.dbUser.id`, `auth.isAdmin`).
- Produces: `GET /api/goals/impact/batch?ids=a,b,c` → `{ success: true, impact: Record<string, ImpactTiers> }` (only visible ids present).

- [ ] **Step 1: Write the failing route test**

`src/app/api/goals/__tests__/impact-batch-route.pg.test.ts` — follow the `work-route.test.ts` harness exactly (TEST_DATABASE_URL guard, `seedTestOrg`, `installTestAuth`):

```ts
/**
 * Route-handler drive for the Home strip's batched impact endpoint. Real
 * Postgres + seeded auth (`verify` skill): jsdom cannot prove the visibility
 * filter or the ids cap. Inert without TEST_DATABASE_URL.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let visibleGoalId: string
  let personalOtherGoalId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    const base = {
      organizationId: seeded.organizationId,
      kind: 'kpi',
      unit: 'count',
      direction: 'increase',
      startValue: 0,
      targetValue: 10,
      startAt: new Date('2026-07-01T00:00:00Z'),
      targetDate: new Date('2026-09-01T00:00:00Z'),
    }
    visibleGoalId = (await prisma.goal.create({ data: { ...base, name: 'Org goal' } })).id
    // Another user's PERSONAL goal: must be silently absent, never 403.
    personalOtherGoalId = (
      await prisma.goal.create({
        data: { ...base, name: 'Someone else personal', ownerUserId: seeded.otherUserId ?? 'other-user' },
      })
    ).id
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  const get = async (ids: string) => {
    const { GET } = await import('@/app/api/goals/impact/batch/route')
    const response = await GET(
      new NextRequest(`http://test/api/goals/impact/batch?ids=${ids}`),
      { params: Promise.resolve({}) } as any,
    )
    return { status: response.status, body: await response.json() }
  }

  test('returns zero-shape impact for a visible goal with no contributions', async () => {
    const { status, body } = await get(visibleGoalId)
    assert.equal(status, 200)
    assert.equal(body.impact[visibleGoalId].measured.runsCompleted, 0)
  })

  test('another user personal goal is absent from the response (never 403)', async () => {
    const { status, body } = await get(`${visibleGoalId},${personalOtherGoalId}`)
    assert.equal(status, 200)
    assert.ok(body.impact[visibleGoalId])
    assert.equal(body.impact[personalOtherGoalId], undefined)
  })

  test('more than 3 ids is a 400', async () => {
    const { status } = await get('a,b,c,d')
    assert.equal(status, 400)
  })

  test('empty ids is a 400', async () => {
    const { status } = await get('')
    assert.equal(status, 400)
  })
}
```

Adapt seeding details to what `seedTestOrg` actually returns (read `src/lib/server/__tests__/test-auth.ts` first; if it has no second user, create one directly with `prisma.user.create` and use its id for the personal goal).

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx tsx --test src/app/api/goals/__tests__/impact-batch-route.pg.test.ts`
(If no local test DB is exported, start the throwaway Postgres per the `verify` skill first.)
Expected: FAIL — route module does not exist.

- [ ] **Step 3: Implement the route**

`src/app/api/goals/impact/batch/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { goalImpactBatch } from '@/lib/goals/impact'
import { goalReadWhere } from '@/lib/server/goal-scope'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

/** Hard cap: the Home strip shows at most 3 goals; anything more is misuse. */
const MAX_IDS = 3

// GET /api/goals/impact/batch?ids=a,b,c — per-goal impact tiers for the Home
// strip. Ids the caller may not see are silently dropped (absent, never 403 —
// the confidential-goal rule). Flat query count regardless of ids.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const ids = (request.nextUrl.searchParams.get('ids') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  if (ids.length === 0 || ids.length > MAX_IDS) {
    return NextResponse.json(
      { success: false, error: `ids must list 1-${MAX_IDS} goal ids` },
      { status: 400 },
    )
  }
  const visible = await prisma.goal.findMany({
    where: {
      organizationId: auth.organizationId,
      id: { in: ids },
      ...goalReadWhere(auth.dbUser.id, { isAdmin: auth.isAdmin }),
    },
    select: { id: true },
  })
  const impact = await goalImpactBatch(
    auth.organizationId,
    visible.map((goal) => goal.id),
  )
  return { success: true, impact: Object.fromEntries(impact) }
}, { requires: 'member' })
```

If `goalReadWhere` returns an `OR` and other routes combine it via `AND` (check `src/app/api/goals/route.ts:174` for the exact idiom), copy that idiom.

- [ ] **Step 4: Run test to verify it passes**

Run: same command as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/goals/impact/batch src/app/api/goals/__tests__/impact-batch-route.pg.test.ts
git commit -m "feat(goals): capped batch impact endpoint for the Home strip"
```

---

### Task 3: Pure selection + formatting module `tracked.ts`

**Files:**
- Create: `src/lib/goals/tracked.ts`
- Test: `src/lib/goals/__tests__/tracked.test.ts`

**Interfaces:**
- Consumes: `GoalSummary` from `@/lib/types` (fields used: `id`, `name`, `status`, `startAt`, `direction`, `unit`, `startValue`, `currentValue`, `riskLevel`).
- Produces:
  - `TRACKED_GOALS_LIMIT = 3`
  - `pickTrackedGoals<T extends TrackedGoalInput>(goals: T[] | null | undefined): T[]`
  - `goalMovement(goal: Pick<GoalSummary, 'direction' | 'unit' | 'startValue' | 'currentValue'>): { text: string; favorable: boolean | null }`
  - `fmtUsdCompact(value: number): string` (e.g. `$18.40`, `$3.1k`, `$142k`)
  - `fmtRunTime(seconds: number): string` (`45s`, `12m`, `6.2h`)

- [ ] **Step 1: Write the failing tests**

`src/lib/goals/__tests__/tracked.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickTrackedGoals, goalMovement, fmtUsdCompact, fmtRunTime, TRACKED_GOALS_LIMIT } from '../tracked'

const goal = (overrides: Record<string, unknown>) => ({
  id: 'g',
  status: 'active',
  startAt: '2026-08-01T00:00:00Z',
  direction: 'increase',
  unit: 'usd',
  startValue: 0,
  currentValue: null,
  ...overrides,
})

test('pickTrackedGoals: active only, newest startAt first, capped', () => {
  const goals = [
    goal({ id: 'old', startAt: '2026-01-01T00:00:00Z' }),
    goal({ id: 'paused', status: 'paused' }),
    goal({ id: 'a', startAt: '2026-08-10T00:00:00Z' }),
    goal({ id: 'b', startAt: '2026-08-09T00:00:00Z' }),
    goal({ id: 'c', startAt: '2026-08-08T00:00:00Z' }),
  ]
  const picked = pickTrackedGoals(goals as never[])
  assert.equal(picked.length, TRACKED_GOALS_LIMIT)
  assert.deepEqual(picked.map((g: { id: string }) => g.id), ['a', 'b', 'c'])
})

test('pickTrackedGoals tolerates undefined/null', () => {
  assert.deepEqual(pickTrackedGoals(undefined), [])
  assert.deepEqual(pickTrackedGoals(null), [])
})

test('goalMovement: null currentValue renders an em dash with no color', () => {
  assert.deepEqual(goalMovement(goal({}) as never), { text: '—', favorable: null })
})

test('goalMovement: percent goals render percentage POINTS, not fmt %', () => {
  const moved = goalMovement(goal({ unit: 'percent', startValue: 0.062, currentValue: 0.05, direction: 'decrease' }) as never)
  assert.equal(moved.text, '−1.2pp')
  assert.equal(moved.favorable, true) // decrease direction: falling is good
})

test('goalMovement: favorability follows direction, not sign', () => {
  const down = goalMovement(goal({ startValue: 100, currentValue: 80, direction: 'decrease', unit: 'count' }) as never)
  assert.equal(down.favorable, true)
  const up = goalMovement(goal({ startValue: 100, currentValue: 80, direction: 'increase', unit: 'count' }) as never)
  assert.equal(up.favorable, false)
})

test('goalMovement: usd delta uses compact money with explicit sign', () => {
  const moved = goalMovement(goal({ startValue: 0, currentValue: 142000 }) as never)
  assert.equal(moved.text, '+$142k')
})

test('fmtUsdCompact', () => {
  assert.equal(fmtUsdCompact(18.4), '$18.40')
  assert.equal(fmtUsdCompact(3100), '$3.1k')
  assert.equal(fmtUsdCompact(142000), '$142k')
  assert.equal(fmtUsdCompact(0), '$0')
})

test('fmtRunTime', () => {
  assert.equal(fmtRunTime(45), '45s')
  assert.equal(fmtRunTime(720), '12m')
  assert.equal(fmtRunTime(22320), '6.2h')
  assert.equal(fmtRunTime(0), '0s')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/lib/goals/__tests__/tracked.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/goals/tracked.ts`**

```ts
/**
 * Selection + formatting for the Home "Goals in flight" strip. Pure (no
 * React, no fetch) so it is directly unit-testable — the lib/flows/recent.ts
 * pattern this strip replaces.
 */
import type { GoalSummary } from '@/lib/types'

export type TrackedGoalInput = Pick<
  GoalSummary,
  'id' | 'status' | 'startAt' | 'direction' | 'unit' | 'startValue' | 'currentValue'
>

/** Rows shown on the Home strip. */
export const TRACKED_GOALS_LIMIT = 3

/** Most recently created active goals. */
export function pickTrackedGoals<T extends TrackedGoalInput>(goals: T[] | null | undefined): T[] {
  if (!Array.isArray(goals)) return []
  return goals
    .filter((goal) => goal.status === 'active')
    .sort((a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime())
    .slice(0, TRACKED_GOALS_LIMIT)
}

/** `$18.40` under $1k (cents matter at that scale), `$3.1k` / `$142k` above. */
export function fmtUsdCompact(value: number): string {
  const abs = Math.abs(value)
  if (abs === 0) return '$0'
  if (abs < 1000) return `$${abs.toFixed(2)}`
  const thousands = abs / 1000
  return `$${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1)}k`
}

/** Measured run time: `45s`, `12m`, `6.2h`. */
export function fmtRunTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${(seconds / 3600).toFixed(1)}h`
}

/**
 * The MOVED cell: currentValue − startValue on the goal's primary metric.
 *
 * - Percent goals render the delta in percentage POINTS (`−1.2pp`) — the
 *   level formatter's ×100-and-% is correct for levels, wrong-reading for
 *   deltas.
 * - `favorable` is direction AGREEMENT, not sign: a negative delta on a
 *   decrease goal (churn, savings) is favorable. Sign-only coloring would
 *   paint every successful cost-reduction goal red.
 * - No data yet (null currentValue) → em dash, no color.
 *
 * Uses the typographic minus (−) so the sign column aligns with the `pp`
 * rendering in the tests and UI.
 */
export function goalMovement(
  goal: Pick<GoalSummary, 'direction' | 'unit' | 'startValue' | 'currentValue'>,
): { text: string; favorable: boolean | null } {
  if (goal.currentValue === null || goal.currentValue === undefined) {
    return { text: '—', favorable: null }
  }
  const delta = goal.currentValue - goal.startValue
  if (delta === 0) return { text: '±0', favorable: null }
  const favorable = goal.direction === 'decrease' ? delta < 0 : delta > 0
  const sign = delta > 0 ? '+' : '−'
  const abs = Math.abs(delta)
  const magnitude =
    goal.unit === 'percent'
      ? `${(abs * 100).toFixed(1)}pp`
      : goal.unit === 'usd'
        ? fmtUsdCompact(abs) // unsigned; the sign prefix is added below
        : abs >= 1000
          ? `${(abs / 1000).toFixed(1)}k`
          : String(Math.round(abs))
  return { text: `${sign}${magnitude}`, favorable }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/lib/goals/__tests__/tracked.test.ts`
Expected: PASS. If `fmtUsdCompact(142000)` renders `$142.0k` instead of `$142k`, the `thousands >= 100` rounding branch is wrong — fix the implementation, not the test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/goals/tracked.ts src/lib/goals/__tests__/tracked.test.ts
git commit -m "feat(goals): pure selection/formatting for the Home goal strip"
```

---

### Task 4: `GoalsInFlight` component; swap into Home; delete RecentFlows

**Files:**
- Create: `src/app/(app)/g/[scope]/dashboard/goals-in-flight.tsx`
- Modify: `src/app/(app)/g/[scope]/dashboard/home-assistant.tsx` (import at line 27; render site at line ~708)
- Delete: `src/app/(app)/g/[scope]/dashboard/recent-flows.tsx`, `src/lib/flows/recent.ts`, `src/lib/flows/__tests__/recent.test.ts`
- Test: covered by Task 3's unit tests + Task 5 build; component renders nothing in every degraded state, matching the RecentFlows contract.

**Interfaces:**
- Consumes: `pickTrackedGoals`, `goalMovement`, `fmtUsdCompact`, `fmtRunTime` (Task 3); `/api/goals/impact/batch` (Task 2); `useCachedJson` from `@/lib/client/use-cached-json`; `useScope`, `ALL_SCOPE` from `@/lib/client/scoped-href`; `ScopedLink` from `@/components/ui/scoped-link`; `GoalSummary`, `ImpactTiers` types.
- Produces: `GoalsInFlight({ goals }: { goals: GoalSummary[] | null })` — rendered by HomeAssistant.

- [ ] **Step 1: Implement the component**

`src/app/(app)/g/[scope]/dashboard/goals-in-flight.tsx`:

```tsx
'use client'

import { useMemo } from 'react'
import { ScopedLink } from '@/components/ui/scoped-link'
import { ALL_SCOPE, useScope } from '@/lib/client/scoped-href'
import { useCachedJson } from '@/lib/client/use-cached-json'
import { cn } from '@/lib/utils'
import { pickTrackedGoals, goalMovement, fmtUsdCompact, fmtRunTime } from '@/lib/goals/tracked'
import type { ImpactTiers } from '@/lib/goals/impact'
import type { GoalSummary } from '@/lib/types'

const RISK_DOT: Record<GoalSummary['riskLevel'], string> = {
  on_track: 'bg-emerald-500',
  at_risk: 'bg-amber-500',
  off_track: 'bg-rose-500',
  no_data: 'border bg-transparent',
}

type BatchResponse = { success?: boolean; impact?: Record<string, ImpactTiers> }

/**
 * "Goals in flight" — the 3 most recently created active goals with the four
 * numbers: MOVED (measured metric movement), SPENT (AI cost), TIME (measured
 * run seconds), VALUE (estimated labor value, marked ~). Replaces the
 * RecentFlows strip. Renders nothing while loading, on error, with zero
 * active goals, or under a single-goal lens — that goal has a whole surface;
 * a "top 3" beside "View all" would read as a bug there. The impact fetch
 * failing degrades to — cells; the strip itself stays.
 */
export function GoalsInFlight({ goals }: { goals: GoalSummary[] | null }) {
  const scope = useScope()
  const tracked = useMemo(() => pickTrackedGoals(goals), [goals])
  // Sorted ids → stable cache key regardless of goal ordering changes.
  const ids = useMemo(() => tracked.map((goal) => goal.id).sort().join(','), [tracked])
  const { data } = useCachedJson<BatchResponse>(
    scope === ALL_SCOPE && ids ? `/api/goals/impact/batch?ids=${encodeURIComponent(ids)}` : null,
  )
  if (scope !== ALL_SCOPE || tracked.length === 0) return null
  const impact = data?.impact ?? {}
  const cell = (goalId: string, pick: (tiers: ImpactTiers) => string) => {
    const tiers = impact[goalId]
    return tiers ? pick(tiers) : '—'
  }
  return (
    <div className="mt-8">
      <div className="flex items-center justify-between px-1">
        <p className="text-xs font-medium text-muted-foreground">Goals in flight</p>
        <ScopedLink
          href="/goals"
          className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          View all →
        </ScopedLink>
      </div>
      <div className="mt-3 overflow-hidden rounded-xl border bg-card shadow-1">
        {/* Column header — hidden on mobile where rows stack their own labels */}
        <div className="hidden grid-cols-[1fr_repeat(4,5.5rem)] gap-2 border-b px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:grid">
          <span>Goal</span>
          <span className="text-right">Moved</span>
          <span className="text-right">Spent</span>
          <span className="text-right">Time</span>
          <span className="text-right" title="Estimated labor value">Value</span>
        </div>
        {tracked.map((goal) => {
          const moved = goalMovement(goal)
          return (
            <ScopedLink
              key={goal.id}
              href={`/goals/${goal.id}`}
              className="grid grid-cols-1 gap-1 border-b px-4 py-3 text-sm transition-colors last:border-b-0 hover:bg-accent sm:grid-cols-[1fr_repeat(4,5.5rem)] sm:gap-2"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden
                  className={cn('h-2 w-2 shrink-0 rounded-full', RISK_DOT[goal.riskLevel])}
                />
                <span className="truncate font-medium">{goal.name}</span>
              </span>
              <Metric label="Moved" value={moved.text} tone={moved.favorable} />
              <Metric label="Spent" value={cell(goal.id, (t) => fmtUsdCompact(t.estimated.aiCostUsd))} />
              <Metric label="Time" value={cell(goal.id, (t) => fmtRunTime(t.measured.aiRunSecondsTotal))} />
              <Metric label="Value" value={cell(goal.id, (t) => `~${fmtUsdCompact(t.estimated.laborValueUsd)}`)} />
            </ScopedLink>
          )
        })}
      </div>
    </div>
  )
}

/** One number cell: right-aligned on desktop, label/value pair on mobile. */
function Metric({ label, value, tone }: { label: string; value: string; tone?: boolean | null }) {
  return (
    <span className="flex items-baseline justify-between tabular-nums sm:justify-end">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground sm:hidden">{label}</span>
      <span
        className={cn(
          tone === true && 'text-emerald-600',
          tone === false && 'text-rose-600',
          tone == null && 'text-foreground',
        )}
      >
        {value}
      </span>
    </span>
  )
}
```

- [ ] **Step 2: Swap in HomeAssistant and delete RecentFlows**

In `src/app/(app)/g/[scope]/dashboard/home-assistant.tsx`:
- Line 27: replace `import { RecentFlows } from './recent-flows'` with `import { GoalsInFlight } from './goals-in-flight'`.
- Line ~708: replace the comment + render:

```tsx
            {/* The 3 most recent goals in flight — only while the composer is
                untouched, so a drafted message keeps the screen. Replaced the
                recent-flows strip (2026-08-14): Home leads with outcomes, not
                artifacts. */}
            {input.trim() === '' && <GoalsInFlight goals={allGoals} />}
```

(`allGoals`, not the lens-filtered `goals` — the component makes its own lens decision via `useScope`, and the strip must see all goals under the all lens.)

Then delete the orphans:

```bash
git rm src/app/\(app\)/g/\[scope\]/dashboard/recent-flows.tsx src/lib/flows/recent.ts src/lib/flows/__tests__/recent.test.ts
```

- [ ] **Step 3: Verify nothing else references the deleted modules**

Run: `rg -n "RecentFlows|flows/recent|pickRecentFlows" src --glob '!node_modules'`
Expected: no matches.

- [ ] **Step 4: Typecheck + lint the touched surface**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean (or only pre-existing warnings; the ESLint a11y ratchet must not gain new entries).

- [ ] **Step 5: Commit**

```bash
git add -A src/app/\(app\)/g/\[scope\]/dashboard src/lib/flows
git commit -m "feat(home): goals-in-flight strip replaces recent flows"
```

---

### Task 5: Full verification

**Files:** none new.

- [ ] **Step 1: Full unit suite**

Run: `npm test`
Expected: PASS (including the deleted recent.test.ts no longer running).

- [ ] **Step 2: Route tests against throwaway Postgres**

Per the `verify` skill: start the throwaway Postgres, run the pg-guarded tests:
`TEST_DATABASE_URL=<url> npx tsx --test src/app/api/goals/__tests__/impact-batch-route.pg.test.ts`
Expected: PASS.

- [ ] **Step 3: Build**

Run: `npx next build`
Expected: success; `/g/[scope]/dashboard` compiles with the new component.

- [ ] **Step 4: Commit any stragglers, no-op otherwise**

```bash
git status --short
```
