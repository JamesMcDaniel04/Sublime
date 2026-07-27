# Goal ↔ Agent Bundles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every goal offer the agents that work on it — curated per goal template, plus three goal-native agents that use the `native:sublime-goals` tool plane — deployable in one click from the goal page.

**Architecture:** One nullable column (`Goal.templateKey`) gives a created goal memory of its template. A pure `bundleForGoal()` module composes curated seeds, goal-native seeds and a kind-matched fallback into a ranked list. Three surfaces render it: an agent-count chip on the gallery card, a "Works on it" section in the detail dialog, and a deploy card on the goal page that posts to the existing `/api/templates/provision`.

**Tech Stack:** TypeScript, Next.js App Router, Prisma/Postgres, React client components, `node:test` + `node:assert/strict` via `tsx`, React Testing Library for component tests.

**Spec:** `docs/superpowers/specs/2026-07-27-goal-agent-bundles-design.md`

## Global Constraints

- `'goals'` goes in a seed's `integrations` list and **NEVER** in `requiredIntegrations` — the plane has no connection to make, so requiring it blocks the seed forever.
- Metric Collector is offered only for sources `manual`, `slack_assisted`, `gmail_assisted` — the exact set `canWriteDatapoint()` permits.
- Period Close Reporter is offered only when the goal's `recurrence` is non-null.
- `source: null` means "not yet known" (pre-creation) and yields `conditional: true`, never exclusion.
- `GoalTemplate.agents` is a **required** field that may be `[]`. Omitting it must be a compile error.
- Fallback (`kind_match`) entries appear **only** when the curated list is empty or absent.
- Exactly one migration. No other schema change.
- Run one test file: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <path>`
- Run the full suite: `npm test`. Typecheck: `npx tsc --noEmit -p tsconfig.json`. Lint: `npx eslint <paths>`.
- Baseline before this plan: 1894 tests, 1872 pass, 22 skipped, 0 fail.

## File Structure

| File | Responsibility |
| --- | --- |
| `prisma/schema.prisma` (modify) | Add `templateKey String?` to `Goal`. |
| `prisma/migrations/20260727120000_goal_template_provenance/migration.sql` (create) | The one-line ALTER. |
| `src/app/api/goals/route.ts` (modify) | Accept and persist `templateKey`. |
| `src/app/goals/new/page.tsx` (modify) | Forward the template key it already reads from the query string. |
| `src/lib/goals/goal-templates.ts` (modify) | `agents` required on `TemplateSpec`; curated lists for all 45. |
| `src/lib/templates/goal-native-seeds.ts` (create) | The three goal-native `SeedTemplate`s. Own file so the 80-seed catalogue file does not grow further. |
| `src/lib/templates/catalogue.ts` (modify) | Spread `GOAL_NATIVE_SEEDS` into `SEED_CATALOGUE`. |
| `src/lib/goals/agent-bundle.ts` (create) | Pure `bundleForGoal()`. No I/O. |
| `src/components/goals/agent-bundle-card.tsx` (create) | The goal-page deploy card. |
| `src/components/goals/goal-template-card.tsx` (modify) | Agent-count chip. |
| `src/components/goals/goal-template-detail.tsx` (modify) | "Works on it" section. |
| `src/app/goals/[id]/page.tsx` (modify) | Mount `AgentBundleCard`. |

---

### Task 1: Goal template provenance

**Files:**
- Modify: `prisma/schema.prisma` (the `Goal` model, after `dashboardLayout`)
- Create: `prisma/migrations/20260727120000_goal_template_provenance/migration.sql`
- Modify: `src/app/api/goals/route.ts` (body schema ~line 63; `tx.goal.create` data block ~line 238)
- Modify: `src/app/goals/new/page.tsx` (template prefill effect ~line 113; submit body ~line 312)
- Test: `src/app/api/goals/__tests__/goal-template-key.test.ts`

**Interfaces:**
- Produces: `Goal.templateKey: string | null` persisted at creation; request field `templateKey?: string`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/goals/__tests__/goal-template-key.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { goalTemplateByKey, GOAL_TEMPLATES } from '@/lib/goals/goal-templates'

// The wizard sends whatever ?template= contained. A goal must never persist a
// templateKey that does not resolve, or the bundle lookup silently degrades to
// the fallback path with no signal that curation was expected.
test('every goal template key is resolvable, so a persisted templateKey is meaningful', () => {
  assert.ok(GOAL_TEMPLATES.length >= 45)
  for (const template of GOAL_TEMPLATES) {
    assert.equal(goalTemplateByKey(template.key)?.key, template.key)
  }
  assert.equal(goalTemplateByKey('not-a-real-template'), null)
})
```

- [ ] **Step 2: Run test to verify it passes already**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/goals/__tests__/goal-template-key.test.ts`
Expected: PASS. This test guards the invariant the column depends on; it is green before the column exists, which is fine — the schema work below is DB-shaped and is verified by typecheck plus the migration applying.

- [ ] **Step 3: Add the Prisma field**

In `prisma/schema.prisma`, in the `Goal` model, immediately after the `dashboardLayout Json?` field and its doc comment, add:

```prisma
  /// The GoalTemplate.key this goal was created from, or null for
  /// Copilot-drafted and manually-created goals. Read by the agent-bundle
  /// lookup to offer the template's curated agents; never edited after create.
  templateKey     String?
```

- [ ] **Step 4: Write the migration**

Create `prisma/migrations/20260727120000_goal_template_provenance/migration.sql`:

```sql
-- Goal template provenance (spec 2026-07-27): remember which goal template
-- created a goal so its curated agent bundle can be offered after creation.
-- Nullable: Copilot-drafted and manually-created goals have no template.
ALTER TABLE "goals" ADD COLUMN "templateKey" TEXT;
```

- [ ] **Step 5: Regenerate the client and typecheck**

Run: `npx prisma generate && npx tsc --noEmit -p tsconfig.json`
Expected: no output from tsc.

- [ ] **Step 6: Accept and persist it in the API**

In `src/app/api/goals/route.ts`, add to the body schema object (alongside `dashboardLayout: z.unknown().optional()`):

```ts
    templateKey: z.string().max(120).optional(),
```

In the same file's `tx.goal.create({ data: { ... } })` block, add after `parentGoalId`:

```ts
        templateKey: input.templateKey ?? null,
```

- [ ] **Step 7: Forward it from the wizard**

In `src/app/goals/new/page.tsx`, the effect that reads `?template=` already resolves the template. Add a state field beside `templateLayout`:

```ts
  // Persisted on the goal so its curated agent bundle is resolvable after
  // creation — the query param is gone by then.
  const [templateKey, setTemplateKey] = useState<string | null>(null)
```

In that same effect, after the template resolves, record the key:

```ts
      setTemplateKey(key)
```

And in the submit body, beside the `dashboardLayout` spread:

```ts
          ...(templateKey ? { templateKey } : {}),
```

- [ ] **Step 8: Typecheck, lint and commit**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npx eslint src/app/api/goals/route.ts src/app/goals/new/page.tsx src/app/api/goals/__tests__/goal-template-key.test.ts
```
Expected: no output from either.

