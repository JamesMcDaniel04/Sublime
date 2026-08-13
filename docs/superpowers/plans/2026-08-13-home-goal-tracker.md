# Home Goals-in-Flight Mini Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A compact per-goal log on Home — the 3 most recently created active goals with movement, AI cost, run time, and estimated value — backed by a flat 3-query batch loader.

**Architecture:** A pure bucketing function (`batchImpactOf`) reuses the existing tested `flowRunStatsOf`/`agentRunStatsOf`/`computeImpact` pipeline; `goalImpactBatch` feeds it from 3 queries. A capped, visibility-filtered route exposes it. A pure client module picks/formats goals; a small client component renders labelled columns in the Home hero above RecentFlows, all-goals lens only.

**Tech Stack:** Next.js app router, Prisma, node:test via tsx, Tailwind.

**Spec:** `docs/superpowers/specs/2026-08-13-home-goal-tracker-design.md` — read it first.

## Global Constraints

- Test command shape: `TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test <file>` (node:test + `assert/strict`, matching existing tests).
- Route smoke tests are gated on `TEST_DATABASE_URL` exactly like `src/app/api/__tests__/credentials-route-smoke.test.ts`.
- 404-not-403 discipline: invisible goals are silently dropped, never denied.
- MOVED coloring is by direction agreement, never raw sign. Percent deltas render as `pp`, never through `fmtValue`.
- The strip renders ONLY under the all-goals lens and ONLY while the composer is empty.
- Commit after each task.

---

### Task 1: Pure client module — `pickTrackedGoals` + `goalMovement`

**Files:**
- Modify: `src/components/goals/chart-math.ts` (export the private `compact`)
- Create: `src/lib/goals/tracked.ts`
- Test: `src/lib/goals/__tests__/tracked.test.ts`

**Interfaces:**
- Consumes: `compact(value: number): string` from chart-math (currently private — add `export`).
- Produces:
  - `TRACKED_GOALS_LIMIT = 3`
  - `pickTrackedGoals<T extends { status: string; startAt: string }>(goals: T[] | null | undefined): T[]`
  - `goalMovement(goal: { currentValue: number | null; startValue: number; unit: 'usd' | 'count' | 'percent'; direction: 'increase' | 'decrease' }): { text: string; favorable: boolean | null }`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/goals/__tests__/tracked.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { goalMovement, pickTrackedGoals } from '../tracked'

const goal = (over: Partial<Parameters<typeof goalMovement>[0]> = {}) => ({
  currentValue: 150 as number | null,
  startValue: 100,
  unit: 'usd' as const,
  direction: 'increase' as const,
  ...over,
})

test('pickTrackedGoals: active only, newest startAt first, capped at 3', () => {
  const rows = [
    { id: 'a', status: 'active', startAt: '2026-08-01T00:00:00Z' },
    { id: 'b', status: 'archived', startAt: '2026-08-10T00:00:00Z' },
    { id: 'c', status: 'active', startAt: '2026-08-05T00:00:00Z' },
    { id: 'd', status: 'active', startAt: '2026-08-09T00:00:00Z' },
    { id: 'e', status: 'active', startAt: '2026-07-01T00:00:00Z' },
  ]
  assert.deepEqual(pickTrackedGoals(rows).map((row) => row.id), ['d', 'c', 'a'])
})

test('pickTrackedGoals tolerates missing input', () => {
  assert.deepEqual(pickTrackedGoals(undefined), [])
  assert.deepEqual(pickTrackedGoals(null), [])
})

test('goalMovement: usd gain on an increase goal is favorable', () => {
  assert.deepEqual(goalMovement(goal({ currentValue: 242_000, startValue: 100_000 })), {
    text: '+$142k',
    favorable: true,
  })
})

test('goalMovement: negative delta on a decrease goal is favorable', () => {
  const moved = goalMovement(goal({ unit: 'count', direction: 'decrease', currentValue: 60, startValue: 400 }))
  assert.equal(moved.text, '−340')
  assert.equal(moved.favorable, true)
})

test('goalMovement: percent deltas render as percentage points', () => {
  // Stored percent values are fractions (fmtValue multiplies by 100).
  const moved = goalMovement(goal({ unit: 'percent', direction: 'decrease', currentValue: 0.03, startValue: 0.042 }))
  assert.equal(moved.text, '−1.2pp')
  assert.equal(moved.favorable, true)
})

