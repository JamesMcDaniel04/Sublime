# RevOps Narrowing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reposition the three goal features for RevOps teams under 500 people — a catalogue lens, standards instead of to-dos, adoption measured per rep, and rules that read as playbook findings — without adding a single template or feature.

**Architecture:** Three of the four changes are re-readings of data that already exists: a filter over the template catalogue, a `groupBy` over `assigneeUserId`, and a rendering branch in the rules strip. Only the rule `finding` phrasing needs storage, because the threshold it names exists solely inside prose the miner wrote.

**Tech Stack:** Prisma + Postgres, TypeScript, Next.js App Router, `node:test` + `tsx`, `@testing-library/react`.

**Spec:** `docs/superpowers/specs/2026-07-29-revops-narrowing-design.md`

## Global Constraints

- Test runner: `npm test`. Single file: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <path>`. Typecheck `npm run typecheck`, lint `npm run lint`.
- **Template keys never change.** Renaming is names and descriptions only — the legacy-key test and every bookmarked `/goals/new?template=` link must stay green.
- **No new templates, tables, or agent capabilities.** One nullable column is the entire storage change.
- `PRODUCT_DEPARTMENTS` is unchanged. RevOps is a lens, not a department.
- `UserRole` (`ADMIN | USER`) is **never** used to decide a view — it is a permissions concept, and keying on it conflates "can change settings" with "owns the process".
- The 5-org/4-personal per-department split and all 20 personal templates are untouched.
- Adoption copy points at the process, not the person: lead with the team number, order reps by volume, never use the word "compliance", and keep skip reasons beside a rep's number.
- Tenant guard: every `update` needs `organizationId` in its where clause — use `updateMany`.
- Rules learned before this ships have `finding: null` and fall back to `statement`. No backfill.

**Task order:** 1, 2, 3, 4 are independent. 5 depends on 4. 6 depends on 3.

---

### Task 1: The RevOps lens

**Files:**
- Modify: `src/lib/goals/goal-templates.ts` (export the lens)
- Modify: `src/components/goals/goal-template-gallery.tsx` (tab + filter)
- Test: `src/lib/goals/__tests__/goal-templates.test.ts`

**Interfaces:**
- Consumes: `VISIBLE_GOAL_TEMPLATES`.
- Produces: `REVOPS_TEMPLATES: GoalTemplate[]`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/goals/__tests__/goal-templates.test.ts`:

```ts
test('the RevOps lens is the standards a process owner rolls out', () => {
  const { REVOPS_TEMPLATES } = require('../goal-templates')
  assert.equal(REVOPS_TEMPLATES.length, 8)
  for (const entry of REVOPS_TEMPLATES) {
    assert.equal(entry.scope, 'org', `${entry.key}: a RevOps buyer carries no personal number`)
    assert.equal(entry.motion, 'action', `${entry.key}: a play is work, not a metric`)
    assert.ok(
      ['sales', 'marketing', 'csm'].includes(entry.department),
      `${entry.key}: RevOps spans the revenue-owning departments only`,
    )
  }
})

test('the lens never surfaces a personal or outcome template', () => {
  const { REVOPS_TEMPLATES } = require('../goal-templates')
  const keys = new Set(REVOPS_TEMPLATES.map((entry: { key: string }) => entry.key))
  // The buyer owns the process; these are for the people doing the work.
  assert.equal(keys.has('sales-personal-revive-stalled-deals'), false)
  assert.equal(keys.has('sales-personal-quota'), false)
  assert.equal(keys.has('sales-org-quarterly-revenue'), false, 'an outcome is not a play')
})

test('every RevOps template is also in the visible catalogue', () => {
  const { REVOPS_TEMPLATES } = require('../goal-templates')
  // The lens is a filter, never a second source of templates.
  for (const entry of REVOPS_TEMPLATES) {
    assert.ok(VISIBLE_GOAL_TEMPLATES.includes(entry), `${entry.key}: must be the same object`)
  }
})
```

Replace the `require` calls with a top-of-file import once the export exists —
they are written this way only so the test file parses before Step 3.

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/goal-templates.test.ts`
Expected: FAIL — `REVOPS_TEMPLATES` is undefined.

- [ ] **Step 3: Export the lens**

In `src/lib/goals/goal-templates.ts`, below `VISIBLE_GOAL_TEMPLATES`:

```ts
/** Departments that own revenue. RevOps spans all three, which is why it is a
 *  lens rather than a department of its own. */
const REVENUE_DEPARTMENTS = ['sales', 'marketing', 'csm'] as const

/**
 * The catalogue a RevOps buyer should see: the standards a process owner rolls
 * out across the revenue-owning departments.
 *
 * Org scope because a RevOps person carries no quota and works no deals;
 * action motion because a play is work the team performs, not a number someone
 * watches. A filter over VISIBLE_GOAL_TEMPLATES, never a second source of
 * templates — the same objects appear in both.
 */
