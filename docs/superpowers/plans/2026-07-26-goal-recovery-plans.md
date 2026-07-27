# Goal Recovery Plans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a goal's risk worsens, one LLM call produces a persisted, structured recovery plan (diagnosis + connect-tool / launch-agent / manual actions) rendered as a strip on the goal dashboard, with one-click agent launch through the existing provisioning path.

**Architecture:** Two new Prisma models (`GoalRecoveryPlan`, `GoalRecoveryAction`). Deterministic candidate assembly (pure) feeds one `generateStructured` call whose output is validated against the candidate ids — the LLM can only select, never invent. The existing `UserSuggestion` + `notify` pipeline stays as the alert vehicle; LLM failure falls back to today's rule-based suggestion exactly. Spec: `docs/superpowers/specs/2026-07-26-goal-recovery-plans-design.md`.

**Tech Stack:** Next.js App Router, Prisma/Postgres, zod, `generateStructured` from `src/lib/llm/model-runner.ts`, `node:test` + `tsx` (dependency-injection style, no mock framework).

## Global Constraints

- Tests run with: `npm test` (all) or `TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test <file>` (single file). Test files live in `__tests__/` beside the code, use `node:test` + `assert/strict`, and inject dependencies via a `deps` parameter defaulting to real implementations (see `src/lib/goals/__tests__/emit-recommendation.test.ts`).
- Structured-output JSON Schema must stay inside the supported strict subset: no `type: [..., 'null']` (use the `anyOf` `nullable()` helper), no `minItems`/`maxItems` (enforce in zod + prompt), every object closes `additionalProperties: false`. See `src/lib/goals/copilot.ts:29-50`.
- Risk vocabulary: `'on_track' | 'at_risk' | 'off_track' | 'no_data'`. Plan statuses: `'open' | 'resolved' | 'superseded' | 'dismissed'`. Action kinds: `'connect_tool' | 'launch_agent' | 'manual_step'`. Action statuses: `'proposed' | 'accepted' | 'done' | 'dismissed'`.
- All goal API routes authorize with `{ id, organizationId, OR: [{ ownerUserId: null }, { ownerUserId: userId }] }` (see `src/app/api/goals/[id]/route.ts:29-34`).
- LLM failure must never block or degrade evaluation: the legacy rule-based suggestion path must fire unchanged on any generation failure.
- Timestamptz(6) on all datetime columns; tables are `@@map`-ped snake_case; ids are `cuid()`; every row carries `organizationId @db.Uuid` with a cascade FK to Organization.
- Do not modify `src/lib/goals/evaluate.ts` — evaluation math is out of scope.

---

### Task 1: Prisma models + migration

**Files:**

- Modify: `prisma/schema.prisma` (after the `GoalContribution` model, ~line 1355)
- Create: `prisma/migrations/20260726210000_goal_recovery_plans/migration.sql`

**Interfaces:**

- Produces: Prisma client models `goalRecoveryPlan`, `goalRecoveryAction` with the exact field names below. Later tasks rely on `plan.status`, `plan.triggerRiskLevel`, `action.kind`, `action.payload`, `action.resultRef`.

- [ ] **Step 1: Add models to schema.prisma**

```prisma
/// AI-generated recovery plan for a goal whose risk worsened. At most one
/// 'open' plan per goal — enforced by a migration-managed partial unique
/// index (same discipline as GoalMetric's one-primary index). The
/// UserSuggestion emitted alongside is the alert vehicle; this row is the
/// content the goal dashboard renders.
model GoalRecoveryPlan {
  id               String    @id @default(cuid())
  organizationId   String    @db.Uuid
  goalId           String
  status           String    @default("open") // 'open' | 'resolved' | 'superseded' | 'dismissed'
  triggerRiskLevel String // 'at_risk' | 'off_track'
  diagnosis        String    @db.Text
  /// Measured-fact evidence lines frozen at generation time (string[]).
  evidence         Json      @default("[]")
  /// { ms: number } — latency of the generating call.
  modelMeta        Json      @default("{}")
  createdAt        DateTime  @default(now()) @db.Timestamptz(6)
  resolvedAt       DateTime? @db.Timestamptz(6)

  organization Organization         @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  goal         Goal                 @relation(fields: [goalId], references: [id], onDelete: Cascade)
  actions      GoalRecoveryAction[]

  @@index([organizationId, goalId, status])
  @@map("goal_recovery_plans")
}

/// One independently actionable step of a recovery plan. payload by kind:
/// connect_tool {source}, launch_agent {seedKey}, manual_step {}.
/// resultRef records what accepting produced (AgentTask id / flow id).
model GoalRecoveryAction {
  id         String    @id @default(cuid())
  organizationId String @db.Uuid
  planId     String
  kind       String // 'connect_tool' | 'launch_agent' | 'manual_step'
  title      String
  rationale  String    @db.Text
  payload    Json      @default("{}")
  rank       Int       @default(0)
  status     String    @default("proposed") // 'proposed' | 'accepted' | 'done' | 'dismissed'
  resultRef  String?
  acceptedAt DateTime? @db.Timestamptz(6)
  createdAt  DateTime  @default(now()) @db.Timestamptz(6)

  organization Organization     @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  plan         GoalRecoveryPlan @relation(fields: [planId], references: [id], onDelete: Cascade)

  @@index([planId])
  @@map("goal_recovery_actions")
}
```

Also add the back-relations: `recoveryPlans GoalRecoveryPlan[]` on `Goal`, and `goalRecoveryPlans GoalRecoveryPlan[]` + `goalRecoveryActions GoalRecoveryAction[]` on `Organization` (match how the Organization model lists its other goal relations).

- [ ] **Step 2: Write the migration SQL**

```sql
-- Goal recovery plans: AI-generated get-back-on-track plans (spec 2026-07-26).
CREATE TABLE "goal_recovery_plans" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "goalId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "triggerRiskLevel" TEXT NOT NULL,
    "diagnosis" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "modelMeta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(6),
    CONSTRAINT "goal_recovery_plans_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "goal_recovery_actions" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "planId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "rank" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "resultRef" TEXT,
    "acceptedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "goal_recovery_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "goal_recovery_plans_organizationId_goalId_status_idx"
    ON "goal_recovery_plans"("organizationId", "goalId", "status");
-- One open plan per goal (partial unique — migration-managed, not in schema.prisma).
CREATE UNIQUE INDEX "goal_recovery_plans_one_open_per_goal"
    ON "goal_recovery_plans"("goalId") WHERE "status" = 'open';
CREATE INDEX "goal_recovery_actions_planId_idx" ON "goal_recovery_actions"("planId");

ALTER TABLE "goal_recovery_plans" ADD CONSTRAINT "goal_recovery_plans_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "goal_recovery_plans" ADD CONSTRAINT "goal_recovery_plans_goalId_fkey"
    FOREIGN KEY ("goalId") REFERENCES "goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "goal_recovery_actions" ADD CONSTRAINT "goal_recovery_actions_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "goal_recovery_actions" ADD CONSTRAINT "goal_recovery_actions_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "goal_recovery_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

Before writing, open an existing migration (`prisma/migrations/20260726180000_goals_v24_multimetric_dashboards/migration.sql`) and check the referenced table name for organizations FKs — copy whatever name that file uses (`organizations` vs `Organization`) exactly.

- [ ] **Step 3: Validate and generate**

Run: `npx prisma validate && npx prisma generate`
Expected: both succeed. If validate complains about missing back-relations, add the exact relation it names.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260726210000_goal_recovery_plans/
git commit -m "feat(goals): recovery plan data spine"
```

