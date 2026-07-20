# Organization Persona Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Widen historical activity backfill to GitHub, auto-trigger it on connect, and compute a durable per-organization persona (deterministic department weights + LLM narrative) that feeds template ranking and agent system prompts — with a loudly-logged Neo4j projection.

**Architecture:** A new pure `src/lib/persona/weights.ts` computes normalized department weights from three signal kinds (connected tools, scan profiles, activity volume); `src/lib/persona/compute.ts` wraps it with a debounced, never-throwing `recomputeOrgPersona` that persists to a new Postgres `OrganizationPersona` row and projects an `insight` node into the graph when RAG is configured. A GitHub `ActivitySource` (Nango-proxy-based) joins the existing Slack adapter, auto-triggered from the Nango status route via a small testable `auto-backfill` module. Two consumption points: `buildSynthesisPrompt`/seed-catalogue ordering, and `buildAgentSystemPrompt`.

**Tech Stack:** Next.js 15 route handlers, Prisma/Postgres, Anthropic SDK via existing `generateStructured`, Nango proxy, Neo4j via existing `commitGraph`, node:test + tsx.

**Spec:** `docs/superpowers/specs/2026-07-20-org-persona-pipeline-design.md`

## Global Constraints

- TDD every code task: write the failing test, run it, watch it fail for the right reason, then implement. Test runner: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <files>`.
- DB-gated tests follow the repo protocol (`src/app/api/__tests__/tool-capture-e2e.test.ts` is the reference): the entire body sits inside `if (process.env.TEST_DATABASE_URL) { ... } else { test('… (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {}) }`, seeds with `seedTestOrg` from `@/lib/server/__tests__/test-auth`, and cleans up in `after()`.
- Throwaway Postgres for DB-gated tests (from `.claude/skills/verify`): PG15 at `postgresql://qa@127.0.0.1:54339/sublime_qa`, Supabase objects stubbed, `npx prisma migrate deploy` applied. Start/stop with `pg_ctl` per that skill; export `TEST_DATABASE_URL`, `DATABASE_URL`, `DIRECT_URL` all to that URL plus `ENCRYPTION_KEY=ci-encryption-key` when running.
- Tenant guard: every Prisma query on org-scoped models MUST include `organizationId` in its `where` (the guarded `prisma` client throws otherwise). `prisma.organizationPersona.findUnique({ where: { organizationId } })` is valid — `organizationId` is the model's unique key.
- Fire-and-forget convention: background work is `void promise.catch(() => undefined)` (or logged catch); it must never throw into or block the triggering request/run.
- Persona narrative prompts must instruct the model to describe patterns only — never quote names, emails, or record contents (same rule as `buildScanPrompt`).
- LLM calls use the cheap tier: `process.env.AGENT_REFLECTION_MODEL?.trim() || DEFAULT_SUMMARY_MODEL`.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Known pre-existing failures in this environment (NOT caused by this work — do not chase): `assistant chat PATCH records an executed run` and the two `slack connections-route` tests.

---

### Task 1: `OrganizationPersona` model + migration

**Files:**
- Modify: `prisma/schema.prisma` (Organization relations list ~line 34-61; new model after `ActivityBackfill` ~line 957)
- Create: `prisma/migrations/20260720120000_organization_persona/migration.sql`

**Interfaces:**
- Consumes: existing `Organization` model.
- Produces: Prisma model `OrganizationPersona` with fields `id`, `organizationId` (unique, uuid), `departmentWeights` (Json), `narrative` (String?), `confidence` (Float?), `signalsSummary` (Json), `computedAt` (DateTime), timestamps — used by Tasks 3, 7, 8 via `prisma.organizationPersona`.

- [ ] **Step 1: Add the model to `prisma/schema.prisma`**

After the `ActivityBackfill` model, add:

```prisma
/// Durable per-organization persona (org-persona-pipeline spec 2026-07-20).
/// departmentWeights are deterministic and always present; narrative and
/// confidence stay NULL until real usage signal exists (a scan profile or
/// activity events). Postgres is the source of truth; a graph projection
/// mirrors it when NEO4J_* + VOYAGE_API_KEY are configured.
model OrganizationPersona {
  id                String   @id @default(cuid())
  organizationId    String   @unique @db.Uuid
  departmentWeights Json     @default("{}")
  narrative         String?
  confidence        Float?
  signalsSummary    Json     @default("{}")
  computedAt        DateTime @db.Timestamptz(6)
  createdAt         DateTime @default(now()) @db.Timestamptz(6)
  updatedAt         DateTime @updatedAt @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@map("organization_personas")
}
```

In the `Organization` model's relation list (after `userSuggestions UserSuggestion[]`), add:

```prisma
  persona                   OrganizationPersona?
```

- [ ] **Step 2: Author the migration**

Create `prisma/migrations/20260720120000_organization_persona/migration.sql`:

```sql
-- Durable per-organization persona (org-persona-pipeline spec). Department
-- weights are deterministic and always present; narrative/confidence stay
-- NULL until real usage signal exists (a scan profile or activity events).
CREATE TABLE "organization_personas" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "departmentWeights" JSONB NOT NULL DEFAULT '{}',
    "narrative" TEXT,
    "confidence" DOUBLE PRECISION,
    "signalsSummary" JSONB NOT NULL DEFAULT '{}',
    "computedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "organization_personas_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "organization_personas_organizationId_key" ON "organization_personas"("organizationId");

ALTER TABLE "organization_personas" ADD CONSTRAINT "organization_personas_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Verify migration + schema agree against the throwaway Postgres**

Run (with the throwaway PG running):

```bash
export DATABASE_URL="postgresql://qa@127.0.0.1:54339/sublime_qa"
export DIRECT_URL="$DATABASE_URL"
npx prisma migrate deploy
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
npx prisma generate
```

Expected: `migrate deploy` applies `20260720120000_organization_persona`; `migrate diff` exits 0 (no drift); generate succeeds.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260720120000_organization_persona/
git commit -m "feat: OrganizationPersona model + migration"
```

---

### Task 2: Pure persona weights module

**Files:**
- Create: `src/lib/persona/weights.ts`
- Test: `src/lib/persona/__tests__/weights.test.ts`

**Interfaces:**
- Consumes: `departmentsForTools`, `DEPARTMENTS`, `type Department` from `@/lib/templates/departments`; `import type { PendingNode } from '@/lib/rag/indexer'` (type-only — keeps the module pure at runtime).
- Produces (used by Tasks 3 and 7):
  - `type PersonaSignals = { connectedToolSlugs: string[]; scannedConnectionSlugs: string[]; activityEventCounts: Record<string, number> }`
  - `computeDepartmentWeights(signals: PersonaSignals): Record<Department, number>` — normalized to sum 1; `{ general: 1, rest 0 }` on zero signal.
  - `hasNarrativeSignal(signals: PersonaSignals): boolean`
  - `personaGraphNode(organizationId: string, weights: Record<Department, number>, narrative: string | null): PendingNode`
  - `topPersonaDepartments(weights: unknown, limit?: number): string[]` — tolerant of raw Json.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/persona/__tests__/weights.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeDepartmentWeights, hasNarrativeSignal, personaGraphNode, topPersonaDepartments } from '../weights'

test('zero signal → general only', () => {
  const w = computeDepartmentWeights({ connectedToolSlugs: [], scannedConnectionSlugs: [], activityEventCounts: {} })
  assert.equal(w.general, 1)
  assert.equal(w.sales, 0)
})

test('glue-only connections (slack/gmail) contribute nothing → general', () => {
  const w = computeDepartmentWeights({ connectedToolSlugs: ['slack', 'gmail'], scannedConnectionSlugs: [], activityEventCounts: {} })
  assert.equal(w.general, 1)
  assert.equal(w.engineering, 0)
})

test('anchor connection sets its departments; weights normalize to 1', () => {
  const w = computeDepartmentWeights({ connectedToolSlugs: ['github'], scannedConnectionSlugs: [], activityEventCounts: {} })
  assert.equal(w.engineering, 1)
  const total = Object.values(w).reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(total - 1) < 1e-9)
})