export const REVOPS_TEMPLATES: GoalTemplate[] = VISIBLE_GOAL_TEMPLATES.filter(
  (entry) =>
    (REVENUE_DEPARTMENTS as readonly string[]).includes(entry.department) &&
    entry.scope === 'org' &&
    entry.motion === 'action',
)
```

Then convert the test's `require` calls to a normal import at the top of the
test file.

- [ ] **Step 4: Add the tab**

In `src/components/goals/goal-template-gallery.tsx`, import `REVOPS_TEMPLATES`
and add the label:

```tsx
const DEPARTMENT_LABELS: Record<string, string> = {
  revops: 'RevOps',
  sales: 'Sales',
  marketing: 'Marketing',
  engineering: 'Engineering',
  finance: 'Finance',
  csm: 'Customer Success',
}
```

Change the tab list to `{['all', 'revops', ...PRODUCT_DEPARTMENTS].map(...)}`
and branch the filter:

```tsx
  const visible = useMemo(() => {
    const inDepartment =
      department === 'all'
        ? VISIBLE_GOAL_TEMPLATES
        : department === 'revops'
          ? REVOPS_TEMPLATES
          : VISIBLE_GOAL_TEMPLATES.filter((entry) => entry.department === department)
    return byReadiness(inDepartment, connected, connectedIntegrations)
  }, [department, connected, connectedIntegrations])
```

`all` stays the default — a second inference for the default tab is
over-thinking a one-click change.

- [ ] **Step 5: Add the gallery test**

Append to `src/components/goals/__tests__/goal-template-gallery.test.tsx`:

```tsx
test('the RevOps tab shows only the plays a process owner rolls out', () => {
  render(<GoalTemplateGallery />)
  fireEvent.click(screen.getByRole('tab', { name: 'RevOps' }))
  // 8 templates, one page, so every one renders.
  assert.equal(screen.getAllByText('View goal').length, 8)
  assert.equal(
    screen.queryByText('Hit my quarterly quota'),
    null,
    'a personal target is not a play',
  )
})
```

- [ ] **Step 6: Run tests, typecheck, commit**

```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/goal-templates.test.ts
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/goals/__tests__/goal-template-gallery.test.tsx
npm run typecheck
git add src/lib/goals src/components/goals
git commit -m "feat(goals): a RevOps lens over the template catalogue"
```

---

### Task 2: Standards, not to-dos

**Files:**
- Modify: `src/lib/goals/goal-templates.ts` (8 names + descriptions)
- Test: `src/lib/goals/__tests__/goal-templates.test.ts`

**Interfaces:**
- Consumes: `REVOPS_TEMPLATES` (Task 1) for the test.
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/goals/__tests__/goal-templates.test.ts`:

```ts
test('RevOps plays are phrased as standards, not as a rep\'s to-do', () => {
  // "Multithread every open deal" is something you do. "Every open deal is
  // multithreaded" is something you can be FAILING at — which is what a
  // process owner buys a tool to find out.
  const IMPERATIVE_OPENERS = /^(work|multithread|qualify|close|revive|follow|ship|build|review|capture|explain|plan)\b/i
  for (const entry of REVOPS_TEMPLATES) {
    assert.equal(
      IMPERATIVE_OPENERS.test(entry.name),
      false,
      `${entry.key}: "${entry.name}" reads as an instruction to a person`,
    )
  }
})

test('renaming never changes a key', () => {
  // Bookmarked /goals/new?template=<key> links outlive any amount of copy.
  for (const key of [
    'sales-org-multithread-open-deals',
    'sales-org-qualify-inbound-same-day',
    'sales-org-close-plan-on-commit',
    'sales-org-work-the-whitespace',
    'marketing-org-work-every-event-lead',
    'marketing-org-brief-every-launch',
    'csm-org-plan-every-new-account',
    'csm-org-close-every-adoption-gap',
  ]) {
    assert.ok(goalTemplateByKey(key), `${key} must still resolve`)
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/goal-templates.test.ts`
Expected: FAIL — several names open with an imperative.

- [ ] **Step 3: Rename the eight**

In `src/lib/goals/goal-templates.ts`, change only the name (3rd string) and
description (4th string) arguments. Keys, kinds, sources, agents, layouts and
scopes are all untouched.