---

### Task 2: Candidate assembly (pure)

**Files:**

- Create: `src/lib/goals/recovery-candidates.ts`
- Test: `src/lib/goals/__tests__/recovery-candidates.test.ts`

**Interfaces:**

- Consumes: `SeedTemplate` from `@/lib/templates/catalogue`, `MetricSourceOption`/`sourceIsAvailable` from `@/lib/metrics/source-options`, `goalTemplatesFor` from `@/lib/templates/goal-fit`, `sortByAdoption` + score map from `@/lib/templates/adoption`.
- Produces:

  ```ts
  export type RecoveryCandidates = {
    agentTemplates: Array<{ seedKey: string; name: string; description: string; requiredIntegrations: string[] }>
    sourceGaps: Array<{ source: string; label: string; reason: 'goal_template_source' | 'agent_requirement' }>
  }
  export function assembleRecoveryCandidates(input: {
    goalKind: string
    seeds: SeedTemplate[]
    adoptionScores: Record<string, number>
    sources: MetricSourceOption[]
    goalTemplateSources: string[]   // ranked sources[] of the matching goal template, [] if none
  }): RecoveryCandidates
  ```

Rules the function implements:

- `agentTemplates` = `goalTemplatesFor(goalKind, seeds)` ranked by `sortByAdoption(candidates, (seed) =>`seed:${seed.seedKey}`, adoptionScores)`, capped to 6.
- `sourceGaps` = (a) each of `goalTemplateSources` that is a known source option but not currently available per `sourceIsAvailable` (reason `'goal_template_source'`), then (b) each `requiredIntegrations` entry of the ranked agentTemplates whose name matches a known-but-unavailable source option (reason `'agent_requirement'`), deduped by `source`, `manual` always excluded, capped to 4. Label comes from the `SOURCE_FALLBACK_LABELS`-style map — copy that map from `src/lib/goals/copilot.ts:239-248` into this module (export it as `RECOVERY_SOURCE_LABELS`) rather than importing copilot.

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assembleRecoveryCandidates } from '../recovery-candidates'
import type { MetricSourceOption } from '@/lib/metrics/source-options'

const seeds = [
  {
    seedKey: 'pipeline-reviver', name: 'Pipeline Reviver', description: 'revive stale deals',
    departments: ['sales'], requiredIntegrations: ['salesforce'], recommendedIntegrations: [],
    kind: 'flow', goalKinds: ['arr'], estimatedMinutesSaved: 30,
  },
  {
    seedKey: 'outbound-writer', name: 'Outbound Writer', description: 'draft outbound',
    departments: ['sales'], requiredIntegrations: [], recommendedIntegrations: [],
    kind: 'agent', goalKinds: ['arr'],
  },
  {
    seedKey: 'expense-auditor', name: 'Expense Auditor', description: 'audit spend',
    departments: ['operations'], requiredIntegrations: [], recommendedIntegrations: [],
    kind: 'agent', goalKinds: ['savings'],
  },
] as never[]

const option = (source: string, available: boolean): MetricSourceOption =>
  ({
    source,
    group: 'source_of_truth',
    ...(available ? { available: true } : {}),
    metrics: [],
    connections: available ? [{ ref: `credential:${source}-1`, label: source }] : [],
  }) as MetricSourceOption

test('agent templates filter by goal kind and respect adoption ranking', () => {
  const result = assembleRecoveryCandidates({
    goalKind: 'arr',
    seeds,
    adoptionScores: { 'seed:outbound-writer': 10, 'seed:pipeline-reviver': 1 },
    sources: [option('stripe', true)],
    goalTemplateSources: [],
  })
  assert.deepEqual(result.agentTemplates.map((t) => t.seedKey), ['outbound-writer', 'pipeline-reviver'])
})

test('unconnected goal-template sources become source gaps; connected ones do not', () => {
  const result = assembleRecoveryCandidates({
    goalKind: 'arr',
    seeds: [],
    adoptionScores: {},
    sources: [option('stripe', true), option('hubspot', false)],
    goalTemplateSources: ['stripe', 'hubspot', 'manual'],
  })
  assert.deepEqual(result.sourceGaps.map((gap) => gap.source), ['hubspot'])
  assert.equal(result.sourceGaps[0].reason, 'goal_template_source')
})

test('agent required integrations surface as gaps, deduped against template sources', () => {
  const result = assembleRecoveryCandidates({
    goalKind: 'arr',
    seeds,
    adoptionScores: {},
    sources: [option('salesforce', false)],
    goalTemplateSources: ['salesforce'],
  })
  const salesforceGaps = result.sourceGaps.filter((gap) => gap.source === 'salesforce')
  assert.equal(salesforceGaps.length, 1)
  assert.equal(salesforceGaps[0].reason, 'goal_template_source')
})

