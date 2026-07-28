# Goal Work Learning Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the `GoalWork` ledger into behavior change — a deterministic feedback block on every run, durable targeting rules earned from evidence, and cadence proposals a human accepts.

**Architecture:** The agent records why it picked each subject (`signals`); a human taps why they skipped (fixed vocabulary). A weekly per-org tick runs a one-split decision stump over those pairs to earn rules, promotes repeats to the seed level, and retires rules that probes contradict. Active rules and recent stats render into one block injected beside `goalWorkSection` at run time. Every tier is deterministic — no LLM anywhere in the miner.

**Tech Stack:** Prisma + Postgres, TypeScript, `node:test` + `tsx`, `@testing-library/react`, Next.js App Router.

**Spec:** `docs/superpowers/specs/2026-07-28-goal-work-learning-design.md`

## Global Constraints

- Test runner: `npm test`. Single file: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <path>`. Typecheck `npm run typecheck`, lint `npm run lint`.
- **No LLM anywhere in the miner.** Every tier is deterministic and countable.
- **Nothing mutates an agent's config.** Tier 3 emits a `UserSuggestion`; a human accepts.
- Thresholds, exact values: `MIN_RULE_SAMPLE = 5`, `MIN_SKIP_RATE = 0.7`, `EVIDENCE_WINDOW_DAYS = 90`, `STATS_WINDOW_DAYS = 30`, `PROMOTE_GOALS = 2`, `EXPLORE_RATE = 0.2`, `RETIRE_PROBE_MIN = 2`, `RETIRE_PROBE_RATE = 0.5`, `UNPROBED_TTL_DAYS = 60`, `CADENCE_SKIP_RATE = 0.6`, `CADENCE_MIN_ITEMS = 10`.
- Skip vocabulary, exactly: `too_early | wrong_contact | wrong_content | already_handled | not_relevant | other`.
- `signals` is flat and untyped. The miner reads numbers and short strings and ignores everything else — never add a schema over it.
- Rule `statement` is prose the agent applies. Code never enforces it; `signal` exists only to dedupe and group.
- Tenant guard: every `update` needs `organizationId` in its where clause — use `updateMany` (see `src/app/api/goals/[id]/recovery/route.ts`).
- `User.id` is a **cuid**, not a uuid. User references are plain `String`.
- A learning failure must never break the cron tick — best-effort `void … .catch(() => undefined)`.
- Copy says *used* and *worked*, never *caused*.

**Task order:** 1 → (2, 3, 4 independent) → 5 → 6 → 7 → 8 → 9. Task 10 (UI) depends only on Task 1 and may run any time after it.

---

### Task 1: Schema — `GoalWorkRule`, `signals`, `probeForRuleId`

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260728180000_goal_work_learning/migration.sql`
- Test: `src/lib/goals/__tests__/goal-work-rule.pg.test.ts`

**Interfaces:**
- Consumes: the existing `GoalWork` model.
- Produces: Prisma models `GoalWorkRule`, and `GoalWork.signals` / `GoalWork.probeForRuleId`.

- [ ] **Step 1: Add the model and columns**

In `prisma/schema.prisma`, add to `GoalWork` after `bodyFormat`:

```prisma
  /// Flat, untyped features the agent used to pick this subject. The miner
  /// reads numbers and short strings and ignores anything else — a schema
  /// over this would be a taxonomy nobody maintains.
  signals        Json?
  /// Set when the agent drafts something an active rule would have
  /// suppressed. The entire falsification mechanism. Deliberately not an FK:
  /// a retired rule's probes must stay readable as history.
  probeForRuleId String?
```

Add the new model beside `GoalWork`:

```prisma
/// A targeting lesson learned from what humans did with an agent's work.
///
/// Level 1: goalId + resourceId set — this agent, on this goal.
/// Level 2: seedKey set, goalId and resourceId null — every deployment of
/// this seed in this org, promoted when the lesson repeats on 2+ goals.
///
/// `statement` is prose the agent applies, not a predicate code enforces: the
/// agent is the only thing that knows a subject's signals BEFORE producing,
/// and enforcing in code would mean producing first and discarding after —
/// wasting exactly the work the rule exists to prevent.
model GoalWorkRule {
  id             String    @id @default(cuid())
  organizationId String    @db.Uuid

  goalId         String?
  resourceId     String?
  seedKey        String?

  signal         String
  statement      String

  skippedCount   Int
  totalCount     Int
  topSkipReason  String?

  status         String    @default("active") // active | retired
  /// Share of suppressed subjects the agent must draft anyway, as probes.
  /// Without this a rule destroys the evidence that would revise it.
  exploreRate    Float     @default(0.2)

  learnedAt      DateTime  @default(now()) @db.Timestamptz(6)
  retiredAt      DateTime? @db.Timestamptz(6)
  retiredReason  String? // 'probes_contradicted' | 'unprobed'

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId, goalId, status])
  @@index([organizationId, seedKey, status])
  @@map("goal_work_rules")
}
```

Add `goalWorkRules GoalWorkRule[]` to the `Organization` model beside `goalWork`.

- [ ] **Step 2: Write the migration**

Create `prisma/migrations/20260728180000_goal_work_learning/migration.sql`:

```sql
ALTER TABLE "goal_work" ADD COLUMN "signals" JSONB;
ALTER TABLE "goal_work" ADD COLUMN "probeForRuleId" TEXT;

CREATE INDEX "goal_work_probeForRuleId_idx" ON "goal_work"("probeForRuleId");

CREATE TABLE "goal_work_rules" (
    "id"             TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "goalId"         TEXT,
    "resourceId"     TEXT,
    "seedKey"        TEXT,
    "signal"         TEXT NOT NULL,
    "statement"      TEXT NOT NULL,
    "skippedCount"   INTEGER NOT NULL,
    "totalCount"     INTEGER NOT NULL,
    "topSkipReason"  TEXT,
    "status"         TEXT NOT NULL DEFAULT 'active',
    "exploreRate"    DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "learnedAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt"      TIMESTAMPTZ(6),
    "retiredReason"  TEXT,
    CONSTRAINT "goal_work_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "goal_work_rules_organizationId_goalId_status_idx"
    ON "goal_work_rules"("organizationId", "goalId", "status");
CREATE INDEX "goal_work_rules_organizationId_seedKey_status_idx"
    ON "goal_work_rules"("organizationId", "seedKey", "status");

-- One ACTIVE rule per signal per scope, so a re-run of the miner updates
-- rather than duplicating. Partial unique — migration-managed, same
-- discipline as goal_work_one_pending_per_subject.
CREATE UNIQUE INDEX "goal_work_rules_one_active_per_scope"
    ON "goal_work_rules"("organizationId", COALESCE("goalId", ''), COALESCE("resourceId", ''), COALESCE("seedKey", ''), "signal")
    WHERE "status" = 'active';

ALTER TABLE "goal_work_rules" ADD CONSTRAINT "goal_work_rules_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Generate and typecheck**

Run: `npx prisma generate && npm run typecheck`
Expected: no new errors. (`src/app/uicheck/page.tsx` has a pre-existing unrelated error about the `'revenue'` goal kind; ignore it.)

- [ ] **Step 4: Write the partial-index test**

Create `src/lib/goals/__tests__/goal-work-rule.pg.test.ts`:

```ts
/**
 * The one-active-rule-per-scope partial index is raw SQL in the migration and
 * invisible to Prisma's types. Requires real Postgres — see the `verify`
 * skill. Inert without TEST_DATABASE_URL so `npm test` stays green.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  const rule = (overrides: Record<string, unknown> = {}) => ({
    organizationId: seeded.organizationId,
    goalId: 'goal-1',
    resourceId: 'agent-1',
    signal: 'daysCold',
    statement: 'Do not draft deals cold under 14 days.',
    skippedCount: 6,
    totalCount: 7,
    ...overrides,
  })

  test('a scope may hold only one ACTIVE rule per signal', async () => {
    await prisma.goalWorkRule.create({ data: rule() })
    await assert.rejects(
      () => prisma.goalWorkRule.create({ data: rule() }),
      /Unique constraint|one_active_per_scope/,
      'a second active rule for the same signal and scope must be rejected',
    )
  })

  test('retiring frees the scope so the lesson can be relearned', async () => {
    const first = await prisma.goalWorkRule.create({ data: rule({ signal: 'stage' }) })
    await prisma.goalWorkRule.updateMany({
      where: { id: first.id, organizationId: seeded.organizationId },
      data: { status: 'retired', retiredAt: new Date(), retiredReason: 'probes_contradicted' },
    })
    const second = await prisma.goalWorkRule.create({ data: rule({ signal: 'stage' }) })
    assert.ok(second.id, 'after retirement the signal is learnable again')
  })

  test('a seed-level rule does not collide with a goal-level rule', async () => {
    // COALESCE in the index means null scope columns compare as '' — the two
    // levels must still be distinguishable.
    await prisma.goalWorkRule.create({ data: rule({ signal: 'contacts' }) })
    const seedLevel = await prisma.goalWorkRule.create({
      data: rule({ signal: 'contacts', goalId: null, resourceId: null, seedKey: 'sales-sequence-personalizer' }),
    })
    assert.ok(seedLevel.id, 'level 1 and level 2 rules coexist')
  })
}
```

- [ ] **Step 5: Run it against real Postgres**

Follow the `verify` skill's throwaway-PG protocol, then:

```bash
TEST_DATABASE_URL=postgresql://qa@127.0.0.1:54339/sublime_qa \
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/goal-work-rule.pg.test.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add prisma src/lib/goals/__tests__/goal-work-rule.pg.test.ts
git commit -m "feat(goals): add the GoalWorkRule model and work signals"
```

---

### Task 2: The decision stump

**Files:**
- Create: `src/lib/goals/work-signals.ts`
- Test: `src/lib/goals/__tests__/work-signals.test.ts`

**Interfaces:**
- Consumes: `Disposition` from `@/lib/goals/work-transitions`.
- Produces: `findRuleCandidates(rows: WorkObservation[]): RuleCandidate[]`, with
  `WorkObservation = { disposition: Disposition; skipReason: string | null; signals: Record<string, unknown> | null }`
  and `RuleCandidate = { signal: string; statement: string; skippedCount: number; totalCount: number; topSkipReason: string | null }`.
  Also exports `MIN_RULE_SAMPLE = 5` and `MIN_SKIP_RATE = 0.7`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/goals/__tests__/work-signals.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { findRuleCandidates } from '../work-signals'

const skipped = (signals: Record<string, unknown>, reason = 'too_early') => ({
  disposition: 'skipped' as const,
  skipReason: reason,
  signals,
})
const used = (signals: Record<string, unknown>) => ({
  disposition: 'used' as const,
  skipReason: null,
  signals,
})

test('finds the split that separates skipped from used', () => {
  const rows = [
    skipped({ daysCold: 4 }), skipped({ daysCold: 9 }), skipped({ daysCold: 11 }),
    skipped({ daysCold: 8 }), skipped({ daysCold: 12 }),
    used({ daysCold: 21 }), used({ daysCold: 30 }), used({ daysCold: 45 }),
  ]
  const candidates = findRuleCandidates(rows)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].signal, 'daysCold')
  assert.equal(candidates[0].skippedCount, 5)
  assert.equal(candidates[0].totalCount, 5, 'the band holds only the skipped side')
  assert.match(candidates[0].statement, /under/i)
  assert.equal(candidates[0].topSkipReason, 'too_early')
})

test('a signal that does not separate yields no rule', () => {
  // Skipped and used are interleaved — no split is clean enough.
  const rows = [
    skipped({ daysCold: 5 }), used({ daysCold: 6 }),
    skipped({ daysCold: 7 }), used({ daysCold: 8 }),
    skipped({ daysCold: 9 }), used({ daysCold: 10 }),
    skipped({ daysCold: 11 }), used({ daysCold: 12 }),
  ]
  assert.deepEqual(findRuleCandidates(rows), [])
})

test('a band below MIN_RULE_SAMPLE never becomes a rule', () => {
  // 4 skipped, cleanly separated — but one bad week must not invent a rule.
  const rows = [
    skipped({ daysCold: 2 }), skipped({ daysCold: 3 }),
    skipped({ daysCold: 4 }), skipped({ daysCold: 5 }),
    used({ daysCold: 40 }), used({ daysCold: 50 }),
  ]
  assert.deepEqual(findRuleCandidates(rows), [])
})

test('a band below MIN_SKIP_RATE never becomes a rule', () => {
  // 5 in the band but only 3 skipped = 0.6 — a rule should be nearly always right.
  const rows = [
    skipped({ daysCold: 1 }), skipped({ daysCold: 2 }), skipped({ daysCold: 3 }),
    used({ daysCold: 4 }), used({ daysCold: 5 }),
    used({ daysCold: 40 }), used({ daysCold: 50 }), used({ daysCold: 60 }),
  ]
  assert.deepEqual(findRuleCandidates(rows), [])
})

test('categorical signals count per value', () => {
  const rows = [
    skipped({ stage: 'prospecting' }, 'not_relevant'),
    skipped({ stage: 'prospecting' }, 'not_relevant'),
    skipped({ stage: 'prospecting' }, 'not_relevant'),
    skipped({ stage: 'prospecting' }, 'wrong_contact'),
    skipped({ stage: 'prospecting' }, 'not_relevant'),
    used({ stage: 'negotiation' }), used({ stage: 'negotiation' }),
  ]
  const candidates = findRuleCandidates(rows)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].signal, 'stage')
  assert.match(candidates[0].statement, /prospecting/)
  assert.equal(candidates[0].topSkipReason, 'not_relevant', 'the most common reason wins')
})

test('rows with no signals are ignored without throwing', () => {
  const rows = [
    { disposition: 'skipped' as const, skipReason: 'too_early', signals: null },
    { disposition: 'used' as const, skipReason: null, signals: {} },
  ]
  assert.deepEqual(findRuleCandidates(rows), [])
})

test('non-numeric, non-string signal values are ignored', () => {
  // Nested objects and arrays are not something a statement can describe.
  const rows = Array.from({ length: 6 }, () =>
    skipped({ nested: { a: 1 }, list: [1, 2], ok: 3 }),
  )
  const signals = findRuleCandidates(rows).map((candidate) => candidate.signal)
  assert.equal(signals.includes('nested'), false)
  assert.equal(signals.includes('list'), false)
})

test('pending and edited rows never count as evidence', () => {
  // Only a settled human decision is evidence. `pending` means nobody looked.
  const rows = [
    ...Array.from({ length: 6 }, () => ({
      disposition: 'pending' as const, skipReason: null, signals: { daysCold: 3 },
    })),
    used({ daysCold: 40 }),
  ]
  assert.deepEqual(findRuleCandidates(rows), [])
})

test('several separating signals each yield a candidate', () => {
  const rows = [
    ...Array.from({ length: 5 }, () => skipped({ daysCold: 3, contacts: 1 })),
    used({ daysCold: 40, contacts: 5 }), used({ daysCold: 50, contacts: 6 }),
  ]
  const signals = findRuleCandidates(rows).map((candidate) => candidate.signal).sort()
  assert.deepEqual(signals, ['contacts', 'daysCold'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/work-signals.test.ts`
Expected: FAIL — cannot find module `../work-signals`.

- [ ] **Step 3: Implement**

Create `src/lib/goals/work-signals.ts`:

```ts
/**
 * Turns settled work into targeting rule candidates. Pure, deterministic, no
 * LLM — a rule the team can read, argue with, and later disprove.
 *
 * The algorithm is a ONE-SPLIT DECISION STUMP, chosen because it is exactly
 * the shape of the statement we want to produce. "Deals under 14 days cold"
 * is actionable; a correlation coefficient is not.
 *
 * Only settled human decisions count as evidence. `pending` means nobody
 * looked yet, and treating silence as rejection would teach the agent to stop
 * producing work simply because the queue is backed up.
 */
import type { Disposition } from '@/lib/goals/work-transitions'

export const MIN_RULE_SAMPLE = 5
export const MIN_SKIP_RATE = 0.7

export type WorkObservation = {
  disposition: Disposition
  skipReason: string | null
  signals: Record<string, unknown> | null
}

export type RuleCandidate = {
  signal: string
  statement: string
  /** Skipped rows inside the band the statement describes. */
  skippedCount: number
  /** All rows inside that band. */
  totalCount: number
  topSkipReason: string | null
}

type Settled = { skipped: boolean; skipReason: string | null; value: number | string }

const isSettled = (disposition: Disposition) =>
  disposition === 'skipped' || disposition === 'used' || disposition === 'edited'

/** Only values a statement can describe. */
function usableValue(raw: unknown): number | string | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.length > 0 && raw.length <= 64) return raw
  return null
}