test('a scanned connection outweighs a merely-connected one', () => {
  const w = computeDepartmentWeights({
    connectedToolSlugs: ['github', 'zendesk'],
    scannedConnectionSlugs: ['zendesk'],
    activityEventCounts: {},
  })
  // zendesk: 1 (connected) + 2 (scanned) = 3 → csm; github: 1 → engineering
  assert.ok(w.csm > w.engineering)
})

test('activity weight is log-scaled and capped so raw volume cannot swamp everything', () => {
  const w = computeDepartmentWeights({
    connectedToolSlugs: ['salesforce'],
    scannedConnectionSlugs: [],
    activityEventCounts: { github: 10_000_000 }, // log10(1e7+1) ≈ 7, capped at 3
  })
  // salesforce → +1 each to sales/finance/csm (total 3); github activity → capped 3 to engineering.
  // engineering = 3 / 6 = 0.5; uncapped it would be ~7/10 = 0.7.
  assert.ok(w.engineering <= 0.5 + 1e-9)
})

test('duplicate slugs count once per signal kind', () => {
  const one = computeDepartmentWeights({ connectedToolSlugs: ['github'], scannedConnectionSlugs: [], activityEventCounts: {} })
  const dup = computeDepartmentWeights({ connectedToolSlugs: ['github', 'github'], scannedConnectionSlugs: [], activityEventCounts: {} })
  assert.deepEqual(dup, one)
})

test('hasNarrativeSignal: a scan profile or activity flips it; connections alone never do', () => {
  assert.equal(hasNarrativeSignal({ connectedToolSlugs: ['github'], scannedConnectionSlugs: [], activityEventCounts: {} }), false)
  assert.equal(hasNarrativeSignal({ connectedToolSlugs: [], scannedConnectionSlugs: ['github'], activityEventCounts: {} }), true)
  assert.equal(hasNarrativeSignal({ connectedToolSlugs: [], scannedConnectionSlugs: [], activityEventCounts: { slack: 5 } }), true)
  assert.equal(hasNarrativeSignal({ connectedToolSlugs: [], scannedConnectionSlugs: [], activityEventCounts: { slack: 0 } }), false)
})

test('personaGraphNode: stable id, insight type, top departments + narrative in text', () => {
  const node = personaGraphNode('org-1', { sales: 0.6, engineering: 0.4, marketing: 0, finance: 0, csm: 0, general: 0 }, 'A sales-led team.')
  assert.equal(node.id, 'persona:org-1')
  assert.equal(node.type, 'insight')
  assert.ok(node.text.includes('sales'))
  assert.ok(node.text.includes('A sales-led team.'))
  assert.equal((node.props as { kind?: string }).kind, 'persona')
  assert.equal(node.visibility, 'shared')
})

test('topPersonaDepartments: sorted desc, excludes general and zeros, tolerant of junk', () => {
  assert.deepEqual(topPersonaDepartments({ sales: 0.2, engineering: 0.7, general: 0.1, finance: 0 }), ['engineering', 'sales'])
  assert.deepEqual(topPersonaDepartments(null), [])
  assert.deepEqual(topPersonaDepartments('junk'), [])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/persona/__tests__/weights.test.ts`
Expected: FAIL — cannot find module `../weights`.

- [ ] **Step 3: Implement `src/lib/persona/weights.ts`**

```ts
/**
 * Pure persona math. Three signal kinds feed department weights:
 *   - connected tools (+1 per anchor department — presence only)
 *   - scanned connections (+2 — evidence of real usage, weighted above presence)
 *   - activity-ledger volume (+log10(count+1), capped — observed behavior)
 * Glue tools (slack/gmail/…) contribute nothing: departmentsForTools maps
 * them to ['general'], which is the no-signal fallback, never a weight.
 * Kept dependency-light (type-only indexer import) so it unit-tests without
 * Prisma or the graph store.
 */
import { DEPARTMENTS, departmentsForTools, type Department } from '@/lib/templates/departments'
import type { PendingNode } from '@/lib/rag/indexer'

export type PersonaSignals = {
  connectedToolSlugs: string[]
  scannedConnectionSlugs: string[]
  activityEventCounts: Record<string, number>
}

const CONNECTED_WEIGHT = 1
const SCANNED_WEIGHT = 2
const ACTIVITY_WEIGHT_CAP = 3

export function computeDepartmentWeights(signals: PersonaSignals): Record<Department, number> {
  const raw = new Map<Department, number>()
  const add = (slug: string, amount: number) => {
    const departments = departmentsForTools([slug])
    if (departments.length === 1 && departments[0] === 'general') return // glue/unknown — no department signal
    for (const department of departments) raw.set(department, (raw.get(department) ?? 0) + amount)
  }
  for (const slug of new Set(signals.connectedToolSlugs)) add(slug, CONNECTED_WEIGHT)
  for (const slug of new Set(signals.scannedConnectionSlugs)) add(slug, SCANNED_WEIGHT)
  for (const [slug, count] of Object.entries(signals.activityEventCounts)) {
    if (count > 0) add(slug, Math.min(ACTIVITY_WEIGHT_CAP, Math.log10(count + 1)))
  }
  const weights = Object.fromEntries(DEPARTMENTS.map((d) => [d, 0])) as Record<Department, number>
  const total = [...raw.values()].reduce((a, b) => a + b, 0)
  if (total === 0) return { ...weights, general: 1 }
  for (const [department, value] of raw) weights[department] = value / total
  return weights
}

/** Narrative requires observed usage — a scan profile or activity events. Mere connections never qualify. */
export function hasNarrativeSignal(signals: PersonaSignals): boolean {
  return signals.scannedConnectionSlugs.length > 0 || Object.values(signals.activityEventCounts).some((count) => count > 0)
}

/**
 * The graph projection of a persona. The graph has no organization node —
 * every node is already org-scoped by organizationId — so the persona is a
 * standalone org-shared insight node with a stable id (upserts in place),
 * not an edge to anything.
 */
export function personaGraphNode(
  organizationId: string,
  weights: Record<Department, number>,
  narrative: string | null,
): PendingNode {
  const top = (Object.entries(weights) as [Department, number][])
    .filter(([department, weight]) => weight > 0 && department !== 'general')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
  return {
    id: `persona:${organizationId}`,
    type: 'insight',
    text: [
      `Organization persona: ${top.map(([d, w]) => `${d} (${Math.round(w * 100)}%)`).join(', ') || 'general'}.`,
      narrative ?? '',
    ].join(' ').trim().slice(0, 1500),
    props: { kind: 'persona', departmentWeights: weights },
    visibility: 'shared',
  }
}

/** Tolerant reader for the persisted Json weights — safe on junk/legacy shapes. */
export function topPersonaDepartments(weights: unknown, limit = 3): string[] {
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) return []
  return Object.entries(weights as Record<string, unknown>)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0 && entry[0] !== 'general')
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([department]) => department)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/persona/__tests__/weights.test.ts`
Expected: all 9 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/persona/
git commit -m "feat: pure persona department-weight computation"
```

---

### Task 3: `recomputeOrgPersona` (debounced compute + persist + graph projection)

**Files:**
- Create: `src/lib/persona/compute.ts`
- Test: `src/lib/persona/__tests__/compute.test.ts` (DB-gated)

