# Goal Work Ledger and Workroom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every unit of work an agent does toward a goal — what it produced, for whom, what a human did with it, and whether it landed — and make the goal page the place that work happens.

**Architecture:** A new `GoalWork` table holds one row per subject (not per run), with `disposition` (what a human did, captured by the act itself) held separate from `outcome` (whether it landed). Two new tools on the existing goals tool plane let agents write and read it, inheriting the plane's existing authorization with no new surface. The goal page gains a workroom above the dashboard where clicking Copy/Edit/Skip *is* the disposition write.

**Tech Stack:** Next.js App Router, Prisma + Postgres, TypeScript, `node:test` + `tsx`, `@testing-library/react` with `@/test-support/jsdom-env`, Zod, Tailwind.

**Spec:** `docs/superpowers/specs/2026-07-28-goal-work-ledger-design.md`

## Global Constraints

- Test runner: `npm test`. Single file: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <path>`.
- Typecheck `npm run typecheck`; lint `npm run lint`.
- **One row per subject**, never one per run. `runId` groups a batch; it is not the unit.
- **`disposition` and `outcome` are never conflated.** Disposition is what a human did; outcome is whether it landed.
- **`outcome` may only be set on `used` or `edited`.** A skipped item was never sent, so an outcome on it would corrupt the funnel denominator.
- **`log_work` carries no write policy.** `agent-tool-policy.ts` guards `log_datapoint` because a system of record owns the number. Work has no system of record — the agent is the author. Never gate `log_work` on `AGENT_WRITABLE_SOURCES`.
- Dedupe is a **partial** unique index — raw SQL in the migration, never `@@unique` in `schema.prisma`.
- Agent-supplied `assigneeHint` that resolves to nobody yields `assigneeUserId: null`. It must never fail the run.
- Funnel copy says "used" and "worked", never "caused" — these counts are descriptive, not causal.
- Queries in tests must include `organizationId`; `src/lib/tenant-guard.ts` throws on unscoped org-model queries.
- `GoalsToolClient` stays database-free — all I/O goes through `GoalsDataPort`.

**Note on `runId`:** the plane loader (`tool-planes.ts:212`) has `{ providers, resource }` and no execution id, so v1 writes `runId: null`. The column ships anyway so batch grouping stays available without a later migration. This is a deliberate scope decision, not an oversight.

---

### Task 1: `GoalWork` schema and migration

**Files:**
- Modify: `prisma/schema.prisma` (new model + back-relations on `Goal` and `Organization`)
- Create: `prisma/migrations/20260728160000_goal_work_ledger/migration.sql`
- Test: `src/lib/goals/__tests__/goal-work-index.pg.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the `goal_work` table and Prisma model `GoalWork`.

- [ ] **Step 1: Add the model to `schema.prisma`**

```prisma
/// One unit of work an agent or flow did toward a goal — one row per SUBJECT
/// (deal, lead, account), never one per run. `disposition` records what a
/// human did with it; `outcome` records whether it landed. They are separate
/// on purpose: "a person used the draft" and "it moved the goal" are
/// different facts, and merging them would make the funnel unreadable.
model GoalWork {
  id             String    @id @default(cuid())
  organizationId String    @db.Uuid
  goalId         String

  /// Provenance. runId is an AgentExecution.id or FlowRun.id depending on
  /// resourceType — deliberately not an FK, because work outlives run pruning.
  resourceType   String
  resourceId     String
  runId          String?

  subject        String
  /// Stable external id. The dedupe key; null means this row is never deduped.
  subjectRef     String?
  produced       String
  body           String?   @db.Text
  bodyFormat     String    @default("markdown")

  assigneeUserId String?   @db.Uuid

  disposition    String    @default("pending")
  dispositionBy  String?   @db.Uuid
  dispositionAt  DateTime? @db.Timestamptz(6)
  skipReason     String?

  outcome        String    @default("unknown")
  outcomeSource  String?
  outcomeNote    String?
  outcomeAt      DateTime? @db.Timestamptz(6)

  createdAt      DateTime  @default(now()) @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  goal         Goal         @relation(fields: [goalId], references: [id], onDelete: Cascade)

  @@index([organizationId, goalId, disposition])
  @@index([goalId, assigneeUserId, disposition])
  @@index([goalId, resourceId])
  @@map("goal_work")
}
```

Add `goalWork GoalWork[]` to both the `Goal` model and the `Organization` model. Without both back-relations `prisma generate` fails.

- [ ] **Step 2: Write the migration**

Create `prisma/migrations/20260728160000_goal_work_ledger/migration.sql`:

```sql
CREATE TABLE "goal_work" (
    "id"             TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "goalId"         TEXT NOT NULL,
    "resourceType"   TEXT NOT NULL,
    "resourceId"     TEXT NOT NULL,
    "runId"          TEXT,
    "subject"        TEXT NOT NULL,
    "subjectRef"     TEXT,
    "produced"       TEXT NOT NULL,
    "body"           TEXT,
    "bodyFormat"     TEXT NOT NULL DEFAULT 'markdown',
    "assigneeUserId" UUID,
    "disposition"    TEXT NOT NULL DEFAULT 'pending',
    "dispositionBy"  UUID,
    "dispositionAt"  TIMESTAMPTZ(6),
    "skipReason"     TEXT,
    "outcome"        TEXT NOT NULL DEFAULT 'unknown',
    "outcomeSource"  TEXT,
    "outcomeNote"    TEXT,
    "outcomeAt"      TIMESTAMPTZ(6),
    "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "goal_work_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "goal_work_organizationId_goalId_disposition_idx"
    ON "goal_work"("organizationId", "goalId", "disposition");
CREATE INDEX "goal_work_goalId_assigneeUserId_disposition_idx"
    ON "goal_work"("goalId", "assigneeUserId", "disposition");
CREATE INDEX "goal_work_goalId_resourceId_idx"
    ON "goal_work"("goalId", "resourceId");

-- One PENDING item per subject per goal (partial unique — migration-managed,
-- not expressible in schema.prisma). Without it a daily agent redrafts the
-- same subjects every morning and the queue is unusable. Once an item is
-- dispositioned the subject is free again, which is correct for a deal that
-- stalls twice. Same discipline as goal_recovery_plans_one_open_per_goal.
CREATE UNIQUE INDEX "goal_work_one_pending_per_subject"
    ON "goal_work"("goalId", "subjectRef")
    WHERE "disposition" = 'pending' AND "subjectRef" IS NOT NULL;

ALTER TABLE "goal_work" ADD CONSTRAINT "goal_work_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "goal_work" ADD CONSTRAINT "goal_work_goalId_fkey"
    FOREIGN KEY ("goalId") REFERENCES "goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Generate and typecheck**

Run: `npx prisma generate && npm run typecheck`
Expected: no errors. If Prisma complains about a missing relation field, the back-relation on `Goal` or `Organization` was not added in Step 1.

- [ ] **Step 4: Write the partial-index test**

This is the one claim unit tests cannot prove. Create
`src/lib/goals/__tests__/goal-work-index.pg.test.ts`:

```ts
/**
 * Proves the partial unique index, which is raw SQL in the migration and
 * therefore invisible to both Prisma's types and every jsdom test. Requires a
 * real Postgres — see the `verify` skill for the throwaway-PG protocol.
 * Skipped when TEST_DATABASE_URL is unset so `npm test` stays green locally.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const DB = process.env.TEST_DATABASE_URL
const maybe = DB ? test : test.skip

maybe('a subject may have only one pending item, and may be re-drafted after disposition', async () => {
  const { PrismaClient } = await import('@prisma/client')
  const prisma = new PrismaClient({ datasources: { db: { url: DB } } })
  const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
  const seeded = await seedTestOrg()

  const goal = await prisma.goal.create({
    data: {
      organizationId: seeded.organizationId,
      name: 'Revive every stalled deal',
      kind: 'kpi',
      unit: 'count',
      direction: 'increase',
      startValue: 0,
      targetValue: 12,
      startAt: new Date('2026-07-01T00:00:00Z'),
      targetDate: new Date('2026-08-01T00:00:00Z'),
      createdByUserId: seeded.userId,
    },
  })

  const row = (overrides: Record<string, unknown> = {}) => ({
    organizationId: seeded.organizationId,
    goalId: goal.id,
    resourceType: 'agent',
    resourceId: 'agent-1',
    subject: 'Acme Corp — deal 412',
    subjectRef: 'deal-412',
    produced: 're-entry email',
    ...overrides,
  })

  const first = await prisma.goalWork.create({ data: row() })

  await assert.rejects(
    () => prisma.goalWork.create({ data: row() }),
    /Unique constraint|goal_work_one_pending_per_subject/,
    'a second PENDING item for the same subject must be rejected',
  )

  // Disposition frees the subject — a deal that stalls twice gets drafted twice.
  await prisma.goalWork.update({
    where: { id: first.id },
    data: { disposition: 'used', dispositionAt: new Date() },
  })
  const second = await prisma.goalWork.create({ data: row() })
  assert.ok(second.id, 'after disposition the subject must be draftable again')

  // A null subjectRef opts out of dedupe entirely.
  await prisma.goalWork.create({ data: row({ subjectRef: null }) })
  await prisma.goalWork.create({ data: row({ subjectRef: null }) })

  await prisma.$disconnect()
})
```

- [ ] **Step 5: Run it against a real Postgres**

Follow the `verify` skill's throwaway-PG protocol, then:

```bash
TEST_DATABASE_URL=postgresql://qa@127.0.0.1:54339/sublime_qa \
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/goal-work-index.pg.test.ts
```
Expected: PASS. Without `TEST_DATABASE_URL` it reports as skipped, which is the intended local behavior.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260728160000_goal_work_ledger src/lib/goals/__tests__/goal-work-index.pg.test.ts
git commit -m "feat(goals): add the GoalWork ledger table"
```

---

### Task 2: The transition state machine

**Files:**
- Create: `src/lib/goals/work-transitions.ts`
- Test: `src/lib/goals/__tests__/work-transitions.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Disposition`, `type Outcome`, `type WorkState`, `type WorkPatch`, and `refusePatch(current: WorkState, patch: WorkPatch): string | null` — returns `null` when the patch is allowed, otherwise the refusal reason.

- [ ] **Step 1: Write the failing test**

Create `src/lib/goals/__tests__/work-transitions.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { refusePatch } from '../work-transitions'

const pending = { disposition: 'pending', outcome: 'unknown' } as const
const used = { disposition: 'used', outcome: 'unknown' } as const
const edited = { disposition: 'edited', outcome: 'unknown' } as const
const skipped = { disposition: 'skipped', outcome: 'unknown' } as const

test('a pending item accepts any disposition', () => {
  assert.equal(refusePatch(pending, { disposition: 'used' }), null)
  assert.equal(refusePatch(pending, { disposition: 'edited' }), null)
  assert.equal(refusePatch(pending, { disposition: 'skipped' }), null)
})

test('outcome may be set on used or edited items', () => {
  assert.equal(refusePatch(used, { outcome: 'worked' }), null)
  assert.equal(refusePatch(edited, { outcome: 'no_response' }), null)
})

test('outcome on a skipped item is refused — it was never sent', () => {
  // Allowing this would put an item in the outcome numerator that was never
  // in its denominator, making the process look better or worse than it was.
  const refusal = refusePatch(skipped, { outcome: 'worked' })
  assert.ok(refusal, 'must be refused')
  assert.match(refusal, /skipped/i)
})

test('outcome on a pending item is refused — nobody has used it yet', () => {
  assert.ok(refusePatch(pending, { outcome: 'worked' }))
})

test('a skipped item cannot be un-skipped', () => {
  const refusal = refusePatch(skipped, { disposition: 'used' })
  assert.ok(refusal, 'skipped is terminal')
  assert.match(refusal, /terminal|skipped/i)
})

test('a dispositioned item may still be re-dispositioned between used and edited', () => {
  // Editing something you already copied is normal and must not be refused.
  assert.equal(refusePatch(used, { disposition: 'edited' }), null)
})

test('assignee, body and skipReason are always allowed', () => {
  assert.equal(refusePatch(skipped, { assigneeUserId: null }), null)
  assert.equal(refusePatch(pending, { body: 'redrafted' }), null)
  assert.equal(refusePatch(pending, { skipReason: 'too early' }), null)
})

test('an unknown disposition or outcome value is refused', () => {
  assert.ok(refusePatch(pending, { disposition: 'sent' as never }))
  assert.ok(refusePatch(used, { outcome: 'great' as never }))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/work-transitions.test.ts`
Expected: FAIL — cannot find module `../work-transitions`.

- [ ] **Step 3: Implement**

Create `src/lib/goals/work-transitions.ts`:

```ts
/**
 * The legal moves on a GoalWork row. Pure, so the route and the UI cannot
 * disagree about what is allowed, and so every refusal is unit-testable.
 *
 * The load-bearing rule is that `outcome` belongs only to used or edited
 * items. A skipped item was never sent, so nothing could have landed;
 * recording an outcome on it would place a row in the outcome numerator that
 * was never in its denominator and quietly corrupt the funnel.
 */

export const DISPOSITIONS = ['pending', 'used', 'edited', 'skipped'] as const
export const OUTCOMES = ['unknown', 'worked', 'no_response', 'failed'] as const

export type Disposition = (typeof DISPOSITIONS)[number]
export type Outcome = (typeof OUTCOMES)[number]

export type WorkState = { disposition: Disposition; outcome: Outcome }

export type WorkPatch = {
  disposition?: Disposition
  outcome?: Outcome
  assigneeUserId?: string | null
  body?: string
  skipReason?: string | null
}

/** Dispositions that mean a human actually put the work to use. */
const USED: ReadonlySet<Disposition> = new Set<Disposition>(['used', 'edited'])