test('goalMovement: gain on a decrease goal is unfavorable', () => {
  assert.equal(goalMovement(goal({ direction: 'decrease' })).favorable, false)
})

test('goalMovement: null current renders an em dash with no verdict', () => {
  assert.deepEqual(goalMovement(goal({ currentValue: null })), { text: '—', favorable: null })
})

test('goalMovement: zero delta is neutral', () => {
  assert.deepEqual(goalMovement(goal({ currentValue: 100 })), { text: '±0', favorable: null })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test src/lib/goals/__tests__/tracked.test.ts`
Expected: FAIL — cannot find module `../tracked`.

- [ ] **Step 3: Export `compact` from chart-math**

In `src/components/goals/chart-math.ts`, change `function compact(` to `export function compact(` (the doc stays with it; no other change).

- [ ] **Step 4: Write the implementation**

```ts
// src/lib/goals/tracked.ts
/**
 * Selection + formatting for the Home "Goals in flight" strip.
 * Pure (no React, no fetch) so it is directly unit-testable — the
 * lib/flows/recent.ts pattern.
 */
import { compact } from '@/components/goals/chart-math'

/** Rows shown on the Home strip. */
export const TRACKED_GOALS_LIMIT = 3

/** The slice of GoalSummary the selection reads. */
export type TrackedGoalInput = {
  status: string
  /** Creation-time proxy: GoalSummary carries no createdAt, and startAt
   *  defaults to now() at creation. */
  startAt: string
}

/** The 3 most recently created active goals. */
export function pickTrackedGoals<T extends TrackedGoalInput>(
  goals: T[] | null | undefined,
): T[] {
  if (!Array.isArray(goals)) return []
  return goals
    .filter((goal) => goal.status === 'active')
    .sort((a, b) => Date.parse(b.startAt) - Date.parse(a.startAt))
    .slice(0, TRACKED_GOALS_LIMIT)
}

/**
 * The goal's movement since it was set, as display text plus a verdict.
 *
 * Not fmtValue: that formats LEVELS (percent × 100 with a % sign), and a
 * delta on a percent goal is percentage POINTS — "−1.2pp", not "−1.2%".
 * `favorable` compares the delta against the goal's direction, never raw
 * sign — a drop on a churn/savings goal is a win and must render as one.
 * Null when there is nothing to judge (no data yet, or no movement).
 */
export function goalMovement(goal: {
  currentValue: number | null
  startValue: number
  unit: 'usd' | 'count' | 'percent'
  direction: 'increase' | 'decrease'
}): { text: string; favorable: boolean | null } {
  if (goal.currentValue === null) return { text: '—', favorable: null }
  const delta = goal.currentValue - goal.startValue
  if (delta === 0) return { text: '±0', favorable: null }
  const sign = delta > 0 ? '+' : '−'
  const magnitude = Math.abs(delta)
  const body =
    goal.unit === 'percent'
      ? `${Number((magnitude * 100).toFixed(1))}pp`
      : goal.unit === 'usd'
        ? `$${compact(magnitude)}`
        : compact(magnitude)
  return {
    text: `${sign}${body}`,
    favorable: goal.direction === 'increase' ? delta > 0 : delta < 0,
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test src/lib/goals/__tests__/tracked.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/goals/tracked.ts src/lib/goals/__tests__/tracked.test.ts src/components/goals/chart-math.ts
git commit -m "feat(goals): pure selection + movement formatting for the Home tracker"
```

---

### Task 2: Batched per-goal impact — `batchImpactOf` + `goalImpactBatch`

**Files:**
- Modify: `src/lib/goals/impact.ts` (append; nothing existing changes)
- Test: `src/lib/goals/__tests__/impact.test.ts` (append)

**Interfaces:**
- Consumes: existing `flowRunStatsOf`, `agentRunStatsOf`, `computeImpact`, `settingsFor`, `ImpactTiers`, `prisma` — all already in `impact.ts`.
- Produces:
  - `batchImpactOf(inputs: { goalIds: string[]; contributions: Array<{ goalId: string; resourceType: string; resourceId: string; estimatedMinutesSavedPerRun: number; createdAt: Date }>; flowRuns: Array<{ flowId: string; startedAt: Date; finishedAt: Date | null }>; agentRuns: Array<{ agentTaskId: string | null; startedAt: Date; inputTokens: number; outputTokens: number; executionTime: number | null }>; hourlyRateUsd: number; aiCostPerMTokensUsd: number }): Map<string, ImpactTiers>` — pure, exported.
  - `goalImpactBatch(organizationId: string, goalIds: string[]): Promise<Map<string, ImpactTiers>>`

- [ ] **Step 1: Write the failing tests (append to impact.test.ts)**

```ts
test('batchImpactOf: runs before a contribution createdAt never count, even past the batch min', async () => {
  const { batchImpactOf } = await import('../impact')
  const jan1 = new Date('2026-01-01T00:00:00Z')
  const feb1 = new Date('2026-02-01T00:00:00Z')
  const run = (start: Date, seconds: number) => ({
    flowId: 'flow-late',
    startedAt: start,
    finishedAt: new Date(start.getTime() + seconds * 1000),
  })
  const impact = batchImpactOf({
    goalIds: ['g-early', 'g-late'],
    contributions: [
      { goalId: 'g-early', resourceType: 'flow', resourceId: 'flow-early', estimatedMinutesSavedPerRun: 30, createdAt: jan1 },
      { goalId: 'g-late', resourceType: 'flow', resourceId: 'flow-late', estimatedMinutesSavedPerRun: 30, createdAt: feb1 },
    ],
    flowRuns: [
      // Jan 15: after the batch min (jan1) but BEFORE g-late's own cutoff.
      run(new Date('2026-01-15T00:00:00Z'), 60),
      // Feb 10: counts for g-late.
      run(new Date('2026-02-10T00:00:00Z'), 40),
    ],
    agentRuns: [],
    hourlyRateUsd: 50,
    aiCostPerMTokensUsd: 10,
  })
  assert.equal(impact.get('g-late')!.measured.runsCompleted, 1)
  assert.equal(impact.get('g-late')!.measured.aiRunSecondsTotal, 40)
})

test('batchImpactOf: agent tokens roll into cost; goals without contributions get the zero shape', async () => {
  const { batchImpactOf } = await import('../impact')
  const jan1 = new Date('2026-01-01T00:00:00Z')
  const impact = batchImpactOf({
    goalIds: ['g-agent', 'g-empty'],
    contributions: [
      { goalId: 'g-agent', resourceType: 'agent', resourceId: 'task-1', estimatedMinutesSavedPerRun: 60, createdAt: jan1 },
    ],
    flowRuns: [],
    agentRuns: [
      { agentTaskId: 'task-1', startedAt: new Date('2026-01-02T00:00:00Z'), inputTokens: 600_000, outputTokens: 400_000, executionTime: 90_000 },
      // Different task — must not leak into task-1's contribution.
      { agentTaskId: 'task-2', startedAt: new Date('2026-01-02T00:00:00Z'), inputTokens: 9_000_000, outputTokens: 0, executionTime: 1 },
    ],
    hourlyRateUsd: 50,
    aiCostPerMTokensUsd: 10,
  })
  const agent = impact.get('g-agent')!
  assert.equal(agent.measured.runsCompleted, 1)
  assert.equal(agent.measured.tokens, 1_000_000)
  assert.equal(agent.measured.aiRunSecondsTotal, 90)
  assert.equal(agent.estimated.aiCostUsd, 10)
  assert.equal(agent.estimated.hoursSaved, 1)
  assert.equal(agent.correlated.paceDeltaPct, null)
  const empty = impact.get('g-empty')!
  assert.equal(empty.measured.runsCompleted, 0)
  assert.equal(empty.estimated.laborValueUsd, 0)
})
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test src/lib/goals/__tests__/impact.test.ts`
Expected: the two new tests FAIL (`batchImpactOf` is not exported); existing tests still pass.

- [ ] **Step 3: Implement (append to `src/lib/goals/impact.ts`)**

```ts
/** Pure core of goalImpactBatch: pre-fetched rows → per-goal tiers.
 *
 *  The SQL cutoff is the EARLIEST contribution createdAt across the batch, so
 *  each contribution re-applies its own `startedAt > createdAt` here — a run
 *  after the batch min but before this contribution's cutoff must not count.
 *  Every requested goalId gets an entry (zero tiers when uncontributed) so
 *  callers never special-case absence. Pace tiers stay per-goal-page only. */
export function batchImpactOf(inputs: {
  goalIds: string[]
  contributions: Array<{
    goalId: string
    resourceType: string
    resourceId: string
    estimatedMinutesSavedPerRun: number
    createdAt: Date
  }>
  flowRuns: Array<{ flowId: string; startedAt: Date; finishedAt: Date | null }>
  agentRuns: Array<{
    agentTaskId: string | null
    startedAt: Date
    inputTokens: number
    outputTokens: number
    executionTime: number | null
  }>
  hourlyRateUsd: number
  aiCostPerMTokensUsd: number
}): Map<string, ImpactTiers> {
  const statsFor = (contribution: (typeof inputs.contributions)[number]) => {
    const after = (startedAt: Date) => startedAt.getTime() > contribution.createdAt.getTime()
    if (contribution.resourceType === 'flow') {
      return flowRunStatsOf(
        inputs.flowRuns.filter((run) => run.flowId === contribution.resourceId && after(run.startedAt)),
      )
    }
    if (contribution.resourceType === 'agent') {
      return agentRunStatsOf(
        inputs.agentRuns.filter((run) => run.agentTaskId === contribution.resourceId && after(run.startedAt)),
      )
    }
    return { runs: 0, tokens: 0, measuredRunSeconds: { total: 0, avg: null } }
  }
  return new Map(
    inputs.goalIds.map((goalId) => [
      goalId,
      computeImpact({
        contributions: inputs.contributions
          .filter((contribution) => contribution.goalId === goalId)
          .map((contribution) => ({
            estimatedMinutesSavedPerRun: contribution.estimatedMinutesSavedPerRun,
            ...statsFor(contribution),
          })),
        hourlyRateUsd: inputs.hourlyRateUsd,
        aiCostPerMTokensUsd: inputs.aiCostPerMTokensUsd,
        paceBefore: null,
        paceAfter: null,
      }),
    ]),
  )
}

/** Per-goal impact for a small batch of goals in a FLAT number of queries
 *  (contributions, flow runs, agent runs — 3, regardless of goal count).
 *  Built for Home's strip: the per-goal goalImpact() is an N+1 over
 *  contributions plus a datapoint read, which is exactly what got the last
 *  impact line removed from Home. No metricDatapoint reads here at all. */
export async function goalImpactBatch(
  organizationId: string,
  goalIds: string[],
): Promise<Map<string, ImpactTiers>> {
  if (goalIds.length === 0) return new Map()
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
  const minCreatedAt = contributions.reduce(
    (min, contribution) => (contribution.createdAt < min ? contribution.createdAt : min),
    contributions[0]?.createdAt ?? new Date(),
  )
  const flowIds = contributions
    .filter((contribution) => contribution.resourceType === 'flow')
    .map((contribution) => contribution.resourceId)
  const agentIds = contributions
    .filter((contribution) => contribution.resourceType === 'agent')
    .map((contribution) => contribution.resourceId)
  const [flowRuns, agentRuns] = await Promise.all([
    flowIds.length === 0
      ? []
      : prisma.flowRun.findMany({
          where: {
            organizationId,
            flowId: { in: flowIds },
            status: 'succeeded',
            startedAt: { gt: minCreatedAt },
          },
          select: { flowId: true, startedAt: true, finishedAt: true },
        }),
    agentIds.length === 0
      ? []
      : prisma.agentExecution.findMany({
          where: {
            organizationId,
            agentTaskId: { in: agentIds },
            completedAt: { not: null },
            error: null,
            startedAt: { gt: minCreatedAt },
          },
          select: {
            agentTaskId: true,
            startedAt: true,
            inputTokens: true,
            outputTokens: true,
            executionTime: true,
          },
        }),
  ])
  return batchImpactOf({ goalIds, contributions, flowRuns, agentRuns, ...settings })
}
```

- [ ] **Step 4: Run to verify all impact tests pass**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test src/lib/goals/__tests__/impact.test.ts`
Expected: PASS, including all pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/goals/impact.ts src/lib/goals/__tests__/impact.test.ts
git commit -m "feat(goals): flat batched per-goal impact loader"
```

---

### Task 3: Route — `GET /api/goals/impact/batch`

**Files:**
- Create: `src/app/api/goals/impact/batch/route.ts`
- Test: `src/app/api/__tests__/goal-impact-batch-smoke.test.ts`

**Interfaces:**
- Consumes: `goalImpactBatch` (Task 2), `goalReadWhere` from `@/lib/server/goal-scope`, `withAuthenticatedApi`/`ApiError` from `@/lib/server/api-handler`.
- Produces: `GET /api/goals/impact/batch?ids=a,b,c` → `{ success: true, impact: Record<goalId, ImpactTiers> }`. Invisible ids absent from `impact`; 0 or >3 ids → 400.

- [ ] **Step 1: Write the failing smoke test**

```ts
// src/app/api/__tests__/goal-impact-batch-smoke.test.ts
/**
 * Batch impact against a real Postgres. The invariant: the batch never
 * aggregates a goal the caller cannot see — invisible ids are silently
 * ABSENT (never 403), the confidential-goal rule.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) {
  test('skipped: TEST_DATABASE_URL not set', { skip: true }, () => {})
} else {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: typeof import('@/lib/prisma').prisma
  let seeded: { organizationId: string; userId: string; auth: unknown; cleanup: () => Promise<void> }
  const goalIds: Record<string, string> = {}

  const makeGoal = async (over: Record<string, unknown> = {}) => {
    const goal = await prisma.goal.create({
      data: {
        organizationId: seeded.organizationId,
        name: `Goal ${crypto.randomUUID().slice(0, 8)}`,
        kind: 'kpi',
        unit: 'count',
        startValue: 0,
        targetValue: 100,
        targetDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        ...over,
      },
      select: { id: true },
    })
    return goal.id
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const testAuth = await import('@/lib/server/__tests__/test-auth')
    // MEMBER, deliberately: an admin sees restricted org goals, which would
    // make the restricted-goal assertion pass for the wrong reason.
    seeded = (await testAuth.seedTestOrg(prisma, { role: 'MEMBER' })) as typeof seeded
    ;(testAuth.installTestAuth as (auth: unknown) => void)(seeded.auth)

    const stranger = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId, isActive: true, role: 'MEMBER' },
    })
    goalIds.visible = await makeGoal()
    goalIds.restricted = await makeGoal({ access: 'restricted' })
    goalIds.personal = await makeGoal({ ownerUserId: stranger.id })
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  const get = async (ids: string) => {
    const { GET } = await import('@/app/api/goals/impact/batch/route')
    return GET(new NextRequest(new URL(`http://test/api/goals/impact/batch?ids=${ids}`)) as never)
  }

  test('a visible goal returns zero-shaped tiers; invisible goals are absent, not denied', async () => {
    const response = await get([goalIds.visible, goalIds.restricted, goalIds.personal].join(','))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(Object.keys(body.impact), [goalIds.visible])
    assert.equal(body.impact[goalIds.visible].measured.runsCompleted, 0)
    assert.equal(body.impact[goalIds.visible].estimated.laborValueUsd, 0)
  })

  test('more than 3 ids is a 400', async () => {
    const response = await get(['a', 'b', 'c', 'd'].join(','))
    assert.equal(response.status, 400)
  })

  test('no ids is a 400', async () => {
    const response = await get('')
    assert.equal(response.status, 400)
  })
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `TEST_DATABASE_URL=<qa-or-local-pg-url> TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test src/app/api/__tests__/goal-impact-batch-smoke.test.ts`
Expected: FAIL — cannot find the route module. (Without `TEST_DATABASE_URL` it skips; use the `verify` skill's throwaway Postgres if no URL is at hand.)

- [ ] **Step 3: Implement the route**

```ts
// src/app/api/goals/impact/batch/route.ts
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { goalReadWhere } from '@/lib/server/goal-scope'
import { goalImpactBatch } from '@/lib/goals/impact'
import { TRACKED_GOALS_LIMIT } from '@/lib/goals/tracked'

export const runtime = 'nodejs'

/**
 * Per-goal impact tiers for Home's "Goals in flight" strip. Capped at the
 * strip's size and loaded flat (goalImpactBatch is 3 queries regardless of
 * goal count) — the org-wide /api/goals/impact stays the N+1 it always was
 * and stays OFF Home. Ids the caller may not see are silently dropped:
 * absent, never 403, because a 403 confirms a confidential goal exists.
 */
export const GET = withAuthenticatedApi(async (request, auth) => {
  const ids = (new URL(request.url).searchParams.get('ids') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  if (ids.length === 0 || ids.length > TRACKED_GOALS_LIMIT) {
    throw new ApiError(`Provide 1–${TRACKED_GOALS_LIMIT} goal ids.`, 400, 'BAD_REQUEST')
  }
  const visible = await prisma.goal.findMany({
    where: {
      id: { in: ids },
      organizationId: auth.organizationId,
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

- [ ] **Step 4: Run to verify the smoke test passes**

Run: `TEST_DATABASE_URL=<url> TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test src/app/api/__tests__/goal-impact-batch-smoke.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/goals/impact/batch/route.ts src/app/api/__tests__/goal-impact-batch-smoke.test.ts
git commit -m "feat(goals): capped, visibility-filtered batch impact route"
```

---

### Task 4: UI — `goals-in-flight.tsx` + Home wiring

**Files:**
- Create: `src/app/(app)/g/[scope]/dashboard/goals-in-flight.tsx`
- Modify: `src/app/(app)/g/[scope]/dashboard/home-assistant.tsx` (two lines: import + render above `<RecentFlows />`)
- Modify: `src/components/goals/impact-strip.tsx` (export the private `formatDuration`)

**Interfaces:**
- Consumes: `pickTrackedGoals`/`goalMovement` (Task 1), `/api/goals/impact/batch` (Task 3), `ImpactTiers` type from `@/components/goals/impact-strip`, `formatDuration` (export it: change `function formatDuration(` to `export function formatDuration(`), `useCachedJson`, `ScopedLink`, `useScope`/`ALL_SCOPE` from `@/lib/client/scoped-href`, `GoalSummary` from `@/lib/types`, `cn` from `@/lib/utils`.
- Produces: `GoalsInFlight({ goals }: { goals: GoalSummary[] | null })` — renders nothing under a goal lens, while goals are null, or with zero active goals.

- [ ] **Step 1: Write the component**

```tsx
// src/app/(app)/g/[scope]/dashboard/goals-in-flight.tsx
'use client'

import { useMemo } from 'react'
import { ScopedLink } from '@/components/ui/scoped-link'
import { ALL_SCOPE, useScope } from '@/lib/client/scoped-href'
import { useCachedJson } from '@/lib/client/use-cached-json'
import { formatDuration, type ImpactTiers } from '@/components/goals/impact-strip'
import { goalMovement, pickTrackedGoals } from '@/lib/goals/tracked'
import type { GoalSummary } from '@/lib/types'
import { cn } from '@/lib/utils'

type BatchResponse = { impact?: Record<string, ImpactTiers> }

/** Same palette as the goal card's hairline, as dots. */
const RISK_DOT: Record<GoalSummary['riskLevel'], string> = {
  on_track: 'bg-emerald-500',
  at_risk: 'bg-amber-500',
  off_track: 'bg-rose-500',
  no_data: 'bg-border',
}

const COLUMNS = [
  { key: 'moved', label: 'Moved', title: 'Goal movement since it was set' },
  { key: 'spent', label: 'Spent', title: 'AI cost of linked runs (tokens × workspace rate)' },
  { key: 'time', label: 'Time', title: 'Measured AI run time' },
  { key: 'value', label: 'Value', title: 'Estimated: hours saved × workspace hourly rate' },
] as const

/**
 * "Goals in flight" — a mini log of the 3 newest active goals with movement,
 * AI spend, run time, and estimated value. Home once had a goal strip and an
 * org-wide impact line and both were removed (the impact endpoint is an N+1;
 * the lens made the strip redundant) — this differs on both counts: the
 * batch route is 3 queries flat, and the strip renders ONLY under the
 * all-goals lens, where no goal surface is one click away. Renders nothing
 * while loading, on error, or with no active goals — it is a shortcut, not a
 * source of truth; /goals owns errors and empty states.
 */
export function GoalsInFlight({ goals }: { readonly goals: GoalSummary[] | null }) {
  const scope = useScope()
  const tracked = useMemo(() => pickTrackedGoals(goals), [goals])
  // Sorted ids → stable cache key regardless of arrival order.
  const ids = useMemo(() => tracked.map((goal) => goal.id).sort().join(','), [tracked])
  const { data } = useCachedJson<BatchResponse>(
    scope === ALL_SCOPE && ids ? `/api/goals/impact/batch?ids=${encodeURIComponent(ids)}` : null,
  )
  if (scope !== ALL_SCOPE || tracked.length === 0) return null
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
        {/* Column header — hidden on mobile, where rows stack their labels. */}
        <div className="hidden grid-cols-[minmax(0,1fr)_repeat(4,minmax(72px,auto))] gap-x-4 border-b px-4 py-2 sm:grid">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Goal</span>
          {COLUMNS.map((column) => (
            <span
              key={column.key}
              title={column.title}
              className="text-right text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
            >
              {column.label}
            </span>
          ))}
        </div>
        {tracked.map((goal) => {
          const impact = data?.impact?.[goal.id]
          const moved = goalMovement(goal)
          const cells = [
            {
              key: 'moved',
              text: moved.text,
              tone:
                moved.favorable === null
                  ? 'text-foreground'
                  : moved.favorable
                    ? 'text-emerald-600'
                    : 'text-rose-600',
            },
            {
              key: 'spent',
              text: impact ? `$${impact.estimated.aiCostUsd.toFixed(2)}` : '—',
              tone: 'text-foreground',
            },
            {
              key: 'time',
              text: impact ? formatDuration(impact.measured.aiRunSecondsTotal) : '—',
              tone: 'text-foreground',
            },
            {
              key: 'value',
              text: impact ? `$${Math.round(impact.estimated.laborValueUsd).toLocaleString()}` : '—',
              tone: 'text-foreground',
            },
          ]
          return (
            <ScopedLink
              key={goal.id}
              href={`/goals/${goal.id}`}
              className="grid grid-cols-1 gap-x-4 gap-y-1 border-b px-4 py-2.5 text-sm transition-colors last:border-b-0 hover:bg-accent/50 sm:grid-cols-[minmax(0,1fr)_repeat(4,minmax(72px,auto))] sm:items-center"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', RISK_DOT[goal.riskLevel])} />
                <span className="truncate font-medium">{goal.name}</span>
              </span>
              {cells.map((cell) => (
                <span
                  key={cell.key}
                  className={cn('font-mono text-xs tabular-nums sm:text-right', cell.tone)}
                >
                  <span className="mr-1.5 text-[10px] uppercase tracking-wide text-muted-foreground sm:hidden">
                    {COLUMNS.find((column) => column.key === cell.key)!.label}
                  </span>
                  {cell.text}
                </span>
              ))}
            </ScopedLink>
          )
        })}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Export `formatDuration` from impact-strip**

In `src/components/goals/impact-strip.tsx`, change `function formatDuration(` to `export function formatDuration(`.

- [ ] **Step 3: Wire into home-assistant.tsx**

Add the import next to the RecentFlows import:

```tsx
import { GoalsInFlight } from './goals-in-flight'
```

Change the hero render (currently `{input.trim() === '' && <RecentFlows />}`) to:

```tsx
            {/* Quick jumps back into recent flow canvases — only while the
                composer is untouched, so a drafted message keeps the screen. */}
            {input.trim() === '' && (
              <>
                {/* allGoals, not the lens-filtered `goals`: the strip refuses
                    to render under a goal lens itself, and feeding it the
                    filtered list would show one row next to "View all". */}
                <GoalsInFlight goals={allGoals} />
                <RecentFlows />
              </>
            )}
```

- [ ] **Step 4: Verify — typecheck, lint, full unit suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass (smoke tests skip without `TEST_DATABASE_URL`).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/g/[scope]/dashboard/goals-in-flight.tsx" "src/app/(app)/g/[scope]/dashboard/home-assistant.tsx" src/components/goals/impact-strip.tsx
git commit -m "feat(home): goals-in-flight mini tracker above recent flows"
```

---

### Task 5: End-to-end verification

**Files:** none new.

- [ ] **Step 1: Run the smoke tests against a real Postgres**

Use the `verify` skill's throwaway-Postgres protocol if no `TEST_DATABASE_URL` is at hand. Run at minimum:

```bash
TEST_DATABASE_URL=<url> TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test \
  src/app/api/__tests__/goal-impact-batch-smoke.test.ts \
  src/lib/goals/__tests__/impact.test.ts \
  src/lib/goals/__tests__/tracked.test.ts
```

Expected: PASS.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean build, bundle budget passes.

- [ ] **Step 3: Commit anything outstanding**

Only if fixes were needed; otherwise nothing to do.