**Interfaces:**
- Consumes: Task 1 model; Task 2 exports; `generateStructured`, `DEFAULT_SUMMARY_MODEL` from `@/lib/llm/model-runner`; `commitGraph` from `@/lib/rag/indexer`; `ragEnabled` from `@/lib/rag/get-store`; `canonicalIntegrationSlug` from `@/lib/templates/departments`; `findOrgIntelligenceAgentId` from `@/lib/intelligence/connection-scan`.
- Produces (used by Tasks 5–8): `recomputeOrgPersona(organizationId: string, opts?: { force?: boolean }, deps?: { generate?: typeof generateStructured; now?: () => Date }): Promise<{ status: 'computed' | 'skipped-cooldown' | 'failed' }>` — never throws.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/persona/__tests__/compute.test.ts`:

```ts
/**
 * recomputeOrgPersona against a real Postgres (TEST_DATABASE_URL): weights
 * persisted from real connection rows, cooldown debounce, and narrative
 * degradation/retention. Skipped without TEST_DATABASE_URL (mirrors
 * route-smoke / tool-capture-e2e).
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let organizationId: string
  let recomputeOrgPersona: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    organizationId = seeded.organizationId
    ;({ recomputeOrgPersona } = await import('../compute'))
    // A connected GitHub mirror row is the base signal for every case below.
    await prisma.nangoConnection.create({
      data: {
        organizationId, userId: seeded.userId, connectionId: 'conn-gh-1',
        providerConfigKey: 'github-app', provider: 'github', status: 'connected',
      },
    })
  })
  after(async () => { if (seeded) await seeded.cleanup() })

  test('computes and persists deterministic weights; no narrative without usage signal', async () => {
    const result = await recomputeOrgPersona(organizationId)
    assert.equal(result.status, 'computed')
    const row = await prisma.organizationPersona.findUnique({ where: { organizationId } })
    assert.ok(row)
    assert.ok((row.departmentWeights as Record<string, number>).engineering > 0)
    assert.equal(row.narrative, null)
    assert.equal(row.confidence, null)
  })

  test('cooldown: an immediate second call skips; force bypasses', async () => {
    assert.equal((await recomputeOrgPersona(organizationId)).status, 'skipped-cooldown')
    assert.equal((await recomputeOrgPersona(organizationId, { force: true })).status, 'computed')
  })

  test('activity signal unlocks narrative; generator failure degrades and never regresses a stored narrative', async () => {
    await prisma.activityEvent.create({
      data: {
        organizationId, source: 'github', actorRef: 'dev1', action: 'opened_pr',
        entityType: 'pull_request', entityRef: 'acme/app#1', occurredAt: new Date(),
        ingestKind: 'backfill', dedupeKey: 'github:acme/app:pr:1',
      },
    })
    const failing = async () => { throw new Error('llm down') }
    assert.equal((await recomputeOrgPersona(organizationId, { force: true }, { generate: failing })).status, 'computed')
    let row = await prisma.organizationPersona.findUnique({ where: { organizationId } })
    assert.equal(row.narrative, null) // weights written; narrative degraded

    const generate = async () => JSON.stringify({ narrative: 'An engineering-led team shipping via GitHub.', confidence: 0.8 })
    await recomputeOrgPersona(organizationId, { force: true }, { generate })
    row = await prisma.organizationPersona.findUnique({ where: { organizationId } })
    assert.equal(row.narrative, 'An engineering-led team shipping via GitHub.')
    assert.equal(row.confidence, 0.8)

    // A later failing pass keeps (never nulls) the stored narrative.
    await recomputeOrgPersona(organizationId, { force: true }, { generate: failing })
    row = await prisma.organizationPersona.findUnique({ where: { organizationId } })
    assert.equal(row.narrative, 'An engineering-led team shipping via GitHub.')
  })
} else {
  test('persona compute (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run (throwaway PG running, migrations applied):

```bash
export TEST_DATABASE_URL="postgresql://qa@127.0.0.1:54339/sublime_qa"
export DATABASE_URL="$TEST_DATABASE_URL" DIRECT_URL="$TEST_DATABASE_URL" ENCRYPTION_KEY="ci-encryption-key"
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/persona/__tests__/compute.test.ts
```

Expected: FAIL — cannot find module `../compute`.

- [ ] **Step 3: Implement `src/lib/persona/compute.ts`**

```ts
/**
 * Org persona: debounced recompute from accumulated signals (connections,
 * scan profiles, activity ledger). The Postgres row is the source of truth
 * and is always written; a graph projection mirrors it when RAG is
 * configured — logged LOUDLY either way, because production has graph
 * credentials and a silent no-op there is a defect, not a config choice.
 * Never throws — safe to fire-and-forget from scan/backfill hooks.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { generateStructured, DEFAULT_SUMMARY_MODEL } from '@/lib/llm/model-runner'
import { commitGraph } from '@/lib/rag/indexer'
import { ragEnabled } from '@/lib/rag/get-store'
import { canonicalIntegrationSlug, type Department } from '@/lib/templates/departments'
import { findOrgIntelligenceAgentId } from '@/lib/intelligence/connection-scan'
import {
  computeDepartmentWeights,
  hasNarrativeSignal,
  personaGraphNode,
  type PersonaSignals,
} from './weights'

/** Recompute cooldown; read per call so tests can override. Default 1h. */
function cooldownMs(): number {
  const parsed = Number(process.env.PERSONA_RECOMPUTE_COOLDOWN_MS)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60 * 60 * 1000
}

const NARRATIVE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    narrative: { type: 'string', description: '2-4 sentence description of how this organization works and what it automates.' },
    confidence: { type: 'number', description: '0..1 confidence that the narrative reflects real usage rather than guesswork.' },
  },
  required: ['narrative', 'confidence'],
}

async function gatherSignals(organizationId: string): Promise<PersonaSignals> {
  const [nango, mcp, activityBySource] = await Promise.all([
    prisma.nangoConnection.findMany({ where: { organizationId, status: 'connected' }, select: { providerConfigKey: true } }),
    prisma.mcpConnection.findMany({ where: { organizationId, isActive: true }, select: { name: true } }),
    prisma.activityEvent.groupBy({ by: ['source'], where: { organizationId }, _count: { _all: true } }),
  ])
  const connectedToolSlugs = [
    ...nango.map((row) => canonicalIntegrationSlug(row.providerConfigKey)),
    ...mcp.map((row) => canonicalIntegrationSlug(row.name)),
  ]
  // Scan profiles persist as 'learning' memories under the hidden org-intelligence
  // agent, keyed by sourceRef `<plane>:<connectionRef>` — the connectionRef slice
  // canonicalizes to the tool slug ('nango:github' → 'github').
  const agentId = await findOrgIntelligenceAgentId(organizationId)
  const scannedConnectionSlugs: string[] = []
  if (agentId) {
    const memories = await prisma.agentMemory.findMany({
      where: { organizationId, agentId, kind: 'learning' },
      select: { sourceRef: true },
      distinct: ['sourceRef'],
    })
    for (const memory of memories) {
      const ref = memory.sourceRef?.split(':')[1]
      if (ref) scannedConnectionSlugs.push(canonicalIntegrationSlug(ref))
    }
  }
  const activityEventCounts = Object.fromEntries(
    activityBySource.map((row) => [canonicalIntegrationSlug(row.source), row._count._all]),
  )
  return { connectedToolSlugs, scannedConnectionSlugs, activityEventCounts }
}