/** `null` when the patch is allowed; otherwise the reason to refuse it. */
export function refusePatch(current: WorkState, patch: WorkPatch): string | null {
  if (patch.disposition !== undefined) {
    if (!(DISPOSITIONS as readonly string[]).includes(patch.disposition)) {
      return `Unknown disposition "${patch.disposition}".`
    }
    if (current.disposition === 'skipped') {
      return 'This item was skipped, and skipped is terminal.'
    }
  }

  if (patch.outcome !== undefined) {
    if (!(OUTCOMES as readonly string[]).includes(patch.outcome)) {
      return `Unknown outcome "${patch.outcome}".`
    }
    // The disposition this patch lands on — the patch's own, when it sets one.
    const landing = patch.disposition ?? current.disposition
    if (landing === 'skipped') {
      return 'This item was skipped, so it has no outcome — nothing was sent.'
    }
    if (!USED.has(landing)) {
      return 'Only work someone actually used can have an outcome.'
    }
  }

  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/work-transitions.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/lib/goals/work-transitions.ts src/lib/goals/__tests__/work-transitions.test.ts
git commit -m "feat(goals): work item transition rules"
```

---

### Task 3: The funnel

**Files:**
- Create: `src/lib/goals/work-stats.ts`
- Test: `src/lib/goals/__tests__/work-stats.test.ts`

**Interfaces:**
- Consumes: `Disposition`, `Outcome` from `work-transitions.ts`.
- Produces: `computeWorkStats(rows: WorkStatRow[]): WorkStats`, with
  `WorkStatRow = { resourceId: string; resourceName: string; disposition: Disposition; outcome: Outcome }`
  and `WorkStats = { overall: WorkFunnel; byAgent: Array<{ resourceId; resourceName } & WorkFunnel> }`,
  `WorkFunnel = { produced: number; used: number; worked: number; usedRate: number | null; workedRate: number | null }`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/goals/__tests__/work-stats.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { computeWorkStats } from '../work-stats'

const row = (
  resourceId: string,
  disposition: 'pending' | 'used' | 'edited' | 'skipped',
  outcome: 'unknown' | 'worked' | 'no_response' | 'failed' = 'unknown',
) => ({ resourceId, resourceName: `Agent ${resourceId}`, disposition, outcome })

test('an empty ledger produces zeros and null rates, never NaN', () => {
  const stats = computeWorkStats([])
  assert.deepEqual(stats.overall, {
    produced: 0, used: 0, worked: 0, usedRate: null, workedRate: null,
  })
  assert.deepEqual(stats.byAgent, [])
})

test('used counts both used and edited', () => {
  const stats = computeWorkStats([
    row('a', 'used'), row('a', 'edited'), row('a', 'pending'),
  ])
  assert.equal(stats.overall.produced, 3)
  assert.equal(stats.overall.used, 2)
})

test('skipped items count as produced but are excluded from the outcome denominator', () => {
  // A high skip rate must read as a targeting problem, not disappear.
  const stats = computeWorkStats([
    row('a', 'used', 'worked'),
    row('a', 'used', 'no_response'),
    row('a', 'skipped'),
    row('a', 'skipped'),
  ])
  assert.equal(stats.overall.produced, 4, 'skipped work was still produced')
  assert.equal(stats.overall.used, 2)
  assert.equal(stats.overall.worked, 1)
  assert.equal(stats.overall.usedRate, 0.5, 'used / produced')
  assert.equal(stats.overall.workedRate, 0.5, 'worked / used, NOT worked / produced')
})

test('workedRate is null when nothing has been used yet', () => {
  const stats = computeWorkStats([row('a', 'pending'), row('a', 'skipped')])
  assert.equal(stats.overall.usedRate, 0)
  assert.equal(stats.overall.workedRate, null, 'no denominator, so no rate')
})

test('per-agent rows carry their own funnel and sort by produced descending', () => {
  const stats = computeWorkStats([
    row('quiet', 'used', 'worked'),
    row('busy', 'used', 'worked'),
    row('busy', 'used', 'no_response'),
    row('busy', 'skipped'),
  ])
  assert.equal(stats.byAgent.length, 2)
  assert.equal(stats.byAgent[0].resourceId, 'busy', 'busiest agent first')
  assert.equal(stats.byAgent[0].produced, 3)
  assert.equal(stats.byAgent[0].used, 2)
  assert.equal(stats.byAgent[0].worked, 1)
  assert.equal(stats.byAgent[1].resourceId, 'quiet')
  assert.equal(stats.byAgent[1].workedRate, 1)
})

test('only `worked` counts as worked — no_response and failed do not', () => {
  const stats = computeWorkStats([
    row('a', 'used', 'no_response'),
    row('a', 'used', 'failed'),
    row('a', 'used', 'unknown'),
  ])
  assert.equal(stats.overall.worked, 0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/work-stats.test.ts`
Expected: FAIL — cannot find module `../work-stats`.

- [ ] **Step 3: Implement**

Create `src/lib/goals/work-stats.ts`:

```ts
/**
 * The produced → used → worked funnel over GoalWork rows. Pure, no I/O.
 *
 * This is DESCRIPTIVE, not causal. It reports what humans did with the work
 * and what they said happened next. It does not claim the work caused the
 * goal to move — that needs attribution and holdouts, which are a separate
 * project. Copy rendered from these numbers must say "used" and "worked",
 * never "caused".
 *
 * Note the two different denominators: usedRate is over everything produced
 * (so a high skip rate correctly reads as a targeting problem), while
 * workedRate is over what was actually used (because skipped work was never
 * sent and could not have landed).
 */
import type { Disposition, Outcome } from '@/lib/goals/work-transitions'

export type WorkStatRow = {
  resourceId: string
  resourceName: string
  disposition: Disposition
  outcome: Outcome
}

export type WorkFunnel = {
  produced: number
  used: number
  worked: number
  /** used / produced. Null only when nothing was produced. */
  usedRate: number | null
  /** worked / used. Null when nothing has been used yet. */
  workedRate: number | null
}

export type WorkStats = {
  overall: WorkFunnel
  byAgent: Array<{ resourceId: string; resourceName: string } & WorkFunnel>
}

const USED: ReadonlySet<Disposition> = new Set<Disposition>(['used', 'edited'])

function funnel(rows: readonly WorkStatRow[]): WorkFunnel {
  const produced = rows.length
  const used = rows.filter((row) => USED.has(row.disposition)).length
  const worked = rows.filter(
    (row) => USED.has(row.disposition) && row.outcome === 'worked',
  ).length
  return {
    produced,
    used,
    worked,
    usedRate: produced > 0 ? used / produced : null,
    workedRate: used > 0 ? worked / used : null,
  }
}

export function computeWorkStats(rows: WorkStatRow[]): WorkStats {
  const byResource = new Map<string, WorkStatRow[]>()
  for (const row of rows) {
    const bucket = byResource.get(row.resourceId)
    if (bucket) bucket.push(row)
    else byResource.set(row.resourceId, [row])
  }

  const byAgent = [...byResource.entries()]
    .map(([resourceId, group]) => ({
      resourceId,
      resourceName: group[0].resourceName,
      ...funnel(group),
    }))
    .sort((a, b) => b.produced - a.produced || a.resourceName.localeCompare(b.resourceName))

  return { overall: funnel(rows), byAgent }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/work-stats.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/lib/goals/work-stats.ts src/lib/goals/__tests__/work-stats.test.ts
git commit -m "feat(goals): produced/used/worked funnel over the work ledger"
```

---

### Task 4: Port methods and assignee resolution

**Files:**
- Modify: `src/lib/integrations/goals.ts` (extend `GoalsDataPort`)
- Modify: `src/lib/integrations/goals-port.ts` (implement, add resource param)
- Modify: `src/features/agents/tool-planes.ts:313` (pass the resource)
- Test: `src/lib/integrations/__tests__/goals-port.test.ts` (existing file)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: on `GoalsDataPort` —
  `writeWork(goalId: string, input: WriteWorkInput): Promise<{ id: string; assigned: boolean }>` and
  `listWork(goalId: string, limit: number, disposition?: string): Promise<GoalWorkItem[]>`;
  types `WriteWorkInput = { subject: string; subjectRef: string | null; produced: string; body: string | null; bodyFormat: 'markdown' | 'html'; assigneeHint: string | null }`
  and `GoalWorkItem = { id: string; subject: string; subjectRef: string | null; produced: string; disposition: string; outcome: string; assigneeUserId: string | null; createdAt: Date }`.
  `prismaGoalsPort(organizationId: string, resource?: GoalResource)`.

- [ ] **Step 1: Extend the port type**

In `src/lib/integrations/goals.ts`, add above `GoalsDataPort`:

```ts
export type WriteWorkInput = {
  subject: string
  subjectRef: string | null
  produced: string
  body: string | null
  bodyFormat: 'markdown' | 'html'
  /** A name or email the agent read while producing. Resolved server-side;
   *  an unresolvable hint yields no assignee rather than an error. */
  assigneeHint: string | null
}

export type GoalWorkItem = {
  id: string
  subject: string
  subjectRef: string | null
  produced: string
  disposition: string
  outcome: string
  assigneeUserId: string | null
  createdAt: Date
}
```

and extend `GoalsDataPort` with:

```ts
  writeWork(goalId: string, input: WriteWorkInput): Promise<{ id: string; assigned: boolean }>
  listWork(goalId: string, limit: number, disposition?: string): Promise<GoalWorkItem[]>
```

- [ ] **Step 2: Write the failing test**

Append to `src/lib/integrations/__tests__/goals-port.test.ts` (create it with the
standard header if it does not exist):

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveAssignee } from '../goals-port'

test('an assignee hint matches a member by email, case-insensitively', async () => {
  const members = [
    { id: 'u1', email: 'Dana@acme.com', name: 'Dana Reed' },
    { id: 'u2', email: 'sam@acme.com', name: 'Sam Diaz' },
  ]
  assert.equal(await resolveAssignee('dana@acme.com', members), 'u1')
})

test('an assignee hint matches a member by full name', async () => {
  const members = [{ id: 'u1', email: 'dana@acme.com', name: 'Dana Reed' }]
  assert.equal(await resolveAssignee('Dana Reed', members), 'u1')
})