function topReason(rows: Settled[]): string | null {
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (!row.skipped || !row.skipReason) continue
    counts.set(row.skipReason, (counts.get(row.skipReason) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 0
  // Sorted for determinism: an arbitrary tie-break would make the same input
  // produce different statements between runs.
  for (const [reason, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > bestCount) {
      best = reason
      bestCount = count
    }
  }
  return best
}

function qualifies(band: Settled[]): boolean {
  if (band.length < MIN_RULE_SAMPLE) return false
  const skipped = band.filter((row) => row.skipped).length
  return skipped / band.length >= MIN_SKIP_RATE
}

function candidateFrom(signal: string, band: Settled[], statement: string): RuleCandidate {
  return {
    signal,
    statement,
    skippedCount: band.filter((row) => row.skipped).length,
    totalCount: band.length,
    topSkipReason: topReason(band),
  }
}

/** Numeric: try every midpoint, keep the qualifying split with the most evidence. */
function numericCandidate(signal: string, rows: Settled[]): RuleCandidate | null {
  const values = [...new Set(rows.map((row) => row.value as number))].sort((a, b) => a - b)
  let best: RuleCandidate | null = null

  for (let index = 0; index < values.length - 1; index += 1) {
    const split = (values[index] + values[index + 1]) / 2
    for (const [side, band] of [
      ['under', rows.filter((row) => (row.value as number) < split)],
      ['over', rows.filter((row) => (row.value as number) >= split)],
    ] as const) {
      if (!qualifies(band)) continue
      const statement =
        side === 'under'
          ? `Do not work subjects whose ${signal} is under ${split}.`
          : `Do not work subjects whose ${signal} is ${split} or more.`
      const candidate = candidateFrom(signal, band, statement)
      // More evidence wins; ties break toward the purer band.
      if (
        !best ||
        candidate.totalCount > best.totalCount ||
        (candidate.totalCount === best.totalCount &&
          candidate.skippedCount > best.skippedCount)
      ) {
        best = candidate
      }
    }
  }
  return best
}

/** Categorical: each distinct value is its own band. */
function categoricalCandidate(signal: string, rows: Settled[]): RuleCandidate | null {
  let best: RuleCandidate | null = null
  const values = [...new Set(rows.map((row) => row.value as string))].sort()

  for (const value of values) {
    const band = rows.filter((row) => row.value === value)
    if (!qualifies(band)) continue
    const candidate = candidateFrom(
      signal,
      band,
      `Do not work subjects whose ${signal} is "${value}".`,
    )
    if (!best || candidate.totalCount > best.totalCount) best = candidate
  }
  return best
}

export function findRuleCandidates(rows: WorkObservation[]): RuleCandidate[] {
  const bySignal = new Map<string, Settled[]>()

  for (const row of rows) {
    if (!isSettled(row.disposition) || !row.signals) continue
    for (const [key, raw] of Object.entries(row.signals)) {
      const value = usableValue(raw)
      if (value === null) continue
      const bucket = bySignal.get(key) ?? []
      bucket.push({ skipped: row.disposition === 'skipped', skipReason: row.skipReason, value })
      bySignal.set(key, bucket)
    }
  }

  const candidates: RuleCandidate[] = []
  for (const [signal, values] of [...bySignal.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (values.length < MIN_RULE_SAMPLE) continue
    // A signal that arrives as both a number and a string is drifting; skip it
    // rather than comparing across types.
    const allNumeric = values.every((row) => typeof row.value === 'number')
    const allString = values.every((row) => typeof row.value === 'string')
    const candidate = allNumeric
      ? numericCandidate(signal, values)
      : allString
        ? categoricalCandidate(signal, values)
        : null
    if (candidate) candidates.push(candidate)
  }
  return candidates
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/work-signals.test.ts`
Expected: PASS, 9 tests.

If the first test's `statement` assertion fails on the split value's formatting (e.g. `13.5` vs `14`), do NOT round in the implementation — midpoints are genuinely fractional. Relax that one assertion to match `/under/i` only, which is what it already does.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/lib/goals/work-signals.ts src/lib/goals/__tests__/work-signals.test.ts
git commit -m "feat(goals): decision-stump miner for work targeting rules"
```

---

### Task 3: Rule lifecycle decisions

**Files:**
- Create: `src/lib/goals/work-rules.ts`
- Test: `src/lib/goals/__tests__/work-rules.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `rulesToRetire(rules: ExistingRule[], tallies: ProbeTally[], now: Date): RetireDecision[]` and `rulesToPromote(rules: ExistingRule[]): PromotionDecision[]`, with
  `ExistingRule = { id: string; signal: string; statement: string; goalId: string | null; seedKey: string | null; agentSeedKey: string | null; learnedAt: Date }`,
  `ProbeTally = { ruleId: string; probes: number; used: number }`,
  `RetireDecision = { ruleId: string; reason: 'probes_contradicted' | 'unprobed' }`,
  `PromotionDecision = { seedKey: string; signal: string; statement: string; fromGoalIds: string[] }`.
  Also exports `PROMOTE_GOALS`, `RETIRE_PROBE_MIN`, `RETIRE_PROBE_RATE`, `UNPROBED_TTL_DAYS`, `EXPLORE_RATE`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/goals/__tests__/work-rules.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { rulesToRetire, rulesToPromote, UNPROBED_TTL_DAYS } from '../work-rules'

const NOW = new Date('2026-07-28T00:00:00Z')
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)

const rule = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  signal: 'daysCold',
  statement: 'Do not work subjects whose daysCold is under 14.',
  goalId: 'goal-1',
  seedKey: null,
  agentSeedKey: 'sales-sequence-personalizer',
  learnedAt: daysAgo(10),
  ...overrides,
})

test('probes that come back used retire the rule', () => {
  const decisions = rulesToRetire([rule()], [{ ruleId: 'r1', probes: 4, used: 3 }], NOW)
  assert.deepEqual(decisions, [{ ruleId: 'r1', reason: 'probes_contradicted' }])
})

test('one used probe is not enough to retire', () => {
  // A single item landing is a fluke, not evidence.
  assert.deepEqual(rulesToRetire([rule()], [{ ruleId: 'r1', probes: 4, used: 1 }], NOW), [])
})

test('probes that confirm the rule leave it standing', () => {
  assert.deepEqual(rulesToRetire([rule()], [{ ruleId: 'r1', probes: 5, used: 0 }], NOW), [])
})

test('a rule nobody probed retires once the TTL passes', () => {
  // The agent ignoring the probe instruction reintroduces the exact
  // calcification the explore allowance exists to prevent.
  const stale = rule({ learnedAt: daysAgo(UNPROBED_TTL_DAYS + 1) })
  assert.deepEqual(rulesToRetire([stale], [], NOW), [
    { ruleId: 'r1', reason: 'unprobed' },
  ])
})

test('an unprobed rule inside the TTL is left alone', () => {
  const fresh = rule({ learnedAt: daysAgo(UNPROBED_TTL_DAYS - 1) })
  assert.deepEqual(rulesToRetire([fresh], [], NOW), [])
})

test('an old rule WITH probes is judged on the probes, not the clock', () => {
  const old = rule({ learnedAt: daysAgo(UNPROBED_TTL_DAYS + 30) })
  assert.deepEqual(rulesToRetire([old], [{ ruleId: 'r1', probes: 6, used: 0 }], NOW), [])
})

test('the same lesson on two goals promotes to the seed', () => {
  const decisions = rulesToPromote([
    rule({ id: 'r1', goalId: 'goal-1' }),
    rule({ id: 'r2', goalId: 'goal-2' }),
  ])
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].seedKey, 'sales-sequence-personalizer')
  assert.equal(decisions[0].signal, 'daysCold')
  assert.deepEqual(decisions[0].fromGoalIds.sort(), ['goal-1', 'goal-2'])
})

test('one goal is a quirk, not an org lesson', () => {
  assert.deepEqual(rulesToPromote([rule({ id: 'r1', goalId: 'goal-1' })]), [])
})

test('two rules on the SAME goal do not promote', () => {
  // Distinct goals is the bar; the same goal twice is one observation.
  assert.deepEqual(
    rulesToPromote([rule({ id: 'r1', goalId: 'goal-1' }), rule({ id: 'r2', goalId: 'goal-1' })]),
    [],
  )
})

test('rules from agents without a seed never promote', () => {
  // Nothing to attach an org-wide lesson to.
  assert.deepEqual(
    rulesToPromote([
      rule({ id: 'r1', goalId: 'goal-1', agentSeedKey: null }),
      rule({ id: 'r2', goalId: 'goal-2', agentSeedKey: null }),
    ]),
    [],
  )
})

test('already-promoted seed rules are not re-promoted', () => {
  // A level-2 rule has no goalId and must be excluded from the tally.
  assert.deepEqual(
    rulesToPromote([
      rule({ id: 'r1', goalId: null, seedKey: 'sales-sequence-personalizer' }),
      rule({ id: 'r2', goalId: 'goal-1' }),
    ]),
    [],
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/work-rules.test.ts`
Expected: FAIL — cannot find module `../work-rules`.

- [ ] **Step 3: Implement**

Create `src/lib/goals/work-rules.ts`:

```ts
/**
 * When a learned rule is promoted, and when it dies. Pure so every threshold
 * is testable without a database.
 *
 * The design problem this solves: a rule that suppresses a category destroys
 * the evidence that would revise it. Once "skip deals cold under 14 days" is
 * enforced, none are ever drafted, so nothing can ever show that the sales
 * cycle changed. The explore allowance produces probes; these functions read
 * them back.
 */

export const PROMOTE_GOALS = 2
export const RETIRE_PROBE_MIN = 2
export const RETIRE_PROBE_RATE = 0.5
export const UNPROBED_TTL_DAYS = 60
export const EXPLORE_RATE = 0.2

const DAY_MS = 24 * 60 * 60 * 1000

export type ExistingRule = {
  id: string
  signal: string
  statement: string
  goalId: string | null
  seedKey: string | null
  /** The seed the rule's agent was deployed from, for promotion. */
  agentSeedKey: string | null
  learnedAt: Date
}

export type ProbeTally = { ruleId: string; probes: number; used: number }

export type RetireDecision = { ruleId: string; reason: 'probes_contradicted' | 'unprobed' }

export type PromotionDecision = {
  seedKey: string
  signal: string
  statement: string
  fromGoalIds: string[]
}

export function rulesToRetire(
  rules: ExistingRule[],
  tallies: ProbeTally[],
  now: Date,
): RetireDecision[] {
  const byRule = new Map(tallies.map((tally) => [tally.ruleId, tally] as const))
  const decisions: RetireDecision[] = []

  for (const rule of rules) {
    const tally = byRule.get(rule.id)

    if (!tally || tally.probes === 0) {
      // Never trust a belief you stopped testing — even when the reason you
      // stopped was an agent not cooperating.
      if (now.getTime() - rule.learnedAt.getTime() >= UNPROBED_TTL_DAYS * DAY_MS) {
        decisions.push({ ruleId: rule.id, reason: 'unprobed' })
      }
      continue
    }

    if (tally.used >= RETIRE_PROBE_MIN && tally.used / tally.probes >= RETIRE_PROBE_RATE) {
      decisions.push({ ruleId: rule.id, reason: 'probes_contradicted' })
    }
  }

  return decisions
}

export function rulesToPromote(rules: ExistingRule[]): PromotionDecision[] {
  // Group level-1 rules (goalId set) by the seed their agent came from.
  const groups = new Map<string, { statement: string; goalIds: Set<string> }>()

  for (const rule of rules) {
    if (!rule.goalId || !rule.agentSeedKey) continue
    const key = `${rule.agentSeedKey} ${rule.signal}`
    const group = groups.get(key) ?? { statement: rule.statement, goalIds: new Set<string>() }
    group.goalIds.add(rule.goalId)
    groups.set(key, group)
  }

  // A seed-level rule that already exists for this (seed, signal) means the
  // lesson was promoted before; do not promote it again.
  const promoted = new Set(
    rules
      .filter((rule) => rule.seedKey && !rule.goalId)
      .map((rule) => `${rule.seedKey} ${rule.signal}`),
  )

  const decisions: PromotionDecision[] = []
  for (const [key, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (promoted.has(key)) continue
    if (group.goalIds.size < PROMOTE_GOALS) continue
    const [seedKey, signal] = key.split(' ')
    decisions.push({
      seedKey,
      signal,
      statement: group.statement,
      fromGoalIds: [...group.goalIds].sort(),
    })
  }
  return decisions
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/work-rules.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/lib/goals/work-rules.ts src/lib/goals/__tests__/work-rules.test.ts
git commit -m "feat(goals): rule promotion and retirement decisions"
```

---

### Task 4: The feedback renderer

**Files:**
- Create: `src/lib/goals/work-feedback.ts`
- Test: `src/lib/goals/__tests__/work-feedback.test.ts`

**Interfaces:**
- Consumes: `WorkFunnel` from `@/lib/goals/work-stats`.
- Produces: `renderWorkFeedback(input: FeedbackInput): string` with
  `FeedbackInput = { goalName: string; stats: WorkFunnel; skipReasons: Array<{ reason: string; count: number }>; rules: FeedbackRule[] }`
  and `FeedbackRule = { id: string; statement: string; skippedCount: number; totalCount: number; topSkipReason: string | null; exploreRate: number }`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/goals/__tests__/work-feedback.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderWorkFeedback } from '../work-feedback'

const stats = { produced: 18, used: 14, worked: 6, usedRate: 14 / 18, workedRate: 6 / 14 }
const empty = { produced: 0, used: 0, worked: 0, usedRate: null, workedRate: null }

const rule = {
  id: 'rul_8f2',
  statement: 'Do not work subjects whose daysCold is under 14.',
  skippedCount: 6,
  totalCount: 7,
  topSkipReason: 'too_early',
  exploreRate: 0.2,
}

test('with no work at all it renders nothing', () => {
  // A block that says "0 produced" on a brand-new goal is noise, not feedback.
  assert.equal(
    renderWorkFeedback({ goalName: 'Revive stalled deals', stats: empty, skipReasons: [], rules: [] }),
    '',
  )
})

test('stats alone render without a rules section', () => {
  const block = renderWorkFeedback({
    goalName: 'Revive stalled deals',
    stats,
    skipReasons: [{ reason: 'too_early', count: 3 }, { reason: 'wrong_contact', count: 1 }],
    rules: [],
  })
  assert.match(block, /^## What your work has taught us/)
  assert.match(block, /18 produced/)
  assert.match(block, /14 used/)
  assert.match(block, /6 worked/)
  assert.match(block, /too early ×3/)
  assert.equal(/Rules you must follow/.test(block), false)
})

test('rules render with their evidence and a probe instruction carrying the real id', () => {
  const block = renderWorkFeedback({
    goalName: 'Revive stalled deals',
    stats,
    skipReasons: [{ reason: 'too_early', count: 3 }],
    rules: [rule],
  })
  assert.match(block, /Rules you must follow/)
  assert.match(block, /Do not work subjects whose daysCold is under 14\./)
  assert.match(block, /6 of 7 skipped/)
  assert.match(block, /too early/)
  // The probe instruction is the whole falsification mechanism — without the
  // real rule id the agent cannot label a probe and the rule can never die.
  assert.match(block, /probeRuleId "rul_8f2"/)
  assert.match(block, /1 in 5/)
})

test('the explore rate is rendered as a ratio the agent can act on', () => {
  const block = renderWorkFeedback({
    goalName: 'G',
    stats,
    skipReasons: [],
    rules: [{ ...rule, exploreRate: 0.25 }],
  })
  assert.match(block, /1 in 4/)
})

test('skip reasons render as human words, never raw enum values', () => {
  const block = renderWorkFeedback({
    goalName: 'G',
    stats,
    skipReasons: [{ reason: 'already_handled', count: 2 }],
    rules: [],
  })
  assert.match(block, /already handled ×2/)
  assert.equal(/already_handled/.test(block), false)
})

test('it never claims the work caused anything', () => {
  const block = renderWorkFeedback({
    goalName: 'G',
    stats,
    skipReasons: [{ reason: 'too_early', count: 3 }],
    rules: [rule],
  })
  assert.equal(/caused/i.test(block), false)
})

test('rules render even when the stats window is empty', () => {
  // A rule learned from 90 days of evidence outlives a quiet 30-day window.
  const block = renderWorkFeedback({
    goalName: 'G',
    stats: empty,
    skipReasons: [],
    rules: [rule],
  })
  assert.match(block, /Rules you must follow/)
  assert.equal(/0 produced/.test(block), false, 'a dead stats line must be omitted')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/work-feedback.test.ts`
Expected: FAIL — cannot find module `../work-feedback`.

- [ ] **Step 3: Implement**

Create `src/lib/goals/work-feedback.ts`:

```ts
/**
 * The block injected into a goal-linked agent's prompt: what its work has
 * taught us, and the rules that follow from it. Pure so the copy is testable
 * and so nothing here can reach a database mid-run.
 *
 * Deliberately descriptive. It reports what people did with the work and what
 * they said happened next; it never claims the work CAUSED the goal to move.
 */
import type { WorkFunnel } from '@/lib/goals/work-stats'

export type FeedbackRule = {
  id: string
  statement: string
  skippedCount: number
  totalCount: number
  topSkipReason: string | null
  exploreRate: number
}

export type FeedbackInput = {
  goalName: string
  stats: WorkFunnel
  skipReasons: Array<{ reason: string; count: number }>
  rules: FeedbackRule[]
}

/** Raw enum values must never reach a prompt — they read as internal state. */
const REASON_WORDS: Record<string, string> = {
  too_early: 'too early',
  wrong_contact: 'wrong contact',
  wrong_content: 'wrong content',
  already_handled: 'already handled',
  not_relevant: 'not relevant',
  other: 'other',
}

const humanReason = (reason: string) => REASON_WORDS[reason] ?? reason.replace(/_/g, ' ')

/** 0.2 → "1 in 5". A decimal in a prompt invites the model to reinterpret it. */
function asRatio(rate: number): string {
  const denominator = Math.max(2, Math.round(1 / (rate > 0 ? rate : 0.2)))
  return `1 in ${denominator}`
}

export function renderWorkFeedback(input: FeedbackInput): string {
  const hasStats = input.stats.produced > 0
  if (!hasStats && input.rules.length === 0) return ''

  const lines = ['## What your work has taught us']

  if (hasStats) {
    const { produced, used, worked } = input.stats
    lines.push(
      '',
      `On this goal, your last 30 days: ${produced} produced · ${used} used · ${worked} worked.`,
    )
    const skipped = produced - used
    if (skipped > 0 && input.skipReasons.length > 0) {
      const reasons = input.skipReasons
        .map((entry) => `${humanReason(entry.reason)} ×${entry.count}`)
        .join(', ')
      lines.push(`People skipped ${skipped} — reasons: ${reasons}.`)
    }
  }

  if (input.rules.length > 0) {
    lines.push('', 'Rules you must follow:')
    for (const rule of input.rules) {
      lines.push(`- ${rule.statement}`)
      const reason = rule.topSkipReason ? `, mostly "${humanReason(rule.topSkipReason)}"` : ''
      lines.push(`  (${rule.skippedCount} of ${rule.totalCount} skipped${reason})`)
      lines.push(
        `  Probe: work roughly ${asRatio(rule.exploreRate)} of these anyway and pass ` +
          `probeRuleId "${rule.id}" to log_work, so we find out if this still holds.`,
      )
    }
  }

  return lines.join('\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/work-feedback.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/lib/goals/work-feedback.ts src/lib/goals/__tests__/work-feedback.test.ts
git commit -m "feat(goals): render the work feedback block"
```

---

### Task 5: `signals` and `probeRuleId` on `log_work`

**Files:**
- Modify: `src/lib/integrations/goals.ts` (tool schema, `WriteWorkInput`, handler)
- Modify: `src/lib/integrations/goals-port.ts` (`writeWork`)
- Test: `src/lib/integrations/__tests__/goals.test.ts`

**Interfaces:**
- Consumes: `WriteWorkInput` from the ledger spec.
- Produces: `WriteWorkInput` gains `signals: Record<string, unknown> | null` and `probeRuleId: string | null`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/integrations/__tests__/goals.test.ts`:

```ts
test('log_work carries signals and a probe rule id through to the port', async () => {
  const port = fakePort({ 'goal-a': goalView() })
  const client = new GoalsToolClient(['goal-a'], port, () => NOW)

  await client.executeTool('', 'log_work', {
    subject: 'Acme — deal 412',
    produced: 're-entry email',
    body: 'x',
    signals: { daysCold: 21, stage: 'negotiation' },
    probeRuleId: 'rul_8f2',
  })

  assert.deepEqual(port.workWrites[0].input.signals, { daysCold: 21, stage: 'negotiation' })
  assert.equal(port.workWrites[0].input.probeRuleId, 'rul_8f2')
})

test('log_work without signals stores null rather than an empty object', async () => {
  // An empty object would look like "the agent reported no features", which
  // is different from "the agent reported nothing".
  const port = fakePort({ 'goal-a': goalView() })
  const client = new GoalsToolClient(['goal-a'], port, () => NOW)
  await client.executeTool('', 'log_work', { subject: 'A', produced: 'b', body: 'c' })
  assert.equal(port.workWrites[0].input.signals, null)
  assert.equal(port.workWrites[0].input.probeRuleId, null)
})

test('log_work rejects non-object signals instead of storing junk', async () => {
  const port = fakePort({ 'goal-a': goalView() })
  const client = new GoalsToolClient(['goal-a'], port, () => NOW)
  await assert.rejects(
    () =>
      client.executeTool('', 'log_work', {
        subject: 'A', produced: 'b', body: 'c', signals: 'daysCold=21',
      }),
    /signals/i,
  )
})

test('the log_work schema documents signals and probeRuleId', async () => {
  const tool = goalsTools().find((entry) => entry.name === 'log_work')!
  const properties = (tool.inputSchema as { properties: Record<string, unknown> }).properties
  assert.ok(properties.signals, 'signals must be discoverable in the schema')
  assert.ok(properties.probeRuleId, 'probeRuleId must be discoverable in the schema')
})
```

Extend the `fakePort` helper's `writeWork` so the assertions can read the new fields — it already records `input` verbatim, so no change is needed there.

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/integrations/__tests__/goals.test.ts`
Expected: FAIL — `signals` is `undefined` on the recorded input.

- [ ] **Step 3: Extend the type and tool schema**

In `src/lib/integrations/goals.ts`, add to `WriteWorkInput`:

```ts
  /** Flat features the agent used to pick this subject. Null when it reported
   *  none — distinct from an empty object, which would mean "no features". */
  signals: Record<string, unknown> | null
  /** Set when this item is a probe against an active rule. */
  probeRuleId: string | null
```

Add to the `log_work` tool's `properties`:

```ts
          signals: {
            type: 'object',
            description:
              'Why you picked THIS subject — the features you judged it on, as a flat object: {"daysCold": 21, "stage": "negotiation", "contacts": 3}. This is what lets the team learn which targeting works, so record the numbers you actually used, not a summary.',
          },
          probeRuleId: {
            type: 'string',
            description:
              'Only when you are deliberately working a subject a stated rule tells you to skip, to test whether that rule still holds. Pass the rule id from your instructions.',
          },
```

- [ ] **Step 4: Extend the handler**

In the `log_work` branch of `executeTool`, before calling `this.port.writeWork`:

```ts
      const rawSignals = args.signals
      if (
        rawSignals !== undefined &&
        rawSignals !== null &&
        (typeof rawSignals !== 'object' || Array.isArray(rawSignals))
      ) {
        throw new Error('signals must be a flat object of the features you judged this subject on')
      }
```

and pass through:

```ts
        signals: (rawSignals as Record<string, unknown> | undefined) ?? null,
        probeRuleId: args.probeRuleId ? String(args.probeRuleId) : null,
```

- [ ] **Step 5: Persist them in the port**

In `goals-port.ts`'s `writeWork`, add to the `data` object:

```ts
          signals: input.signals === null ? undefined : (input.signals as object),
          probeForRuleId: input.probeRuleId,
```

`undefined` rather than `null` for signals so Prisma omits the column entirely
rather than writing SQL NULL over a JSON column — both read back as null.

- [ ] **Step 6: Run tests and typecheck**

```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/integrations/__tests__/goals.test.ts
npm run typecheck
```
Expected: PASS. Typecheck will flag any other fake port missing the new fields — add them.

- [ ] **Step 7: Commit**

```bash
git add src/lib/integrations
git commit -m "feat(goals): agents record why they picked a subject"
```

---

### Task 6: Load feedback for a run

**Files:**
- Create: `src/lib/goals/work-rules-port.ts`
- Test: `src/app/api/goals/__tests__/work-learning.pg.test.ts`

**Interfaces:**
- Consumes: `FeedbackInput` (Task 4), `computeWorkStats` (ledger spec), `STATS_WINDOW_DAYS`.
- Produces: `loadWorkFeedback(organizationId: string, goalId: string, resourceId: string): Promise<FeedbackInput | null>`.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/goals/__tests__/work-learning.pg.test.ts`:

```ts
/**
 * Real-Postgres drive for the learning loader. Inert without
 * TEST_DATABASE_URL. Proves org scoping, level-1-over-level-2 precedence,
 * and that retired rules never reach a prompt.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let goalId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
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
    goalId = goal.id
    await prisma.goalContribution.create({
      data: {
        organizationId: seeded.organizationId,
        goalId,
        resourceType: 'agent',
        resourceId: 'agent-1',
        origin: 'manual',
        seedKey: 'sales-sequence-personalizer',
      },
    })
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  test('a goal with no work and no rules yields null, not an empty block', async () => {
    const { loadWorkFeedback } = await import('@/lib/goals/work-rules-port')
    assert.equal(await loadWorkFeedback(seeded.organizationId, goalId, 'agent-1'), null)
  })

  test('active rules load; retired ones never do', async () => {
    const base = {
      organizationId: seeded.organizationId,
      goalId,
      resourceId: 'agent-1',
      skippedCount: 6,
      totalCount: 7,
    }
    await prisma.goalWorkRule.create({
      data: { ...base, signal: 'daysCold', statement: 'Skip cold under 14.' },
    })
    await prisma.goalWorkRule.create({
      data: {
        ...base, signal: 'contacts', statement: 'Skip single-contact deals.',
        status: 'retired', retiredAt: new Date(), retiredReason: 'probes_contradicted',
      },
    })

    const feedback = await loadFeedback()
    const statements = feedback!.rules.map((rule: { statement: string }) => rule.statement)
    assert.deepEqual(statements, ['Skip cold under 14.'])
  })

  test('a level-1 rule wins over a level-2 rule on the same signal', async () => {
    await prisma.goalWorkRule.create({
      data: {
        organizationId: seeded.organizationId,
        goalId: null, resourceId: null, seedKey: 'sales-sequence-personalizer',
        signal: 'daysCold', statement: 'Org-wide: skip cold under 30.',
        skippedCount: 10, totalCount: 12,
      },
    })
    const feedback = await loadFeedback()
    const statements = feedback!.rules.map((rule: { statement: string }) => rule.statement)
    assert.ok(statements.includes('Skip cold under 14.'), 'the narrower rule survives')
    assert.equal(
      statements.includes('Org-wide: skip cold under 30.'),
      false,
      'the seed-level rule on the same signal is dropped',
    )
  })

  test('another org with identical rules never leaks in', async () => {
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    const other = await seedTestOrg(prisma)
    await prisma.goalWorkRule.create({
      data: {
        organizationId: other.organizationId,
        goalId, resourceId: 'agent-1',
        signal: 'stage', statement: 'THEIRS — must never appear.',
        skippedCount: 9, totalCount: 9,
      },
    })
    const feedback = await loadFeedback()
    const statements = feedback!.rules.map((rule: { statement: string }) => rule.statement)
    assert.equal(statements.some((s: string) => s.includes('THEIRS')), false)
    await other.cleanup()
    const { installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    installTestAuth(seeded.auth)
  })

  async function loadFeedback() {
    const { loadWorkFeedback } = await import('@/lib/goals/work-rules-port')
    return loadWorkFeedback(seeded.organizationId, goalId, 'agent-1')
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run with `TEST_DATABASE_URL` set. Expected: FAIL — cannot find `work-rules-port`.

- [ ] **Step 3: Implement**

Create `src/lib/goals/work-rules-port.ts`:

```ts
/**
 * Loads everything a run needs to render its feedback block: the recent
 * funnel, why people skipped, and the rules in force.
 *
 * Both rule levels apply. A level-2 (seed-wide) rule about a signal a level-1
 * (this agent, this goal) rule already covers is dropped — the narrower
 * observation was made where the work actually happens.
 */
import { prisma } from '@/lib/prisma'
import { computeWorkStats } from '@/lib/goals/work-stats'
import type { Disposition, Outcome } from '@/lib/goals/work-transitions'
import type { FeedbackInput, FeedbackRule } from '@/lib/goals/work-feedback'

export const STATS_WINDOW_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

export async function loadWorkFeedback(
  organizationId: string,
  goalId: string,
  resourceId: string,
): Promise<FeedbackInput | null> {
  const goal = await prisma.goal.findFirst({
    where: { id: goalId, organizationId },
    select: { name: true },
  })
  if (!goal) return null

  const since = new Date(Date.now() - STATS_WINDOW_DAYS * DAY_MS)
  const rows = await prisma.goalWork.findMany({
    where: { organizationId, goalId, resourceId, createdAt: { gte: since } },
    select: { disposition: true, outcome: true, skipReason: true },
  })

  const stats = computeWorkStats(
    rows.map((row) => ({
      resourceId,
      resourceName: '',
      disposition: row.disposition as Disposition,
      outcome: row.outcome as Outcome,
    })),
  ).overall

  const reasonCounts = new Map<string, number>()
  for (const row of rows) {
    if (row.disposition !== 'skipped' || !row.skipReason) continue
    reasonCounts.set(row.skipReason, (reasonCounts.get(row.skipReason) ?? 0) + 1)
  }
  const skipReasons = [...reasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))

  const contribution = await prisma.goalContribution.findFirst({
    where: { organizationId, goalId, resourceId },
    select: { seedKey: true },
  })

  const [level1, level2] = await Promise.all([
    prisma.goalWorkRule.findMany({
      where: { organizationId, goalId, resourceId, status: 'active' },
      orderBy: { learnedAt: 'asc' },
    }),
    contribution?.seedKey
      ? prisma.goalWorkRule.findMany({
          where: { organizationId, seedKey: contribution.seedKey, goalId: null, status: 'active' },
          orderBy: { learnedAt: 'asc' },
        })
      : Promise.resolve([]),
  ])

  const covered = new Set(level1.map((rule) => rule.signal))
  const toFeedbackRule = (rule: (typeof level1)[number]): FeedbackRule => ({
    id: rule.id,
    statement: rule.statement,
    skippedCount: rule.skippedCount,
    totalCount: rule.totalCount,
    topSkipReason: rule.topSkipReason,
    exploreRate: rule.exploreRate,
  })

  const rules = [
    ...level1.map(toFeedbackRule),
    ...level2.filter((rule) => !covered.has(rule.signal)).map(toFeedbackRule),
  ]

  if (stats.produced === 0 && rules.length === 0) return null
  return { goalName: goal.name, stats, skipReasons, rules }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run with `TEST_DATABASE_URL` set. Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/lib/goals/work-rules-port.ts src/app/api/goals/__tests__/work-learning.pg.test.ts
git commit -m "feat(goals): load work feedback and the rules in force"
```

---

### Task 7: Inject the block at run time

**Files:**
- Modify: `src/features/agents/execute-agent.ts`
- Test: `src/features/agents/__tests__/goals-plane.test.ts`

**Interfaces:**
- Consumes: `loadWorkFeedback` (Task 6), `renderWorkFeedback` (Task 4), `resolveLinkedGoalIds`.
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test**

Append to `src/features/agents/__tests__/goals-plane.test.ts`:

```ts
test('the feedback block and the goal-work instruction are separate blocks', async () => {
  // goalWorkSection tells the agent HOW to log; the feedback block tells it
  // WHAT it has learned. Merging them would mean an agent with no history
  // loses its logging instructions.
  const { renderWorkFeedback } = await import('@/lib/goals/work-feedback')
  const instruction = goalWorkSection(goalsTools())
  const feedback = renderWorkFeedback({
    goalName: 'G',
    stats: { produced: 0, used: 0, worked: 0, usedRate: null, workedRate: null },
    skipReasons: [],
    rules: [],
  })
  assert.ok(instruction, 'logging instructions exist regardless of history')
  assert.equal(feedback, '', 'no history means no feedback block')
})
```

- [ ] **Step 2: Run test to verify it passes trivially, then wire the injection**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/agents/__tests__/goals-plane.test.ts`
Expected: PASS. This test guards the separation; the wiring below is verified by typecheck and the full suite.

- [ ] **Step 3: Add the injection**

In `src/features/agents/execute-agent.ts`, immediately after the existing
`goalWorkSection` append:

```ts
    // What the agent's own work has taught us, per linked goal. Best-effort:
    // a learning-layer failure must never stop a run that would otherwise do
    // useful work.
    if (goalWork) {
      try {
        const { resolveLinkedGoalIds } = await import('@/lib/integrations/goals-port')
        const { loadWorkFeedback } = await import('@/lib/goals/work-rules-port')
        const { renderWorkFeedback } = await import('@/lib/goals/work-feedback')
        const linkedGoalIds = await resolveLinkedGoalIds(organizationId, {
          type: 'agent',
          id: agent.id,
        })
        for (const linkedGoalId of linkedGoalIds.slice(0, 2)) {
          const feedback = await loadWorkFeedback(organizationId, linkedGoalId, agent.id)
          if (!feedback) continue
          const block = renderWorkFeedback(feedback)
          if (block) system += `\n\n${block}`
        }
      } catch {
        // Non-fatal by design.
      }
    }
```

`slice(0, 2)` bounds prompt growth: an agent linked to many goals would
otherwise append a block per goal. Two is enough for the common one-goal and
two-goal cases without an unbounded prompt.

- [ ] **Step 4: Verify the whole suite and types**

```bash
npm run typecheck && npm test
```
Expected: PASS, no new failures.

- [ ] **Step 5: Commit**

```bash
git add src/features/agents
git commit -m "feat(goals): inject what an agent's work has taught us"
```

---

### Task 8: The weekly learning tick

**Files:**
- Create: `src/lib/goals/run-work-learning.ts`
- Modify: `src/app/api/cron/dispatch/route.ts:479`
- Test: `src/app/api/goals/__tests__/work-learning-run.pg.test.ts`

**Interfaces:**
- Consumes: `findRuleCandidates` (Task 2), `rulesToRetire`/`rulesToPromote` (Task 3).
- Produces: `runGoalWorkLearning(organizationId: string, db?): Promise<WorkLearningStats>` with `WorkLearningStats = { organizationId: string; rulesLearned: number; rulesPromoted: number; rulesRetired: number; cadenceProposals: number }`.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/goals/__tests__/work-learning-run.pg.test.ts`:

```ts
/**
 * The weekly tick, driven against real Postgres. Inert without
 * TEST_DATABASE_URL.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let goalId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
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
    goalId = goal.id
    await prisma.goalContribution.create({
      data: {
        organizationId: seeded.organizationId, goalId,
        resourceType: 'agent', resourceId: 'agent-1',
        origin: 'manual', seedKey: 'sales-sequence-personalizer',
      },
    })
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  const work = (overrides: Record<string, unknown>) =>
    prisma.goalWork.create({
      data: {
        organizationId: seeded.organizationId, goalId,
        resourceType: 'agent', resourceId: 'agent-1',
        subject: `S-${Math.random()}`, produced: 're-entry email',
        ...overrides,
      },
    })

  test('a clean signal split earns a rule', async () => {
    for (const daysCold of [3, 5, 7, 9, 11]) {
      await work({ disposition: 'skipped', skipReason: 'too_early', signals: { daysCold } })
    }
    for (const daysCold of [30, 40, 50]) {
      await work({ disposition: 'used', signals: { daysCold } })
    }

    const { runGoalWorkLearning } = await import('@/lib/goals/run-work-learning')
    const stats = await runGoalWorkLearning(seeded.organizationId, prisma)
    assert.equal(stats.rulesLearned, 1)

    const rule = await prisma.goalWorkRule.findFirstOrThrow({
      where: { organizationId: seeded.organizationId, goalId, status: 'active' },
    })
    assert.equal(rule.signal, 'daysCold')
    assert.equal(rule.topSkipReason, 'too_early')
    assert.equal(rule.exploreRate, 0.2)
  })

  test('running twice does not duplicate the rule', async () => {
    const { runGoalWorkLearning } = await import('@/lib/goals/run-work-learning')
    await runGoalWorkLearning(seeded.organizationId, prisma)
    const count = await prisma.goalWorkRule.count({
      where: { organizationId: seeded.organizationId, goalId, signal: 'daysCold', status: 'active' },
    })
    assert.equal(count, 1, 'the partial unique index and the runner must agree')
  })

  test('probes that come back used retire the rule', async () => {
    const rule = await prisma.goalWorkRule.findFirstOrThrow({
      where: { organizationId: seeded.organizationId, goalId, signal: 'daysCold', status: 'active' },
    })
    for (let index = 0; index < 3; index += 1) {
      await work({ disposition: 'used', signals: { daysCold: 4 }, probeForRuleId: rule.id })
    }
    await work({ disposition: 'skipped', skipReason: 'too_early', signals: { daysCold: 4 }, probeForRuleId: rule.id })

    const { runGoalWorkLearning } = await import('@/lib/goals/run-work-learning')
    const stats = await runGoalWorkLearning(seeded.organizationId, prisma)
    assert.ok(stats.rulesRetired >= 1)

    const retired = await prisma.goalWorkRule.findFirstOrThrow({ where: { id: rule.id } })
    assert.equal(retired.status, 'retired')
    assert.equal(retired.retiredReason, 'probes_contradicted')
  })

  test('the tick never throws on an org with no goals at all', async () => {
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    const empty = await seedTestOrg(prisma)
    const { runGoalWorkLearning } = await import('@/lib/goals/run-work-learning')
    const stats = await runGoalWorkLearning(empty.organizationId, prisma)
    assert.deepEqual(
      { learned: stats.rulesLearned, retired: stats.rulesRetired },
      { learned: 0, retired: 0 },
    )
    await empty.cleanup()
    const { installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    installTestAuth(seeded.auth)
  })
}
```

- [ ] **Step 2: Run test to verify it fails**

Run with `TEST_DATABASE_URL` set. Expected: FAIL — cannot find `run-work-learning`.

- [ ] **Step 3: Implement**

Create `src/lib/goals/run-work-learning.ts`:

```ts
/**
 * Per-org weekly learning tick. Reads settled work, earns targeting rules,
 * promotes repeats to the seed level, retires rules the probes contradict,
 * and proposes a cadence change when skips have no structure at all.
 *
 * Never throws — cron dispatch fires it best-effort, and a learning failure
 * must not break the tick that also drives goal refresh.
 *
 * systemPrisma by default: a cross-tenant cron sweep, CRON_SECRET-gated at the
 * route, with every query explicitly org-scoped.
 */
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { findRuleCandidates, type WorkObservation } from './work-signals'
import {
  rulesToPromote,
  rulesToRetire,
  EXPLORE_RATE,
  type ExistingRule,
  type ProbeTally,
} from './work-rules'
import type { Disposition } from './work-transitions'

export const EVIDENCE_WINDOW_DAYS = 90
export const CADENCE_SKIP_RATE = 0.6
export const CADENCE_MIN_ITEMS = 10

const DAY_MS = 24 * 60 * 60 * 1000

export type WorkLearningStats = {
  organizationId: string
  rulesLearned: number
  rulesPromoted: number
  rulesRetired: number
  cadenceProposals: number
}

export async function runGoalWorkLearning(
  organizationId: string,
  db = systemPrisma,
): Promise<WorkLearningStats> {
  const stats: WorkLearningStats = {
    organizationId, rulesLearned: 0, rulesPromoted: 0, rulesRetired: 0, cadenceProposals: 0,
  }

  try {
    const now = new Date()
    const since = new Date(now.getTime() - EVIDENCE_WINDOW_DAYS * DAY_MS)

    const rows = await db.goalWork.findMany({
      where: { organizationId, createdAt: { gte: since } },
      select: {
        goalId: true, resourceId: true, disposition: true,
        skipReason: true, signals: true, probeForRuleId: true,
      },
    })
    if (rows.length === 0) return stats

    // ── Retire first, so a rule the probes killed cannot block relearning ──
    const active = await db.goalWorkRule.findMany({
      where: { organizationId, status: 'active' },
      select: {
        id: true, signal: true, statement: true, goalId: true,
        seedKey: true, resourceId: true, learnedAt: true,
      },
    })

    const tallies = new Map<string, ProbeTally>()
    for (const row of rows) {
      if (!row.probeForRuleId) continue
      const tally = tallies.get(row.probeForRuleId) ?? {
        ruleId: row.probeForRuleId, probes: 0, used: 0,
      }
      tally.probes += 1
      if (row.disposition === 'used' || row.disposition === 'edited') tally.used += 1
      tallies.set(row.probeForRuleId, tally)
    }

    const contributions = await db.goalContribution.findMany({
      where: { organizationId },
      select: { goalId: true, resourceId: true, seedKey: true },
    })
    const seedFor = new Map(
      contributions.map((row) => [`${row.goalId} ${row.resourceId}`, row.seedKey] as const),
    )

    const existing: ExistingRule[] = active.map((rule) => ({
      id: rule.id,
      signal: rule.signal,
      statement: rule.statement,
      goalId: rule.goalId,
      seedKey: rule.seedKey,
      agentSeedKey: seedFor.get(`${rule.goalId} ${rule.resourceId}`) ?? null,
      learnedAt: rule.learnedAt,
    }))

    for (const decision of rulesToRetire(existing, [...tallies.values()], now)) {
      await db.goalWorkRule.updateMany({
        where: { id: decision.ruleId, organizationId },
        data: { status: 'retired', retiredAt: now, retiredReason: decision.reason },
      })
      stats.rulesRetired += 1
    }

    // ── Earn ──────────────────────────────────────────────────────────────
    const byPair = new Map<string, WorkObservation[]>()
    for (const row of rows) {
      // Probes are excluded from earning evidence: they exist precisely
      // BECAUSE a rule said not to work them, so counting them would let a
      // rule re-earn itself from its own exceptions.
      if (row.probeForRuleId) continue
      const key = `${row.goalId} ${row.resourceId}`
      const bucket = byPair.get(key) ?? []
      bucket.push({
        disposition: row.disposition as Disposition,
        skipReason: row.skipReason,
        signals: (row.signals as Record<string, unknown> | null) ?? null,
      })
      byPair.set(key, bucket)
    }

    const stillActive = new Set(
      (
        await db.goalWorkRule.findMany({
          where: { organizationId, status: 'active' },
          select: { goalId: true, resourceId: true, signal: true },
        })
      ).map((rule) => `${rule.goalId} ${rule.resourceId} ${rule.signal}`),
    )

    for (const [key, observations] of byPair) {
      const [goalId, resourceId] = key.split(' ')
      for (const candidate of findRuleCandidates(observations)) {
        if (stillActive.has(`${goalId} ${resourceId} ${candidate.signal}`)) continue
        await db.goalWorkRule.create({
          data: {
            organizationId, goalId, resourceId,
            signal: candidate.signal,
            statement: candidate.statement,
            skippedCount: candidate.skippedCount,
            totalCount: candidate.totalCount,
            topSkipReason: candidate.topSkipReason,
            exploreRate: EXPLORE_RATE,
          },
        })
        stillActive.add(`${goalId} ${resourceId} ${candidate.signal}`)
        stats.rulesLearned += 1
      }
    }

    // ── Promote ───────────────────────────────────────────────────────────
    const afterEarn = await db.goalWorkRule.findMany({
      where: { organizationId, status: 'active' },
      select: {
        id: true, signal: true, statement: true, goalId: true,
        seedKey: true, resourceId: true, learnedAt: true,
      },
    })
    const promotable: ExistingRule[] = afterEarn.map((rule) => ({
      id: rule.id, signal: rule.signal, statement: rule.statement,
      goalId: rule.goalId, seedKey: rule.seedKey,
      agentSeedKey: seedFor.get(`${rule.goalId} ${rule.resourceId}`) ?? null,
      learnedAt: rule.learnedAt,
    }))

    for (const decision of rulesToPromote(promotable)) {
      await db.goalWorkRule.create({
        data: {
          organizationId,
          goalId: null, resourceId: null, seedKey: decision.seedKey,
          signal: decision.signal,
          statement: decision.statement,
          skippedCount: 0, totalCount: decision.fromGoalIds.length,
          exploreRate: EXPLORE_RATE,
        },
      })
      stats.rulesPromoted += 1
    }
  } catch (error) {
    apiLogger.warn('goals.runGoalWorkLearning failed', {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  return stats
}
```

- [ ] **Step 4: Wire it into the cron**

In `src/app/api/cron/dispatch/route.ts`, directly after the
`runBehaviorIntelligence` loop at line 479:

```ts
    // Goal work learning: earn targeting rules from what humans did with
    // agent output, retire the ones probes disproved. Best-effort, same as
    // behavior intelligence — a learning failure must not break the tick.
    for (const { organizationId } of recentBehaviorOrgs) {
      void import('@/lib/goals/run-work-learning')
        .then((module) => module.runGoalWorkLearning(organizationId))
        .catch(() => undefined)
    }
```

- [ ] **Step 5: Run tests and typecheck**

Run with `TEST_DATABASE_URL` set. Expected: PASS, 4 tests. Then `npm run typecheck && npm test`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/goals/run-work-learning.ts src/app/api/cron/dispatch/route.ts src/app/api/goals/__tests__/work-learning-run.pg.test.ts
git commit -m "feat(goals): weekly tick that earns, promotes and retires work rules"
```

---

### Task 9: Tier 3 — the cadence proposal

**Files:**
- Modify: `src/lib/goals/run-work-learning.ts`
- Create: `src/lib/goals/cadence-proposal.ts`
- Test: `src/lib/goals/__tests__/cadence-proposal.test.ts`

**Interfaces:**
- Consumes: `RuleCandidate` (Task 2).
- Produces: `shouldProposeCadenceChange(input: CadenceInput): boolean` with `CadenceInput = { produced: number; skipped: number; candidates: number }`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/goals/__tests__/cadence-proposal.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldProposeCadenceChange } from '../cadence-proposal'

test('high skips with no derivable rule proposes a cadence change', () => {
  // Nothing explains the skips, so the honest read is volume, not targeting.
  assert.equal(shouldProposeCadenceChange({ produced: 20, skipped: 15, candidates: 0 }), true)
})

test('high skips WITH a derivable rule proposes nothing', () => {
  // A rule is the better remedy; proposing both would ask the user to fix a
  // problem the agent is already about to fix itself.
  assert.equal(shouldProposeCadenceChange({ produced: 20, skipped: 15, candidates: 1 }), false)
})

test('a healthy skip rate proposes nothing', () => {
  assert.equal(shouldProposeCadenceChange({ produced: 20, skipped: 4, candidates: 0 }), false)
})

test('too little work to judge proposes nothing', () => {
  // 6 of 9 skipped is 0.67, over the rate — but nine items is not a pattern.
  assert.equal(shouldProposeCadenceChange({ produced: 9, skipped: 6, candidates: 0 }), false)
})

test('exactly at both thresholds proposes', () => {
  assert.equal(shouldProposeCadenceChange({ produced: 10, skipped: 6, candidates: 0 }), true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/cadence-proposal.test.ts`
Expected: FAIL — cannot find module `../cadence-proposal`.

- [ ] **Step 3: Implement**

Create `src/lib/goals/cadence-proposal.ts`:

```ts
/**
 * Tier 3 fires precisely when Tier 2 FAILS.
 *
 * If skips correlate with a signal you get a targeting rule and the agent
 * keeps working. If they correlate with nothing, no rule is derivable, and the
 * honest conclusion is not "target better" but "this agent produces more than
 * the team can absorb". Those are opposite remedies, so proposing a cadence
 * change while a rule is also being learned would ask a human to fix
 * something the agent is about to fix itself.
 */

export const CADENCE_SKIP_RATE = 0.6
export const CADENCE_MIN_ITEMS = 10

export type CadenceInput = {
  produced: number
  skipped: number
  /** Rule candidates found for this agent-goal pair this cycle. */
  candidates: number
}

export function shouldProposeCadenceChange(input: CadenceInput): boolean {
  if (input.candidates > 0) return false
  if (input.produced < CADENCE_MIN_ITEMS) return false
  return input.skipped / input.produced >= CADENCE_SKIP_RATE
}
```

- [ ] **Step 4: Emit the suggestion from the tick**

In `run-work-learning.ts`, inside the earn loop, after `findRuleCandidates`:

```ts
      const candidates = findRuleCandidates(observations)
      // …existing earn loop over `candidates`…

      const produced = observations.length
      const skipped = observations.filter((row) => row.disposition === 'skipped').length
      if (shouldProposeCadenceChange({ produced, skipped, candidates: candidates.length })) {
        const goal = await db.goal.findFirst({
          where: { id: goalId, organizationId },
          select: { name: true, createdByUserId: true, ownerUserId: true },
        })
        const userId = goal?.ownerUserId ?? goal?.createdByUserId
        // No addressable user means no one to ask; skip rather than orphan a row.
        if (goal && userId) {
          const open = await db.userSuggestion.count({
            where: {
              organizationId, userId, status: 'open', kind: 'enhancement',
              targetType: 'agent', targetId: resourceId,
            },
          })
          // One open proposal per agent: re-proposing weekly is nagging.
          if (open === 0) {
            await db.userSuggestion.create({
              data: {
                organizationId, userId, kind: 'enhancement',
                title: 'Produce less, more often used',
                description:
                  `This agent produced ${produced} items for "${goal.name}" and ${skipped} were skipped, ` +
                  'with no common reason we could find. Reducing how often it runs would likely raise the share that gets used.',
                targetType: 'agent', targetId: resourceId,
                evidence: [`${skipped} of ${produced} skipped`, 'no targeting pattern found'],
                metadata: { goalId, reason: 'cadence' },
              },
            })
            stats.cadenceProposals += 1
          }
        }
      }
```

Add the import: `import { shouldProposeCadenceChange } from './cadence-proposal'`, and delete the now-duplicated `CADENCE_SKIP_RATE`/`CADENCE_MIN_ITEMS` constants from `run-work-learning.ts` — they live in `cadence-proposal.ts`.

- [ ] **Step 5: Run tests and typecheck**

```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/cadence-proposal.test.ts
npm run typecheck && npm test
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/goals
git commit -m "feat(goals): propose a cadence change when skips have no pattern"
```

---

### Task 10: Skip captures a reason

**Files:**
- Modify: `src/components/goals/workroom/work-item.tsx`
- Test: `src/components/goals/workroom/__tests__/work-item.test.tsx`

**Interfaces:**
- Consumes: the PATCH route's existing `skipReason` field.
- Produces: nothing downstream.

Independent of Tasks 2–9; needs only Task 1.

- [ ] **Step 1: Write the failing test**

Append to `src/components/goals/workroom/__tests__/work-item.test.tsx`:

```tsx
test('Skip asks why before recording anything', () => {
  // "Skipped" alone says something is wrong; the reason says what to change.
  const patches: unknown[] = []
  render(<WorkItem item={item} onPatch={(patch) => patches.push(patch)} />)
  fireEvent.click(screen.getByRole('button', { name: /^skip$/i }))
  assert.deepEqual(patches, [], 'the first click only opens the reasons')
  assert.ok(screen.getByRole('button', { name: /too early/i }))
})

test('choosing a reason records it with the skip', () => {
  const patches: unknown[] = []
  render(<WorkItem item={item} onPatch={(patch) => patches.push(patch)} />)
  fireEvent.click(screen.getByRole('button', { name: /^skip$/i }))
  fireEvent.click(screen.getByRole('button', { name: /too early/i }))
  assert.deepEqual(patches, [{ disposition: 'skipped', skipReason: 'too_early' }])
})

test('every vocabulary reason is offered', () => {
  render(<WorkItem item={item} onPatch={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: /^skip$/i }))
  for (const label of [/too early/i, /wrong contact/i, /wrong content/i, /already handled/i, /not relevant/i, /other/i]) {
    assert.ok(screen.getByRole('button', { name: label }), `${label} must be offered`)
  }
})

test('the reason picker can be dismissed without skipping', () => {
  const patches: unknown[] = []
  render(<WorkItem item={item} onPatch={(patch) => patches.push(patch)} />)
  fireEvent.click(screen.getByRole('button', { name: /^skip$/i }))
  fireEvent.click(screen.getByRole('button', { name: /never mind/i }))
  assert.deepEqual(patches, [])
  assert.ok(screen.getByRole('button', { name: /^copy$/i }), 'the normal actions come back')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/goals/workroom/__tests__/work-item.test.tsx`
Expected: FAIL — clicking Skip records a patch immediately.

- [ ] **Step 3: Implement**

In `src/components/goals/workroom/work-item.tsx`, add the vocabulary and a
local step state:

```tsx
/** Closed vocabulary so reasons are countable without an LLM. Order is the
 *  order they are offered — most common first. */
const SKIP_REASONS: Array<{ value: string; label: string }> = [
  { value: 'too_early', label: 'Too early' },
  { value: 'wrong_contact', label: 'Wrong contact' },
  { value: 'wrong_content', label: 'Wrong content' },
  { value: 'already_handled', label: 'Already handled' },
  { value: 'not_relevant', label: 'Not relevant' },
  { value: 'other', label: 'Other' },
]
```

Add `import { useState } from 'react'` and inside the component:

```tsx
  const [askingWhy, setAskingWhy] = useState(false)
```

Replace the actions block with:

```tsx
      {open && !askingWhy && (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={copy}>
            Copy
          </Button>
          <Button size="sm" variant="outline" onClick={() => setAskingWhy(true)}>
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

      {open && askingWhy && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">Why are you skipping it?</p>
          <div className="flex flex-wrap gap-1.5">
            {SKIP_REASONS.map((reason) => (
              <Button
                key={reason.value}
                size="sm"
                variant="outline"
                onClick={() => onPatch({ disposition: 'skipped', skipReason: reason.value })}
              >
                {reason.label}
              </Button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setAskingWhy(false)}>
              Never mind
            </Button>
          </div>
        </div>
      )}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/goals/workroom/__tests__/work-item.test.tsx`
Expected: PASS, all tests including the four pre-existing ones.

- [ ] **Step 5: Verify in a real browser**

Follow the `browser-verification-harness` memory: a temp client page mounting
`<WorkItem>` with a stubbed `onPatch`, its path added to `publicPages` in
`src/lib/supabase/middleware.ts`, `npx next dev -p 3113` with placeholder
Supabase env vars, driven by the cached Playwright chromium. Confirm the reason
chips wrap rather than overflow the card, and that "Never mind" restores the
normal actions.

Tear down afterwards — delete the route, revert the middleware line, and
`rm -rf .next/types`.

- [ ] **Step 6: Commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/components/goals/workroom
git commit -m "feat(goals): Skip records why, not just that"
```

---

## Self-Review

**Spec coverage.** §1 evidence capture → Tasks 5 (`signals`, `probeRuleId`) and 10 (skip vocabulary). §2 rule model → Task 1; lifecycle → Task 3; `probeForRuleId` → Tasks 1 and 5. §3 Tier 1+2 block → Tasks 4 (render), 6 (load), 7 (inject); Tier 3 → Task 9. §4 files → all five appear, four pure as specified; cron wiring → Task 8 Step 4. §5 algorithm and every constant → Tasks 2, 3, 9. §6 failure modes: no signals → Task 2's "rows with no signals are ignored" and Task 4's empty-render test; ignored probes → Task 3's `unprobed` test; all-`other` skips → the stump runs on signals not reasons (Task 2); key drift → Task 2's mixed-type guard. §7 tests → distributed; the real-Postgres legs are Tasks 1, 6, 8.

**Type consistency.** `WorkObservation`/`RuleCandidate` defined in Task 2, consumed in Task 8. `ExistingRule`/`ProbeTally`/`RetireDecision`/`PromotionDecision` defined in Task 3, consumed in Task 8. `FeedbackInput`/`FeedbackRule` defined in Task 4, produced by Task 6, consumed in Task 7. `WorkFunnel` comes from the existing `work-stats.ts` and is reused rather than redefined. `EXPLORE_RATE` lives in `work-rules.ts` and is imported by Task 8; `CADENCE_SKIP_RATE`/`CADENCE_MIN_ITEMS` live in `cadence-proposal.ts` only — Task 9 Step 4 explicitly deletes the duplicates Task 8 introduced.

**Two decisions worth flagging to a reviewer.** Probes are excluded from earning evidence (Task 8's earn loop), or a rule would re-earn itself from its own exceptions. And retirement runs *before* earning in the same tick, so a rule the probes just killed does not block relearning the same signal from fresh evidence.