async function generateNarrative(
  organizationId: string,
  signals: PersonaSignals,
  weights: Record<Department, number>,
  generate: typeof generateStructured,
): Promise<{ narrative: string; confidence: number } | null> {
  const agentId = await findOrgIntelligenceAgentId(organizationId)
  const memories = agentId
    ? await prisma.agentMemory.findMany({
        where: { organizationId, agentId, kind: 'learning', status: 'open' },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { title: true },
      })
    : []
  const model = process.env.AGENT_REFLECTION_MODEL?.trim() || DEFAULT_SUMMARY_MODEL
  const raw = await generate({
    schemaName: 'org_persona_narrative',
    schema: NARRATIVE_JSON_SCHEMA,
    maxTokens: 400,
    model,
    system:
      'You are profiling an organization from its connected-tool usage so an automation platform can calibrate suggestions and agent behavior. Write a 2-4 sentence persona narrative: what kind of team this appears to be, which departments dominate, and what they appear to automate or care about. Describe patterns and shapes only — never quote names, emails, or any record contents. Also return a 0..1 confidence.',
    user: [
      `Connected tools: ${[...new Set(signals.connectedToolSlugs)].join(', ') || 'none'}`,
      `Department weights: ${JSON.stringify(weights)}`,
      `Activity volume by source: ${JSON.stringify(signals.activityEventCounts)}`,
      'Usage learnings:',
      ...(memories.length ? memories.map((m) => `- ${m.title}`) : ['- none']),
    ].join('\n'),
  })
  try {
    const parsed = JSON.parse(raw) as { narrative?: unknown; confidence?: unknown }
    if (typeof parsed.narrative !== 'string' || !parsed.narrative.trim()) return null
    const confidence = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0
    return { narrative: parsed.narrative.trim().slice(0, 2000), confidence }
  } catch {
    return null
  }
}

function summarizeSignals(signals: PersonaSignals): Prisma.InputJsonValue {
  return {
    connectedTools: [...new Set(signals.connectedToolSlugs)],
    scannedConnections: [...new Set(signals.scannedConnectionSlugs)],
    activityEventCounts: signals.activityEventCounts,
  }
}