test('an unresolvable hint yields null rather than throwing', async () => {
  // An agent guessing a stranger's name must never fail the run.
  const members = [{ id: 'u1', email: 'dana@acme.com', name: 'Dana Reed' }]
  assert.equal(await resolveAssignee('Someone Else', members), null)
  assert.equal(await resolveAssignee(null, members), null)
  assert.equal(await resolveAssignee('', members), null)
})

test('an ambiguous name hint yields null rather than guessing', async () => {
  const members = [
    { id: 'u1', email: 'd1@acme.com', name: 'Dana Reed' },
    { id: 'u2', email: 'd2@acme.com', name: 'Dana Reed' },
  ]
  assert.equal(await resolveAssignee('Dana Reed', members), null)
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/integrations/__tests__/goals-port.test.ts`
Expected: FAIL — `resolveAssignee` is not exported.

- [ ] **Step 4: Implement in `goals-port.ts`**

Add the pure resolver and wire the two port methods:

```ts
export type OrgMember = { id: string; email: string | null; name: string | null }

/**
 * Resolve an agent's free-text assignee hint to an org member. Exported and
 * pure so the matching rules are testable without a database.
 *
 * Returns null rather than throwing or guessing: an agent that read a name
 * off a CRM record must never fail its run because that person is not a
 * Sublime user, and an ambiguous match is worse than no match — the item
 * lands in the Unassigned pool where a human can route it.
 */
export function resolveAssignee(
  hint: string | null | undefined,
  members: OrgMember[],
): string | null {
  const needle = (hint ?? '').trim().toLowerCase()
  if (!needle) return null

  const byEmail = members.filter((m) => (m.email ?? '').toLowerCase() === needle)
  if (byEmail.length === 1) return byEmail[0].id

  const byName = members.filter((m) => (m.name ?? '').toLowerCase() === needle)
  return byName.length === 1 ? byName[0].id : null
}
```

Change the factory signature and add both methods:

```ts
export function prismaGoalsPort(
  organizationId: string,
  resource?: GoalResource,
): GoalsDataPort {
```

```ts
    async writeWork(goalId, input) {
      // Resolve the hint against real members; unresolvable means Unassigned.
      const members = await prisma.user.findMany({
        where: { organizationMemberships: { some: { organizationId } } },
        select: { id: true, email: true, name: true },
      })
      const assigneeUserId = resolveAssignee(input.assigneeHint, members)

      const created = await prisma.goalWork.create({
        data: {
          organizationId,
          goalId,
          resourceType: resource?.type ?? 'agent',
          resourceId: resource?.id ?? 'unknown',
          subject: input.subject,
          subjectRef: input.subjectRef,
          produced: input.produced,
          body: input.body,
          bodyFormat: input.bodyFormat,
          assigneeUserId,
        },
        select: { id: true },
      })
      return { id: created.id, assigned: assigneeUserId !== null }
    },

    async listWork(goalId, limit, disposition) {
      return prisma.goalWork.findMany({
        where: { organizationId, goalId, ...(disposition ? { disposition } : {}) },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true, subject: true, subjectRef: true, produced: true,
          disposition: true, outcome: true, assigneeUserId: true, createdAt: true,
        },
      })
    },
```

If the membership relation name differs from `organizationMemberships`, check
`prisma/schema.prisma`'s `User` model and use the actual field — the shape of
the query matters, not the guessed name.

- [ ] **Step 5: Pass the resource at the construction site**

In `src/features/agents/tool-planes.ts`, line 313, change:

```ts
            new GoalsToolClient(goalIds, prismaGoalsPort(organizationId, options.resource)),
```

`options.resource` is already in scope — the `if` on line 305 guarantees it is defined.

- [ ] **Step 6: Run tests and typecheck**

```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/integrations/__tests__/goals-port.test.ts
npm run typecheck
```
Expected: PASS. Typecheck will flag any existing fake port in other tests that
now misses the two new methods — add no-op implementations there.

- [ ] **Step 7: Commit**

```bash
git add src/lib/integrations src/features/agents/tool-planes.ts
git commit -m "feat(goals): work ledger port methods and assignee resolution"
```

---

### Task 5: `log_work` and `list_work` tools

**Files:**
- Modify: `src/lib/integrations/goals.ts` (tool defs + client handlers)
- Test: `src/lib/integrations/__tests__/goals.test.ts` (existing file)

**Interfaces:**
- Consumes: `writeWork` / `listWork` from Task 4.
- Produces: two entries in `goalsTools()` and two branches in `GoalsToolClient.executeTool`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/integrations/__tests__/goals.test.ts`:

```ts
test('log_work writes one row per subject and reports the assignee outcome', async () => {
  const written: unknown[] = []
  const client = new GoalsToolClient(['goal-1'], {
    ...fakePort,
    writeWork: async (goalId, input) => {
      written.push({ goalId, input })
      return { id: 'work-1', assigned: true }
    },
  })

  const result = await client.executeTool('', 'log_work', {
    subject: 'Acme Corp — deal 412',
    subjectRef: 'deal-412',
    produced: 're-entry email',
    body: 'Following up on the pricing question…',
    assigneeHint: 'dana@acme.com',
  })

  assert.equal(written.length, 1)
  assert.deepEqual(result, {
    ok: true, id: 'work-1', goalId: 'goal-1',
    subject: 'Acme Corp — deal 412', assigned: true,
  })
})

test('log_work is permitted on a goal owned by a system of record', async () => {
  // Unlike log_datapoint, work has no system of record — the agent IS the
  // author, so the AGENT_WRITABLE_SOURCES allowlist must not apply here.
  const client = new GoalsToolClient(['goal-1'], {
    ...fakePort,
    getGoal: async () => ({ ...fakeGoal, primarySource: 'stripe' }),
    writeWork: async () => ({ id: 'work-1', assigned: false }),
  })
  const result = await client.executeTool('', 'log_work', {
    subject: 'Acme', produced: 're-entry email', body: 'x',
  })
  assert.equal((result as { ok: boolean }).ok, true)
})

test('log_work requires a subject and something produced', async () => {
  const client = new GoalsToolClient(['goal-1'], fakePort)
  await assert.rejects(
    () => client.executeTool('', 'log_work', { produced: 'email', body: 'x' }),
    /subject/i,
  )
  await assert.rejects(
    () => client.executeTool('', 'log_work', { subject: 'Acme', body: 'x' }),
    /produced/i,
  )
})

test('log_work refuses a goal this agent is not linked to', async () => {
  const client = new GoalsToolClient(['goal-1'], fakePort)
  await assert.rejects(
    () => client.executeTool('', 'log_work', {
      goalId: 'goal-elsewhere', subject: 'A', produced: 'b', body: 'c',
    }),
    /not linked/i,
  )
})

test('list_work returns queued items with their disposition and outcome', async () => {
  const client = new GoalsToolClient(['goal-1'], {
    ...fakePort,
    listWork: async () => [{
      id: 'w1', subject: 'Acme', subjectRef: 'deal-412', produced: 're-entry email',
      disposition: 'skipped', outcome: 'unknown', assigneeUserId: null,
      createdAt: new Date('2026-07-20T00:00:00Z'),
    }],
  })
  const result = (await client.executeTool('', 'list_work', {})) as {
    items: Array<{ disposition: string; createdAt: string }>
  }
  assert.equal(result.items[0].disposition, 'skipped')
  assert.equal(result.items[0].createdAt, '2026-07-20T00:00:00.000Z')
})
```

Reuse whatever `fakePort` / `fakeGoal` fixtures already exist at the top of that
file; extend `fakePort` with no-op `writeWork` and `listWork` so the other tests
still compile.

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/integrations/__tests__/goals.test.ts`
Expected: FAIL — `Unknown goals tool: log_work`.

- [ ] **Step 3: Add the tool definitions**

In `goalsTools()`, after the `log_datapoint` entry:

```ts
    {
      name: 'log_work',
      description:
        'Record ONE thing you produced toward this goal. Call it once per subject — one call per deal, lead or account, never one call summarizing a batch. The per-subject record is what lets the team see which work landed and what to stop producing.',
      inputSchema: {
        type: 'object',
        properties: {
          goalId,
          subject: {
            type: 'string',
            description: 'Who or what this work is about, as a person would say it: "Acme Corp — deal 412".',
          },
          subjectRef: {
            type: 'string',
            description: 'A stable id for the subject (CRM record id). Supplying it stops you re-drafting the same subject while an earlier draft is still waiting on a human.',
          },
          produced: {
            type: 'string',
            description: 'What you made, as a short noun phrase: "re-entry email", "buying-committee map".',
          },
          body: { type: 'string', description: 'The artifact itself, ready for a person to use.' },
          bodyFormat: { type: 'string', enum: ['markdown', 'html'], description: 'Defaults to markdown.' },
          assigneeHint: {
            type: 'string',
            description: 'Name or email of the person who should act on it — usually the record owner. Unrecognized names are fine; the item goes to the unassigned pool.',
          },
        },
        required: ['subject', 'produced', 'body'],
      },
    },
    {
      name: 'list_work',
      description:
        'What you have already queued for this goal, newest first, with each item\'s disposition and outcome. Read it before producing: it stops you re-drafting something a human has not dealt with, and shows what people skipped so you can stop producing that kind of thing.',
      inputSchema: {
        type: 'object',
        properties: {
          goalId,
          disposition: {
            type: 'string',
            enum: ['pending', 'used', 'edited', 'skipped'],
            description: 'Optional filter. Omit to see everything recent.',
          },
        },
        required: [],
      },
    },
```

- [ ] **Step 4: Add the client handlers**

In `executeTool`, before the final `throw`:

```ts
    if (name === 'log_work') {
      const goal = await this.loadGoal(args.goalId)
      // Deliberately NO canWriteDatapoint check: that guard exists because a
      // system of record owns the NUMBER. Work has no system of record — this
      // agent is its author — so the allowlist does not apply.
      const subject = String(args.subject ?? '').trim()
      if (!subject) throw new Error('subject is required — name who or what this work is about')
      const produced = String(args.produced ?? '').trim()
      if (!produced) throw new Error('produced is required — name what you made')
      const body = args.body === undefined || args.body === null ? null : String(args.body)

      const bodyFormat = args.bodyFormat === 'html' ? 'html' : 'markdown'
      const written = await this.port.writeWork(goal.id, {
        subject,
        subjectRef: args.subjectRef ? String(args.subjectRef) : null,
        produced,
        body,
        bodyFormat,
        assigneeHint: args.assigneeHint ? String(args.assigneeHint) : null,
      })
      return {
        ok: true,
        id: written.id,
        goalId: goal.id,
        subject,
        assigned: written.assigned,
      }
    }

    if (name === 'list_work') {
      const goal = await this.loadGoal(args.goalId)
      const disposition = args.disposition ? String(args.disposition) : undefined
      const items = await this.port.listWork(goal.id, WORK_LIMIT, disposition)
      return {
        goalId: goal.id,
        items: items.map((item) => ({
          id: item.id,
          subject: item.subject,
          subjectRef: item.subjectRef,
          produced: item.produced,
          disposition: item.disposition,
          outcome: item.outcome,
          assigned: item.assigneeUserId !== null,
          createdAt: item.createdAt.toISOString(),
        })),
      }
    }
```

Add `const WORK_LIMIT = 50` beside the existing `DATAPOINT_LIMIT`.

- [ ] **Step 5: Run tests to verify they pass**

```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/integrations/__tests__/goals.test.ts
npm run typecheck
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/integrations
git commit -m "feat(goals): log_work and list_work on the goals tool plane"
```

---

### Task 6: The work API routes

**Files:**
- Create: `src/app/api/goals/[id]/work/route.ts`
- Create: `src/app/api/goals/[id]/work/[workId]/route.ts`
- Test: `src/app/api/goals/__tests__/work-route.test.ts`

**Interfaces:**
- Consumes: `refusePatch` (Task 2), `computeWorkStats` (Task 3).
- Produces: `GET /api/goals/[id]/work?filter=` returning `{ items, stats }`, and `PATCH /api/goals/[id]/work/[workId]`.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/goals/__tests__/work-route.test.ts`. It runs against a real
Postgres following the `verify` skill; it self-skips without `TEST_DATABASE_URL`.

```ts
/**
 * Route-handler drive for the work queue. Real Postgres + seeded auth, per the
 * `verify` skill — jsdom cannot prove tenant scoping or transition refusals.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const DB = process.env.TEST_DATABASE_URL
const maybe = DB ? test : test.skip

maybe('the queue lists items and refuses illegal transitions', async () => {
  const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
  const { prisma } = await import('@/lib/prisma')
  const seeded = await seedTestOrg()
  installTestAuth(seeded)

  const goal = await prisma.goal.create({
    data: {
      organizationId: seeded.organizationId,
      name: 'Revive every stalled deal',
      kind: 'kpi', unit: 'count', direction: 'increase',
      startValue: 0, targetValue: 12,
      startAt: new Date('2026-07-01T00:00:00Z'),
      targetDate: new Date('2026-08-01T00:00:00Z'),
      createdByUserId: seeded.userId,
    },
  })

  const item = await prisma.goalWork.create({
    data: {
      organizationId: seeded.organizationId, goalId: goal.id,
      resourceType: 'agent', resourceId: 'agent-1',
      subject: 'Acme — deal 412', subjectRef: 'deal-412',
      produced: 're-entry email', body: 'Following up…',
    },
  })

  const { GET } = await import('../[id]/work/route')
  const listed = await GET(
    new NextRequest(`http://t/api/goals/${goal.id}/work?filter=all`),
    { params: Promise.resolve({ id: goal.id }) } as never,
  )
  const body = await listed.json()
  assert.equal(body.items.length, 1)
  assert.equal(body.items[0].subject, 'Acme — deal 412')
  assert.equal(body.stats.overall.produced, 1)

  const { PATCH } = await import('../[id]/work/[workId]/route')
  const patch = (payload: Record<string, unknown>) =>
    PATCH(
      new NextRequest(`http://t/api/goals/${goal.id}/work/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ id: goal.id, workId: item.id }) } as never,
    )

  // Outcome before anyone used it — refused.
  assert.equal((await patch({ outcome: 'worked' })).status, 400)

  // Copy records `used`.
  assert.equal((await patch({ disposition: 'used' })).status, 200)
  const afterUse = await prisma.goalWork.findFirstOrThrow({
    where: { id: item.id, organizationId: seeded.organizationId },
  })
  assert.equal(afterUse.disposition, 'used')
  assert.ok(afterUse.dispositionAt, 'dispositionAt must be stamped')
  assert.equal(afterUse.dispositionBy, seeded.userId)

  // Now an outcome is legal.
  assert.equal((await patch({ outcome: 'worked' })).status, 200)
  const afterOutcome = await prisma.goalWork.findFirstOrThrow({
    where: { id: item.id, organizationId: seeded.organizationId },
  })
  assert.equal(afterOutcome.outcome, 'worked')
  assert.equal(afterOutcome.outcomeSource, 'human')
})

maybe('a skipped item can never be given an outcome or un-skipped', async () => {
  const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
  const { prisma } = await import('@/lib/prisma')
  const seeded = await seedTestOrg()
  installTestAuth(seeded)

  const goal = await prisma.goal.create({
    data: {
      organizationId: seeded.organizationId, name: 'G', kind: 'kpi', unit: 'count',
      direction: 'increase', startValue: 0, targetValue: 1,
      startAt: new Date('2026-07-01T00:00:00Z'), targetDate: new Date('2026-08-01T00:00:00Z'),
      createdByUserId: seeded.userId,
    },
  })
  const item = await prisma.goalWork.create({
    data: {
      organizationId: seeded.organizationId, goalId: goal.id,
      resourceType: 'agent', resourceId: 'a', subject: 'S', produced: 'p',
      disposition: 'skipped',
    },
  })

  const { PATCH } = await import('../[id]/work/[workId]/route')
  const call = (payload: Record<string, unknown>) =>
    PATCH(
      new NextRequest(`http://t/x`, {
        method: 'PATCH', body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ id: goal.id, workId: item.id }) } as never,
    )

  assert.equal((await call({ outcome: 'worked' })).status, 400)
  assert.equal((await call({ disposition: 'used' })).status, 400)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run with `TEST_DATABASE_URL` set per the `verify` skill.