```bash
git add prisma/schema.prisma prisma/migrations/20260727120000_goal_template_provenance src/app/api/goals/route.ts src/app/goals/new/page.tsx src/app/api/goals/__tests__/goal-template-key.test.ts
git commit -m "feat(goals): persist the template a goal was created from"
```

---

### Task 2: Three goal-native seeds

**Files:**
- Create: `src/lib/templates/goal-native-seeds.ts`
- Modify: `src/lib/templates/catalogue.ts:469` (the `SEED_CATALOGUE` spread)
- Test: `src/lib/templates/__tests__/goal-native-seeds.test.ts`

**Interfaces:**
- Consumes: `SeedTemplate` from `@/lib/templates/catalogue`
- Produces: `GOAL_NATIVE_SEEDS: SeedTemplate[]`, and the exported keys `GOAL_PACE_AUDITOR_KEY`, `GOAL_METRIC_COLLECTOR_KEY`, `GOAL_PERIOD_CLOSE_KEY` (Task 4 imports these rather than repeating string literals)

- [ ] **Step 1: Write the failing test**

Create `src/lib/templates/__tests__/goal-native-seeds.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GOAL_METRIC_COLLECTOR_KEY,
  GOAL_NATIVE_SEEDS,
  GOAL_PACE_AUDITOR_KEY,
  GOAL_PERIOD_CLOSE_KEY,
} from '@/lib/templates/goal-native-seeds'
import { SEED_CATALOGUE, getSeedByKey } from '@/lib/templates/catalogue'

test('the three goal-native seeds are in the catalogue and resolvable by key', () => {
  assert.equal(GOAL_NATIVE_SEEDS.length, 3)
  for (const key of [GOAL_PACE_AUDITOR_KEY, GOAL_METRIC_COLLECTOR_KEY, GOAL_PERIOD_CLOSE_KEY]) {
    assert.ok(getSeedByKey(key), `${key} is not resolvable through the catalogue`)
  }
})

test('goal-native seeds activate the goals plane through integrations', () => {
  for (const seed of GOAL_NATIVE_SEEDS) {
    assert.ok(
      (seed.integrations ?? []).includes('goals'),
      `${seed.seedKey} must list 'goals' in integrations to activate the plane`,
    )
  }
})

test('NO seed anywhere requires goals — it has no connection to make', () => {
  // The sublime-goals descriptor is available: () => true and is scoped by
  // GoalContribution, not credentials. Listing it in requiredIntegrations would
  // make readiness() report 'connect' forever against an unconnectable tool.
  for (const seed of SEED_CATALOGUE) {
    assert.ok(
      !seed.requiredIntegrations.includes('goals'),
      `${seed.seedKey} must not require 'goals'`,
    )
  }
})

test('the metric collector is always deployable and serves every department', () => {
  const collector = getSeedByKey(GOAL_METRIC_COLLECTOR_KEY)!
  // Delivery-exempt: its output is a datapoint on the goal, not a message, so
  // normalizeDelivery must leave it alone. This is what keeps "every goal has
  // something deployable with zero integrations" true.
  assert.equal(collector.deliversToGoal, true)
  assert.deepEqual(collector.requiredIntegrations, [])
  assert.equal(collector.departments.length, 5)
})

test('the two posting agents DO normalize to a Slack delivery integration', () => {
  for (const key of [GOAL_PACE_AUDITOR_KEY, GOAL_PERIOD_CLOSE_KEY]) {
    const seed = getSeedByKey(key)!
    assert.ok(
      seed.requiredIntegrations.includes('slack'),
      `${key} posts messages and must carry a delivery integration`,
    )
  }
})

test('the delivery exemption stays minimal — exactly one seed uses it', () => {
  const exempt = SEED_CATALOGUE.filter((seed) => seed.deliversToGoal)
  assert.deepEqual(exempt.map((seed) => seed.seedKey), [GOAL_METRIC_COLLECTOR_KEY])
})

test('goal-native seeds are scheduled, not manual — they must run on their own', () => {
  for (const seed of GOAL_NATIVE_SEEDS) {
    assert.equal(seed.trigger?.type, 'schedule', `${seed.seedKey} must be scheduled`)
    assert.equal(seed.trigger?.schedule?.isActive, true)
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/templates/__tests__/goal-native-seeds.test.ts`
Expected: FAIL — cannot find module `@/lib/templates/goal-native-seeds`

- [ ] **Step 3: Write the seeds**

Create `src/lib/templates/goal-native-seeds.ts`:

```ts
/**
 * Goal-native seed templates — agents whose subject IS a Sublime goal, built on
 * the native:sublime-goals tool plane (spec 2026-07-27).
 *
 * Kept out of catalogue.ts, which already carries 80 seeds.
 *
 * CRITICAL: 'goals' belongs in `integrations`, never `requiredIntegrations`.
 * Readiness compares required slugs against CONNECTED slugs, and the goals
 * plane has no connection to make (its descriptor is available: () => true,
 * scoped by GoalContribution). Requiring it would render every one of these
 * permanently blocked behind a Connect button that cannot be satisfied.
 *
 * Deliberately absent: a "why is this off track" diagnoser (that is
 * src/lib/goals/recovery.ts) and a weekly pace digest (src/lib/goals/digest.ts).
 */
import type { Department } from './departments'
import type { SeedTemplate } from './catalogue'

export const GOAL_PACE_AUDITOR_KEY = 'goal-pace-auditor'
export const GOAL_METRIC_COLLECTOR_KEY = 'goal-metric-collector'
export const GOAL_PERIOD_CLOSE_KEY = 'goal-period-close-reporter'

const ALL_DEPARTMENTS: Department[] = ['sales', 'engineering', 'marketing', 'finance', 'csm']

const daily = (hour: number) => ({
  type: 'schedule' as const,
  schedule: {
    type: 'cron' as const,
    cron: `0 ${hour} * * *`,
    time: '',
    timezone: 'UTC',
    isActive: true,
  },
})

const monthly = {
  type: 'schedule' as const,
  schedule: {
    type: 'cron' as const,
    cron: '0 9 1 * *',
    time: '',
    timezone: 'UTC',
    isActive: true,
  },
}

export const GOAL_NATIVE_SEEDS: SeedTemplate[] = [
  {
    seedKey: GOAL_PACE_AUDITOR_KEY,
    name: 'Goal Pace Auditor',
    description:
      'Checks the goal against its pace every morning and posts to Slack only when it is falling behind, naming the gap and the run-rate now needed.',
    departments: ALL_DEPARTMENTS,
    requiredIntegrations: ['slack'],
    recommendedIntegrations: [],
    integrations: ['goals', 'slack'],
    kind: 'agent',
    icon: '⏱️',
    estimatedMinutesSaved: 10,
    trigger: daily(8),
    instructions: [
      'You audit one goal against its pace, once a day.',
      '',
      'Call get_pace. If riskLevel is "on_track", post NOTHING and reply "on track, no post" — a daily "still fine" message trains people to ignore you.',
      '',
      'If riskLevel is "at_risk" or "off_track", call get_goal for the target and unit, then post one Slack message that states: the current value against the target, how far behind pace it is, the run-rate now required per day to finish on time, and the number of days remaining. Use the goal\'s unit. Be specific and short — no preamble, no encouragement.',
      '',
      'If riskLevel is "no_data", say so plainly and note when the metric was last read, rather than guessing.',
    ].join('\n'),
  },
  {
    seedKey: GOAL_METRIC_COLLECTOR_KEY,
    name: 'Goal Metric Collector',
    description:
      'Finds the current number for a goal you track by hand — in a Slack channel, an inbox, or a web page — and records it against the goal automatically.',
    departments: ALL_DEPARTMENTS,
    requiredIntegrations: [],
    recommendedIntegrations: ['slack', 'gmail'],
    integrations: ['goals', 'slack', 'gmail', 'http'],
    kind: 'agent',
    icon: '📥',
    estimatedMinutesSaved: 15,
    trigger: daily(7),
    instructions: [
      'You keep one manually-tracked goal up to date.',
      '',
      'Call get_goal to learn what is being measured and in what unit. Then find the current value from the source described below, and record it with log_datapoint.',
      '',
      'SOURCE: describe here where the number lives — a Slack channel, a mailbox search, or a URL. Edit this line when you deploy the agent.',
      '',
      'Rules: record a number only when you have actually read it from the source. Never estimate, never interpolate, never carry yesterday\'s value forward. If you cannot find a current reading, call list_datapoints to confirm what was last recorded and report that you found nothing new — leaving the series honest matters more than filling it.',
      '',
      'If log_datapoint refuses because the goal is tracked from a system of record, stop and report the number in your output instead. That refusal is correct and must not be worked around.',
    ].join('\n'),
  },
  {
    seedKey: GOAL_PERIOD_CLOSE_KEY,
    name: 'Goal Period Close Reporter',
    description:
      'When a recurring goal\'s period closes, reports how it actually landed against the target it was set — and how that compares with the period before.',
    departments: ALL_DEPARTMENTS,
    requiredIntegrations: ['slack'],
    recommendedIntegrations: [],
    integrations: ['goals', 'slack'],
    kind: 'agent',
    icon: '📆',
    estimatedMinutesSaved: 20,
    trigger: monthly,
    instructions: [
      'You report on recurring goal periods after they close.',
      '',
      'Runs monthly regardless of the goal\'s own cadence. FIRST, call get_goal and list_datapoints and determine whether a period has actually closed since your last run. On a quarterly or yearly goal most runs will find nothing closed — when that is the case, post nothing and reply "no period closed".',
      '',
      'When a period HAS closed, post one Slack message covering: the final value against the target that period was set, whether that is a hit or a miss and by how much, and the change versus the previous period.',
      '',
      'Report the period that closed. Do not forecast the next one and do not recommend actions — a separate recovery plan owns that.',
    ].join('\n'),
  },
]
```

- [ ] **Step 4: Add the delivery-exemption flag**

In `src/lib/templates/catalogue.ts`, add to the `SeedTemplate` type:

```ts
  /** This agent's output is a datapoint written back to a goal, not a message,
   *  so it has no delivery channel to require. normalizeDelivery skips it.
   *  Exactly one seed sets this; see goal-native-seeds.ts. */
  deliversToGoal?: boolean
```

And make `normalizeDelivery` (line ~457) honor it — first line of the function body:

```ts
function normalizeDelivery(seed: SeedTemplate): SeedTemplate {
  if (seed.deliversToGoal) return seed
  const delivery = deliveryForSeed(seed)
```

- [ ] **Step 5: Register them in the catalogue**

In `src/lib/templates/catalogue.ts`, add the import beside the other seed imports at the top:

```ts
import { GOAL_NATIVE_SEEDS } from './goal-native-seeds'
```

And extend the `SEED_CATALOGUE` spread at line 469:

```ts
export const SEED_CATALOGUE: SeedTemplate[] = [...BASE_SEED_CATALOGUE, ...MULTI_TOOL_SEEDS, ...GMAIL_SEEDS, ...GOAL_NATIVE_SEEDS].map(normalizeDelivery)
```

- [ ] **Step 6: Update the catalogue size ratchet and the delivery invariant**

`catalogue.test.ts` hard-codes the catalogue size. The three new seeds serve all
five departments, so update the first test:

```ts
test('83 seeds, 19 per department bucket, unique seedKeys', () => {
  assert.equal(SEED_CATALOGUE.length, 83)
  const keys = SEED_CATALOGUE.map((s) => s.seedKey)
  assert.equal(new Set(keys).size, 83, 'seedKeys must be unique')
  for (const dept of DEPARTMENTS.filter((d) => d !== 'general')) {
    const n = SEED_CATALOGUE.filter((s) => s.departments.includes(dept)).length
    assert.equal(n, 19, `${dept} needs exactly 19 seeds, got ${n}`)
  }
})
```

This is a ratchet bump for real growth, not a weakened invariant — the counts
still pin the catalogue exactly.

In the same file, the delivery invariant must skip the exempt seed. Change only
the guard, leaving every other assertion in that test untouched:

```ts
test('every template requires Slack or Gmail delivery and exposes an executable runbook', () => {
  for (const seed of SEED_CATALOGUE) {
    // Delivery-exempt seeds write their result back to a goal instead of
    // sending it somewhere, so they have no channel to require.
    if (!seed.deliversToGoal) {
      assert.ok(
        seed.requiredIntegrations.includes('slack') || seed.requiredIntegrations.includes('gmail'),
        `${seed.seedKey} needs Slack or Gmail delivery`,
      )
    }
```

The runbook assertions below that guard stay as they are and must still pass —
`instructionsForSeed()` composes those sections for every seed, exempt or not.

- [ ] **Step 7: Run tests**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/templates/__tests__/goal-native-seeds.test.ts src/lib/templates/__tests__/catalogue.test.ts`
Expected: PASS.

If a runbook assertion fails, fix the seed's instructions to satisfy it. Do not weaken it — those sections are what make a provisioned agent produce a usable artifact.

- [ ] **Step 8: Commit**

```bash
git add src/lib/templates/goal-native-seeds.ts src/lib/templates/catalogue.ts src/lib/templates/__tests__/goal-native-seeds.test.ts src/lib/templates/__tests__/catalogue.test.ts
git commit -m "feat(goals): add three goal-native agent seeds"
```

---

### Task 3: Curated bundles on goal templates

**Files:**
- Modify: `src/lib/goals/goal-templates.ts` (the `TemplateSpec` type ~line 63, the `template()` factory ~line 73, the `GoalTemplate` type ~line 34, and all 45 template calls)
- Test: `src/lib/goals/__tests__/goal-template-agents.test.ts`

**Interfaces:**
- Consumes: `getSeedByKey` from `@/lib/templates/catalogue`
- Produces: `GoalTemplate.agents: string[]` — required, possibly empty

- [ ] **Step 1: Write the failing test**

Create `src/lib/goals/__tests__/goal-template-agents.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GOAL_TEMPLATES } from '@/lib/goals/goal-templates'
import { getSeedByKey } from '@/lib/templates/catalogue'