export async function recomputeOrgPersona(
  organizationId: string,
  opts: { force?: boolean } = {},
  deps: { generate?: typeof generateStructured; now?: () => Date } = {},
): Promise<{ status: 'computed' | 'skipped-cooldown' | 'failed' }> {
  const generate = deps.generate ?? generateStructured
  const now = deps.now?.() ?? new Date()
  try {
    const existing = await prisma.organizationPersona.findUnique({
      where: { organizationId },
      select: { computedAt: true },
    })
    if (!opts.force && existing && now.getTime() - existing.computedAt.getTime() < cooldownMs()) {
      return { status: 'skipped-cooldown' }
    }

    const signals = await gatherSignals(organizationId)
    const weights = computeDepartmentWeights(signals)

    let narrative: string | null = null
    let confidence: number | null = null
    if (hasNarrativeSignal(signals)) {
      try {
        const generated = await generateNarrative(organizationId, signals, weights, generate)
        if (generated) ({ narrative, confidence } = generated)
      } catch (error) {
        apiLogger.warn('persona: narrative generation failed — keeping deterministic weights', {
          organizationId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const weightsJson = weights as unknown as Prisma.InputJsonValue
    await prisma.organizationPersona.upsert({
      where: { organizationId },
      create: {
        organizationId,
        departmentWeights: weightsJson,
        narrative,
        confidence,
        signalsSummary: summarizeSignals(signals),
        computedAt: now,
      },
      // On update, only touch narrative/confidence when this pass produced
      // one — a failed or gated narrative pass must never null a stored one.
      update: {
        departmentWeights: weightsJson,
        ...(narrative !== null ? { narrative, confidence } : {}),
        signalsSummary: summarizeSignals(signals),
        computedAt: now,
      },
    })

    if (ragEnabled()) {
      try {
        await commitGraph(organizationId, [personaGraphNode(organizationId, weights, narrative)], [])
        apiLogger.info('persona: projected to knowledge graph', { organizationId })
      } catch (error) {
        // error (not warn) by design: production HAS graph credentials, so a
        // projection failure is a real defect, never an unconfigured env.
        apiLogger.error('persona: graph projection failed', {
          organizationId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    } else {
      apiLogger.info('persona: graph projection skipped — NEO4J_*/VOYAGE_API_KEY not configured', { organizationId })
    }

    return { status: 'computed' }
  } catch (error) {
    apiLogger.warn('persona: recompute failed', {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { status: 'failed' }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Same command as Step 2. Expected: 3 PASS. Also re-run Task 2's tests — still green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/persona/
git commit -m "feat: debounced org persona recompute with graph projection"
```

---

### Task 4: GitHub ActivitySource + registry registration

**Files:**
- Create: `src/lib/activity/sources/github.ts`
- Modify: `src/lib/activity/registry.ts`
- Test: `src/lib/activity/__tests__/github-source.test.ts`

**Interfaces:**
- Consumes: `ActivitySource`, `BackfillBatch`, `NormalizedActivity`, `SourceContext`, `BackfillWindow`, `windowStart` from `../types`; `type NangoProxy` from `@/lib/nango/delivery`; `getNangoClient` from `@/lib/nango/client`. `SourceContext.connectionRef` is the **Nango connection id** — the adapter resolves the mirror row for `providerConfigKey`.
- Produces (used by Task 5): registry entry `'github'` with `capabilities.backfill === true`; exports `makeGithubActivitySource(proxyOverride?: NangoProxy): ActivitySource`, `githubActivitySource`, pure mappers `githubIssueActivity(repo: string, item: Record<string, unknown>): NormalizedActivity | null` and `githubCommitActivity(repo, item)`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/activity/__tests__/github-source.test.ts`:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { githubIssueActivity, githubCommitActivity, makeGithubActivitySource } from '../sources/github'
import { getActivitySource } from '../registry'

test('registry resolves the github source with backfill capability', () => {
  const source = getActivitySource('github')
  assert.ok(source)
  assert.equal(source!.capabilities.backfill, true)
})

test('issue payload → opened_issue; pull_request key flips to opened_pr', () => {
  const base = { number: 7, created_at: '2026-06-01T10:00:00Z', user: { login: 'dev1' }, title: 'Fix login', state: 'open' }
  const issue = githubIssueActivity('acme/app', base)!
  assert.equal(issue.action, 'opened_issue')
  assert.equal(issue.entityType, 'issue')
  assert.equal(issue.entityRef, 'acme/app#7')
  assert.equal(issue.dedupeKey, 'github:acme/app:issue:7')
  const pr = githubIssueActivity('acme/app', { ...base, pull_request: { url: 'x' } })!
  assert.equal(pr.action, 'opened_pr')
  assert.equal(pr.entityType, 'pull_request')
  assert.equal(pr.dedupeKey, 'github:acme/app:pr:7')
})

test('commit payload → pushed_commit with stable dedupe key; message truncated into newState', () => {
  const activity = githubCommitActivity('acme/app', {
    sha: 'abc123def4567890',
    author: { login: 'dev1' },
    commit: { author: { name: 'Dev One', date: '2026-06-02T09:00:00Z' }, message: 'ship it' },
  })!
  assert.equal(activity.action, 'pushed_commit')
  assert.equal(activity.entityRef, 'acme/app@abc123def456')
  assert.equal(activity.dedupeKey, 'github:acme/app:commit:abc123def4567890')
  assert.deepEqual(activity.newState, { message: 'ship it' })
})

test('malformed payloads map to null instead of throwing', () => {
  assert.equal(githubIssueActivity('acme/app', {}), null)
  assert.equal(githubIssueActivity('acme/app', { number: 1, created_at: 'not-a-date', user: { login: 'x' } }), null)
  assert.equal(githubCommitActivity('acme/app', {}), null)
})

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  let prisma: any
  let seeded: any
  let organizationId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    organizationId = seeded.organizationId
    await prisma.nangoConnection.create({
      data: {
        organizationId, userId: seeded.userId, connectionId: 'conn-gh-1',
        providerConfigKey: 'github-app', provider: 'github', status: 'connected',
      },
    })
  })
  after(async () => { if (seeded) await seeded.cleanup() })

  test('backfill walks repos → issues → commits with cursors, tolerating per-repo failures', async () => {
    const ISSUE = { number: 1, created_at: '2026-06-01T10:00:00Z', user: { login: 'dev1' }, title: 'Bug', state: 'open' }
    const PR = { number: 2, created_at: '2026-06-01T11:00:00Z', user: { login: 'dev2' }, title: 'Feat', state: 'open', pull_request: { url: 'x' } }
    const COMMIT = { sha: 'abc123def4567890', author: { login: 'dev1' }, commit: { author: { name: 'D', date: '2026-06-02T09:00:00Z' }, message: 'ship' } }
    const proxy = async ({ endpoint }: { endpoint: string }) => {
      if (endpoint === '/user/repos') return { data: [{ full_name: 'acme/app' }, { full_name: 'acme/empty' }] }
      if (endpoint === '/repos/acme/app/issues') return { data: [ISSUE, PR] }
      if (endpoint === '/repos/acme/app/commits') return { data: [COMMIT] }
      if (endpoint === '/repos/acme/empty/issues') return { data: [] }
      if (endpoint === '/repos/acme/empty/commits') throw new Error('409 Git Repository is empty')
      throw new Error(`unexpected endpoint ${endpoint}`)
    }
    const source = makeGithubActivitySource(proxy as never)
    const batches: { events: unknown[]; nextCursor?: string }[] = []
    for await (const batch of source.backfill({ organizationId, connectionRef: 'conn-gh-1' }, '90d')) batches.push(batch)
    const actions = batches.flatMap((b) => b.events).map((e) => (e as { action: string }).action).sort()
    assert.deepEqual(actions, ['opened_issue', 'opened_pr', 'pushed_commit'])
    assert.equal(batches[batches.length - 1].nextCursor, undefined) // terminal batch carries no cursor
    assert.ok(batches.slice(0, -1).every((b) => typeof b.nextCursor === 'string')) // interior batches checkpoint
  })

  test('backfill yields nothing when no mirror row matches the connectionRef', async () => {
    const source = makeGithubActivitySource((async () => { throw new Error('must not be called') }) as never)
    const batches: unknown[] = []
    for await (const batch of source.backfill({ organizationId, connectionRef: 'missing' }, '90d')) batches.push(batch)
    assert.equal(batches.length, 0)
  })
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run (with the DB env exported as in Task 3):
`TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/activity/__tests__/github-source.test.ts`
Expected: FAIL — cannot find module `../sources/github`.

- [ ] **Step 3: Implement `src/lib/activity/sources/github.ts`**

```ts
/**
 * GitHub ActivitySource — historical issues/PRs/commits through the Nango
 * proxy (credentials never touch this process; same seam as
 * src/lib/nango/delivery.ts). connectionRef is the Nango connection id; the
 * mirror row supplies the providerConfigKey. The GitHub issues endpoint
 * returns PRs too (they carry a pull_request key), so the walk is two phases
 * per repo: issues (issues + PRs), then commits.
 */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { getNangoClient } from '@/lib/nango/client'
import type { NangoProxy } from '@/lib/nango/delivery'
import {
  windowStart,
  type ActivitySource,
  type BackfillBatch,
  type BackfillWindow,
  type NormalizedActivity,
  type SourceContext,
} from '../types'

const PAGE_SIZE = 100
const MAX_REPOS = 10
const CALL_TIMEOUT_MS = 30_000

type GithubCursor = { repos: string[]; repoIndex: number; phase: 'issues' | 'commits'; page: number }

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer)) as Promise<T>
}

function defaultProxy(): NangoProxy {
  const nango = getNangoClient()
  return (args) =>
    withTimeout(nango.proxy(args as never) as Promise<{ data: unknown }>, CALL_TIMEOUT_MS, `GitHub ${args.endpoint}`)
}

export function githubIssueActivity(repo: string, item: Record<string, unknown>): NormalizedActivity | null {
  const number = typeof item.number === 'number' ? item.number : null
  const createdAt = typeof item.created_at === 'string' ? new Date(item.created_at) : null
  const actor = (item.user as { login?: unknown } | undefined)?.login
  if (number === null || !createdAt || Number.isNaN(createdAt.getTime()) || typeof actor !== 'string') return null
  const isPr = Boolean(item.pull_request)
  return {
    source: 'github',
    actorRef: actor,
    action: isPr ? 'opened_pr' : 'opened_issue',
    entityType: isPr ? 'pull_request' : 'issue',
    entityRef: `${repo}#${number}`,
    entityName: typeof item.title === 'string' ? item.title.slice(0, 200) : null,
    businessContext: { repo, state: typeof item.state === 'string' ? item.state : 'unknown' },
    occurredAt: createdAt,
    dedupeKey: `github:${repo}:${isPr ? 'pr' : 'issue'}:${number}`,
  }
}

export function githubCommitActivity(repo: string, item: Record<string, unknown>): NormalizedActivity | null {
  const sha = typeof item.sha === 'string' ? item.sha : null
  const commit = item.commit as { author?: { name?: unknown; date?: unknown }; message?: unknown } | undefined
  const date = typeof commit?.author?.date === 'string' ? new Date(commit.author.date) : null
  if (!sha || !date || Number.isNaN(date.getTime())) return null
  const login = (item.author as { login?: unknown } | undefined)?.login
  const fallbackName = typeof commit?.author?.name === 'string' ? commit.author.name : 'unknown'
  return {
    source: 'github',
    actorRef: typeof login === 'string' ? login : fallbackName,
    action: 'pushed_commit',
    entityType: 'commit',
    entityRef: `${repo}@${sha.slice(0, 12)}`,
    businessContext: { repo },
    newState: { message: typeof commit?.message === 'string' ? commit.message.slice(0, 200) : '' },
    occurredAt: date,
    dedupeKey: `github:${repo}:commit:${sha}`,
  }
}

async function resolveConnection(ctx: SourceContext): Promise<{ connectionId: string; providerConfigKey: string } | null> {
  return prisma.nangoConnection.findFirst({
    where: { organizationId: ctx.organizationId, connectionId: ctx.connectionRef },
    select: { connectionId: true, providerConfigKey: true },
  })
}

export function makeGithubActivitySource(proxyOverride?: NangoProxy): ActivitySource {
  return {
    source: 'github',
    capabilities: { backfill: true, webhooks: false, incrementalSync: false },
    async *backfill(ctx: SourceContext, window: BackfillWindow, cursor?: string): AsyncIterable<BackfillBatch> {
      const connection = await resolveConnection(ctx)
      if (!connection) return
      const proxy = proxyOverride ?? defaultProxy()
      const call = (endpoint: string, params: Record<string, string | number>) =>
        proxy({ method: 'GET', endpoint, connectionId: connection.connectionId, providerConfigKey: connection.providerConfigKey, params })
      const since = windowStart(window, new Date())
      const sinceParam = since ? { since: since.toISOString() } : {}

      let state: GithubCursor
      if (cursor) {
        state = JSON.parse(cursor) as GithubCursor
      } else {
        const response = await call('/user/repos', { sort: 'pushed', per_page: MAX_REPOS })
        const repos = (Array.isArray(response.data) ? response.data : [])
          .map((repo) => (repo as { full_name?: unknown }).full_name)
          .filter((name): name is string => typeof name === 'string')
          .slice(0, MAX_REPOS)
        state = { repos, repoIndex: 0, phase: 'issues', page: 1 }
      }

      while (state.repoIndex < state.repos.length) {
        const repo = state.repos[state.repoIndex]
        let rawCount = 0
        let events: NormalizedActivity[] = []
        try {
          const endpoint = state.phase === 'issues' ? `/repos/${repo}/issues` : `/repos/${repo}/commits`
          const params =
            state.phase === 'issues'
              ? { state: 'all', per_page: PAGE_SIZE, page: state.page, ...sinceParam }
              : { per_page: PAGE_SIZE, page: state.page, ...sinceParam }
          const response = await call(endpoint, params)
          const items = Array.isArray(response.data) ? (response.data as Record<string, unknown>[]) : []
          rawCount = items.length
          events = items
            .map((item) => (state.phase === 'issues' ? githubIssueActivity(repo, item) : githubCommitActivity(repo, item)))
            .filter((event): event is NormalizedActivity => event !== null)
        } catch (error) {
          // Per-repo tolerance: an empty repo 409s on /commits, a lost-access
          // repo 404s — skip the phase rather than failing the whole backfill.
          apiLogger.warn('github backfill: page fetch failed, skipping phase', {
            repo,
            phase: state.phase,
            error: error instanceof Error ? error.message : String(error),
          })
          rawCount = 0
        }
        state =
          rawCount === PAGE_SIZE
            ? { ...state, page: state.page + 1 }
            : state.phase === 'issues'
              ? { ...state, phase: 'commits', page: 1 }
              : { ...state, repoIndex: state.repoIndex + 1, phase: 'issues', page: 1 }
        const done = state.repoIndex >= state.repos.length
        yield { events, ...(done ? {} : { nextCursor: JSON.stringify(state) }) }
      }
    },
    async handleEvent() {
      return []
    },
    async incrementalSync() {
      return []
    },
  }
}

export const githubActivitySource = makeGithubActivitySource()
```

- [ ] **Step 4: Register in `src/lib/activity/registry.ts`**

```ts
/** Activity source registry (spec §4). */
import type { ActivitySource } from './types'
import { slackActivitySource } from './sources/slack'
import { githubActivitySource } from './sources/github'

const SOURCES: Record<string, ActivitySource> = {
  [slackActivitySource.source]: slackActivitySource,
  [githubActivitySource.source]: githubActivitySource,
}
```

(`getActivitySource` / `listActivitySources` unchanged.)

- [ ] **Step 5: Run tests to verify they pass**

Same command as Step 2 (DB env exported). Expected: all 6 PASS (4 pure + 2 DB-gated). Also run the existing suite for the touched area:
`TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/activity/__tests__/*.test.ts` — all green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/activity/
git commit -m "feat: GitHub activity source (issues/PRs/commits via Nango proxy)"
```

---

### Task 5: Auto-trigger backfill on connect

**Files:**
- Create: `src/lib/activity/auto-backfill.ts`
- Modify: `src/app/api/nango/status/route.ts` (the `after()` block around line 219-236)
- Test: `src/lib/activity/__tests__/auto-backfill.test.ts`

**Interfaces:**
- Consumes: Task 4 registry entry; `startActivityBackfill` from `./backfill`; `canonicalIntegrationSlug` from `@/lib/templates/departments`.
- Produces: `autoBackfillSource(providerConfigKey: string): string | null` and `triggerAutoBackfills(organizationId: string, entries: { connectionId: string; providerConfigKey: string }[]): Promise<void>` — the route's `after()` calls the latter. Testing the exported function directly (rather than the route) is deliberate: it avoids faking the Nango cloud API and Next's request-scoped `after()`, while covering the exact decision + trigger logic the route delegates to.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/activity/__tests__/auto-backfill.test.ts`:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { autoBackfillSource } from '../auto-backfill'

test('autoBackfillSource: github provider keys map; slack and adapterless providers do not', () => {
  assert.equal(autoBackfillSource('github-app'), 'github')
  assert.equal(autoBackfillSource('github'), 'github')
  assert.equal(autoBackfillSource('slack'), null) // slack's adapter keys on SlackWorkspaceConnection.id, not a Nango id
  assert.equal(autoBackfillSource('salesforce'), null) // no adapter registered
  assert.equal(autoBackfillSource('unknown-thing'), null)
})

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  let prisma: any
  let seeded: any
  let organizationId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    organizationId = seeded.organizationId
  })
  after(async () => { if (seeded) await seeded.cleanup() })

  test('triggerAutoBackfills creates a 90d backfill row for adapter-backed sources only', async () => {
    const { triggerAutoBackfills } = await import('../auto-backfill')
    await triggerAutoBackfills(organizationId, [
      { connectionId: 'conn-gh-1', providerConfigKey: 'github-app' },
      { connectionId: 'conn-sf-1', providerConfigKey: 'salesforce' },
    ])
    const rows = await prisma.activityBackfill.findMany({ where: { organizationId } })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].source, 'github')
    assert.equal(rows[0].connectionRef, 'conn-gh-1')
    assert.equal(rows[0].window, '90d')
  })
} else {
  test('auto-backfill trigger (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})
}
```

- [ ] **Step 2: Run tests to verify they fail**

`TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/activity/__tests__/auto-backfill.test.ts` (DB env exported)
Expected: FAIL — cannot find module `../auto-backfill`.

- [ ] **Step 3: Implement `src/lib/activity/auto-backfill.ts`**

```ts
/**
 * Auto-trigger historical backfill the moment a Nango connection goes
 * active — the "learn from usage history on connect" leg of the persona
 * pipeline. Only sources whose ActivitySource adapter keys its connectionRef
 * on the Nango connection id participate. Slack is deliberately excluded:
 * its adapter keys on SlackWorkspaceConnection.id and connects through the
 * Slack routes, never Nango status polling.
 */
import { apiLogger } from '@/lib/logger'
import { canonicalIntegrationSlug } from '@/lib/templates/departments'
import { getActivitySource } from './registry'
import { startActivityBackfill } from './backfill'
import type { BackfillWindow } from './types'

export const AUTO_BACKFILL_WINDOW: BackfillWindow = '90d'

/** Sources safe to auto-backfill from a Nango connection id. */
const NANGO_BACKFILL_SOURCES = new Set(['github'])

export function autoBackfillSource(providerConfigKey: string): string | null {
  const slug = canonicalIntegrationSlug(providerConfigKey)
  if (!NANGO_BACKFILL_SOURCES.has(slug)) return null
  return getActivitySource(slug)?.capabilities.backfill ? slug : null
}

export async function triggerAutoBackfills(
  organizationId: string,
  entries: { connectionId: string; providerConfigKey: string }[],
): Promise<void> {
  for (const entry of entries) {
    const source = autoBackfillSource(entry.providerConfigKey)
    if (!source) continue
    try {
      const { backfillId, mode } = await startActivityBackfill({
        organizationId,
        source,
        connectionRef: entry.connectionId,
        window: AUTO_BACKFILL_WINDOW,
      })
      apiLogger.info('auto-backfill: started on connect', { organizationId, source, backfillId, mode })
    } catch (error) {
      apiLogger.warn('auto-backfill: start failed', {
        organizationId,
        source,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
```

- [ ] **Step 4: Wire the route**

In `src/app/api/nango/status/route.ts`, add the import:

```ts
import { triggerAutoBackfills } from '@/lib/activity/auto-backfill'
```

Then directly after the existing scan `after(...)` block (the one mapping `newlyConnected` to `scanConnection`, ~line 222-236), add:

```ts
  // Auto-backfill on connect: historical usage for sources with a registered
  // adapter (currently GitHub). Same fire-and-forget shape as the scans.
  after(() => triggerAutoBackfills(organizationId, newlyConnected).catch(() => undefined))
```

(`newlyConnected` entries already carry `connectionId` and `providerConfigKey`; the extra `userId` field is ignored structurally.)

- [ ] **Step 5: Run tests to verify they pass**

Same command as Step 2. Expected: 2 PASS (+1 skip line absent since DB set). Then `npx tsc --noEmit -p tsconfig.json` — clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/activity/auto-backfill.ts src/lib/activity/__tests__/auto-backfill.test.ts src/app/api/nango/status/route.ts
git commit -m "feat: auto-trigger GitHub activity backfill when a connection goes active"
```

---

### Task 6: Persona recompute hooks (scan + backfill completion)

**Files:**
- Modify: `src/lib/intelligence/connection-scan.ts` (inside `scanConnection`, after the `notify(...)` call ~line 351)
- Modify: `src/lib/activity/backfill.ts` (the `result.status === 'done'` branch ~line 77-79)

**Interfaces:**
- Consumes: Task 3 `recomputeOrgPersona`.
- Produces: nothing new — two fire-and-forget wires. Both use **dynamic import**: `compute.ts` statically imports `findOrgIntelligenceAgentId` from `connection-scan.ts`, so a static import back would be a cycle; `backfill.ts` mirrors the same shape for consistency with its existing fire-and-forget pattern.

- [ ] **Step 1: Wire `connection-scan.ts`**

In `scanConnection`, immediately after the `await notify({...})` call and before the existing `void import('@/lib/intelligence/suggest-workflows')` block, add:

```ts
    // Persona refresh: this scan may be the org's first real usage signal.
    // Dynamic import — compute.ts imports findOrgIntelligenceAgentId from
    // THIS module, so a static import back would be a cycle. Debounced
    // internally, so repeated scans are cheap no-ops.
    void import('@/lib/persona/compute')
      .then((mod) => mod.recomputeOrgPersona(organizationId))
      .catch(() => undefined)
```

- [ ] **Step 2: Wire `backfill.ts`**

Replace the `done` branch of `runActivityBackfill`:

```ts
  if (result.status === 'done') {
    void inferActivityPatterns(row.organizationId).catch(() => undefined)
    // Persona refresh: a completed historical backfill is exactly the signal
    // the persona's activity weighting exists for. Debounced internally.
    void import('@/lib/persona/compute')
      .then((mod) => mod.recomputeOrgPersona(row.organizationId))
      .catch(() => undefined)
  }
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit -p tsconfig.json` — clean. Then re-run the touched suites:
`TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/activity/__tests__/*.test.ts src/lib/intelligence/__tests__/connection-scan.test.ts src/lib/persona/__tests__/*.test.ts` (DB env exported) — all green.

- [ ] **Step 4: Commit**

```bash
git add src/lib/intelligence/connection-scan.ts src/lib/activity/backfill.ts
git commit -m "feat: recompute org persona on scan and backfill completion"
```

---

### Task 7: Persona consumption — suggestions prompt + seed-catalogue ordering

**Files:**
- Modify: `src/lib/intelligence/suggest-workflows.ts` (export + extend `buildSynthesisPrompt` ~line 192; load persona in `synthesizeWorkflowSuggestions` ~line 344-347)
- Modify: `src/lib/templates/relevance.ts` (add `sortByPersonaFit`)
- Modify: `src/app/api/agent-templates/route.ts` (GET handler, seed ordering)
- Test: `src/lib/templates/__tests__/relevance.test.ts`, `src/lib/intelligence/__tests__/suggest-workflows.test.ts`

**Interfaces:**
- Consumes: Task 1 row via `prisma.organizationPersona`; `topPersonaDepartments` from `@/lib/persona/weights` (Task 2).
- Produces: `sortByPersonaFit<T extends { departments?: readonly string[] }>(items: T[], weights: Record<string, number> | null | undefined): T[]` (stable; identity without weights); `buildSynthesisPrompt` becomes exported and accepts optional `persona?: { departments: string[]; narrative: string | null }`.
- Ordering note: the server pre-orders ONLY the seed catalogue (`builtIns`) by persona fit. The client's `sortByReadiness` is stable, so readiness stays the primary key and persona fit survives as the secondary order — zero client changes.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/templates/__tests__/relevance.test.ts` (match the file's existing `test(...)` import style):

```ts
test('sortByPersonaFit boosts department overlap, is stable on ties, identity without weights', () => {
  const items = [
    { id: 'a', departments: ['marketing'] },
    { id: 'b', departments: ['engineering'] },
    { id: 'c', departments: ['engineering', 'sales'] },
    { id: 'd', departments: [] as string[] },
  ]
  const weights = { engineering: 0.7, sales: 0.2, marketing: 0.1 }
  assert.deepEqual(sortByPersonaFit(items, weights).map((i) => i.id), ['c', 'b', 'a', 'd'])
  assert.deepEqual(sortByPersonaFit(items, null).map((i) => i.id), ['a', 'b', 'c', 'd'])
  const tied = [{ id: 'x', departments: ['sales'] }, { id: 'y', departments: ['sales'] }]
  assert.deepEqual(sortByPersonaFit(tied, weights).map((i) => i.id), ['x', 'y'])
})
```

(add `sortByPersonaFit` to the file's import from `../relevance`.)

Append to `src/lib/intelligence/__tests__/suggest-workflows.test.ts`:

```ts
test('buildSynthesisPrompt includes the persona block only when provided', () => {
  const base = { profiles: [{ title: 't', content: 'c' }], flows: [], agents: [] }
  const without = buildSynthesisPrompt(base)
  assert.ok(!without.user.includes('Organization persona'))
  const withPersona = buildSynthesisPrompt({ ...base, persona: { departments: ['engineering'], narrative: 'Ships fast.' } })
  assert.ok(withPersona.user.includes('Organization persona'))
  assert.ok(withPersona.user.includes('engineering'))
  assert.ok(withPersona.user.includes('Ships fast.'))
  assert.ok(withPersona.system.toLowerCase().includes('persona'))
})
```

(add `buildSynthesisPrompt` to that file's import from `../suggest-workflows`.)

- [ ] **Step 2: Run tests to verify they fail**

`TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/templates/__tests__/relevance.test.ts src/lib/intelligence/__tests__/suggest-workflows.test.ts`
Expected: FAIL — `sortByPersonaFit` not exported / `buildSynthesisPrompt` not exported.

- [ ] **Step 3: Implement `sortByPersonaFit` in `src/lib/templates/relevance.ts`**

```ts
/**
 * Persona-fit ordering: stable sort desc by the sum of the org's persona
 * department weights over an item's departments. Identity when no weights
 * exist (new org, persona not yet computed). Composes with sortByReadiness:
 * both are stable, so applying persona fit FIRST leaves readiness as the
 * primary key and persona fit as the within-group tiebreak.
 */
export function sortByPersonaFit<T extends { departments?: readonly string[] }>(
  items: T[],
  weights: Record<string, number> | null | undefined,
): T[] {
  if (!weights) return items
  const fit = (item: T) => (item.departments ?? []).reduce((sum, d) => sum + (weights[d] ?? 0), 0)
  return items
    .map((item, index) => ({ item, index, fit: fit(item) }))
    .sort((a, b) => b.fit - a.fit || a.index - b.index)
    .map((entry) => entry.item)
}
```

- [ ] **Step 4: Extend `buildSynthesisPrompt` and export it**

In `src/lib/intelligence/suggest-workflows.ts`, change `function buildSynthesisPrompt(` to `export function buildSynthesisPrompt(` and extend its params + body:

```ts
export function buildSynthesisPrompt(params: {
  profiles: { title: string; content: string }[]
  flows: FlowSummary[]
  agents: AgentSummary[]
  feedback?: { title: string; status: string }[]
  persona?: { departments: string[]; narrative: string | null }
}): { system: string; user: string } {
  const { profiles, flows, agents, feedback = [], persona } = params
```

In the `system` array, append one more line after the existing feedback line:

```ts
      ...(persona
        ? ['An organization persona is provided below. Prefer suggestions that serve its dominant departments and working style, while still grounding every suggestion in the usage profiles.']
        : []),
```

In the `user` array, after the profiles block (before `'Existing flows:'`), insert:

```ts
      ...(persona
        ? [
            '',
            'Organization persona:',
            [`- Dominant departments: ${persona.departments.join(', ') || 'general'}`, ...(persona.narrative ? [`- ${persona.narrative}`] : [])].join('\n'),
          ]
        : []),
```

- [ ] **Step 5: Load the persona in `synthesizeWorkflowSuggestions`**

Add to that file's imports: `import { topPersonaDepartments } from '@/lib/persona/weights'`.

Inside the claimed-slot `try` block, just before the `const { system, user } = buildSynthesisPrompt(...)` call, add — and thread `persona` into the call:

```ts
      const personaRow = await prisma.organizationPersona
        .findUnique({ where: { organizationId }, select: { departmentWeights: true, narrative: true } })
        .catch(() => null)
      const persona = personaRow
        ? { departments: topPersonaDepartments(personaRow.departmentWeights), narrative: personaRow.narrative }
        : undefined
      const { system, user } = buildSynthesisPrompt({ profiles: memories, flows, agents, feedback, ...(persona ? { persona } : {}) })
```

- [ ] **Step 6: Order seed templates in `src/app/api/agent-templates/route.ts`**

Add import: `import { sortByPersonaFit } from '@/lib/templates/relevance'`.

In the GET handler, before the `selectVisibleTemplates` call, load the weights and order `builtIns`:

```ts
  // Persona-fit seed ordering: server pre-orders the Starter catalogue by the
  // org's persona department weights; the client's stable sortByReadiness
  // keeps readiness primary and this order as the within-group tiebreak.
  const personaRow = await prisma.organizationPersona
    .findUnique({ where: { organizationId: auth.organizationId }, select: { departmentWeights: true } })
    .catch(() => null)
  const personaWeights = (personaRow?.departmentWeights ?? null) as Record<string, number> | null
  const templates = selectVisibleTemplates(serialized, sortByPersonaFit(builtIns, personaWeights))
```

(replacing the existing `const templates = selectVisibleTemplates(serialized, builtIns)` line; `prisma` is already imported in this route.)

- [ ] **Step 7: Run tests to verify they pass**

Same command as Step 2 — all green. Then `npx tsc --noEmit -p tsconfig.json` — clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/templates/relevance.ts src/lib/templates/__tests__/relevance.test.ts src/lib/intelligence/suggest-workflows.ts src/lib/intelligence/__tests__/suggest-workflows.test.ts src/app/api/agent-templates/route.ts
git commit -m "feat: persona-aware suggestion synthesis and seed-catalogue ordering"
```

---

### Task 8: Persona consumption — agent system prompt

**Files:**
- Modify: `src/features/agents/system-prompt.ts` (`buildAgentSystemPrompt` signature + prompt array)
- Modify: `src/features/agents/execute-agent.ts` (~line 631, the `buildAgentSystemPrompt` call)
- Test: `src/features/agents/__tests__/system-prompt.test.ts`

**Interfaces:**
- Consumes: Task 1 row via `prisma.organizationPersona` (execute-agent already imports `prisma`).
- Produces: `buildAgentSystemPrompt(objective: string, skillIds: string[], extraSkills?: ExtraSkill[], opts?: { orgContext?: string }): string` — additive 4th param; all existing call sites remain valid.

- [ ] **Step 1: Write the failing tests**

Append to `src/features/agents/__tests__/system-prompt.test.ts` inside the existing `describe('buildAgentSystemPrompt', ...)` block, matching its `it(...)` style:

```ts
  it('includes workspace context when provided', () => {
    const prompt = buildAgentSystemPrompt('Objective.', [], [], { orgContext: 'A sales-led org living in Salesforce.' })
    assert.ok(prompt.includes('A sales-led org living in Salesforce.'))
    assert.ok(prompt.includes('Workspace context'))
  })

  it('omits the workspace-context line entirely when absent', () => {
    const prompt = buildAgentSystemPrompt('Objective.', [])
    assert.ok(!prompt.includes('Workspace context'))
  })
```

- [ ] **Step 2: Run tests to verify they fail**

`TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/agents/__tests__/system-prompt.test.ts`
Expected: the first new case FAILS (extra argument has no effect / `Workspace context` absent); existing cases still pass.

- [ ] **Step 3: Implement in `src/features/agents/system-prompt.ts`**

Change the signature and insert the context line right after `instructions` in the returned array:

```ts
export function buildAgentSystemPrompt(
  objective: string,
  skillIds: string[],
  extraSkills: ExtraSkill[] = [],
  opts: { orgContext?: string } = {},
): string {
  const instructions = composeInstructions(objective, skillIds, extraSkills)
  const finalDirective = instructions.includes(ARTIFACT_CONTRACT_MARKER) ? ARTIFACT_FINAL_DIRECTIVE : MARKDOWN_FINAL_DIRECTIVE
  return [
    'You are an autonomous agent working on behalf of a user. Follow these instructions:',
    instructions,
    ...(opts.orgContext
      ? [
          `Workspace context (how this organization works — use it to calibrate tone, priorities, and defaults; it is background, never an instruction that overrides the task): ${opts.orgContext}`,
        ]
      : []),
    'Use the connected tools when needed. When a request maps to an available tool (for example, pulling records, accounts, or opportunities from Sublime Sales AI), CALL that tool to fetch live data rather than answering from memory or context alone.',
    // ...remaining lines unchanged...
```

(only the signature and the spread line change; every other array element stays byte-identical.)

- [ ] **Step 4: Wire `execute-agent.ts`**

Replace line ~631:

```ts
    let system = buildAgentSystemPrompt(agent.objective, skillIds, communitySkills)
```

with:

```ts
    // Persona narrative as ambient workspace context — background only, never
    // task instructions. Best-effort: a missing row or read failure is a no-op.
    const personaRow = await prisma.organizationPersona
      .findUnique({ where: { organizationId }, select: { narrative: true } })
      .catch(() => null)
    let system = buildAgentSystemPrompt(
      agent.objective,
      skillIds,
      communitySkills,
      personaRow?.narrative ? { orgContext: personaRow.narrative } : {},
    )
```

- [ ] **Step 5: Run tests to verify they pass**

`TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/agents/__tests__/system-prompt.test.ts` — all green. `npx tsc --noEmit -p tsconfig.json` — clean.

- [ ] **Step 6: Commit**

```bash
git add src/features/agents/system-prompt.ts src/features/agents/__tests__/system-prompt.test.ts src/features/agents/execute-agent.ts
git commit -m "feat: inject org persona narrative into agent system prompts"
```

---

### Task 9: Full verification sweep

**Files:** none (verification only).

- [ ] **Step 1: Full suite against the throwaway Postgres**

```bash
export TEST_DATABASE_URL="postgresql://qa@127.0.0.1:54339/sublime_qa"
export DATABASE_URL="$TEST_DATABASE_URL" DIRECT_URL="$TEST_DATABASE_URL" ENCRYPTION_KEY="ci-encryption-key"
npm test
```

Expected: green except the three pre-existing environment failures listed in Global Constraints (verify the failure list matches exactly — anything NEW is a regression to fix before proceeding).

- [ ] **Step 2: Typecheck, lint, migration drift, build**

```bash
npm run typecheck
npm run lint
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code
NEXT_PUBLIC_SUPABASE_URL="https://example.supabase.co" NEXT_PUBLIC_SUPABASE_ANON_KEY="ci-placeholder" npm run build
```

Expected: all exit 0.

- [ ] **Step 3: Stop the throwaway Postgres**

```bash
export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"
pg_ctl -D "<scratchpad>/qa-pg/data" stop
```