Expected: FAIL — cannot resolve `../[id]/work/route`.

- [ ] **Step 3: Implement the list route**

Create `src/app/api/goals/[id]/work/route.ts`:

```ts
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { computeWorkStats } from '@/lib/goals/work-stats'
import type { Disposition, Outcome } from '@/lib/goals/work-transitions'

export const runtime = 'nodejs'

const FILTERS = ['mine', 'unassigned', 'all', 'done'] as const
type Filter = (typeof FILTERS)[number]

const PAGE = 100

export const GET = withAuthenticatedApi(async (request, auth) => {
  const url = new URL(request.url)
  const goalId = url.pathname.split('/').at(-2)!
  const raw = url.searchParams.get('filter') ?? 'mine'
  const filter = (FILTERS as readonly string[]).includes(raw) ? (raw as Filter) : 'mine'

  const goal = await prisma.goal.findFirst({
    where: { id: goalId, organizationId: auth.organizationId },
    select: { id: true },
  })
  if (!goal) throw new ApiError('Goal not found', 404, 'NOT_FOUND')

  const open = { disposition: { in: ['pending'] } }
  const where = {
    organizationId: auth.organizationId,
    goalId,
    ...(filter === 'mine' ? { assigneeUserId: auth.dbUser.id, ...open } : {}),
    ...(filter === 'unassigned' ? { assigneeUserId: null, ...open } : {}),
    ...(filter === 'all' ? open : {}),
    ...(filter === 'done' ? { disposition: { in: ['used', 'edited', 'skipped'] } } : {}),
  }

  const items = await prisma.goalWork.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: PAGE,
  })

  // Stats always span the whole goal, never the current filter — a funnel that
  // changed when you clicked a tab would be unreadable.
  const all = await prisma.goalWork.findMany({
    where: { organizationId: auth.organizationId, goalId },
    select: { resourceId: true, disposition: true, outcome: true },
  })
  const names = await prisma.agent.findMany({
    where: {
      organizationId: auth.organizationId,
      id: { in: [...new Set(all.map((row) => row.resourceId))] },
    },
    select: { id: true, name: true },
  })
  const nameById = new Map(names.map((agent) => [agent.id, agent.name]))

  const stats = computeWorkStats(
    all.map((row) => ({
      resourceId: row.resourceId,
      resourceName: nameById.get(row.resourceId) ?? 'Removed agent',
      disposition: row.disposition as Disposition,
      outcome: row.outcome as Outcome,
    })),
  )

  return { items, stats }
})
```