```
sales-org-multithread-open-deals
  name  'Every open deal is multithreaded'
  desc  'The standard: no deal advances on a single contact. Coverage is three or more engaged people.'

sales-org-qualify-inbound-same-day
  name  'Inbound is qualified within a day'
  desc  'The standard: every inbound lead is scored, enriched and routed before it goes cold.'

sales-org-close-plan-on-commit
  name  'Every commit deal has a close plan'
  desc  'The standard: nothing sits in commit without an agreed, dated path to signature.'

sales-org-work-the-whitespace
  name  'Whitespace gets worked every week'
  desc  'The standard: unworked accounts are ranked and opened, rather than waiting to be noticed.'

marketing-org-work-every-event-lead
  name  'Event leads are worked within a week'
  desc  'The standard: event leads are segmented and handed to sales before they cool.'

marketing-org-brief-every-launch
  name  'Every launch has a readiness brief'
  desc  'The standard: no launch ships without tasks, creative and enablement reconciled.'

csm-org-plan-every-new-account
  name  'Every new account starts with a plan'
  desc  'The standard: onboarding begins from owners and dates, not an intro call.'

csm-org-close-every-adoption-gap
  name  'Adoption gaps get closed'
  desc  'The standard: unused capability becomes a named play, not a health-score number.'
```

- [ ] **Step 4: Run the full suite**

```bash
npm test
```
Expected: PASS. Any component test asserting an old name literal must be
updated to the new one — do NOT weaken the assertion to a substring match.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/lib/goals
git commit -m "feat(goals): phrase RevOps plays as standards, not to-dos"
```

---

### Task 3: Rules carry a human-readable finding

**Files:**
- Modify: `prisma/schema.prisma` (`GoalWorkRule.finding`)
- Create: `prisma/migrations/20260729100000_goal_work_rule_finding/migration.sql`
- Modify: `src/lib/goals/work-signals.ts` (produce it)
- Modify: `src/lib/goals/run-work-learning.ts` (persist it)
- Test: `src/lib/goals/__tests__/work-signals.test.ts`

**Interfaces:**
- Consumes: `RuleCandidate` from `work-signals.ts`.
- Produces: `RuleCandidate` gains `finding: string`; `GoalWorkRule.finding String?`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/goals/__tests__/work-signals.test.ts`:

```ts
test('every candidate carries a finding phrased for a person', () => {
  // `statement` is directive because it goes into an agent prompt. A human
  // reading the rules strip needs an observation, not an instruction — and the
  // threshold exists only inside the statement's prose, so it must be built
  // here where the split is still a number.
  const rows = [
    ...Array.from({ length: 5 }, () => skipped({ daysCold: 3 })),
    used({ daysCold: 40 }),
    used({ daysCold: 50 }),
  ]
  const [candidate] = findRuleCandidates(rows)
  assert.match(candidate.statement, /^Do not work/, 'the agent gets an instruction')
  assert.doesNotMatch(candidate.finding, /^Do not/, 'the human gets an observation')
  assert.match(candidate.finding, /daysCold/)
  assert.match(candidate.finding, /under/)
})

test('categorical candidates carry a finding too', () => {
  const rows = [
    ...Array.from({ length: 5 }, () => skipped({ stage: 'prospecting' }, 'not_relevant')),
    used({ stage: 'negotiation' }),
  ]
  const [candidate] = findRuleCandidates(rows)
  assert.ok(candidate.finding.length > 0)
  assert.match(candidate.finding, /prospecting/)
  assert.doesNotMatch(candidate.finding, /^Do not/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/work-signals.test.ts`
Expected: FAIL — `candidate.finding` is undefined.

- [ ] **Step 3: Produce the finding in the miner**

In `src/lib/goals/work-signals.ts`, add to `RuleCandidate`:

```ts
  /** The same conclusion phrased as an observation, for a human reading the
   *  rules strip. Built here because the threshold is a number at this point
   *  and only prose by the time `statement` exists. */
  finding: string
```

Change `candidateFrom` to take both:

```ts
function candidateFrom(
  signal: string,
  band: Settled[],
  statement: string,
  finding: string,
): RuleCandidate {
  return {
    signal,
    statement,
    finding,
    skippedCount: band.filter((row) => row.skipped).length,
    totalCount: band.length,
    topSkipReason: topReason(band),
  }
}
```

In `numericCandidate`, build both strings per side:

```ts
      const statement =
        side === 'under'
          ? `Do not work subjects whose ${signal} is under ${split}.`
          : `Do not work subjects whose ${signal} is ${split} or more.`
      const finding =
        side === 'under' ? `${signal} under ${split}` : `${signal} ${split} or more`
      const candidate = candidateFrom(signal, band, statement, finding)
```

In `categoricalCandidate`:

```ts
    const candidate = candidateFrom(
      signal,
      band,
      `Do not work subjects whose ${signal} is "${value}".`,
      `${signal} is "${value}"`,
    )
```

- [ ] **Step 4: Add the column**

In `prisma/schema.prisma`, on `GoalWorkRule`, below `statement`:

```prisma
  /// The same conclusion phrased as an observation for a human. Null on rules
  /// learned before this shipped; the strip falls back to `statement`, so no
  /// backfill is needed.
  finding        String?
```

Create `prisma/migrations/20260729100000_goal_work_rule_finding/migration.sql`:

```sql
ALTER TABLE "goal_work_rules" ADD COLUMN "finding" TEXT;
```

- [ ] **Step 5: Persist it**

In `src/lib/goals/run-work-learning.ts`, in the `goalWorkRule.create` inside the
earn loop, add `finding: candidate.finding,` beside `statement`.

The promotion `create` keeps `finding: decision.statement` unavailable — add
`finding` to `PromotionDecision` in `src/lib/goals/work-rules.ts` (carried from
the level-1 rule the same way `statement` already is) and pass
`finding: decision.finding,`. In `rulesToPromote`, capture it alongside the
statement:

```ts
    const group = groups.get(key) ?? {
      statement: rule.statement,
      finding: rule.finding,
      goalIds: new Set<string>(),
    }
```

and add `finding: string | null` to `ExistingRule`, `finding: group.finding` to
the pushed `PromotionDecision`. In `run-work-learning.ts`'s `toExisting`, map
`finding: rule.finding` and add `finding: true` to `RULE_SCOPE_SELECT`.

- [ ] **Step 6: Run tests and the real-Postgres leg**

```bash
npx prisma generate && npm run typecheck
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/work-signals.test.ts src/lib/goals/__tests__/work-rules.test.ts
```

Then follow the `verify` skill's throwaway-PG protocol, `npx prisma migrate deploy`, and:

```bash
TEST_DATABASE_URL=postgresql://qa@127.0.0.1:54339/sublime_qa \
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/goals/__tests__/work-learning-run.pg.test.ts
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add prisma src/lib/goals
git commit -m "feat(goals): rules carry a finding for humans and a statement for agents"
```

---

### Task 4: The funnel buckets by rep

**Files:**
- Modify: `src/lib/goals/work-stats.ts`
- Test: `src/lib/goals/__tests__/work-stats.test.ts`

**Interfaces:**
- Consumes: `Disposition`, `Outcome`.
- Produces: `WorkStatRow` gains `assigneeUserId: string | null` and `assigneeName: string`; `WorkStats` gains `byAssignee: Array<{ assigneeUserId: string | null; assigneeName: string } & WorkFunnel>`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/goals/__tests__/work-stats.test.ts`:

```ts
const forRep = (
  assigneeUserId: string | null,
  assigneeName: string,
  disposition: 'pending' | 'used' | 'edited' | 'skipped',
  outcome: 'unknown' | 'worked' | 'no_response' | 'failed' = 'unknown',
) => ({ resourceId: 'a', resourceName: 'Agent a', assigneeUserId, assigneeName, disposition, outcome })

test('adoption buckets by the person, with the same funnel math as by agent', () => {
  const rows = [
    forRep('u1', 'Dana Reed', 'used', 'worked'),
    forRep('u1', 'Dana Reed', 'used'),
    forRep('u2', 'Sam Diaz', 'used'),
    forRep('u2', 'Sam Diaz', 'skipped'),
  ]
  const stats = computeWorkStats(rows)
  const dana = stats.byAssignee.find((row) => row.assigneeUserId === 'u1')!
  assert.equal(dana.produced, 2)
  assert.equal(dana.used, 2)
  assert.equal(dana.usedRate, 1)
  assert.equal(dana.worked, 1)
  // Same rows, same totals, different bucket.
  assert.equal(stats.overall.produced, stats.byAssignee.reduce((sum, row) => sum + row.produced, 0))
})

test('unassigned work is its own bucket and always sorts last', () => {
  // Work nobody owns does not get done — that is a routing finding, not a rep
  // finding, so it must never head the list as though it were a person.
  const rows = [
    forRep(null, 'Unassigned', 'pending'),
    forRep(null, 'Unassigned', 'pending'),
    forRep(null, 'Unassigned', 'pending'),
    forRep('u1', 'Dana Reed', 'used'),
  ]
  const stats = computeWorkStats(rows)
  assert.equal(stats.byAssignee.at(-1)!.assigneeUserId, null)
  assert.equal(stats.byAssignee.at(-1)!.produced, 3)
})

test('reps sort by volume, never by rate — the list is not a leaderboard', () => {
  const rows = [
    forRep('quiet', 'Quiet Rep', 'used'),
    forRep('busy', 'Busy Rep', 'used'),
    forRep('busy', 'Busy Rep', 'skipped'),
    forRep('busy', 'Busy Rep', 'skipped'),
  ]
  const stats = computeWorkStats(rows)
  assert.deepEqual(
    stats.byAssignee.map((row) => row.assigneeUserId),
    ['busy', 'quiet'],
    'the rep with the most work comes first, despite the worse rate',
  )
})