test('manual is never a gap and caps hold (6 templates, 4 gaps)', () => {
  const manySeeds = Array.from({ length: 9 }, (_, i) => ({
    seedKey: `s${i}`, name: `S${i}`, description: 'd', departments: ['sales'],
    requiredIntegrations: [], recommendedIntegrations: [], kind: 'agent', goalKinds: ['arr'],
  })) as never[]
  const result = assembleRecoveryCandidates({
    goalKind: 'arr',
    seeds: manySeeds,
    adoptionScores: {},
    sources: ['stripe', 'hubspot', 'salesforce', 'google_sheets', 'postgres'].map((s) => option(s, false)),
    goalTemplateSources: ['manual', 'stripe', 'hubspot', 'salesforce', 'google_sheets', 'postgres'],
  })
  assert.equal(result.agentTemplates.length, 6)
  assert.equal(result.sourceGaps.length, 4)
  assert.ok(!result.sourceGaps.some((gap) => gap.source === 'manual'))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test src/lib/goals/__tests__/recovery-candidates.test.ts`
Expected: FAIL — cannot find module `../recovery-candidates`.

- [ ] **Step 3: Implement `recovery-candidates.ts`**

```ts
/**
 * Deterministic candidate assembly for recovery-plan generation. Pure: the
 * LLM may only SELECT from what this module returns — it never invents a
 * tool or template. Ranking mirrors emit-recommendation (adoption order).
 */
import type { SeedTemplate } from '@/lib/templates/catalogue'
import { goalTemplatesFor } from '@/lib/templates/goal-fit'
import { sortByAdoption } from '@/lib/templates/adoption'
import {
  sourceIsAvailable,
  type MetricSourceOption,
} from '@/lib/metrics/source-options'

export const RECOVERY_SOURCE_LABELS: Record<string, string> = {
  stripe: 'Stripe',
  hubspot: 'HubSpot',
  salesforce: 'Salesforce',
  google_sheets: 'Google Sheets',
  postgres: 'Postgres',
  url: 'URL',
  slack_assisted: 'Slack (AI-read)',
  gmail_assisted: 'Gmail (AI-read)',
}

const MAX_AGENT_TEMPLATES = 6
const MAX_SOURCE_GAPS = 4

export type RecoveryCandidates = {
  agentTemplates: Array<{
    seedKey: string
    name: string
    description: string
    requiredIntegrations: string[]
  }>
  sourceGaps: Array<{
    source: string
    label: string
    reason: 'goal_template_source' | 'agent_requirement'
  }>
}

export function assembleRecoveryCandidates(input: {
  goalKind: string
  seeds: SeedTemplate[]
  adoptionScores: Record<string, number>
  sources: MetricSourceOption[]
  goalTemplateSources: string[]
}): RecoveryCandidates {
  const ranked = sortByAdoption(
    goalTemplatesFor(input.goalKind, input.seeds),
    (seed) => `seed:${seed.seedKey}`,
    input.adoptionScores,
  ).slice(0, MAX_AGENT_TEMPLATES)

  const optionBySource = new Map(input.sources.map((option) => [option.source, option]))
  const unavailable = (source: string): boolean => {
    if (source === 'manual') return false
    const option = optionBySource.get(source)
    return option ? !sourceIsAvailable(option) : false
  }

  const gaps: RecoveryCandidates['sourceGaps'] = []
  const seen = new Set<string>()
  const push = (source: string, reason: RecoveryCandidates['sourceGaps'][number]['reason']) => {
    if (seen.has(source) || !unavailable(source)) return
    seen.add(source)
    gaps.push({ source, label: RECOVERY_SOURCE_LABELS[source] ?? source, reason })
  }
  for (const source of input.goalTemplateSources) push(source, 'goal_template_source')
  for (const template of ranked) {
    for (const integration of template.requiredIntegrations) push(integration, 'agent_requirement')
  }

  return {
    agentTemplates: ranked.map((seed) => ({
      seedKey: seed.seedKey,
      name: seed.name,
      description: seed.description,
      requiredIntegrations: seed.requiredIntegrations,
    })),
    sourceGaps: gaps.slice(0, MAX_SOURCE_GAPS),
  }
}
```

Note: `sortByAdoption`'s exact signature is in `src/lib/templates/adoption.ts` — read it first; if it sorts in place or returns a new array with different argument order, adapt the call (the usage at `src/lib/goals/emit-recommendation.ts:123` is the reference).

- [ ] **Step 4: Run tests to verify they pass**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test src/lib/goals/__tests__/recovery-candidates.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/goals/recovery-candidates.ts src/lib/goals/__tests__/recovery-candidates.test.ts
git commit -m "feat(goals): deterministic recovery-plan candidate assembly"
```

---

### Task 3: Plan generation + validation (LLM boundary)

**Files:**

- Create: `src/lib/goals/recovery.ts`
- Test: `src/lib/goals/__tests__/recovery.test.ts`

**Interfaces:**

- Consumes: `RecoveryCandidates` from Task 2, `generateStructured` from `@/lib/llm/model-runner`.
- Produces:

  ```ts
  export type RecoveryActionDraft = {
    kind: 'connect_tool' | 'launch_agent' | 'manual_step'
    refId: string | null   // source for connect_tool, seedKey for launch_agent, null for manual_step
    title: string
    rationale: string
  }
  export type RecoveryPlanDraft = { diagnosis: string; actions: RecoveryActionDraft[] }
  export class RecoveryDraftError extends Error {}
  export const RECOVERY_PLAN_SCHEMA: Record<string, unknown>
  export function validateRecoveryDraft(raw: string, candidates: RecoveryCandidates): RecoveryPlanDraft  // throws RecoveryDraftError
  export function riskWorse(next: string, prev: string): boolean  // off_track worse than at_risk
  export async function draftRecoveryPlan(input: {
    goal: { name: string; kind: string; unit: string; targetValue: number; targetDate: Date; direction: string }
    evidence: string[]
    candidates: RecoveryCandidates
    generate?: typeof generateStructured   // DI for tests
  }): Promise<RecoveryPlanDraft>           // throws RecoveryDraftError on any failure
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  draftRecoveryPlan,
  RecoveryDraftError,
  riskWorse,
  validateRecoveryDraft,
} from '../recovery'
import type { RecoveryCandidates } from '../recovery-candidates'

const candidates: RecoveryCandidates = {
  agentTemplates: [
    { seedKey: 'pipeline-reviver', name: 'Pipeline Reviver', description: 'd', requiredIntegrations: [] },
  ],
  sourceGaps: [{ source: 'stripe', label: 'Stripe', reason: 'goal_template_source' }],
}

const draft = (actions: unknown[]) =>
  JSON.stringify({ diagnosis: 'Pace fell behind after week 3.', actions })

test('valid draft passes through with ranks preserved by order', () => {
  const plan = validateRecoveryDraft(
    draft([
      { kind: 'connect_tool', refId: 'stripe', title: 'Connect Stripe', rationale: 'exact MRR' },
      { kind: 'launch_agent', refId: 'pipeline-reviver', title: 'Revive pipeline', rationale: 'stale deals' },
      { kind: 'manual_step', refId: null, title: 'Review pricing page', rationale: 'conversion' },
    ]),
    candidates,
  )
  assert.equal(plan.actions.length, 3)
  assert.equal(plan.diagnosis, 'Pace fell behind after week 3.')
})

test('actions with ids outside the candidate set are dropped', () => {
  const plan = validateRecoveryDraft(
    draft([
      { kind: 'launch_agent', refId: 'made-up-agent', title: 'x', rationale: 'y' },
      { kind: 'connect_tool', refId: 'quickbooks', title: 'x', rationale: 'y' },
      { kind: 'manual_step', refId: null, title: 'Call top accounts', rationale: 'z' },
    ]),
    candidates,
  )
  assert.deepEqual(plan.actions.map((action) => action.kind), ['manual_step'])
})

test('a draft with zero surviving actions throws', () => {
  assert.throws(
    () => validateRecoveryDraft(draft([{ kind: 'launch_agent', refId: 'nope', title: 'x', rationale: 'y' }]), candidates),
    RecoveryDraftError,
  )
})

test('unparseable JSON throws RecoveryDraftError', () => {
  assert.throws(() => validateRecoveryDraft('not json', candidates), RecoveryDraftError)
})

test('draftRecoveryPlan wires goal + candidates into the model call', async () => {
  let captured: { system: string; user: string } | null = null
  const plan = await draftRecoveryPlan({
    goal: { name: 'Q4 ARR', kind: 'arr', unit: 'usd', targetValue: 2_000_000, targetDate: new Date('2026-12-31'), direction: 'increase' },
    evidence: ['Q4 ARR: $1,300,000 is $300,000 behind pace ($1,600,000 expected by today).'],
    candidates,
    generate: async (opts) => {
      captured = { system: opts.system, user: opts.user }
      return draft([{ kind: 'manual_step', refId: null, title: 'Review pipeline', rationale: 'r' }])
    },
  })
  assert.equal(plan.actions.length, 1)
  assert.ok(captured!.user.includes('pipeline-reviver'))
  assert.ok(captured!.user.includes('behind pace'))
})

test('generation failure surfaces as RecoveryDraftError', async () => {
  await assert.rejects(
    draftRecoveryPlan({
      goal: { name: 'g', kind: 'arr', unit: 'usd', targetValue: 1, targetDate: new Date('2026-12-31'), direction: 'increase' },
      evidence: [],
      candidates,
      generate: async () => { throw new Error('provider down') },
    }),
    RecoveryDraftError,
  )
})

test('riskWorse orders off_track above at_risk only', () => {
  assert.equal(riskWorse('off_track', 'at_risk'), true)
  assert.equal(riskWorse('at_risk', 'off_track'), false)
  assert.equal(riskWorse('at_risk', 'at_risk'), false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test src/lib/goals/__tests__/recovery.test.ts`
Expected: FAIL — cannot find module `../recovery`.

- [ ] **Step 3: Implement `recovery.ts`**

```ts
/**
 * Recovery-plan drafting: one structured model call that SELECTS from
 * pre-assembled candidates. Ids are re-validated post-hoc; an id the
 * assembler didn't offer is dropped, and an empty surviving set is a
 * failure — the caller falls back to the rule-based suggestion.
 */
import { z } from 'zod'
import { generateStructured } from '@/lib/llm/model-runner'
import type { RecoveryCandidates } from './recovery-candidates'

export class RecoveryDraftError extends Error {}

const RISK_SEVERITY: Record<string, number> = { at_risk: 1, off_track: 2 }
export function riskWorse(next: string, prev: string): boolean {
  return (RISK_SEVERITY[next] ?? 0) > (RISK_SEVERITY[prev] ?? 0)
}

const nullable = (schema: Record<string, unknown>) =>
  ({ anyOf: [schema, { type: 'null' }] }) as const

export const RECOVERY_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    diagnosis: {
      type: 'string',
      description: 'Why the goal is behind, grounded ONLY in the evidence lines provided. 1-3 sentences.',
    },
    // 2-5 actions; count is enforced in zod + prompt (min/maxItems are
    // outside the supported strict subset — see copilot.ts).
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['connect_tool', 'launch_agent', 'manual_step'] },
          refId: nullable({
            type: 'string',
            description: 'connect_tool: a source id from sourceGaps. launch_agent: a seedKey from agentTemplates. manual_step: null.',
          }),
          title: { type: 'string' },
          rationale: { type: 'string' },
        },
        required: ['kind', 'refId', 'title', 'rationale'],
        additionalProperties: false,
      },
    },
  },
  required: ['diagnosis', 'actions'],
  additionalProperties: false,
} as const

const rawPlanSchema = z.object({
  diagnosis: z.string().min(1).max(1000),
  actions: z
    .array(
      z.object({
        kind: z.enum(['connect_tool', 'launch_agent', 'manual_step']),
        refId: z.string().nullable(),
        title: z.string().min(1).max(120),
        rationale: z.string().min(1).max(500),
      }),
    )
    .min(1)
    .max(5),
})

export type RecoveryActionDraft = {
  kind: 'connect_tool' | 'launch_agent' | 'manual_step'
  refId: string | null
  title: string
  rationale: string
}
export type RecoveryPlanDraft = { diagnosis: string; actions: RecoveryActionDraft[] }

export function validateRecoveryDraft(
  raw: string,
  candidates: RecoveryCandidates,
): RecoveryPlanDraft {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new RecoveryDraftError('unparseable recovery draft')
  }
  const shell = rawPlanSchema.safeParse(parsed)
  if (!shell.success) throw new RecoveryDraftError('recovery draft failed shape validation')

  const gapSources = new Set(candidates.sourceGaps.map((gap) => gap.source))
  const seedKeys = new Set(candidates.agentTemplates.map((template) => template.seedKey))
  const actions = shell.data.actions.filter((action) =>
    action.kind === 'manual_step'
      ? true
      : action.kind === 'connect_tool'
        ? action.refId !== null && gapSources.has(action.refId)
        : action.refId !== null && seedKeys.has(action.refId),
  )
  if (actions.length === 0) throw new RecoveryDraftError('no valid actions survived id validation')
  return { diagnosis: shell.data.diagnosis, actions }
}

const SYSTEM = [
  'A measurable business goal has fallen behind pace. Write a short recovery plan.',
  'Rules:',
  '- diagnosis: 1-3 sentences explaining the shortfall using ONLY the evidence lines given. Never invent numbers.',
  '- 2 to 5 actions, most impactful first.',
  '- connect_tool actions: refId MUST be one of the sourceGaps ids. Recommending a connection means exact automatic tracking replaces manual/assisted entry.',
  '- launch_agent actions: refId MUST be a seedKey from agentTemplates. These are automations that do work toward the goal.',
  '- manual_step actions: refId null; a concrete step the human should take. Use sparingly — prefer tools and agents.',
  '- title: short imperative. rationale: one sentence tying the action to the evidence.',
  '- Respond with the JSON object only.',
].join('\n')

export async function draftRecoveryPlan(input: {
  goal: {
    name: string
    kind: string
    unit: string
    targetValue: number
    targetDate: Date
    direction: string
  }
  evidence: string[]
  candidates: RecoveryCandidates
  generate?: typeof generateStructured
}): Promise<RecoveryPlanDraft> {
  const generate = input.generate ?? generateStructured
  const user = JSON.stringify({
    goal: {
      name: input.goal.name,
      kind: input.goal.kind,
      unit: input.goal.unit,
      targetValue: input.goal.targetValue,
      targetDate: input.goal.targetDate.toISOString().slice(0, 10),
      direction: input.goal.direction,
    },
    evidence: input.evidence,
    agentTemplates: input.candidates.agentTemplates,
    sourceGaps: input.candidates.sourceGaps,
  })
  let raw: string
  try {
    raw = await generate({
      system: SYSTEM,
      user,
      schema: RECOVERY_PLAN_SCHEMA as Record<string, unknown>,
      schemaName: 'goal_recovery_plan',
      maxTokens: 1500,
    })
  } catch (error) {
    throw new RecoveryDraftError(
      error instanceof Error ? error.message : 'recovery draft generation failed',
    )
  }
  return validateRecoveryDraft(raw, input.candidates)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test src/lib/goals/__tests__/recovery.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/goals/recovery.ts src/lib/goals/__tests__/recovery.test.ts
git commit -m "feat(goals): recovery-plan drafting with candidate-locked validation"
```

---

### Task 4: Wire generation into the worsening transition

**Files:**

- Modify: `src/lib/goals/emit-recommendation.ts`
- Test: `src/lib/goals/__tests__/emit-recommendation.test.ts` (extend)

**Interfaces:**

- Consumes: `assembleRecoveryCandidates` (Task 2), `draftRecoveryPlan`/`riskWorse`/`RecoveryDraftError` (Task 3).
- Produces: extended `EmitDeps` with the new injectable fields below; `emitGoalRecommendation` unchanged signature. Later tasks rely on: plan rows created with `status: 'open'`, actions with `payload` `{source}` / `{seedKey}` / `{}`, suggestion `metadata.planId`.

Behavior changes inside `emitGoalRecommendation` (keep everything else — recipient resolution, evidence, benchmark, notify — as is):

1. **Dedup/supersede gate** replaces the plain `findOpen` early-return:
   - Load any open plan for the goal (`findOpenPlan` dep).
   - If an open plan exists and `!riskWorse(evaluation.riskLevel, plan.triggerRiskLevel)` → return `{ emitted: false, reason: 'open-plan' }`.
   - If it exists and the risk DID worsen → mark it superseded (`supersedePlan` dep) and continue (regenerate).
   - The legacy `findOpen` suggestion check now applies only on the fallback path (an open suggestion with no plan attached blocks a fallback re-emission, as today).
2. **Plan path** (try first): assemble candidates (needs two new deps: `listSources` returning `MetricSourceOption[]` and `goalTemplateSourcesFor(kind)` returning the ranked `sources[]` of the first matching goal template from `GOAL_TEMPLATES` — implement the default by importing `GOAL_TEMPLATES` from `./goal-templates` and matching on `kind`), call `draftRecoveryPlan`, then `createPlan` dep persists plan + actions and returns `{ id }`. Then create the suggestion with `metadata: { goalId, planId, seedKey: null }` and description `plan.diagnosis`, and notify (unchanged shape).
3. **Fallback path** (on `RecoveryDraftError` or any thrown error from the plan path): existing behavior verbatim — adoption-ranked `best` seed, existing title/description/metadata `{ goalId, seedKey }`, suggestion + notify. Log the failure with `apiLogger.warn('goals.recovery: draft failed, using rule-based fallback', {...})`.

New `EmitDeps` fields (with defaults):

```ts
findOpenPlan: (organizationId: string, goalId: string) =>
  prisma.goalRecoveryPlan.findFirst({
    where: { organizationId, goalId, status: 'open' },
    select: { id: true, triggerRiskLevel: true },
  }),
supersedePlan: (id: string) =>
  prisma.goalRecoveryPlan.update({ where: { id }, data: { status: 'superseded' } }).then(() => undefined),
createPlan: (data: {
  organizationId: string
  goalId: string
  triggerRiskLevel: string
  diagnosis: string
  evidence: string[]
  modelMeta: Record<string, unknown>
  actions: Array<{ kind: string; title: string; rationale: string; payload: Record<string, unknown>; rank: number }>
}) =>
  prisma.goalRecoveryPlan.create({
    data: {
      organizationId: data.organizationId,
      goalId: data.goalId,
      triggerRiskLevel: data.triggerRiskLevel,
      diagnosis: data.diagnosis,
      evidence: data.evidence,
      modelMeta: data.modelMeta,
      actions: { create: data.actions.map((action) => ({ ...action, organizationId: data.organizationId })) },
    },
    select: { id: true },
  }),
listSources: () => Promise<MetricSourceOption[]>   // default: listMetricSourceOptions with the goal's recipient — see note
draft: typeof draftRecoveryPlan                     // default: draftRecoveryPlan
goalTemplateSourcesFor: (kind: string) => string[]  // default: first GOAL_TEMPLATES entry matching kind, else []
```

Note on `listSources`: `listMetricSourceOptions(auth)` (src/lib/metrics/available-sources.ts:28) needs `{ organizationId, dbUser: { id } }` — the default is `() => listMetricSourceOptions({ organizationId: goal.organizationId, dbUser: { id: recipient } })` built inside `emitGoalRecommendation` after the recipient resolves (the dep is a factory `(organizationId, userId) => Promise<MetricSourceOption[]>` so tests can stub it without a goal in scope).

Action payload mapping when persisting: `connect_tool` → `{ source: action.refId }`, `launch_agent` → `{ seedKey: action.refId }`, `manual_step` → `{}`. `rank` = array index.

- [ ] **Step 1: Extend the tests (failing first)**

Add to `src/lib/goals/__tests__/emit-recommendation.test.ts` (keep the existing tests; extend the `deps()` helper with the new fields):

```ts
// Additions to the deps() helper:
//   calls.plans = [], calls.superseded = []
//   findOpenPlan: async () => null,
//   supersedePlan: async (id: string) => { calls.superseded.push(id) },
//   createPlan: async (data: unknown) => { calls.plans.push(data); return { id: 'plan-1' } },
//   listSources: async () => [],
//   goalTemplateSourcesFor: () => ['stripe'],
//   draft: async () => ({
//     diagnosis: 'Behind pace since week 3.',
//     actions: [{ kind: 'manual_step', refId: null, title: 'Review pipeline', rationale: 'r' }],
//   }),

test('successful draft persists a plan and the suggestion points at it', async () => {
  const d = deps()
  const result = await emitGoalRecommendation(goal, offTrack, d as never)
  assert.equal(result.emitted, true)
  assert.equal(d.calls.plans.length, 1)
  const plan = d.calls.plans[0] as { triggerRiskLevel: string; actions: Array<{ payload: Record<string, unknown> }> }
  assert.equal(plan.triggerRiskLevel, 'off_track')
  const created = d.calls.create[0] as { metadata: { planId: string } }
  assert.equal(created.metadata.planId, 'plan-1')
})

test('draft failure falls back to the legacy rule-based suggestion', async () => {
  const d = deps({ draft: async () => { throw new Error('provider down') } })
  const result = await emitGoalRecommendation(goal, offTrack, d as never)
  assert.equal(result.emitted, true)
  assert.equal(d.calls.plans.length, 0)
  const created = d.calls.create[0] as { metadata: { seedKey: string | null; planId?: string } }
  assert.equal(created.metadata.seedKey, 'pipeline-reviver')
  assert.equal(created.metadata.planId, undefined)
})

test('an open plan at the same risk level blocks re-emission', async () => {
  const d = deps({ findOpenPlan: async () => ({ id: 'plan-0', triggerRiskLevel: 'off_track' }) })
  const result = await emitGoalRecommendation(goal, offTrack, d as never)
  assert.equal(result.emitted, false)
  assert.equal(d.calls.plans.length, 0)
  assert.equal(d.calls.superseded.length, 0)
})

test('worsening past an open at_risk plan supersedes and regenerates', async () => {
  const d = deps({ findOpenPlan: async () => ({ id: 'plan-0', triggerRiskLevel: 'at_risk' }) })
  const result = await emitGoalRecommendation(goal, offTrack, d as never)
  assert.equal(result.emitted, true)
  assert.deepEqual(d.calls.superseded, ['plan-0'])
  assert.equal(d.calls.plans.length, 1)
})

test('launch_agent and connect_tool drafts persist kind-shaped payloads', async () => {
  const d = deps({
    draft: async () => ({
      diagnosis: 'd',
      actions: [
        { kind: 'connect_tool', refId: 'stripe', title: 'Connect Stripe', rationale: 'r' },
        { kind: 'launch_agent', refId: 'pipeline-reviver', title: 'Deploy reviver', rationale: 'r' },
      ],
    }),
  })
  await emitGoalRecommendation(goal, offTrack, d as never)
  const plan = d.calls.plans[0] as { actions: Array<{ kind: string; payload: Record<string, unknown>; rank: number }> }
  assert.deepEqual(plan.actions[0].payload, { source: 'stripe' })
  assert.deepEqual(plan.actions[1].payload, { seedKey: 'pipeline-reviver' })
  assert.deepEqual(plan.actions.map((action) => action.rank), [0, 1])
})
```

Existing tests will need the `deps()` additions but must otherwise keep passing — the fallback tests (`no tagged template...`, `dedupe: an open goal suggestion...`) exercise the legacy path, so for `dedupe:` set `draft: async () => { throw new Error('x') }` so it reaches the suggestion-dedup gate, or update its assertion to the new `'open-plan'`/`'pending-suggestion'` reason as appropriate.

- [ ] **Step 2: Run tests to verify new ones fail**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test src/lib/goals/__tests__/emit-recommendation.test.ts`
Expected: new tests FAIL (unknown deps ignored, no plan created); existing ones still pass.

- [ ] **Step 3: Implement the wiring in emit-recommendation.ts**

Follow the behavior spec above. Key structure:

```ts
export async function emitGoalRecommendation(goal, evaluation, deps = defaultDeps) {
  const openPlan = await deps.findOpenPlan(goal.organizationId, goal.id)
  if (openPlan && !riskWorse(evaluation.riskLevel, openPlan.triggerRiskLevel)) {
    return { emitted: false, reason: 'open-plan' }
  }
  const recipient = goal.ownerUserId ?? goal.createdByUserId
  if (!recipient) return { emitted: false, reason: 'no-recipient' }
  // ...evidence + benchmark assembly exactly as today...

  try {
    const [sources, scores] = await Promise.all([
      deps.listSources(goal.organizationId, recipient),
      deps.adoptionScores(),
    ])
    const candidates = assembleRecoveryCandidates({
      goalKind: goal.kind,
      seeds: deps.seeds,
      adoptionScores: scores,
      sources,
      goalTemplateSources: deps.goalTemplateSourcesFor(goal.kind),
    })
    const started = Date.now()
    const draft = await deps.draft({ goal, evidence, candidates })
    if (openPlan) await deps.supersedePlan(openPlan.id)
    const plan = await deps.createPlan({
      organizationId: goal.organizationId,
      goalId: goal.id,
      triggerRiskLevel: evaluation.riskLevel,
      diagnosis: draft.diagnosis,
      evidence,
      modelMeta: { ms: Date.now() - started },
      actions: draft.actions.map((action, rank) => ({
        kind: action.kind,
        title: action.title,
        rationale: action.rationale,
        rank,
        payload:
          action.kind === 'connect_tool'
            ? { source: action.refId }
            : action.kind === 'launch_agent'
              ? { seedKey: action.refId }
              : {},
      })),
    })
    const suggestion = await deps.createSuggestion({
      /* same fields as today, but */ description: draft.diagnosis,
      metadata: { goalId: goal.id, planId: plan.id, seedKey: null },
    })
    // notify exactly as today
    return { emitted: true, reason: suggestion.id }
  } catch (error) {
    apiLogger.warn('goals.recovery: draft failed, using rule-based fallback', {
      goalId: goal.id,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
    })
    if (await deps.findOpen(goal.organizationId, goal.id)) {
      return { emitted: false, reason: 'pending-suggestion' }
    }
    // ...legacy body verbatim (best-seed suggestion + notify)...
  }
}
```

`evaluation.riskLevel` here is always `at_risk`/`off_track` (the caller gates on worsening). Import `apiLogger` from `@/lib/logger`.

- [ ] **Step 4: Run the full goals test suite**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test src/lib/goals/__tests__/emit-recommendation.test.ts src/lib/goals/__tests__/recovery.test.ts src/lib/goals/__tests__/recovery-candidates.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/goals/emit-recommendation.ts src/lib/goals/__tests__/emit-recommendation.test.ts
git commit -m "feat(goals): worsening transitions draft an AI recovery plan with rule-based fallback"
```

---

### Task 5: Lifecycle — auto-resolve and connect_tool auto-complete

**Files:**

- Create: `src/lib/goals/recovery-lifecycle.ts`
- Modify: `src/lib/goals/refresh.ts` (in `evaluateAndPersistGoal`, after the `prisma.goal.update` at line ~326)
- Test: `src/lib/goals/__tests__/recovery-lifecycle.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export async function reconcileRecoveryPlan(
    goalId: string,
    organizationId: string,
    riskLevel: string,
    deps?: LifecycleDeps,
  ): Promise<void>
  ```

- Consumes (Task 4's data shapes): open plan rows; `connect_tool` actions with `payload.source`.

Behavior:

1. If `riskLevel === 'on_track'`: mark any open plan `resolved` with `resolvedAt: new Date()`. Done.
2. Else if an open plan exists: for each of its `connect_tool` actions in status `proposed`/`accepted`, check source availability (`listSources` dep, same factory shape as Task 4); if the action's `payload.source` is now available, set it to `done`.
3. Never throw — wrap the body in try/catch with `apiLogger.warn('goals.recovery: lifecycle reconcile failed', ...)`; a lifecycle hiccup must not fail the evaluation tick.

`LifecycleDeps` (with prisma defaults, mirroring Task 4's style):

```ts
type LifecycleDeps = {
  findOpenPlanWithActions: (organizationId: string, goalId: string) => Promise<{
    id: string
    actions: Array<{ id: string; kind: string; status: string; payload: unknown }>
  } | null>
  resolvePlan: (id: string) => Promise<void>
  completeAction: (id: string) => Promise<void>
  listSources: (organizationId: string, userId: string) => Promise<MetricSourceOption[]>
  recipientFor: (goalId: string, organizationId: string) => Promise<string | null>
}
```

Default `recipientFor` reads the goal's `ownerUserId ?? createdByUserId`. Skip the availability check (leave actions untouched) when no recipient resolves.

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reconcileRecoveryPlan } from '../recovery-lifecycle'
import type { MetricSourceOption } from '@/lib/metrics/source-options'

const stripeAvailable: MetricSourceOption = {
  source: 'stripe', group: 'source_of_truth', metrics: [],
  connections: [{ ref: 'credential:c1', label: 'Stripe' }],
} as MetricSourceOption

function deps(overrides: Record<string, unknown> = {}) {
  const calls: Record<string, unknown[]> = { resolved: [], completed: [] }
  return {
    calls,
    findOpenPlanWithActions: async () => ({
      id: 'plan-1',
      actions: [
        { id: 'a1', kind: 'connect_tool', status: 'proposed', payload: { source: 'stripe' } },
        { id: 'a2', kind: 'manual_step', status: 'proposed', payload: {} },
      ],
    }),
    resolvePlan: async (id: string) => { calls.resolved.push(id) },
    completeAction: async (id: string) => { calls.completed.push(id) },
    listSources: async () => [stripeAvailable],
    recipientFor: async () => 'user-1',
    ...overrides,
  }
}

test('returning on_track resolves the open plan', async () => {
  const d = deps()
  await reconcileRecoveryPlan('goal-1', 'org-1', 'on_track', d as never)
  assert.deepEqual(d.calls.resolved, ['plan-1'])
  assert.equal(d.calls.completed.length, 0)
})

test('a now-connected source completes its connect_tool action', async () => {
  const d = deps()
  await reconcileRecoveryPlan('goal-1', 'org-1', 'off_track', d as never)
  assert.deepEqual(d.calls.completed, ['a1'])
  assert.equal(d.calls.resolved.length, 0)
})

test('a still-unconnected source leaves the action untouched', async () => {
  const d = deps({ listSources: async () => [] })
  await reconcileRecoveryPlan('goal-1', 'org-1', 'off_track', d as never)
  assert.equal(d.calls.completed.length, 0)
})

test('no open plan is a no-op and errors never propagate', async () => {
  const d = deps({ findOpenPlanWithActions: async () => null })
  await reconcileRecoveryPlan('goal-1', 'org-1', 'on_track', d as never)
  assert.equal(d.calls.resolved.length, 0)
  const throwing = deps({ findOpenPlanWithActions: async () => { throw new Error('db down') } })
  await reconcileRecoveryPlan('goal-1', 'org-1', 'on_track', throwing as never) // must not reject
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test src/lib/goals/__tests__/recovery-lifecycle.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `recovery-lifecycle.ts`** per the behavior above (use `sourceIsAvailable` on the fetched options to decide availability, matching Task 2's semantics).

- [ ] **Step 4: Run tests to verify they pass**, then **wire into refresh.ts**: in `evaluateAndPersistGoal`, immediately after the `prisma.goal.update` persisting `riskLevel` (line ~326-333), add:

```ts
await reconcileRecoveryPlan(goal.id, organizationId, evaluation.riskLevel)
```

(no deps argument — defaults hit prisma). Place it BEFORE the `worsened` block so a stale open plan resolves before any new emission logic runs.

- [ ] **Step 5: Run the whole test suite**

Run: `npm test`
Expected: PASS across the board (refresh.ts has no direct unit tests; e2e-style goals tests must stay green).

- [ ] **Step 6: Commit**

```bash
git add src/lib/goals/recovery-lifecycle.ts src/lib/goals/__tests__/recovery-lifecycle.test.ts src/lib/goals/refresh.ts
git commit -m "feat(goals): recovery plans resolve on recovery and track tool connections"
```

---

### Task 6: API — plan in goal payload, accept/dismiss routes, provision hook

**Files:**

- Modify: `src/app/api/goals/[id]/route.ts` (GET)
- Create: `src/app/api/goals/[id]/recovery/route.ts` (POST — plan dismiss)
- Create: `src/app/api/goals/[id]/recovery/actions/[actionId]/route.ts` (POST — action accept/dismiss)
- Modify: `src/app/api/templates/provision/route.ts`
- Modify: `src/lib/types.ts` (client-safe view types)

**Interfaces:**

- Produces (client contract):

  ```ts
  // src/lib/types.ts
  export type RecoveryActionView = {
    id: string
    kind: 'connect_tool' | 'launch_agent' | 'manual_step'
    title: string
    rationale: string
    payload: Record<string, unknown>
    status: 'proposed' | 'accepted' | 'done' | 'dismissed'
    resultRef: string | null
  }
  export type RecoveryPlanView = {
    id: string
    status: 'open'
    triggerRiskLevel: 'at_risk' | 'off_track'
    diagnosis: string
    evidence: string[]
    createdAt: string
    actions: RecoveryActionView[]
  }
  ```

  `GoalDetail` gains `recoveryPlan: RecoveryPlanView | null`.
- Provision route gains optional body field `recoveryActionId: z.string().min(1).optional()`.

Behavior:

1. **GET /api/goals/[id]**: after loading the goal, fetch `prisma.goalRecoveryPlan.findFirst({ where: { organizationId, goalId: id, status: 'open' }, include: { actions: { orderBy: { rank: 'asc' } } } })` and map to `RecoveryPlanView` (evidence cast from Json to `string[]`, fall back to `[]` on non-array). Attach as `recoveryPlan` on the returned goal object.
2. **POST /api/goals/[id]/recovery** with body `{ op: 'dismiss' }` (zod `z.object({ op: z.literal('dismiss') })`): authorize via the same `visibleWhere` goal lookup; `updateMany` the open plan to `dismissed`; also flip the pointer suggestion: `prisma.userSuggestion.updateMany({ where: { organizationId, kind: 'goal_action', status: 'open', targetType: 'goal', targetId: id }, data: { status: 'dismissed' } })` — a dismissed plan must not leave an open suggestion muting future recommendations. Return `{ success: true }`; 404 if goal invisible, `{ success: true, changed: 0 }` semantics are fine if no open plan.
3. **POST /api/goals/[id]/recovery/actions/[actionId]** with body `{ op: 'accept' | 'dismiss' }`:
   - Authorize goal (same `visibleWhere`), then load the action joined to its plan (`plan: { goalId: id, organizationId, status: 'open' }`); 404 if absent.
   - `dismiss` → status `dismissed`. Return `{ success: true, status: 'dismissed' }`.
   - `accept` on `manual_step` → status `done`, `acceptedAt: new Date()`. Return `{ success: true, status: 'done' }`.
   - `accept` on `connect_tool` → status `accepted`, `acceptedAt`. Return `{ success: true, status: 'accepted', href: '/integrations' }` (client navigates; Task 5 auto-completes it later).
   - `accept` on `launch_agent` → status `accepted`, `acceptedAt`. Return `{ success: true, status: 'accepted', provision: { seedKey: payload.seedKey, goalId: id, recoveryActionId: actionId } }` — the client then calls POST `/api/templates/provision` with exactly that body. Server-side completion happens in the provision route (next point), so a crashed client leaves the action `accepted` (retryable), never falsely `done`.
4. **Provision route**: accept `recoveryActionId` in `bodySchema`. Inside `attributeProvision(resourceType, resourceId)` after the goal-contribution block, when `recoveryActionId` is present:

   ```ts
   await prisma.goalRecoveryAction.updateMany({
     where: { id: recoveryActionId, organizationId, plan: { status: 'open', ...(goalId ? { goalId } : {}) } },
     data: { status: 'done', resultRef: resourceId, acceptedAt: new Date() },
   })
   ```

   (updateMany so a stale/foreign id is a silent 0-count, not a crash; org scoping prevents cross-org marking.)

No unit tests for the route handlers themselves (repo convention: route logic stays thin; `withAuthenticatedApi` handlers aren't unit-tested) — verification happens in Task 8's route smoke. Keep every branch above inside the handlers thin: parse → authorize → one prisma call → respond.

- [ ] **Step 1: Add `RecoveryActionView`/`RecoveryPlanView` to `src/lib/types.ts` and `recoveryPlan` to `GoalDetail`** (find `GoalDetail` at src/lib/types.ts:105).

- [ ] **Step 2: Implement the GET payload addition** in `src/app/api/goals/[id]/route.ts`.

- [ ] **Step 3: Implement the two new route files** per the behavior spec. Copy the `idFrom`/`visibleWhere` helpers' pattern from `src/app/api/goals/[id]/route.ts` (for the nested action route, derive both ids from `request.nextUrl.pathname` segments: `.../goals/<id>/recovery/actions/<actionId>`).

- [ ] **Step 4: Extend the provision route** (`bodySchema` + `attributeProvision`).

- [ ] **Step 5: Typecheck and test**

Run: `npx tsc --noEmit && npm test`
Expected: clean typecheck, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/types.ts src/app/api/goals/[id]/route.ts src/app/api/goals/[id]/recovery src/app/api/templates/provision/route.ts
git commit -m "feat(goals): recovery plan API — payload, accept/dismiss, provision completion"
```

---

### Task 7: UI — the "Get back on track" strip

**Files:**

- Create: `src/components/goals/recovery-plan-strip.tsx`
- Modify: `src/app/goals/[id]/page.tsx` (render between the soft-source banner ~line 317 and `<GoalDashboard>` ~line 319)

**Interfaces:**

- Consumes: `RecoveryPlanView`/`RecoveryActionView` from `@/lib/types`; the Task 6 endpoints; existing UI kit (`Button`, `Badge` from `@/components/ui/*`, `toast` from `sonner`, icons from `lucide-react`).
- Produces: `export function RecoveryPlanStrip({ goalId, plan, onChanged }: { goalId: string; plan: RecoveryPlanView; onChanged: () => void | Promise<void> })`.

Component behavior (client component, `'use client'`):

- Card container visually distinct from widgets: `rounded-2xl border border-amber-500/40 bg-amber-500/5 p-5 space-y-4` with a header row — a `Sparkles` (or `LifeBuoy`) icon, heading **"Get back on track"**, a Badge showing `plan.triggerRiskLevel === 'off_track' ? 'Off track' : 'At risk'`, and a ghost "Dismiss plan" button on the right.
- Below the header: `plan.diagnosis` as body text, then `plan.evidence` lines as a muted `<ul>` (text-xs, same tone as the soft-source banner).
- Action list: one row per action ordered as given (already rank-ordered by the API), each with title (medium), rationale (muted, text-sm), and a right-aligned control by kind/status:
  - `manual_step` + `proposed` → outline Button "Mark done" → `act(action.id, 'accept')`.
  - `connect_tool` + `proposed` → Button "Connect" → `act(action.id, 'accept')` then `router.push(response.href)`.
  - `connect_tool` + `accepted` → muted text "Waiting for connection…".
  - `launch_agent` + `proposed` → Button "Launch agent" → `act(action.id, 'accept')`, then POST `/api/templates/provision` with the returned `provision` body; on success `toast.success('Agent deployed and linked to this goal.')`; on provision failure `toast.error(body.error ?? 'Could not deploy — try again.')` and leave the row showing a "Retry launch" outline button (state: track `failedActionIds` in a `useState<Set<string>>`; a `launch_agent` action with status `accepted` renders "Retry launch" which re-POSTs provision only — no second accept call).
  - any kind + `done` → green check (`Check` icon) + "Done"; for `launch_agent` with `resultRef`, render "Done" as a Link to `/agents` (`<Link href="/agents">View agent</Link>`).
  - every `proposed` action also gets a small ghost "×" dismiss button → `act(action.id, 'dismiss')`.
- `act(actionId, op)` = POST `/api/goals/${goalId}/recovery/actions/${actionId}` with JSON `{ op }`; non-ok → `toast.error(body.error ?? 'Could not update the plan.')`. After every successful mutation call `await onChanged()` (the page's `load`).
- "Dismiss plan" → POST `/api/goals/${goalId}/recovery` `{ op: 'dismiss' }`, then `onChanged()`.

Page wiring in `src/app/goals/[id]/page.tsx`:

```tsx
{goal.recoveryPlan && (
  <RecoveryPlanStrip goalId={goalId} plan={goal.recoveryPlan} onChanged={load} />
)}
```

- [ ] **Step 1: Implement `recovery-plan-strip.tsx`** per the behavior above.
- [ ] **Step 2: Wire it into the page** and import the component.
- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean. (Memory note: `next build` is the local verification path — no Supabase env vars locally, so the running app is not reachable; real-browser checks happen in Task 8.)

- [ ] **Step 4: Commit**

```bash
git add src/components/goals/recovery-plan-strip.tsx src/app/goals/[id]/page.tsx
git commit -m "feat(goals): get-back-on-track strip renders the recovery plan"
```

---

### Task 8: End-to-end verification

**Files:**

- None new (throwaway verification per the repo's `/verify` skill).

- [ ] **Step 1: Invoke the repo's verification skill** (`Skill: verify`) and follow its protocol: throwaway Postgres, deploy migrations (`npx prisma migrate deploy`), route-smoke the new endpoints with seeded auth:
  - Seed an org + user + off-track goal + a `GoalRecoveryPlan` with one action of each kind (direct prisma inserts in the smoke script — do NOT depend on a live LLM; generation is covered by unit tests with stubs).
  - GET `/api/goals/[id]` → response contains `recoveryPlan.actions` length 3, rank-ordered.
  - POST accept on the `manual_step` → `status: 'done'`; re-GET shows it.
  - POST accept on the `connect_tool` → `status: 'accepted'`, `href: '/integrations'`.
  - POST dismiss on the plan → re-GET shows `recoveryPlan: null`, and the pointer suggestion (seed one) flipped to `dismissed`.
  - Cross-org probe: a second org's auth on the same ids → 404s, no state change.
- [ ] **Step 2: Run the full suite one more time**: `npm test && npx tsc --noEmit && npx prisma validate`. Expected: all green.
- [ ] **Step 3: Commit any smoke-harness leftovers cleanup** (the verify protocol uses throwaway files; nothing should land in git — `git status` must be clean apart from intended changes).

---

## Self-Review Notes (already applied)

- Spec's "supersede on further worsening" required loosening the old suggestion-level dedup: the plan-level gate (Task 4) is now the primary gate; the suggestion-level `findOpen` check survives only on the fallback path. The dismiss route (Task 6) closes the loop the spec called out: dismissing a plan also dismisses the pointer suggestion so future recommendations aren't muted forever.
- `riskWorse` lives in Task 3 (recovery.ts) and is consumed by Task 4 — single definition.
- The provision route, not the accept route, marks `launch_agent` actions `done` (with `resultRef`) — matching the spec's "action stays accepted with visible retry" failure behavior.
- Evidence/`renderGoalEvidence`, notify shape, benchmark line: reused verbatim from the existing emit path; no duplication introduced.