- [ ] **Step 4: Implement the patch route**

Create `src/app/api/goals/[id]/work/[workId]/route.ts`:

```ts
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import {
  DISPOSITIONS, OUTCOMES, refusePatch,
  type Disposition, type Outcome,
} from '@/lib/goals/work-transitions'

export const runtime = 'nodejs'

const patchSchema = z
  .object({
    disposition: z.enum(DISPOSITIONS).optional(),
    outcome: z.enum(OUTCOMES).optional(),
    outcomeNote: z.string().max(2000).nullable().optional(),
    assigneeUserId: z.string().uuid().nullable().optional(),
    body: z.string().max(50_000).optional(),
    skipReason: z.string().max(500).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change')

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const segments = new URL(request.url).pathname.split('/')
  const workId = segments.at(-1)!
  const goalId = segments.at(-3)!

  const patch = patchSchema.parse(await request.json())

  const current = await prisma.goalWork.findFirst({
    where: { id: workId, goalId, organizationId: auth.organizationId },
    select: { id: true, disposition: true, outcome: true },
  })
  if (!current) throw new ApiError('Work item not found', 404, 'NOT_FOUND')

  const refusal = refusePatch(
    { disposition: current.disposition as Disposition, outcome: current.outcome as Outcome },
    patch,
  )
  if (refusal) throw new ApiError(refusal, 400, 'ILLEGAL_TRANSITION')

  const now = new Date()
  // updateMany, NOT update: `src/lib/tenant-guard.ts` throws on any update
  // whose where clause lacks organizationId, and `update` requires a unique
  // key that organizationId cannot be part of. Same shape as
  // src/app/api/goals/[id]/recovery/route.ts:26.
  await prisma.goalWork.updateMany({
    where: { id: current.id, organizationId: auth.organizationId },
    data: {
      ...(patch.disposition !== undefined
        ? { disposition: patch.disposition, dispositionAt: now, dispositionBy: auth.dbUser.id }
        : {}),
      ...(patch.outcome !== undefined
        ? { outcome: patch.outcome, outcomeAt: now, outcomeSource: 'human' }
        : {}),
      ...(patch.outcomeNote !== undefined ? { outcomeNote: patch.outcomeNote } : {}),
      ...(patch.assigneeUserId !== undefined ? { assigneeUserId: patch.assigneeUserId } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.skipReason !== undefined ? { skipReason: patch.skipReason } : {}),
    },
  })

  // updateMany returns a count, so re-read the row to return it.
  const item = await prisma.goalWork.findFirst({
    where: { id: current.id, organizationId: auth.organizationId },
  })
  return { item }
})
```

- [ ] **Step 5: Run tests to verify they pass**

Run with `TEST_DATABASE_URL` set. Expected: PASS, 2 tests.
If `prisma.agent` is not the model name for agents, check `schema.prisma` and use
the real one in the list route's name lookup.

- [ ] **Step 6: Commit**

```bash
npm run typecheck
git add src/app/api/goals
git commit -m "feat(goals): work queue list and patch routes"
```

---

### Task 7: Funnel strip and work item

**Files:**
- Create: `src/components/goals/workroom/work-funnel-strip.tsx`
- Create: `src/components/goals/workroom/work-item.tsx`
- Test: `src/components/goals/workroom/__tests__/work-item.test.tsx`

**Interfaces:**
- Consumes: `WorkStats` (Task 3).
- Produces: `<WorkFunnelStrip stats={WorkStats} />` and
  `<WorkItem item={WorkItemData} onPatch={(patch) => void} />` where
  `WorkItemData = { id, subject, produced, body, bodyFormat, disposition, outcome, assigneeUserId, createdAt }`.

- [ ] **Step 1: Write the failing test**

Create `src/components/goals/workroom/__tests__/work-item.test.tsx`:

```tsx
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { WorkItem } from '../work-item'

afterEach(cleanup)

const item = {
  id: 'w1',
  subject: 'Acme Corp — deal 412',
  produced: 're-entry email',
  body: 'Following up on the pricing question from our 3/14 call.',
  bodyFormat: 'markdown' as const,
  disposition: 'pending' as const,
  outcome: 'unknown' as const,
  assigneeUserId: null,
  createdAt: new Date('2026-07-20T00:00:00Z').toISOString(),
}

test('renders the subject, what was produced, and the artifact', () => {
  render(<WorkItem item={item} onPatch={() => {}} />)
  assert.ok(screen.getByText('Acme Corp — deal 412'))
  assert.ok(screen.getByText('re-entry email'))
  assert.ok(screen.getByText(/pricing question/))
})

test('Copy records used — the act IS the disposition', () => {
  const patches: unknown[] = []
  render(<WorkItem item={item} onPatch={(patch) => patches.push(patch)} />)
  fireEvent.click(screen.getByRole('button', { name: /copy/i }))
  assert.deepEqual(patches, [{ disposition: 'used' }])
})

test('Skip records skipped', () => {
  const patches: unknown[] = []
  render(<WorkItem item={item} onPatch={(patch) => patches.push(patch)} />)
  fireEvent.click(screen.getByRole('button', { name: /skip/i }))
  assert.deepEqual(patches, [{ disposition: 'skipped' }])
})

test('a dispositioned item offers no Copy or Skip', () => {
  render(<WorkItem item={{ ...item, disposition: 'used' }} onPatch={() => {}} />)
  assert.equal(screen.queryByRole('button', { name: /^skip$/i }), null)
})

test('an unassigned item offers Claim', () => {
  render(<WorkItem item={item} onPatch={() => {}} currentUserId="u1" />)
  assert.ok(screen.getByRole('button', { name: /claim/i }))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/goals/workroom/__tests__/work-item.test.tsx`