test('byAgent is unchanged by the new bucket', () => {
  const rows = [forRep('u1', 'Dana Reed', 'used'), forRep('u2', 'Sam Diaz', 'skipped')]
  const stats = computeWorkStats(rows)
  assert.equal(stats.byAgent.length, 1, 'both rows came from the same agent')
  assert.equal(stats.byAgent[0].produced, 2)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/work-stats.test.ts`
Expected: FAIL — `stats.byAssignee` is undefined.

- [ ] **Step 3: Implement**

In `src/lib/goals/work-stats.ts`, extend `WorkStatRow`:

```ts
export type WorkStatRow = {
  resourceId: string
  resourceName: string
  /** Null when nobody owns it — kept as its own bucket, never folded away. */
  assigneeUserId: string | null
  assigneeName: string
  disposition: Disposition
  outcome: Outcome
}
```

Extend `WorkStats`:

```ts
export type WorkStats = {
  overall: WorkFunnel
  byAgent: Array<{ resourceId: string; resourceName: string } & WorkFunnel>
  /** Adoption: did the people who were given this work actually use it. */
  byAssignee: Array<{ assigneeUserId: string | null; assigneeName: string } & WorkFunnel>
}
```

Add the second grouping inside `computeWorkStats`, before the return:

```ts
  const byAssigneeMap = new Map<string, WorkStatRow[]>()
  for (const row of rows) {
    // The null bucket needs a stable key that cannot collide with a cuid.
    const key = row.assigneeUserId ?? ' unassigned'
    const bucket = byAssigneeMap.get(key)
    if (bucket) bucket.push(row)
    else byAssigneeMap.set(key, [row])
  }

  const byAssignee = [...byAssigneeMap.entries()]
    .map(([, group]) => ({
      assigneeUserId: group[0].assigneeUserId,
      assigneeName: group[0].assigneeName,
      ...funnel(group),
    }))
    // Volume, not rate — this is a workload view, not a leaderboard. Unassigned
    // always sorts last: it is a routing finding, not a person.
    .sort((a, b) => {
      if (a.assigneeUserId === null) return 1
      if (b.assigneeUserId === null) return -1
      return b.produced - a.produced || a.assigneeName.localeCompare(b.assigneeName)
    })

  return { overall: funnel(rows), byAgent, byAssignee }
```

- [ ] **Step 4: Fix the existing callers**

`work-rules-port.ts` and `src/app/api/goals/[id]/work/route.ts` both build
`WorkStatRow`s and now need the two new fields. In `work-rules-port.ts`, where
it maps rows for `computeWorkStats`, add `assigneeUserId: null, assigneeName: ''`
— that call only reads `.overall`, so the bucket is unused there.

- [ ] **Step 5: Run tests and typecheck**

```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/work-stats.test.ts
npm run typecheck
```
Expected: PASS. Typecheck surfaces every remaining caller missing the fields.

- [ ] **Step 6: Commit**

```bash
git add src/lib/goals
git commit -m "feat(goals): bucket the work funnel by rep, not just by agent"
```

---

### Task 5: The adoption view and the order flip

**Files:**
- Modify: `src/app/api/goals/[id]/work/route.ts`
- Create: `src/components/goals/workroom/work-adoption-strip.tsx`
- Modify: `src/components/goals/workroom/work-queue.tsx`
- Test: `src/components/goals/workroom/__tests__/work-adoption-strip.test.tsx`
- Test: `src/components/goals/workroom/__tests__/work-queue.test.tsx`

**Interfaces:**
- Consumes: `WorkStats.byAssignee` (Task 4).
- Produces: the work GET returns `viewerHasWork: boolean`; `<WorkAdoptionStrip stats={WorkStats} />`.

- [ ] **Step 1: Write the failing component test**

Create `src/components/goals/workroom/__tests__/work-adoption-strip.test.tsx`:

```tsx
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen } from '@testing-library/react'
import { WorkAdoptionStrip } from '../work-adoption-strip'

afterEach(cleanup)

const funnel = (produced: number, used: number, worked = 0) => ({
  produced,
  used,
  worked,
  usedRate: produced > 0 ? used / produced : null,
  workedRate: used > 0 ? worked / used : null,
})

const stats = {
  overall: funnel(24, 17, 6),
  byAgent: [],
  byAssignee: [
    { assigneeUserId: 'u2', assigneeName: 'Sam Diaz', ...funnel(9, 7) },
    { assigneeUserId: 'u1', assigneeName: 'Dana Reed', ...funnel(8, 8) },
    { assigneeUserId: 'u3', assigneeName: 'Alex Chen', ...funnel(7, 2) },
    { assigneeUserId: null, assigneeName: 'Unassigned', ...funnel(3, 0) },
  ],
}

test('leads with the team number, not the leaderboard', () => {
  render(<WorkAdoptionStrip stats={stats} />)
  const text = screen.getByText(/24 produced/).textContent ?? ''
  assert.match(text, /17 used/)
  assert.match(text, /71%/)
})

test('shows every person who was given work, including nobody', () => {
  render(<WorkAdoptionStrip stats={stats} />)
  for (const name of ['Sam Diaz', 'Dana Reed', 'Alex Chen', 'Unassigned']) {
    assert.ok(screen.getByText(name), `${name} must appear`)
  }
})

test('never uses the language of compliance', () => {
  // This table is one design decision from a surveillance product. If it reads
  // as a narc dashboard at a 40-person revenue team it gets switched off, and
  // the disposition signal dies with it.
  const { container } = render(<WorkAdoptionStrip stats={stats} />)
  const text = container.textContent ?? ''
  for (const word of [/compliance/i, /violation/i, /rank/i, /#1/]) {
    assert.equal(word.test(text), false, `"${word}" has no place in this view`)
  }
})

test('renders nothing before any work exists', () => {
  const { container } = render(
    <WorkAdoptionStrip stats={{ overall: funnel(0, 0), byAgent: [], byAssignee: [] }} />,
  )
  assert.equal(container.textContent, '')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/goals/workroom/__tests__/work-adoption-strip.test.tsx`
Expected: FAIL — cannot find module `../work-adoption-strip`.

- [ ] **Step 3: Implement the strip**

Create `src/components/goals/workroom/work-adoption-strip.tsx`:

```tsx
'use client'

import type { WorkStats } from '@/lib/goals/work-stats'

const pct = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)}%`)

/**
 * Did the people given this work actually use it.
 *
 * The single question a process owner cannot answer today: every adoption
 * metric they have is self-reported, and reps optimize those. Disposition is
 * not a report — it is the side effect of copying or skipping.
 *
 * Deliberately not a leaderboard. It leads with the team number, orders by
 * volume rather than rate, and names no one as failing. A low number beside a
 * rep is usually a targeting problem, which is why their skip reasons sit
 * alongside it in the rules strip rather than in a separate performance view.
 */
export function WorkAdoptionStrip({ stats }: { stats: WorkStats }) {
  if (stats.overall.produced === 0) return null
  const { produced, used, worked, usedRate } = stats.overall

  return (
    <div className="space-y-2 rounded-xl border bg-card px-4 py-3">
      <p className="text-sm">
        <span className="font-medium">Team</span>
        {' — '}
        {produced} produced → <span className="font-medium">{used} used</span> ({pct(usedRate)}) →{' '}
        {worked} worked
      </p>
      <ul className="space-y-0.5">
        {stats.byAssignee.map((row) => (
          <li
            key={row.assigneeUserId ?? 'unassigned'}
            className="flex justify-between gap-4 text-xs text-muted-foreground"
          >
            <span className="truncate">{row.assigneeName}</span>
            <span className="shrink-0 tabular-nums">
              {row.produced} → {row.used} ({pct(row.usedRate)})
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 4: Return `viewerHasWork` from the route**

In `src/app/api/goals/[id]/work/route.ts`, resolve assignee names and add the
flag. After the `all` query, replace the `computeWorkStats` call:

```ts
  const members = await prisma.user.findMany({
    where: { organizationId: auth.organizationId },
    select: { id: true, name: true, email: true },
  })
  const memberName = new Map(
    members.map((member) => [member.id, member.name ?? member.email ?? 'Teammate'] as const),
  )

  const stats = computeWorkStats(
    all.map((row) => ({
      resourceId: row.resourceId,
      resourceName: nameFor(row.resourceId),
      assigneeUserId: row.assigneeUserId,
      // A departed teammate still owns their history; degrade rather than throw.
      assigneeName: row.assigneeUserId
        ? (memberName.get(row.assigneeUserId) ?? 'Former teammate')
        : 'Unassigned',
      disposition: row.disposition as Disposition,
      outcome: row.outcome as Outcome,
    })),
  )
```

Add `assigneeUserId: true` to the `all` query's `select`. Then, before the
return:

```ts
  // Which front door to open. The person with no work assigned is the person
  // watching the process, so they get adoption first. Deliberately derived
  // rather than read from UserRole, which is ADMIN|USER — a permissions
  // concept, not a job function.
  const viewerHasWork = await prisma.goalWork.count({
    where: {
      organizationId: auth.organizationId,
      goalId,
      assigneeUserId: auth.dbUser.id,
      disposition: 'pending',
    },
  })

  return { items, stats, rules, viewerId: auth.dbUser.id, viewerHasWork: viewerHasWork > 0 }
```

- [ ] **Step 5: Flip the order in the workroom**

In `src/components/goals/workroom/work-queue.tsx`, add
`const [viewerHasWork, setViewerHasWork] = useState(true)` (defaulting to the
rep view avoids a flash of the ops view for the common case), set it in `load`
with `setViewerHasWork(body.viewerHasWork ?? true)`, import
`WorkAdoptionStrip`, and render conditionally:

```tsx
      {viewerHasWork ? (
        <>
          {queueBlock}
          <WorkAdoptionStrip stats={stats} />
        </>
      ) : (
        <>
          <WorkAdoptionStrip stats={stats} />
          {queueBlock}
        </>
      )}
```

Extract the existing filter tabs + outcome prompt + list into a `queueBlock`
constant above the return so both orders render the identical markup.

- [ ] **Step 6: Add the order test**

Append to `src/components/goals/workroom/__tests__/work-queue.test.tsx`:

```tsx
test('a viewer with no assigned work sees adoption before the queue', async () => {
  globalThis.fetch = (async () =>
    respond({
      items: [item()],
      stats: {
        overall: { produced: 4, used: 3, worked: 1, usedRate: 0.75, workedRate: 0.33 },
        byAgent: [],
        byAssignee: [
          { assigneeUserId: 'u1', assigneeName: 'Dana Reed', produced: 4, used: 3, worked: 1, usedRate: 0.75, workedRate: 0.33 },
        ],
      },
      viewerHasWork: false,
    })) as typeof fetch

  const { container } = render(<WorkQueue goalId="g1" />)
  await waitFor(() => assert.ok(screen.getByText('Dana Reed')))
  const text = container.textContent ?? ''
  assert.ok(
    text.indexOf('Dana Reed') < text.indexOf('Acme — deal 412'),
    'the process owner sees the team before the queue',
  )
})

test('a viewer with assigned work sees their queue first', async () => {
  globalThis.fetch = (async () =>
    respond({
      items: [item()],
      stats: {
        overall: { produced: 4, used: 3, worked: 1, usedRate: 0.75, workedRate: 0.33 },
        byAgent: [],
        byAssignee: [
          { assigneeUserId: 'u1', assigneeName: 'Dana Reed', produced: 4, used: 3, worked: 1, usedRate: 0.75, workedRate: 0.33 },
        ],
      },
      viewerHasWork: true,
    })) as typeof fetch

  const { container } = render(<WorkQueue goalId="g1" />)
  await waitFor(() => assert.ok(screen.getByText('Acme — deal 412')))
  const text = container.textContent ?? ''
  assert.ok(
    text.indexOf('Acme — deal 412') < text.indexOf('Dana Reed'),
    'a rep sees their work first',
  )
  assert.ok(screen.getByText('Dana Reed'), 'but adoption still renders below')
})
```

- [ ] **Step 7: Run everything and commit**

```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/goals/workroom/__tests__/work-adoption-strip.test.tsx src/components/goals/workroom/__tests__/work-queue.test.tsx
npm run typecheck && npm test
git add src/app/api/goals src/components/goals/workroom
git commit -m "feat(goals): adoption per rep, and the front door that fits the viewer"
```

---

### Task 6: Rules read as playbook findings

**Files:**
- Modify: `src/app/api/goals/[id]/work/route.ts` (return `finding` + recent notes)
- Modify: `src/components/goals/workroom/work-rules-strip.tsx`
- Test: `src/components/goals/workroom/__tests__/work-rules-strip.test.tsx`

**Interfaces:**
- Consumes: `GoalWorkRule.finding` (Task 3).
- Produces: `WorkRule` gains `finding: string | null`; the route returns `skipNotes: Array<{ subject: string; note: string }>`.

- [ ] **Step 1: Write the failing test**

Append to `src/components/goals/workroom/__tests__/work-rules-strip.test.tsx`:

```tsx
test('shows the finding, not the instruction meant for the agent', () => {
  // The statement is directive because it goes into an agent prompt. A person
  // reading this needs an observation about their entry criteria.
  render(
    <WorkRulesStrip
      rules={[{ ...rule, finding: 'daysCold under 14' }]}
      skipNotes={[]}
      onRevoke={() => {}}
    />,
  )
  assert.ok(screen.getByText(/daysCold under 14/))
  assert.equal(screen.queryByText(/Do not work subjects/), null)
})

test('falls back to the statement for rules learned before findings existed', () => {
  render(<WorkRulesStrip rules={[{ ...rule, finding: null }]} skipNotes={[]} onRevoke={() => {}} />)
  assert.ok(screen.getByText('Do not work subjects whose daysCold is under 14.'))
})

test('renders what reps said in their own words', () => {
  // The highest-signal artifact on the page: unprompted feedback on the
  // playbook, which RevOps otherwise gathers by hand from win/loss decks.
  render(
    <WorkRulesStrip
      rules={[{ ...rule, finding: 'daysCold under 14' }]}
      skipNotes={[
        { subject: 'Acme — deal 412', note: 'The account merged last week, so this is moot.' },
      ]}
      onRevoke={() => {}}
    />,
  )
  assert.ok(screen.getByText(/In their words/i))
  assert.ok(screen.getByText(/The account merged last week/))
})

test('the notes section is absent when nobody wrote one', () => {
  render(
    <WorkRulesStrip
      rules={[{ ...rule, finding: 'daysCold under 14' }]}
      skipNotes={[]}
      onRevoke={() => {}}
    />,
  )
  assert.equal(screen.queryByText(/In their words/i), null)
})

test('notes alone are worth showing even with no rules yet', () => {
  render(
    <WorkRulesStrip
      rules={[]}
      skipNotes={[{ subject: 'Initech', note: 'We already have an exec sponsor here.' }]}
      onRevoke={() => {}}
    />,
  )
  assert.ok(screen.getByText(/We already have an exec sponsor/))
})
```

Update the file's shared `rule` fixture to include `finding: 'daysCold under 14'`,
and add `skipNotes={[]}` to the pre-existing renders.

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/goals/workroom/__tests__/work-rules-strip.test.tsx`
Expected: FAIL — `skipNotes` is not a prop; the statement still renders.

- [ ] **Step 3: Update the strip**

In `src/components/goals/workroom/work-rules-strip.tsx`, add `finding: string | null`
to `WorkRule`, change the heading to `What your team is telling you`, render
`rule.finding ?? rule.statement`, and add the notes section:

```tsx
export type SkipNote = { subject: string; note: string }

export function WorkRulesStrip({
  rules,
  skipNotes,
  onRevoke,
}: {
  rules: WorkRule[]
  skipNotes: SkipNote[]
  onRevoke: (ruleId: string) => void
}) {
  if (rules.length === 0 && skipNotes.length === 0) return null
  // …rules list, rendering {rule.finding ?? rule.statement}…

  {skipNotes.length > 0 && (
    <div className="space-y-1 pt-1">
      <p className="text-xs font-medium text-muted-foreground">In their words</p>
      <ul className="space-y-0.5">
        {skipNotes.map((entry) => (
          <li key={`${entry.subject}-${entry.note}`} className="text-xs text-muted-foreground">
            “{entry.note}”
          </li>
        ))}
      </ul>
    </div>
  )}
}
```

Keep the heading `What your team is telling you` — the rules are derived from
what reps skipped, so they are the team's feedback, not the agent's config.

- [ ] **Step 4: Return findings and notes from the route**

In `src/app/api/goals/[id]/work/route.ts`, add `finding: rule.finding,` to the
mapped `rules`, and before the return:

```ts
  // Verbatim feedback on the playbook. Capped: this is a signal, not an inbox.
  const noteRows = await prisma.goalWork.findMany({
    where: { organizationId: auth.organizationId, goalId, skipNote: { not: null } },
    orderBy: { dispositionAt: 'desc' },
    take: 5,
    select: { subject: true, skipNote: true },
  })
  const skipNotes = noteRows.map((row) => ({ subject: row.subject, note: row.skipNote! }))
```

Add `skipNotes` to the returned object.

- [ ] **Step 5: Pass them through the queue**

In `src/components/goals/workroom/work-queue.tsx`, add
`const [skipNotes, setSkipNotes] = useState<SkipNote[]>([])`, set it in `load`
from `body.skipNotes ?? []`, clear it in the catch alongside the other state,
and pass `skipNotes={skipNotes}` to `<WorkRulesStrip>`.

- [ ] **Step 6: Run everything and commit**

```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/goals/workroom/__tests__/work-rules-strip.test.tsx
npm run typecheck && npm run lint && npm test
git add src/app/api/goals src/components/goals/workroom
git commit -m "feat(goals): rules read as findings, with what reps actually said"
```

---

## Self-Review

**Spec coverage.** §1 lens → Task 1; task→standard copy → Task 2. §2 `byAssignee`
→ Task 4; `viewerHasWork` and the order flip → Task 5; the anti-surveillance
stance → Task 5's copy and its "never uses the language of compliance" test.
§3 rules as findings → Tasks 3 (produce and store) and 6 (render); `skipNote`
verbatims → Task 6. §4 positioning is copy, carried by Tasks 2 and 6. §5 tests
→ distributed; the real-Postgres leg is Task 3 Step 6. Out-of-scope items appear
in no task.

**Type consistency.** `RuleCandidate.finding` is added in Task 3 and consumed by
`run-work-learning.ts` in the same task. `WorkStatRow`'s two new fields are
added in Task 4 and supplied by the route in Task 5 and by `work-rules-port.ts`
in Task 4 Step 4. `WorkStats.byAssignee` is defined in Task 4 and consumed in
Task 5. `WorkRule.finding` and `SkipNote` are defined in Task 6 and produced by
the route in the same task. `REVOPS_TEMPLATES` is exported in Task 1 and used by
Task 2's test.

**One hazard worth flagging.** Task 2 renames templates that four component
tests may assert by literal name. Task 2 Step 4 says to update those literals
rather than weaken them to substring matches — a test that stops checking the
exact name stops protecting the copy, which in this change *is* the product.