test('every curated seedKey resolves to a real seed', () => {
  for (const template of GOAL_TEMPLATES) {
    for (const seedKey of template.agents) {
      assert.ok(
        getSeedByKey(seedKey),
        `${template.key} references unknown seed "${seedKey}"`,
      )
    }
  }
})

test('curated agents come from the goal template\'s own department', () => {
  for (const template of GOAL_TEMPLATES) {
    for (const seedKey of template.agents) {
      const seed = getSeedByKey(seedKey)!
      assert.ok(
        seed.departments.includes(template.department),
        `${template.key} (${template.department}) curates ${seedKey}, which serves ${seed.departments.join('|')}`,
      )
    }
  }
})

test('agents is present on every template, so an empty list is deliberate', () => {
  for (const template of GOAL_TEMPLATES) {
    assert.ok(Array.isArray(template.agents), `${template.key} has no agents field`)
  }
  // Curation is intentionally partial, but a mostly-empty catalogue would mean
  // the curation step was skipped rather than considered.
  const curated = GOAL_TEMPLATES.filter((template) => template.agents.length > 0)
  assert.ok(
    curated.length >= 40,
    `only ${curated.length} of ${GOAL_TEMPLATES.length} templates are curated`,
  )
})

test('no template curates the same seed twice', () => {
  for (const template of GOAL_TEMPLATES) {
    assert.equal(
      new Set(template.agents).size,
      template.agents.length,
      `${template.key} lists a duplicate seed`,
    )
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/goal-template-agents.test.ts`
Expected: FAIL — `template.agents` is undefined, so `Array.isArray` fails and the for-of throws.

- [ ] **Step 3: Add the required field**

In `src/lib/goals/goal-templates.ts`, add to the `GoalTemplate` type after `sources`:

```ts
  /** Curated seedKeys from this template's own department that work toward
   *  this goal. Explicitly `[]` when no existing seed genuinely fits — the
   *  bundle then falls back to kind-matching. Required so an omission is a
   *  compile error rather than an invisible gap. */
  agents: string[]
```

Add the same required field to `TemplateSpec` (note: NOT optional):

```ts
  agents: string[]
```

And in the `template()` factory's returned object, after `sources: rankSources(spec.sources),`:

```ts
  agents: spec.agents,
```

- [ ] **Step 4: Curate all 45 templates**

Add an `agents: [...]` entry to each template's spec object. Apply exactly this mapping — every seedKey below is verified present in the catalogue and in the matching department.

**Sales**

| Template | `agents` |
| --- | --- |
| `sales-org-quarterly-revenue` | `['sales-forecast-evidence-auditor', 'sales-weekly-pipeline-digest']` |
| `sales-org-arr-growth` | `['sales-renewal-expansion-radar']` |
| `sales-personal-quota` | `['sales-forecast-evidence-auditor', 'sales-prospect-followup-digest']` |
| `sales-personal-monthly-closed` | `['sales-discovery-followup-writer', 'sales-prospect-followup-digest']` |
| `sales-org-pipeline-coverage` | `['sales-pipeline-hygiene-nudger', 'sales-territory-white-space']` |
| `sales-org-win-rate` | `['sales-loss-pattern-review', 'sales-call-coaching-loop']` |
| `sales-org-new-logos` | `['sales-territory-white-space', 'sales-new-lead-to-sf-opportunity']` |
| `sales-personal-pipeline-created` | `['sales-sequence-personalizer', 'sales-account-intent-brief']` |
| `sales-personal-meetings-booked` | `['sales-sequence-personalizer', 'sales-prospect-followup-digest']` |

**Marketing**

| Template | `agents` |
| --- | --- |
| `marketing-org-monthly-mqls` | `['mkt-inbound-mql-router', 'marketing-lead-quality-loop']` |
| `marketing-org-inbound-mrr` | `['marketing-lead-quality-loop', 'marketing-funnel-anomaly-brief']` |
| `marketing-personal-campaign-leads` | `['mkt-inbound-mql-router', 'marketing-campaign-command-center']` |
| `marketing-personal-newsletter` | `[]` |
| `marketing-org-cac` | `['marketing-funnel-anomaly-brief', 'marketing-lead-quality-loop']` |
| `marketing-org-organic-traffic` | `['marketing-content-repurpose-engine', 'marketing-editorial-operations']` |
| `marketing-org-sourced-pipeline` | `['marketing-lead-quality-loop', 'marketing-funnel-anomaly-brief']` |
| `marketing-personal-content-output` | `['marketing-editorial-operations', 'mkt-content-repurposer']` |
| `marketing-personal-conversion-rate` | `['marketing-creative-performance-review', 'marketing-funnel-anomaly-brief']` |

`marketing-personal-newsletter` is `[]` deliberately: the catalogue has no list-tool seed, and every marketing seed is CRM- or content-shaped. Kind-matching plus the goal-native agents serve it better than a forced pairing.

**Engineering**

| Template | `agents` |
| --- | --- |
| `engineering-org-infra-savings` | `[]` |
| `engineering-org-open-bugs` | `['eng-quality-escape-review', 'eng-issue-triage-routing']` |
| `engineering-personal-bug-backlog` | `['eng-issue-triage-routing']` |
| `engineering-personal-ship-cadence` | `['eng-sprint-risk-forecaster']` |
| `engineering-org-deploy-frequency` | `['eng-release-readiness-room', 'eng-release-notes-drafter']` |
| `engineering-org-p1-incidents` | `['eng-incident-context-assembler', 'eng-oncall-handoff']` |
| `engineering-org-lead-time` | `['eng-sprint-risk-forecaster', 'eng-pr-review-checklist-bot']` |
| `engineering-personal-review-turnaround` | `['eng-pr-review-checklist-bot']` |
| `engineering-personal-test-coverage` | `['eng-quality-escape-review']` |

`engineering-org-infra-savings` is `[]` deliberately: every engineering seed is code- or ticket-shaped, and none reads cloud spend.

**Finance**

| Template | `agents` |
| --- | --- |
| `finance-org-vendor-savings` | `['finance-spend-exception-review', 'fin-spend-anomaly-reporter']` |
| `finance-org-collected-revenue` | `['finance-cash-collection-prioritizer', 'fin-weekly-cash-ar-digest']` |
| `finance-personal-cost-center` | `['finance-spend-exception-review']` |
| `finance-personal-dso` | `['finance-cash-collection-prioritizer', 'fin-weekly-cash-ar-digest']` |
| `finance-org-gross-margin` | `['finance-margin-leakage-finder', 'finance-deal-economics-review']` |
| `finance-org-burn-reduction` | `['fin-spend-anomaly-reporter', 'finance-headcount-plan-monitor']` |
| `finance-org-revenue-per-head` | `['finance-headcount-plan-monitor', 'finance-board-metrics-packet']` |
| `finance-personal-close-cycle` | `['finance-close-command-center']` |
| `finance-personal-forecast-accuracy` | `['finance-forecast-assumption-register', 'finance-revenue-variance-explainer']` |

**CSM**

| Template | `agents` |
| --- | --- |
| `csm-org-nrr` | `['csm-renewal-readiness-review', 'csm-churn-risk-early-warning']` |
| `csm-org-expansion-mrr` | `['csm-adoption-gap-finder', 'csm-renewal-readiness-review']` |
| `csm-personal-renewals` | `['csm-renewal-readiness-review', 'csm-renewal-risk-email']` |
| `csm-personal-churn-saves` | `['csm-churn-risk-early-warning', 'csm-escalation-command-center']` |
| `csm-org-gross-retention` | `['csm-churn-risk-early-warning', 'csm-health-score-explainer']` |
| `csm-org-csat` | `['csm-ticket-theme-to-roadmap', 'csm-escalation-command-center']` |
| `csm-org-time-to-value` | `['csm-onboarding-task-orchestrator', 'csm-onboarding-risk-radar']` |
| `csm-personal-qbr-coverage` | `['csm-qbr-prep-brief', 'csm-executive-briefing']` |
| `csm-personal-response-time` | `['csm-ticket-triage-escalation', 'csm-escalation-command-center']` |

- [ ] **Step 5: Run tests**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/goal-template-agents.test.ts src/lib/goals/__tests__/goal-templates.test.ts`
Expected: PASS. `goal-templates.test.ts` locks per-department counts and key preservation and must stay green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/goals/goal-templates.ts src/lib/goals/__tests__/goal-template-agents.test.ts
git commit -m "feat(goals): curate agent bundles on goal templates"
```

---

### Task 4: Bundle resolution

**Files:**
- Create: `src/lib/goals/agent-bundle.ts`
- Test: `src/lib/goals/__tests__/agent-bundle.test.ts`

**Interfaces:**
- Consumes: `goalTemplateByKey` (`@/lib/goals/goal-templates`), `getSeedByKey` + `SeedTemplate` (`@/lib/templates/catalogue`), `goalTemplatesFor` (`@/lib/templates/goal-fit`), `AGENT_WRITABLE_SOURCES` (`@/lib/goals/agent-tool-policy`), the three key constants (`@/lib/templates/goal-native-seeds`)
- Produces:
  - `type BundleEntry = { seedKey: string; name: string; description: string; requiredIntegrations: string[]; origin: 'curated' | 'goal_native' | 'kind_match'; conditional: boolean; deployed: boolean }`
  - `bundleForGoal(input: { templateKey?: string | null; kind: string; source?: string | null; recurrence?: string | null; deployedSeedKeys?: string[] }): BundleEntry[]`

- [ ] **Step 1: Write the failing test**

Create `src/lib/goals/__tests__/agent-bundle.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundleForGoal } from '@/lib/goals/agent-bundle'
import {
  GOAL_METRIC_COLLECTOR_KEY,
  GOAL_PACE_AUDITOR_KEY,
  GOAL_PERIOD_CLOSE_KEY,
} from '@/lib/templates/goal-native-seeds'

const keys = (entries: { seedKey: string }[]) => entries.map((entry) => entry.seedKey)

test('curated entries lead, then goal-native, and no fallback appears', () => {
  const bundle = bundleForGoal({
    templateKey: 'sales-org-pipeline-coverage',
    kind: 'custom_kpi',
    source: 'hubspot',
    recurrence: null,
  })
  const origins = bundle.map((entry) => entry.origin)
  assert.equal(origins[0], 'curated')
  assert.ok(!origins.includes('kind_match'), 'a curated template must not fall back')
  // Ordering: every curated entry precedes every goal_native entry.
  assert.equal(
    origins.lastIndexOf('curated') < origins.indexOf('goal_native'),
    true,
  )
})

test('the pace auditor is offered for every goal', () => {
  const bundle = bundleForGoal({ templateKey: null, kind: 'custom_kpi', source: 'stripe' })
  assert.ok(keys(bundle).includes(GOAL_PACE_AUDITOR_KEY))
})

test('the metric collector is offered only where the write policy permits', () => {
  for (const source of ['manual', 'slack_assisted', 'gmail_assisted']) {
    const bundle = bundleForGoal({ templateKey: null, kind: 'custom_kpi', source })
    assert.ok(
      keys(bundle).includes(GOAL_METRIC_COLLECTOR_KEY),
      `collector should be offered for ${source}`,
    )
  }
  for (const source of ['stripe', 'hubspot', 'salesforce', 'google_sheets', 'postgres', 'url']) {
    const bundle = bundleForGoal({ templateKey: null, kind: 'custom_kpi', source })
    assert.ok(
      !keys(bundle).includes(GOAL_METRIC_COLLECTOR_KEY),
      `collector must NOT be offered for ${source} — log_datapoint would refuse`,
    )
  }
})

test('an unknown source means pre-creation, so the collector is conditional not excluded', () => {
  const bundle = bundleForGoal({ templateKey: null, kind: 'custom_kpi', source: null })
  const collector = bundle.find((entry) => entry.seedKey === GOAL_METRIC_COLLECTOR_KEY)
  assert.ok(collector, 'collector should appear when the source is not yet chosen')
  assert.equal(collector.conditional, true)
})

test('the period close reporter needs a recurrence', () => {
  const recurring = bundleForGoal({
    templateKey: null,
    kind: 'revenue',
    source: 'stripe',
    recurrence: 'quarterly',
  })
  assert.ok(keys(recurring).includes(GOAL_PERIOD_CLOSE_KEY))

  const oneOff = bundleForGoal({ templateKey: null, kind: 'revenue', source: 'stripe', recurrence: null })
  assert.ok(!keys(oneOff).includes(GOAL_PERIOD_CLOSE_KEY))
})

test('fallback fires only when curation is empty or absent', () => {
  // marketing-personal-newsletter is curated as a deliberate [].
  const emptyCurated = bundleForGoal({
    templateKey: 'marketing-personal-newsletter',
    kind: 'lead_gen',
    source: 'google_sheets',
  })
  assert.ok(
    emptyCurated.some((entry) => entry.origin === 'kind_match'),
    'an empty curated list must fall back',
  )

  const noTemplate = bundleForGoal({ templateKey: null, kind: 'lead_gen', source: 'hubspot' })
  assert.ok(noTemplate.some((entry) => entry.origin === 'kind_match'))
})

test('an unknown templateKey degrades to the fallback rather than throwing', () => {
  const bundle = bundleForGoal({ templateKey: 'deleted-template', kind: 'revenue', source: 'stripe' })
  assert.ok(bundle.length > 0)
  assert.ok(!bundle.some((entry) => entry.origin === 'curated'))
})

test('a deployed seed is marked, not dropped', () => {
  const bundle = bundleForGoal({
    templateKey: 'sales-org-pipeline-coverage',
    kind: 'custom_kpi',
    source: 'hubspot',
    deployedSeedKeys: ['sales-pipeline-hygiene-nudger'],
  })
  const entry = bundle.find((item) => item.seedKey === 'sales-pipeline-hygiene-nudger')
  assert.ok(entry, 'a deployed seed must still be listed')
  assert.equal(entry.deployed, true)
  assert.equal(bundle.filter((item) => item.deployed).length, 1)
})

test('a seed both curated and kind-matched appears once, as curated', () => {
  const bundle = bundleForGoal({
    templateKey: 'sales-org-quarterly-revenue',
    kind: 'revenue',
    source: 'stripe',
  })
  assert.equal(new Set(keys(bundle)).size, bundle.length, 'bundle contains a duplicate')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/agent-bundle.test.ts`
Expected: FAIL — cannot find module `@/lib/goals/agent-bundle`

- [ ] **Step 3: Write the implementation**

Create `src/lib/goals/agent-bundle.ts`:

```ts
/**
 * Which agents work on a goal (spec 2026-07-27). Pure — no I/O — so ordering
 * and applicability are exhaustively unit-testable.
 *
 * Composition, in display order: the goal template's curated seeds, then the
 * goal-native seeds that apply, then a kind-matched fallback used ONLY when
 * curation is empty or absent. That last rule is what makes an explicit
 * `agents: []` meaningful: it says "nothing here fits, go find matches by kind"
 * rather than "no agents at all".
 */
import { goalTemplateByKey } from '@/lib/goals/goal-templates'
import { getSeedByKey, type SeedTemplate } from '@/lib/templates/catalogue'
import { goalTemplatesFor } from '@/lib/templates/goal-fit'
import { AGENT_WRITABLE_SOURCES } from '@/lib/goals/agent-tool-policy'
import {
  GOAL_METRIC_COLLECTOR_KEY,
  GOAL_PACE_AUDITOR_KEY,
  GOAL_PERIOD_CLOSE_KEY,
} from '@/lib/templates/goal-native-seeds'

export type BundleOrigin = 'curated' | 'goal_native' | 'kind_match'

export type BundleEntry = {
  seedKey: string
  name: string
  description: string
  requiredIntegrations: string[]
  origin: BundleOrigin
  /** True when applicability depends on a choice not yet made (the metric
   *  source, before the goal exists). The UI renders a qualifier. */
  conditional: boolean
  deployed: boolean
}

export type BundleInput = {
  templateKey?: string | null
  kind: string
  /** The goal's primary metric source. `null` = not chosen yet (pre-creation). */
  source?: string | null
  recurrence?: string | null
  deployedSeedKeys?: string[]
}

/** How many kind-matched seeds to offer when falling back. Enough to be useful,
 *  short enough that the card stays a decision rather than a catalogue. */
const MAX_FALLBACK = 3

function goalNativeKeysFor(input: BundleInput): { key: string; conditional: boolean }[] {
  const entries: { key: string; conditional: boolean }[] = [
    { key: GOAL_PACE_AUDITOR_KEY, conditional: false },
  ]

  // Mirrors canWriteDatapoint: offering the collector on a system-of-record
  // goal would produce an agent whose first log_datapoint call is refused.
  const source = input.source
  if (source === null || source === undefined) {
    entries.push({ key: GOAL_METRIC_COLLECTOR_KEY, conditional: true })
  } else if (AGENT_WRITABLE_SOURCES.has(source)) {
    entries.push({ key: GOAL_METRIC_COLLECTOR_KEY, conditional: false })
  }

  if (input.recurrence) {
    entries.push({ key: GOAL_PERIOD_CLOSE_KEY, conditional: false })
  }
  return entries
}

export function bundleForGoal(input: BundleInput): BundleEntry[] {
  const deployed = new Set(input.deployedSeedKeys ?? [])
  const seen = new Set<string>()
  const bundle: BundleEntry[] = []

  const push = (seed: SeedTemplate, origin: BundleOrigin, conditional: boolean) => {
    if (seen.has(seed.seedKey)) return
    seen.add(seed.seedKey)
    bundle.push({
      seedKey: seed.seedKey,
      name: seed.name,
      description: seed.description,
      requiredIntegrations: seed.requiredIntegrations,
      origin,
      conditional,
      deployed: deployed.has(seed.seedKey),
    })
  }

  // 1. Curated. An unknown key (a template removed since the goal was created)
  //    degrades to the fallback rather than throwing.
  const template = input.templateKey ? goalTemplateByKey(input.templateKey) : null
  for (const seedKey of template?.agents ?? []) {
    const seed = getSeedByKey(seedKey)
    if (seed) push(seed, 'curated', false)
  }

  // 2. Goal-native.
  for (const entry of goalNativeKeysFor(input)) {
    const seed = getSeedByKey(entry.key)
    if (seed) push(seed, 'goal_native', entry.conditional)
  }

  // 3. Fallback — only when curation produced nothing.
  const hasCurated = bundle.some((entry) => entry.origin === 'curated')
  if (!hasCurated) {
    for (const seed of goalTemplatesFor(input.kind).slice(0, MAX_FALLBACK)) {
      push(seed, 'kind_match', false)
    }
  }

  return bundle
}
```

- [ ] **Step 4: Run tests**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/agent-bundle.test.ts`
Expected: PASS — 9 tests

If "fallback fires only when curation is empty or absent" fails for `lead_gen`, confirm that at least one seed declares `goalKinds: ['lead_gen']` — `mkt-inbound-mql-router` does. If it does not, the fallback has nothing to return and the assertion is correct to fail; fix by adding `goalKinds` to that seed rather than weakening the test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/goals/agent-bundle.ts src/lib/goals/__tests__/agent-bundle.test.ts
git commit -m "feat(goals): resolve which agents work on a goal"
```

---

### Task 5: Pre-creation surfaces

**Files:**
- Modify: `src/components/goals/goal-template-detail.tsx` (add a section after the "Reads from" `</section>`)
- Modify: `src/components/goals/goal-template-card.tsx` (add a chip in the `tools` slot)
- Test: `src/components/goals/__tests__/goal-template-agents-ui.test.tsx`

**Interfaces:**
- Consumes: `bundleForGoal`, `BundleEntry` (Task 4); `IntegrationChip` (`@/components/integrations/integration-chip`)
- Produces: no new exports

- [ ] **Step 1: Write the failing test**

Create `src/components/goals/__tests__/goal-template-agents-ui.test.tsx`:

```tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, cleanup } from '@testing-library/react'
import { GoalTemplateDetail } from '@/components/goals/goal-template-detail'
import { goalTemplateByKey } from '@/lib/goals/goal-templates'

const template = goalTemplateByKey('sales-org-pipeline-coverage')!

test('the detail dialog lists the agents that work on the goal', () => {
  render(
    <GoalTemplateDetail
      template={template}
      sources={[]}
      sourcesFailed={false}
      onClose={() => {}}
    />,
  )
  assert.ok(screen.getByText('Works on it'))
  // A curated seed and a goal-native seed both appear.
  assert.ok(screen.getByText('Goal Pace Auditor'))
  assert.ok(screen.getAllByText(/Pipeline Hygiene|hygiene/i).length > 0)
  cleanup()
})

test('a source-dependent agent is shown with its qualifier before the source is chosen', () => {
  render(
    <GoalTemplateDetail
      template={template}
      sources={[]}
      sourcesFailed={false}
      onClose={() => {}}
    />,
  )
  assert.ok(screen.getByText('Goal Metric Collector'))
  assert.ok(screen.getByText(/if you track this goal manually or with AI-read/i))
  cleanup()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/goals/__tests__/goal-template-agents-ui.test.tsx`
Expected: FAIL — "Unable to find an element with the text: Works on it"

- [ ] **Step 3: Add the "Works on it" section**

In `src/components/goals/goal-template-detail.tsx`, add the imports:

```ts
import { IntegrationChip } from '@/components/integrations/integration-chip'
import { bundleForGoal } from '@/lib/goals/agent-bundle'
```

Inside the component, beside the existing `preview` memo:

```ts
  // source: null — the user picks the metric source in the wizard, after this
  // dialog. Source-dependent agents come back flagged conditional.
  const agents = useMemo(
    () =>
      template
        ? bundleForGoal({
            templateKey: template.key,
            kind: template.kind,
            source: null,
            recurrence: template.recurrence,
          })
        : [],
    [template],
  )
```

Then insert this section immediately after the closing `</section>` of "Reads from" and before the "Dashboard preview" section:

```tsx
        {agents.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Works on it</h3>
            <p className="text-xs text-muted-foreground">
              Deploy these from the goal once it exists — they do the work the
              number measures.
            </p>
            <ul className="space-y-1.5">
              {agents.map((agent) => (
                <li
                  key={agent.seedKey}
                  className="space-y-1 rounded-lg border border-border/60 px-3 py-2"
                >
                  <p className="text-sm font-medium">{agent.name}</p>
                  <p className="text-xs text-muted-foreground">{agent.description}</p>
                  {agent.conditional && (
                    <p className="text-xs text-muted-foreground">
                      Available if you track this goal manually or with AI-read.
                    </p>
                  )}
                  {agent.requiredIntegrations.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                      {agent.requiredIntegrations.map((integration) => (
                        <IntegrationChip key={integration} name={integration} />
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
```

- [ ] **Step 4: Add the card chip**

In `src/components/goals/goal-template-card.tsx`, add the import:

```ts
import { bundleForGoal } from '@/lib/goals/agent-bundle'
```

Inside the component, before the `return`:

```ts
  const agentCount = bundleForGoal({
    templateKey: template.key,
    kind: template.kind,
    source: null,
    recurrence: template.recurrence,
  }).length
```

In the `tools` slot, after the closing `</div>` of the sources row and before the closing `</div>` of the wrapper:

```tsx
            {agentCount > 0 && (
              <p className="text-xs font-medium text-muted-foreground">
                {agentCount} {agentCount === 1 ? 'agent' : 'agents'} work on it
              </p>
            )}
```

- [ ] **Step 5: Run tests**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/goals/__tests__/goal-template-agents-ui.test.tsx src/components/goals/__tests__/goal-template-detail.test.tsx src/components/goals/__tests__/goal-template-card.test.tsx`
Expected: PASS. The two existing component tests must stay green.

- [ ] **Step 6: Commit**

```bash
git add src/components/goals/goal-template-detail.tsx src/components/goals/goal-template-card.tsx src/components/goals/__tests__/goal-template-agents-ui.test.tsx
git commit -m "feat(goals): show bundled agents on template card and detail"
```

---

### Task 6: Goal-page deploy card

**Files:**
- Create: `src/components/goals/agent-bundle-card.tsx`
- Modify: `src/app/goals/[id]/page.tsx` (mount after the soft-source nudge, before `<GoalDashboard`)
- Test: `src/components/goals/__tests__/agent-bundle-card.test.tsx`

**Interfaces:**
- Consumes: `bundleForGoal`, `BundleEntry` (Task 4); `missingIntegrations` (`@/lib/templates/relevance`)
- Produces: `AgentBundleCard({ goalId, templateKey, kind, source, recurrence, deployedSeedKeys, connectedIntegrations, onChanged })`

- [ ] **Step 1: Write the failing test**

Create `src/components/goals/__tests__/agent-bundle-card.test.tsx`:

```tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, cleanup } from '@testing-library/react'
import { AgentBundleCard } from '@/components/goals/agent-bundle-card'

const base = {
  goalId: 'goal-1',
  templateKey: 'sales-org-pipeline-coverage',
  kind: 'custom_kpi',
  source: 'hubspot',
  recurrence: null,
  onChanged: async () => {},
}

test('an agent whose tools are all connected offers a Deploy button', () => {
  render(
    <AgentBundleCard
      {...base}
      deployedSeedKeys={[]}
      connectedIntegrations={['slack', 'salesforce', 'granola', 'hubspot']}
    />,
  )
  assert.ok(screen.getAllByRole('button', { name: /deploy/i }).length > 0)
  cleanup()
})

test('a blocked agent names what is missing instead of offering Deploy', () => {
  render(
    <AgentBundleCard {...base} deployedSeedKeys={[]} connectedIntegrations={[]} />,
  )
  assert.ok(screen.getAllByText(/needs/i).length > 0)
  cleanup()
})

test('an already-deployed agent is shown as deployed, not re-offered', () => {
  render(
    <AgentBundleCard
      {...base}
      deployedSeedKeys={['sales-pipeline-hygiene-nudger']}
      connectedIntegrations={['slack', 'salesforce', 'granola']}
    />,
  )
  assert.ok(screen.getByText(/deployed/i))
  cleanup()
})

test('the card renders nothing when the bundle is empty', () => {
  const { container } = render(
    <AgentBundleCard
      goalId="goal-1"
      templateKey={null}
      kind="not_a_real_kind"
      source="stripe"
      recurrence={null}
      deployedSeedKeys={['goal-pace-auditor']}
      connectedIntegrations={[]}
      onChanged={async () => {}}
      hideWhenAllDeployed
    />,
  )
  assert.equal(container.textContent?.includes('Put agents to work'), false)
  cleanup()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/goals/__tests__/agent-bundle-card.test.tsx`
Expected: FAIL — cannot find module `@/components/goals/agent-bundle-card`

- [ ] **Step 3: Write the component**

Create `src/components/goals/agent-bundle-card.tsx`:

```tsx
'use client'

/**
 * "Put agents to work" — the agents that advance this goal, deployable in one
 * click (spec 2026-07-27).
 *
 * Deploy is a single POST to /api/templates/provision, which materializes the
 * agent AND creates the GoalContribution link in the same call. Re-deploying an
 * already-linked seed is idempotent server-side, so a double click cannot
 * produce a duplicate link.
 */
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { Bot, Check, Rocket } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { IntegrationChip } from '@/components/integrations/integration-chip'
import { bundleForGoal } from '@/lib/goals/agent-bundle'
import { missingIntegrations } from '@/lib/templates/relevance'

export function AgentBundleCard({
  goalId,
  templateKey,
  kind,
  source,
  recurrence,
  deployedSeedKeys,
  connectedIntegrations,
  onChanged,
  hideWhenAllDeployed = false,
}: {
  goalId: string
  templateKey: string | null
  kind: string
  source: string | null
  recurrence: string | null
  deployedSeedKeys: string[]
  connectedIntegrations: string[]
  onChanged: () => void | Promise<void>
  /** Collapse the card once nothing is left to deploy. */
  hideWhenAllDeployed?: boolean
}) {
  const [busySeedKey, setBusySeedKey] = useState<string | null>(null)

  const bundle = useMemo(
    () => bundleForGoal({ templateKey, kind, source, recurrence, deployedSeedKeys }),
    [templateKey, kind, source, recurrence, deployedSeedKeys],
  )

  const deploy = async (seedKey: string) => {
    setBusySeedKey(seedKey)
    try {
      const response = await fetch('/api/templates/provision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seedKey, goalId }),
      })
      const body = (await response.json()) as { error?: string }
      if (!response.ok) {
        toast.error(body.error || 'Could not deploy — try again.')
        return
      }
      toast.success('Agent deployed and linked to this goal.')
      await onChanged()
    } finally {
      setBusySeedKey(null)
    }
  }

  if (bundle.length === 0) return null
  if (hideWhenAllDeployed && bundle.every((entry) => entry.deployed)) return null

  return (
    <section
      aria-label="Agents for this goal"
      className="space-y-4 rounded-2xl border p-5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Bot className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Put agents to work</h2>
        <p className="text-sm text-muted-foreground">
          This goal tracks the number. These do the work.
        </p>
      </div>

      <ul className="space-y-2">
        {bundle.map((entry) => {
          const missing = missingIntegrations(entry.requiredIntegrations, connectedIntegrations)
          const blocked = missing.length > 0
          return (
            <li
              key={entry.seedKey}
              data-blocked={blocked}
              className={`flex flex-wrap items-center gap-3 rounded-xl border bg-background/60 px-4 py-3 ${
                blocked && !entry.deployed ? 'opacity-70' : ''
              }`}
            >
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-sm font-medium">{entry.name}</p>
                <p className="text-sm text-muted-foreground">{entry.description}</p>
                {blocked && !entry.deployed && (
                  <p className="text-xs text-muted-foreground">
                    Needs {missing.join(', ')} —{' '}
                    <Link
                      href="/integrations"
                      className="font-medium text-foreground underline-offset-2 hover:underline"
                    >
                      connect
                    </Link>
                  </p>
                )}
                {entry.requiredIntegrations.length > 0 && !blocked && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {entry.requiredIntegrations.map((integration) => (
                      <IntegrationChip key={integration} name={integration} />
                    ))}
                  </div>
                )}
              </div>

              {entry.deployed ? (
                <span className="flex items-center gap-1.5 text-sm font-medium text-emerald-600">
                  <Check className="h-4 w-4" />
                  <Link href="/agents" className="underline-offset-2 hover:underline">
                    Deployed
                  </Link>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant={blocked ? 'outline' : 'default'}
                  disabled={blocked || busySeedKey === entry.seedKey}
                  onClick={() => void deploy(entry.seedKey)}
                >
                  <Rocket className="mr-1.5 h-4 w-4" />
                  Deploy
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
```

- [ ] **Step 4: Mount it on the goal page**

In `src/app/goals/[id]/page.tsx`, add the import:

```ts
import { AgentBundleCard } from '@/components/goals/agent-bundle-card'
```

Insert immediately after the soft-source nudge block (the `SOFT_SOURCES.has(...)` paragraph) and before `<GoalDashboard`:

```tsx
      <AgentBundleCard
        goalId={goalId}
        templateKey={goal.templateKey ?? null}
        kind={goal.kind}
        source={goal.metric?.source ?? null}
        recurrence={goal.recurrence ?? null}
        deployedSeedKeys={contributions
          .map((contribution) => contribution.seedKey)
          .filter((seedKey): seedKey is string => Boolean(seedKey))}
        connectedIntegrations={connectedIntegrations}
        onChanged={load}
      />
```

Three supporting edits are needed, each verified as necessary against the current code:

**(a) Expose `templateKey` on the goal detail response.** The query uses `include`, so the column arrives from Prisma automatically once Task 1 adds it — but the handler builds its response by enumerating fields, so it must be added explicitly. In `src/app/api/goals/[id]/route.ts`, in the returned `goal` object beside `dashboardLayout`:

```ts
      templateKey: goal.templateKey,
```

And in `src/lib/types.ts`, add to `interface GoalDetail` (line ~127, beside `dashboardLayout: unknown | null`):

```ts
  templateKey: string | null
```

**(b) Expose `seedKey` on the client contribution type.** The contributions API already selects `seedKey` and spreads it into the response — only the client type omits it. In `src/components/goals/contribution-panel.tsx`, add to `export type Contribution`:

```ts
  seedKey: string | null
```

**(c) Load connected integrations.** Copy the pattern `templates-explorer.tsx` already uses (lines 159 and 191). In `src/app/goals/[id]/page.tsx`, beside the existing data loading:

```ts
  const integrationsQuery = useCachedJson<{
    success?: boolean
    tools?: Parameters<typeof connectedSlugSet>[0]
  }>('/api/integrations/available')

  const connectedIntegrations = useMemo(
    () =>
      Array.from(
        connectedSlugSet(
          integrationsQuery.data?.success ? integrationsQuery.data.tools ?? [] : [],
        ),
      ),
    [integrationsQuery.data],
  )
```

with imports:

```ts
import { connectedSlugSet } from '@/lib/templates/relevance'
import { useCachedJson } from '@/lib/client/use-cached-json'
```

A failed probe yields `[]`, which renders every agent as blocked rather than hiding the card — the same fail-soft posture `GoalTemplateDetail` takes with `sourcesFailed`.

- [ ] **Step 5: Run tests, typecheck and lint**

Run:
```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/goals/__tests__/agent-bundle-card.test.tsx
npx tsc --noEmit -p tsconfig.json
npx eslint src/components/goals/agent-bundle-card.tsx src/app/goals/\[id\]/page.tsx
```
Expected: tests PASS, no output from tsc or eslint.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: 0 failures. Baseline was 1894 tests / 1872 pass / 22 skipped; this plan adds 27 tests (1 + 7 + 4 + 9 + 2 + 4), so expect ~1921 total.

- [ ] **Step 7: Commit**

```bash
git add src/components/goals/agent-bundle-card.tsx src/app/goals/\[id\]/page.tsx src/components/goals/__tests__/agent-bundle-card.test.tsx src/app/api/goals/\[id\]/route.ts src/lib/types.ts src/components/goals/contribution-panel.tsx
git commit -m "feat(goals): deploy bundled agents from the goal page"
```

---

## Verification

The DB-backed path cannot be proven by the unit suite. After Task 6, verify against a throwaway Postgres using the protocol in the `verify` skill:

1. Apply migrations (`npx prisma migrate deploy` against `TEST_DATABASE_URL`) — confirm `goals.templateKey` exists.
2. Create a goal through the wizard from a curated template; confirm the row's `templateKey` is set.
3. Open the goal; confirm the card lists the curated agents plus Pace Auditor.
4. Deploy one; confirm an `AgentTask` is created and a `GoalContribution` row appears with the matching `seedKey`, and the card flips that entry to "Deployed".

## Known coverage limits

- `templateKey` persistence is verified by typecheck and the manual step above, not by an automated test — writing one requires a database.
- The deploy `fetch` is not exercised in the component tests; they cover rendering states only. The provision endpoint itself is already covered by its own tests.

## Out of Scope

- Deploying from the create wizard
- Bulk "deploy all"
- Per-workspace bundle editing
- Broadening `goalKinds` beyond what the fallback needs
- Any change to recovery plans, the digest, or attribution