Expected: FAIL — cannot find module `../work-item`.

- [ ] **Step 3: Implement `work-item.tsx`**

```tsx
'use client'

import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/ui/markdown'
import { HtmlPreview } from '@/components/ui/html-preview'
import type { Disposition, Outcome, WorkPatch } from '@/lib/goals/work-transitions'

export type WorkItemData = {
  id: string
  subject: string
  produced: string
  body: string | null
  bodyFormat: 'markdown' | 'html'
  disposition: Disposition
  outcome: Outcome
  assigneeUserId: string | null
  createdAt: string
}

/**
 * One row of the workroom. Every action writes a disposition as its side
 * effect — there is no separate "mark as used" step, because a marking step
 * divorced from the moment of use is a chore nobody does, and an unmarked
 * ledger teaches nothing.
 */
export function WorkItem({
  item,
  onPatch,
  currentUserId,
}: {
  item: WorkItemData
  onPatch: (patch: WorkPatch) => void
  currentUserId?: string
}) {
  const open = item.disposition === 'pending'

  const copy = () => {
    if (item.body) void navigator.clipboard?.writeText(item.body)
    onPatch({ disposition: 'used' })
  }

  return (
    <li className="space-y-2 rounded-xl border bg-background/60 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{item.subject}</p>
        <p className="text-xs text-muted-foreground">{item.produced}</p>
      </div>

      {item.body && (
        <div className="max-h-40 overflow-y-auto text-sm text-muted-foreground">
          {item.bodyFormat === 'html' ? (
            <HtmlPreview html={item.body} />
          ) : (
            <Markdown>{item.body}</Markdown>
          )}
        </div>
      )}

      {open && (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={copy}>Copy</Button>
          <Button size="sm" variant="outline" onClick={() => onPatch({ disposition: 'skipped' })}>
            Skip
          </Button>
          {item.assigneeUserId === null && currentUserId && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onPatch({ assigneeUserId: currentUserId })}
            >
              Claim
            </Button>
          )}
        </div>
      )}
    </li>
  )
}
```

- [ ] **Step 4: Implement `work-funnel-strip.tsx`**

```tsx
'use client'

import type { WorkStats } from '@/lib/goals/work-stats'

const pct = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)}%`)

/**
 * produced → used → worked, overall and per agent.
 *
 * Copy is deliberately descriptive: "used" and "worked", never "caused".
 * These are counts of what people did and reported, not an attribution claim.
 */
export function WorkFunnelStrip({ stats }: { stats: WorkStats }) {
  if (stats.overall.produced === 0) return null
  const { produced, used, worked, usedRate, workedRate } = stats.overall

  return (
    <div className="space-y-2 rounded-xl border bg-card px-4 py-3">
      <p className="text-sm">
        <span className="font-medium">{produced} produced</span>
        {' → '}
        <span className="font-medium">{used} used</span> ({pct(usedRate)})
        {' → '}
        <span className="font-medium">{worked} worked</span> ({pct(workedRate)})
      </p>
      <ul className="space-y-0.5">
        {stats.byAgent.map((agent) => (
          <li key={agent.resourceId} className="flex justify-between gap-4 text-xs text-muted-foreground">
            <span className="truncate">{agent.resourceName}</span>
            <span className="tabular-nums">
              {agent.produced} → {agent.used} → {agent.worked}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/goals/workroom/__tests__/work-item.test.tsx`
Expected: PASS, 5 tests. If `Markdown` expects a `content` prop rather than
children, check `src/components/ui/markdown.tsx` and match its real API.

- [ ] **Step 6: Commit**

```bash
npm run typecheck
git add src/components/goals/workroom
git commit -m "feat(goals): work item and funnel strip"
```

---

### Task 8: The queue and the outcome prompt

**Files:**
- Create: `src/components/goals/workroom/work-queue.tsx`
- Create: `src/components/goals/workroom/work-outcome-prompt.tsx`
- Test: `src/components/goals/workroom/__tests__/work-queue.test.tsx`

**Interfaces:**
- Consumes: `WorkItem`, `WorkFunnelStrip` (Task 7); `GET`/`PATCH` routes (Task 6).
- Produces: `<WorkQueue goalId={string} currentUserId={string} />`.

- [ ] **Step 1: Write the failing test**

Create `src/components/goals/workroom/__tests__/work-queue.test.tsx`:

```tsx
import '@/test-support/jsdom-env'
import { test, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen, waitFor } from '@testing-library/react'
import { WorkQueue } from '../work-queue'

afterEach(cleanup)

const emptyStats = { overall: { produced: 0, used: 0, worked: 0, usedRate: null, workedRate: null }, byAgent: [] }

const respond = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as Response

beforeEach(() => {
  globalThis.fetch = (async () => respond({ items: [], stats: emptyStats })) as typeof fetch
})

test('an empty queue explains itself and points at the agent bundle', async () => {
  render(<WorkQueue goalId="g1" currentUserId="u1" />)
  await waitFor(() => {
    assert.ok(screen.getByText(/no work yet/i))
    assert.ok(screen.getByText(/deploy an agent/i))
  })
})

test('items render with their subject', async () => {
  globalThis.fetch = (async () =>
    respond({
      items: [{
        id: 'w1', subject: 'Acme — deal 412', produced: 're-entry email',
        body: 'hello', bodyFormat: 'markdown', disposition: 'pending',
        outcome: 'unknown', assigneeUserId: null,
        createdAt: '2026-07-20T00:00:00.000Z',
      }],
      stats: emptyStats,
    })) as typeof fetch

  render(<WorkQueue goalId="g1" currentUserId="u1" />)
  await waitFor(() => assert.ok(screen.getByText('Acme — deal 412')))
})

test('the outcome prompt appears only for used items older than seven days', async () => {
  const old = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString()
  const fresh = new Date().toISOString()
  globalThis.fetch = (async () =>
    respond({
      items: [
        { id: 'old', subject: 'Old one', produced: 'email', body: null, bodyFormat: 'markdown',
          disposition: 'used', outcome: 'unknown', assigneeUserId: null, createdAt: old },
        { id: 'new', subject: 'Fresh one', produced: 'email', body: null, bodyFormat: 'markdown',
          disposition: 'used', outcome: 'unknown', assigneeUserId: null, createdAt: fresh },
        { id: 'skip', subject: 'Skipped one', produced: 'email', body: null, bodyFormat: 'markdown',
          disposition: 'skipped', outcome: 'unknown', assigneeUserId: null, createdAt: old },
      ],
      stats: emptyStats,
    })) as typeof fetch

  render(<WorkQueue goalId="g1" currentUserId="u1" />)
  await waitFor(() => assert.ok(screen.getByText(/did these land/i)))
  // Only the aged, used item is asked about. A skipped item was never sent,
  // so asking whether it landed would be incoherent.
  assert.ok(screen.getByRole('button', { name: /worked/i }))
  const prompt = screen.getByText(/did these land/i).closest('div')!
  assert.ok(prompt.textContent?.includes('Old one'))
  assert.equal(prompt.textContent?.includes('Skipped one'), false)
  assert.equal(prompt.textContent?.includes('Fresh one'), false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/goals/workroom/__tests__/work-queue.test.tsx`
Expected: FAIL — cannot find module `../work-queue`.

- [ ] **Step 3: Implement `work-outcome-prompt.tsx`**

```tsx
'use client'

import { Button } from '@/components/ui/button'
import type { WorkPatch } from '@/lib/goals/work-transitions'
import type { WorkItemData } from './work-item'

/** Only work this old is worth asking about — anything fresher has not had
 *  time to land, and asking would train people to answer noise. */
export const OUTCOME_PROMPT_AGE_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

/** Used or edited, old enough to have landed, and nobody has said yet. */
export function needsOutcome(item: WorkItemData, now: number): boolean {
  if (item.disposition !== 'used' && item.disposition !== 'edited') return false
  if (item.outcome !== 'unknown') return false
  return now - new Date(item.createdAt).getTime() >= OUTCOME_PROMPT_AGE_DAYS * DAY_MS
}

export function WorkOutcomePrompt({
  items,
  onPatch,
}: {
  items: WorkItemData[]
  onPatch: (id: string, patch: WorkPatch) => void
}) {
  if (items.length === 0) return null
  return (
    <div className="space-y-2 rounded-xl border border-dashed bg-muted/40 px-4 py-3">
      <p className="text-xs font-medium text-muted-foreground">
        Did these land? {items.length} sent over a week ago
      </p>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm">{item.subject}</span>
            <span className="flex gap-1.5">
              <Button size="sm" variant="outline" onClick={() => onPatch(item.id, { outcome: 'worked' })}>
                Worked
              </Button>
              <Button size="sm" variant="outline" onClick={() => onPatch(item.id, { outcome: 'no_response' })}>
                No response
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 4: Implement `work-queue.tsx`**

```tsx
'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/ui/empty-state'
import { ListChecks } from 'lucide-react'
import type { WorkPatch } from '@/lib/goals/work-transitions'
import type { WorkStats } from '@/lib/goals/work-stats'
import { WorkItem, type WorkItemData } from './work-item'
import { WorkFunnelStrip } from './work-funnel-strip'
import { WorkOutcomePrompt, needsOutcome } from './work-outcome-prompt'

const FILTERS = [
  { key: 'mine', label: 'Mine' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'all', label: 'All' },
  { key: 'done', label: 'Done' },
] as const

const EMPTY_STATS: WorkStats = {
  overall: { produced: 0, used: 0, worked: 0, usedRate: null, workedRate: null },
  byAgent: [],
}

/**
 * The workroom. Sits above the dashboard on the goal page because the work is
 * the point and the number is the evidence, not the other way round.
 */
export function WorkQueue({
  goalId,
  currentUserId,
}: {
  goalId: string
  currentUserId: string
}) {
  const [filter, setFilter] = useState<string>('mine')
  const [items, setItems] = useState<WorkItemData[]>([])
  const [stats, setStats] = useState<WorkStats>(EMPTY_STATS)
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/goals/${goalId}/work?filter=${filter}`, {
        cache: 'no-store',
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'could not load work')
      setItems(body.items ?? [])
      setStats(body.stats ?? EMPTY_STATS)
    } catch {
      setItems([])
      setStats(EMPTY_STATS)
    } finally {
      setLoaded(true)
    }
  }, [goalId, filter])

  useEffect(() => { void load() }, [load])

  const patch = useCallback(
    async (id: string, body: WorkPatch) => {
      await fetch(`/api/goals/${goalId}/work/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      await load()
    },
    [goalId, load],
  )

  // Computed from the loaded page rather than fetched separately: the prompt
  // is a nudge, not a report, so it only ever asks about what is on screen.
  const awaitingOutcome = useMemo(() => {
    const now = Date.now()
    return items.filter((item) => needsOutcome(item, now))
  }, [items])

  return (
    <section className="space-y-3" aria-labelledby="goal-workroom-heading">
      <h2 id="goal-workroom-heading" className="text-sm font-semibold">
        Work
      </h2>

      <WorkFunnelStrip stats={stats} />

      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter work">
        {FILTERS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={filter === entry.key}
            onClick={() => setFilter(entry.key)}
            className={cn(
              'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
              filter === entry.key
                ? 'border-horizon-300 bg-horizon-50 text-horizon-700 dark:border-horizon-500/40 dark:bg-horizon-500/15 dark:text-horizon-200'
                : 'border-border/60 bg-card text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <WorkOutcomePrompt items={awaitingOutcome} onPatch={patch} />

      {loaded && items.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No work yet"
          description="Agents write their work here as they produce it."
          action={
            <Link href="#" className="text-sm font-medium underline-offset-2 hover:underline">
              Deploy an agent below
            </Link>
          }
        />
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <WorkItem
              key={item.id}
              item={item}
              currentUserId={currentUserId}
              onPatch={(body) => void patch(item.id, body)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}
```

If `EmptyState` does not accept an `action` prop, check
`src/components/ui/empty-state.tsx` and put the link in `description` instead —
the test only requires the text "no work yet" and "deploy an agent" to render.

- [ ] **Step 5: Run tests to verify they pass**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/goals/workroom/__tests__/work-queue.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
npm run typecheck
git add src/components/goals/workroom
git commit -m "feat(goals): the workroom queue and outcome prompt"
```

---

### Task 9: Mount the workroom on the goal page

**Files:**
- Modify: `src/app/(app)/goals/[id]/page.tsx` (import + render above `GoalDashboard`)

**Interfaces:**
- Consumes: `<WorkQueue goalId currentUserId />` (Task 8).
- Produces: nothing downstream.

- [ ] **Step 1: Find the current user id available to the page**

Run: `grep -n "dbUser\|currentUser\|useAuth\|session" "src/app/(app)/goals/[id]/page.tsx" | head`

If the page has no current-user id, read it from the same endpoint the rest of
the app uses — check `src/app/(app)/layout.tsx` for the existing pattern rather
than adding a new fetch.

- [ ] **Step 2: Mount it above the dashboard**

Add the import:

```tsx
import { WorkQueue } from '@/components/goals/workroom/work-queue'
```

and render it immediately before `<GoalDashboard …>`:

```tsx
      <WorkQueue goalId={goalId} currentUserId={currentUserId} />

      <AgentBundleCard
```

Order matters: `WorkQueue` → `AgentBundleCard` → `GoalDashboard`. The work comes
first, the agents that produce it sit directly beneath (so the empty state's
"deploy an agent below" is literally true), and the number is evidence at the
bottom.

- [ ] **Step 3: Verify the whole suite and types**

```bash
npm run typecheck && npm run lint && npm test
```
Expected: PASS, no new failures.

- [ ] **Step 4: Verify in a real browser**

Follow the harness in the `browser-verification-harness` memory: add a temp
client page mounting `<WorkQueue>` with a stubbed fetch, add its path to
`publicPages` in `src/lib/supabase/middleware.ts`, boot
`npx next dev -p 3111` with placeholder Supabase env vars, and drive it with the
cached Playwright chromium. Confirm: items render, filter tabs switch, the
outcome prompt appears for aged used items, and card text does not overflow.

Tear down afterwards — delete the route, revert the middleware line, and
`rm -rf .next/types` (a stale validator entry fails typecheck otherwise).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/goals/[id]/page.tsx"
git commit -m "feat(goals): put the workroom above the dashboard"
```

---

## Self-Review

**Spec coverage.** §1 record → Task 1 (model, migration, partial index proven
against real PG). §2 agent writes → Tasks 4 (port, assignee resolution) and 5
(tools, no-write-policy assertion). §3 workroom → Tasks 7 (item, action-as-
disposition), 8 (queue, outcome prompt, empty state), 9 (mount, page order), 6
(routes). §4 reading back → Task 3 (funnel) and 7 (strip, descriptive copy).
§5 state machine → Task 2 (pure rules) and 6 (route enforcement, both illegal
transitions tested). §6 tests → distributed across every task; the real-Postgres
legs are Tasks 1 and 6. Out-of-scope items appear in no task.

**Type consistency.** `Disposition`/`Outcome`/`WorkPatch` are defined once in
Task 2 and imported by Tasks 3, 6, 7, 8. `WorkStats`/`WorkFunnel` defined in
Task 3, consumed in 6 and 7. `WorkItemData` defined in Task 7, consumed in 8.
`WriteWorkInput`/`GoalWorkItem` defined in Task 4, consumed in 5.
`refusePatch(current, patch)` — same argument order at its definition (Task 2)
and its only call site (Task 6). `computeWorkStats(rows)` likewise.

**Known hazards.** Task 4 guesses the Prisma relation name for org membership
and Task 6 guesses the agent model name; both steps say to check
`schema.prisma` and use the real names. Task 7 flags that `Markdown` may take a
prop rather than children, and Task 8 that `EmptyState` may not accept `action`
— each with a concrete fallback. Tasks 1 and 6 self-skip without
`TEST_DATABASE_URL` so `npm test` stays green for anyone without a local PG.
