# Integration Learnings Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 1 of the integration-learnings spec (`docs/superpowers/specs/2026-07-12-integration-learnings-design.md`): a multi-source activity ledger + graph projection, the `ActivitySource` contract with a Slack adapter (live + backfill), an evidence-linked inference job, and an `activity` flow trigger.

**Architecture:** Per-source adapters normalize provider events into `NormalizedActivity`; a Postgres `ActivityEvent` ledger (deduped per org) is the durable record; each event projects into the existing Graph-RAG store as `(actor)-[:performed]->(activity)-[:on]->(entity)` nodes/edges; an LLM inference job writes `insight` nodes that are rejected unless they carry `evidence` edges to real activity nodes; live events also match `activity`-triggered flows with DB-unique idempotency.

**Tech Stack:** Next.js 15 route handlers, Prisma/Postgres, existing Graph-RAG (`src/lib/rag/`), BullMQ (queue mode) with `after()` inline fallback, `node:test` via tsx.

## Global Constraints

- Test runner: `npm test` runs ALL `src/**/__tests__/*.test.ts` via `tsx --test`. Single file: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <path>`. Tests use `import { test } from 'node:test'` + `import assert from 'node:assert/strict'`.
- All graph work is best-effort: gated on `ragEnabled()`, wrapped in try/catch, failures logged via `apiLogger.warn`, never thrown to callers (mirrors `src/lib/rag/indexer.ts`).
- Dedup/idempotency is always a DB unique constraint caught as Prisma `P2002` — never check-then-set (mirrors `Signal.dedupeKey`, `SlackProcessedEvent`).
- Dedupe keys are unique PER ORG, never global (cross-tenant collision rule from `Signal`).
- Backfilled events NEVER fire flow triggers (`ingestKind === 'backfill'` excluded) — spec §9.
- Inference insights REQUIRE ≥1 evidence edge or the write is rejected — spec §8.
- New Prisma models need back-relations on `Organization` (schema convention) and a migration under `prisma/migrations/`.
- Node id scheme: extend `nodeIds` in `src/lib/rag/indexer.ts`; ids must be stable so re-index upserts in place.
- Commit style: conventional commits (`feat(activity): …`), no Claude attribution beyond the standard trailer.

---

### Task 1: Prisma models — ActivityEvent, ActivityBackfill, ActivityTriggerClaim

**Files:**
- Modify: `prisma/schema.prisma` (append models after `SlackProcessedEvent`, ~line 815; add back-relations inside `model Organization`)
- Migration: `npx prisma migrate dev --name activity_learnings`

**Interfaces:**
- Produces: Prisma models `ActivityEvent`, `ActivityBackfill`, `ActivityTriggerClaim` with the exact fields below. Later tasks use `prisma.activityEvent.create`, `prisma.activityBackfill.update`, `prisma.activityTriggerClaim.create`.

- [ ] **Step 1: Add the models to `prisma/schema.prisma`**

```prisma
/// One normalized business activity from any connected tool. Immutable once
/// written; the durable record beneath the graph projection (Neo4j retention
/// prunes nodes — this ledger is what makes the graph rebuildable).
model ActivityEvent {
  id             String    @id @default(cuid())
  organizationId String    @db.Uuid
  source         String // 'slack' | 'salesforce' | 'github' | ...
  actorRef       String // provider user id
  actorName      String?
  action         String // normalized verb: 'posted_message', 'changed_stage', ...
  entityType     String // 'message' | 'opportunity' | 'pull_request' | ...
  entityRef      String // provider entity id
  entityName     String?
  previousState  Json?
  newState       Json?
  participants   Json      @default("[]") // array of actor refs
  businessContext Json     @default("{}") // related account/opp/channel/repo refs
  outcome        String?
  occurredAt     DateTime // provider timestamp
  ingestedAt     DateTime  @default(now())
  ingestKind     String // 'backfill' | 'webhook' | 'sync'
  // Replay guard, unique PER ORG (a provider id from one tenant must never
  // dedupe-drop another tenant's event) — same rule as Signal.dedupeKey.
  dedupeKey      String
  indexedAt      DateTime? // null until graph indexing succeeds; re-index sweeps nulls

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@unique([organizationId, dedupeKey])
  @@index([organizationId, occurredAt])
  @@index([organizationId, source, action])
  @@index([organizationId, indexedAt])
  @@map("activity_events")
}

/// One historical backfill run for a connected source. Cursor-checkpointed so
/// a crashed/redeployed job resumes instead of re-reading completed pages.
model ActivityBackfill {
  id             String    @id @default(cuid())
  organizationId String    @db.Uuid
  source         String
  connectionRef  String // e.g. SlackWorkspaceConnection.id
  window         String // '90d' | '1y' | 'all'
  status         String    @default("pending") // pending | running | partial | done | failed
  cursor         String?
  eventsIngested Int       @default(0)
  error          String?
  startedAt      DateTime?
  completedAt    DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@unique([organizationId, source, connectionRef])
  @@map("activity_backfills")
}

/// Atomic idempotency ledger for activity→flow dispatch: one row per
/// (event, flow) claimed. The unique constraint IS the mechanism — a racing
/// duplicate hits P2002 and loses (same pattern as SlackProcessedEvent).
model ActivityTriggerClaim {
  id        String   @id @default(cuid())
  eventId   String
  flowId    String
  createdAt DateTime @default(now())

  @@unique([eventId, flowId])
  @@index([createdAt])
  @@map("activity_trigger_claims")
}
```

- [ ] **Step 2: Add back-relations inside `model Organization`** (next to the existing `signals Signal[]` at schema line ~50):

```prisma
  activityEvents    ActivityEvent[]
  activityBackfills ActivityBackfill[]
```

- [ ] **Step 3: Generate the migration and client**

Run: `cd /Users/jamesmcdaniel/Den_clone && npx prisma migrate dev --name activity_learnings`
Expected: new folder `prisma/migrations/<ts>_activity_learnings/` and `prisma generate` success. (If no local DB is reachable, use `npx prisma migrate diff --from-schema-datasource --to-schema-datamodel prisma/schema.prisma --script` to author SQL manually into the migration folder, then `npx prisma generate`.)

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no new errors)

- [ ] **Step 5: Commit**

```bash
git add prisma
git commit -m "feat(activity): ActivityEvent ledger, ActivityBackfill, ActivityTriggerClaim models"
```

---

### Task 2: Activity types + ledger writer

**Files:**
- Create: `src/lib/activity/types.ts`
- Create: `src/lib/activity/ledger.ts`
- Test: `src/lib/activity/__tests__/ledger.test.ts`

**Interfaces:**
- Produces:
  - `NormalizedActivity` (all ledger fields minus id/org/ingest bookkeeping; `dedupeKey` required)
  - `BackfillWindow = '90d' | '1y' | 'all'`, `windowStart(window: BackfillWindow, now: Date): Date | null` (null = all)
  - `ActivitySource` interface (adapter contract)
  - `persistActivity(organizationId: string, ingestKind: 'backfill'|'webhook'|'sync', events: NormalizedActivity[]): Promise<{ created: PersistedActivity[]; duplicates: number }>` where `PersistedActivity` is the created row (`id`, `organizationId`, plus every NormalizedActivity field and `ingestKind`).

- [ ] **Step 1: Write `src/lib/activity/types.ts`**

```ts
/**
 * Source-agnostic activity contract (spec §4–5). Every connected tool that
 * participates in integration learnings implements ActivitySource; every
 * event — historical or live — normalizes to NormalizedActivity before it
 * touches the ledger, the graph, or flow triggers.
 */

export type IngestKind = 'backfill' | 'webhook' | 'sync'
export type BackfillWindow = '90d' | '1y' | 'all'

export interface NormalizedActivity {
  source: string
  actorRef: string
  actorName?: string | null
  action: string
  entityType: string
  entityRef: string
  entityName?: string | null
  previousState?: unknown
  newState?: unknown
  participants?: string[]
  businessContext?: Record<string, unknown>
  outcome?: string | null
  occurredAt: Date
  /** Provider event id or stable content hash. Unique per org. */
  dedupeKey: string
}

/** Inclusive start of a backfill window; null = all available history. */
export function windowStart(window: BackfillWindow, now: Date): Date | null {
  if (window === 'all') return null
  const days = window === '90d' ? 90 : 365
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
}

/** Credential handle passed to adapters — adapters never hold raw tokens
 * beyond the call. connectionRef identifies the integration-plane row. */
export interface SourceContext {
  organizationId: string
  connectionRef: string
}

export interface BackfillBatch {
  events: NormalizedActivity[]
  /** Absent/undefined = backfill complete. */
  nextCursor?: string
}

export interface ActivitySource {
  source: string
  capabilities: { backfill: boolean; webhooks: boolean; incrementalSync: boolean }
  backfill(ctx: SourceContext, window: BackfillWindow, cursor?: string): AsyncIterable<BackfillBatch>
  /** Translate one already-verified provider payload into 0..n events. */
  handleEvent(ctx: SourceContext, payload: unknown): Promise<NormalizedActivity[]>
  incrementalSync(ctx: SourceContext, since: Date): Promise<NormalizedActivity[]>
}
```

- [ ] **Step 2: Write the failing test `src/lib/activity/__tests__/ledger.test.ts`**

`persistActivity` takes an injectable prisma-like client so the test needs no DB (same seam style as `postSlackMessage`'s `fetchImpl`).

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { persistActivity, type ActivityDb } from '@/lib/activity/ledger'
import type { NormalizedActivity } from '@/lib/activity/types'

const event = (over: Partial<NormalizedActivity> = {}): NormalizedActivity => ({
  source: 'slack', actorRef: 'U1', action: 'posted_message',
  entityType: 'message', entityRef: 'C1:111.222',
  occurredAt: new Date('2026-07-10T00:00:00Z'), dedupeKey: 'ev1', ...over,
})

class P2002 extends Error { code = 'P2002' }

function stubDb(created: unknown[], opts: { duplicateKeys?: string[] } = {}): ActivityDb {
  return {
    activityEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (opts.duplicateKeys?.includes(data.dedupeKey as string)) throw new P2002('dup')
        const row = { id: `id-${created.length}`, ...data }
        created.push(row)
        return row
      },
    },
  } as unknown as ActivityDb
}

test('persists normalized events with org + ingestKind', async () => {
  const created: Array<Record<string, unknown>> = []
  const result = await persistActivity('org-1', 'webhook', [event()], stubDb(created))
  assert.equal(result.created.length, 1)
  assert.equal(result.duplicates, 0)
  assert.equal(created[0].organizationId, 'org-1')
  assert.equal(created[0].ingestKind, 'webhook')
  assert.equal(created[0].dedupeKey, 'ev1')
})

test('P2002 on dedupeKey counts as duplicate, never throws, others still persist', async () => {
  const created: unknown[] = []
  const result = await persistActivity(
    'org-1', 'backfill',
    [event({ dedupeKey: 'dup' }), event({ dedupeKey: 'fresh' })],
    stubDb(created, { duplicateKeys: ['dup'] }),
  )
  assert.equal(result.created.length, 1)
  assert.equal(result.duplicates, 1)
})

test('non-P2002 errors propagate', async () => {
  const bad = {
    activityEvent: { create: async () => { throw new Error('connection lost') } },
  } as unknown as ActivityDb
  await assert.rejects(() => persistActivity('org-1', 'sync', [event()], bad), /connection lost/)
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/activity/__tests__/ledger.test.ts`
Expected: FAIL — cannot find module `@/lib/activity/ledger`

- [ ] **Step 4: Write `src/lib/activity/ledger.ts`**

```ts
/**
 * Durable activity ledger writes. Dedup is the DB unique constraint
 * (organizationId, dedupeKey) caught as P2002 — a replayed webhook or an
 * overlapping backfill page cannot double-write (same mechanism as Signal).
 */
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { IngestKind, NormalizedActivity } from './types'

/** Injectable seam for tests; production callers omit it. */
export type ActivityDb = Pick<typeof prisma, 'activityEvent'>

export interface PersistedActivity extends NormalizedActivity {
  id: string
  organizationId: string
  ingestKind: IngestKind
}

function isUniqueViolation(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') ||
    (error instanceof Error && (error as { code?: string }).code === 'P2002')
  )
}

export async function persistActivity(
  organizationId: string,
  ingestKind: IngestKind,
  events: NormalizedActivity[],
  db: ActivityDb = prisma,
): Promise<{ created: PersistedActivity[]; duplicates: number }> {
  const created: PersistedActivity[] = []
  let duplicates = 0
  for (const event of events) {
    try {
      const row = await db.activityEvent.create({
        data: {
          organizationId,
          ingestKind,
          source: event.source,
          actorRef: event.actorRef,
          actorName: event.actorName ?? null,
          action: event.action,
          entityType: event.entityType,
          entityRef: event.entityRef,
          entityName: event.entityName ?? null,
          previousState: (event.previousState ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          newState: (event.newState ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          participants: (event.participants ?? []) as Prisma.InputJsonValue,
          businessContext: (event.businessContext ?? {}) as Prisma.InputJsonValue,
          outcome: event.outcome ?? null,
          occurredAt: event.occurredAt,
          dedupeKey: event.dedupeKey,
        },
      })
      created.push({ ...event, id: row.id, organizationId, ingestKind })
    } catch (error) {
      if (isUniqueViolation(error)) { duplicates++; continue }
      throw error
    }
  }
  return { created, duplicates }
}
```

(Note: `previousState`/`newState` are nullable columns — passing `Prisma.JsonNull` writes SQL NULL; if tsc complains about `JsonNull` in `InputJsonValue` position, type the two fields as `Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue` via a small local cast, matching how the codebase handles nullable Json elsewhere.)

- [ ] **Step 5: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/activity/__tests__/ledger.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/lib/activity
git commit -m "feat(activity): ActivitySource contract, NormalizedActivity, deduped ledger writer"
```

---

### Task 3: Graph projection — node/edge types + indexActivity

**Files:**
- Modify: `src/lib/rag/store.ts:15-22` (NodeType union), `src/lib/rag/store.ts:61-67` (EdgeRelation union)
- Modify: `src/lib/rag/indexer.ts:25-32` (nodeIds)
- Create: `src/lib/activity/index-activity.ts`
- Test: `src/lib/activity/__tests__/index-activity.test.ts`

**Interfaces:**
- Consumes: `PersistedActivity` (Task 2), `commitGraph(organizationId, nodes: PendingNode[], edges: GraphEdge[])` from `src/lib/rag/indexer.ts`.
- Produces:
  - New `NodeType` members: `'actor' | 'activity' | 'entity'`; new `EdgeRelation` members: `'performed' | 'on' | 'relates_to' | 'participant' | 'preceded_by' | 'evidence' | 'based_on'`.
  - `nodeIds.activity(id)`, `nodeIds.actor(source, ref)`, `nodeIds.entity(source, type, ref)`.
  - `activityGraphParts(event: PersistedActivity, previousEventId?: string | null): { nodes: PendingNode[]; edges: GraphEdge[] }` (pure — this is what tests assert on).
  - `indexActivity(events: PersistedActivity[]): Promise<void>` — best-effort, marks `indexedAt` on success.

- [ ] **Step 1: Extend the unions in `src/lib/rag/store.ts`**

```ts
export type NodeType =
  | 'account'
  | 'opportunity'
  | 'stakeholder'
  | 'signal'
  | 'agent'
  | 'run'
  | 'insight'
  | 'actor'
  | 'activity'
  | 'entity'
```

```ts
export type EdgeRelation =
  | 'about_account'
  | 'about_opportunity'
  | 'about_stakeholder'
  | 'triggered_run'
  | 'ran_agent'
  | 'belongs_to' // opportunity/stakeholder → account
  | 'performed' // actor → activity
  | 'on' // activity → entity
  | 'relates_to' // activity → account/opportunity
  | 'participant' // activity → actor
  | 'preceded_by' // activity → prior activity on same entity (state chains)
  | 'evidence' // insight(inferred_pattern) → activity
  | 'based_on' // insight(recommendation) → insight(inferred_pattern)
```

- [ ] **Step 2: Extend `nodeIds` in `src/lib/rag/indexer.ts:25-32`**

```ts
export const nodeIds = {
  account: (id: string) => `account:${id}`,
  opportunity: (id: string) => `opp:${id}`,
  stakeholder: (id: string) => `stakeholder:${id}`,
  signal: (id: string) => `signal:${id}`,
  run: (id: string) => `run:${id}`,
  agent: (id: string) => `agent:${id}`,
  activity: (id: string) => `activity:${id}`,
  actor: (source: string, ref: string) => `actor:${source}:${ref}`,
  entity: (source: string, type: string, ref: string) => `entity:${source}:${type}:${ref}`,
}
```

- [ ] **Step 3: Write the failing test `src/lib/activity/__tests__/index-activity.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityGraphParts } from '@/lib/activity/index-activity'
import type { PersistedActivity } from '@/lib/activity/ledger'

const event: PersistedActivity = {
  id: 'ev-1', organizationId: 'org-1', ingestKind: 'webhook',
  source: 'slack', actorRef: 'U1', actorName: 'Sarah', action: 'posted_message',
  entityType: 'message', entityRef: 'C9:111.222', entityName: '#deals',
  participants: ['U2'], businessContext: { accountId: 'acme' },
  occurredAt: new Date('2026-07-10T00:00:00Z'), dedupeKey: 'k1',
}

test('projects actor→activity→entity with stable ids', () => {
  const { nodes, edges } = activityGraphParts(event)
  const ids = nodes.map((n) => n.id)
  assert.ok(ids.includes('activity:ev-1'))
  assert.ok(ids.includes('actor:slack:U1'))
  assert.ok(ids.includes('entity:slack:message:C9:111.222'))
  assert.deepEqual(
    edges.map((e) => `${e.from}-${e.rel}->${e.to}`).sort(),
    [
      'activity:ev-1-on->entity:slack:message:C9:111.222',
      'activity:ev-1-participant->actor:slack:U2',
      'activity:ev-1-relates_to->account:acme',
      'actor:slack:U1-performed->activity:ev-1',
    ].sort(),
  )
})

test('activity node text names actor, action, entity, source', () => {
  const { nodes } = activityGraphParts(event)
  const activity = nodes.find((n) => n.id === 'activity:ev-1')!
  assert.equal(activity.type, 'activity')
  for (const needle of ['Sarah', 'posted_message', '#deals', 'slack']) {
    assert.ok(activity.text.includes(needle), `text missing ${needle}`)
  }
})

test('preceded_by edge links state-history chains', () => {
  const { edges } = activityGraphParts(event, 'ev-0')
  assert.ok(edges.some((e) => e.from === 'activity:ev-1' && e.rel === 'preceded_by' && e.to === 'activity:ev-0'))
})

test('no relates_to edge when businessContext has no accountId', () => {
  const { edges } = activityGraphParts({ ...event, businessContext: {} })
  assert.ok(!edges.some((e) => e.rel === 'relates_to'))
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/activity/__tests__/index-activity.test.ts`
Expected: FAIL — cannot find module `@/lib/activity/index-activity`

- [ ] **Step 5: Write `src/lib/activity/index-activity.ts`**

```ts
/**
 * Graph projection for activity events (spec §5):
 *   (actor)-[:performed]->(activity)-[:on]->(entity)
 * plus participant, relates_to (account/opportunity anchors), and
 * preceded_by (state-history chains on the same entity).
 *
 * activityGraphParts is pure (unit-testable without a store); indexActivity
 * is the best-effort side-effecting wrapper, mirroring indexSignal.
 */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { commitGraph, nodeIds, type PendingNode } from '@/lib/rag/indexer'
import { ragEnabled } from '@/lib/rag/get-store'
import type { GraphEdge } from '@/lib/rag/store'
import type { PersistedActivity } from './ledger'

const nid = nodeIds

function stateSummary(event: PersistedActivity): string {
  if (event.previousState == null && event.newState == null) return ''
  const fmt = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? null))
  return ` Changed from ${fmt(event.previousState)} to ${fmt(event.newState)}.`
}

export function activityGraphParts(
  event: PersistedActivity,
  previousEventId?: string | null,
): { nodes: PendingNode[]; edges: GraphEdge[] } {
  const org = event.organizationId
  const activityId = nid.activity(event.id)
  const actorId = nid.actor(event.source, event.actorRef)
  const entityId = nid.entity(event.source, event.entityType, event.entityRef)
  const actorLabel = event.actorName ?? event.actorRef
  const entityLabel = event.entityName ?? event.entityRef

  const nodes: PendingNode[] = [
    {
      id: activityId, type: 'activity',
      text: `${actorLabel} ${event.action} ${event.entityType} ${entityLabel} in ${event.source}.${stateSummary(event)}${event.outcome ? ` Outcome: ${event.outcome}.` : ''}`,
      props: {
        source: event.source, action: event.action, entityType: event.entityType,
        entityRef: event.entityRef, occurredAt: event.occurredAt.toISOString(),
        ingestKind: event.ingestKind, eventId: event.id,
      },
    },
    { id: actorId, type: 'actor', text: `${actorLabel} (${event.source} user ${event.actorRef})`, props: { source: event.source, actorRef: event.actorRef } },
    { id: entityId, type: 'entity', text: `${event.entityType} ${entityLabel} (${event.source})`, props: { source: event.source, entityType: event.entityType, entityRef: event.entityRef } },
  ]

  const edges: GraphEdge[] = [
    { organizationId: org, from: actorId, to: activityId, rel: 'performed' },
    { organizationId: org, from: activityId, to: entityId, rel: 'on' },
  ]
  for (const participant of event.participants ?? []) {
    if (participant === event.actorRef) continue
    const pid = nid.actor(event.source, participant)
    if (!nodes.some((n) => n.id === pid)) {
      nodes.push({ id: pid, type: 'actor', text: `${participant} (${event.source} user ${participant})`, props: { source: event.source, actorRef: participant } })
    }
    edges.push({ organizationId: org, from: activityId, to: pid, rel: 'participant' })
  }
  const context = (event.businessContext ?? {}) as { accountId?: unknown; opportunityId?: unknown }
  if (typeof context.accountId === 'string' && context.accountId) {
    edges.push({ organizationId: org, from: activityId, to: nid.account(context.accountId), rel: 'relates_to' })
  }
  if (typeof context.opportunityId === 'string' && context.opportunityId) {
    edges.push({ organizationId: org, from: activityId, to: nid.opportunity(context.opportunityId), rel: 'relates_to' })
  }
  if (previousEventId) {
    edges.push({ organizationId: org, from: activityId, to: nid.activity(previousEventId), rel: 'preceded_by' })
  }
  return { nodes, edges }
}

/** Index persisted events into the graph, best-effort; stamps indexedAt on
 * success so the re-index sweep (indexedAt IS NULL) skips them. */
export async function indexActivity(events: PersistedActivity[]): Promise<void> {
  if (!ragEnabled() || events.length === 0) return
  for (const event of events) {
    try {
      // preceded_by: latest prior event on the same entity (state chain).
      const prior = await prisma.activityEvent.findFirst({
        where: {
          organizationId: event.organizationId, source: event.source,
          entityType: event.entityType, entityRef: event.entityRef,
          occurredAt: { lt: event.occurredAt }, NOT: { id: event.id },
        },
        orderBy: { occurredAt: 'desc' },
        select: { id: true },
      })
      const { nodes, edges } = activityGraphParts(event, prior?.id ?? null)
      await commitGraph(event.organizationId, nodes, edges)
      await prisma.activityEvent.update({
        where: { id: event.id, organizationId: event.organizationId },
        data: { indexedAt: new Date() },
      })
    } catch (error) {
      apiLogger.warn('rag.indexActivity failed', { eventId: event.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/activity/__tests__/index-activity.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 7: Run the full suite + typecheck (union changes touch the stores)**

Run: `npm test` then `npx tsc --noEmit`
Expected: PASS — MemoryGraphStore/Neo4jGraphStore are type-generic over NodeType/EdgeRelation strings; fix any exhaustive-switch errors surfaced by tsc.

- [ ] **Step 8: Commit**

```bash
git add src/lib/rag/store.ts src/lib/rag/indexer.ts src/lib/activity
git commit -m "feat(activity): graph projection — actor/activity/entity nodes, performed/on/relates_to/preceded_by edges"
```

---

### Task 4: Evidence-edge invariant — writeInference

**Files:**
- Create: `src/lib/activity/insights.ts`
- Test: `src/lib/activity/__tests__/insights.test.ts`

**Interfaces:**
- Consumes: `commitGraph`, `nodeIds` (indexer), `GraphEdge`.
- Produces:
  - `InferenceWrite = { organizationId: string; kind: 'inferred_pattern' | 'recommendation'; slug: string; text: string; evidenceEventIds: string[]; basedOnInsightIds?: string[] }`
  - `inferenceGraphParts(w: InferenceWrite): { nodes: PendingNode[]; edges: GraphEdge[] }` — **throws** `Error('inference rejected: no evidence')` when the invariant fails (pattern with zero evidence ids; recommendation with zero basedOn ids).
  - `writeInference(w: InferenceWrite): Promise<boolean>` — commits via `commitGraph`, returns false (logged) instead of throwing on store errors, but the invariant throw propagates (callers must supply evidence).
  - Insight node id scheme: `insight:activity:<kind>:<slug>` (stable → re-running inference upserts in place).

- [ ] **Step 1: Write the failing test `src/lib/activity/__tests__/insights.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inferenceGraphParts } from '@/lib/activity/insights'

test('inferred_pattern carries one evidence edge per cited event', () => {
  const { nodes, edges } = inferenceGraphParts({
    organizationId: 'org-1', kind: 'inferred_pattern', slug: 'legal-review-bottleneck',
    text: 'Legal review appears to be a recurring bottleneck.',
    evidenceEventIds: ['ev-1', 'ev-2', 'ev-3'],
  })
  assert.equal(nodes[0].id, 'insight:activity:inferred_pattern:legal-review-bottleneck')
  assert.equal(nodes[0].props.insightKind, 'inferred_pattern')
  const evidence = edges.filter((e) => e.rel === 'evidence')
  assert.deepEqual(evidence.map((e) => e.to).sort(), ['activity:ev-1', 'activity:ev-2', 'activity:ev-3'])
})

test('REJECTS a pattern with zero evidence — the spec §8 invariant', () => {
  assert.throws(
    () => inferenceGraphParts({ organizationId: 'org-1', kind: 'inferred_pattern', slug: 'x', text: 'vibes', evidenceEventIds: [] }),
    /inference rejected: no evidence/,
  )
})

test('recommendation cites patterns via based_on, not raw facts', () => {
  const { edges } = inferenceGraphParts({
    organizationId: 'org-1', kind: 'recommendation', slug: 'legal-readiness-check',
    text: 'Add a legal-readiness check before proposal stage.',
    evidenceEventIds: [],
    basedOnInsightIds: ['insight:activity:inferred_pattern:legal-review-bottleneck'],
  })
  assert.equal(edges.length, 1)
  assert.equal(edges[0].rel, 'based_on')
  assert.equal(edges[0].to, 'insight:activity:inferred_pattern:legal-review-bottleneck')
})

test('REJECTS a recommendation with no based_on patterns', () => {
  assert.throws(
    () => inferenceGraphParts({ organizationId: 'org-1', kind: 'recommendation', slug: 'x', text: 'do stuff', evidenceEventIds: [] }),
    /inference rejected: no evidence/,
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/activity/__tests__/insights.test.ts`
Expected: FAIL — cannot find module `@/lib/activity/insights`

- [ ] **Step 3: Write `src/lib/activity/insights.ts`**

```ts
/**
 * The trust layer (spec §8). Facts are activity nodes; inferences are insight
 * nodes that MUST cite their facts:
 *   inferred_pattern  -[:evidence]->  activity   (>=1 required)
 *   recommendation    -[:based_on]->  inferred_pattern (>=1 required)
 * The invariant is enforced HERE, structurally, not by prompt convention —
 * an inference without provenance is rejected before it can reach the graph.
 */
import { apiLogger } from '@/lib/logger'
import { commitGraph, nodeIds, type PendingNode } from '@/lib/rag/indexer'
import type { GraphEdge } from '@/lib/rag/store'

export interface InferenceWrite {
  organizationId: string
  kind: 'inferred_pattern' | 'recommendation'
  /** Stable slug — re-running inference upserts the same node in place. */
  slug: string
  text: string
  /** Ledger ActivityEvent ids this inference observed. */
  evidenceEventIds: string[]
  /** For recommendations: insight node ids of the patterns they follow from. */
  basedOnInsightIds?: string[]
}

export const insightNodeId = (kind: InferenceWrite['kind'], slug: string) => `insight:activity:${kind}:${slug}`

export function inferenceGraphParts(write: InferenceWrite): { nodes: PendingNode[]; edges: GraphEdge[] } {
  const citations = write.kind === 'recommendation' ? (write.basedOnInsightIds ?? []) : write.evidenceEventIds
  if (citations.length === 0) throw new Error('inference rejected: no evidence')

  const id = insightNodeId(write.kind, write.slug)
  const nodes: PendingNode[] = [{
    id, type: 'insight',
    text: `${write.kind === 'recommendation' ? 'Recommendation' : 'Inferred pattern'}: ${write.text}`.slice(0, 1800),
    props: { insightKind: write.kind, slug: write.slug, evidenceCount: citations.length },
    visibility: 'shared',
  }]
  const edges: GraphEdge[] =
    write.kind === 'recommendation'
      ? citations.map((to) => ({ organizationId: write.organizationId, from: id, to, rel: 'based_on' as const }))
      : citations.map((eventId) => ({ organizationId: write.organizationId, from: id, to: nodeIds.activity(eventId), rel: 'evidence' as const }))
  return { nodes, edges }
}

/** Commit an inference. Invariant violations throw (caller bug); store
 * failures are swallowed-and-logged like every other graph write. */
export async function writeInference(write: InferenceWrite): Promise<boolean> {
  const { nodes, edges } = inferenceGraphParts(write) // may throw — intended
  try {
    await commitGraph(write.organizationId, nodes, edges)
    return true
  } catch (error) {
    apiLogger.warn('rag.writeInference failed', { slug: write.slug, error: error instanceof Error ? error.message : String(error) })
    return false
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/activity/__tests__/insights.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/activity
git commit -m "feat(activity): evidence-edge invariant — inferences rejected without provenance"
```

---

### Task 5: Slack adapter — live normalization + registry + ingest fan-out

**Files:**
- Create: `src/lib/activity/registry.ts`
- Create: `src/lib/activity/sources/slack.ts`
- Create: `src/lib/activity/ingest.ts`
- Modify: `src/lib/slack/dispatch.ts:154` (`routeSlackEvent` — add fan-out call)
- Test: `src/lib/activity/__tests__/slack-source.test.ts`

**Interfaces:**
- Consumes: `NormalizedSlackEvent`, `SlackTriggerInput` (`@/lib/slack/payload`), `persistActivity` (Task 2), `indexActivity` (Task 3).
- Produces:
  - `slackActivityFromInput(input: SlackTriggerInput): NormalizedActivity | null` (pure)
  - `slackActivitySource: ActivitySource` registered under `'slack'`
  - `getActivitySource(source: string): ActivitySource | null` (registry)
  - `ingestActivity(organizationId: string, ingestKind: IngestKind, events: NormalizedActivity[]): Promise<PersistedActivity[]>` — persist → index → (Task 8 adds trigger routing here). Best-effort; never throws.

- [ ] **Step 1: Write the failing test `src/lib/activity/__tests__/slack-source.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slackActivityFromInput } from '@/lib/activity/sources/slack'
import { getActivitySource } from '@/lib/activity/registry'

const input = {
  kind: 'message.channels' as const, text: 'shipping the acme proposal today',
  user: 'U1', channel: 'C9', ts: '1752300000.000100', team: 'T1',
}

test('normalizes a channel message: actor, action, entity, dedupe key, timestamp', () => {
  const activity = slackActivityFromInput(input)!
  assert.equal(activity.source, 'slack')
  assert.equal(activity.actorRef, 'U1')
  assert.equal(activity.action, 'posted_message')
  assert.equal(activity.entityType, 'message')
  assert.equal(activity.entityRef, 'C9:1752300000.000100')
  assert.equal(activity.dedupeKey, 'slack:C9:1752300000.000100')
  // Slack ts is epoch seconds — occurredAt must reflect it, not ingest time.
  assert.equal(activity.occurredAt.getTime(), 1752300000000)
  assert.equal((activity.businessContext as { channel: string }).channel, 'C9')
})

test('thread replies carry the thread as context and replied_in_thread action', () => {
  const activity = slackActivityFromInput({ ...input, thread_ts: '1752290000.000001' })!
  assert.equal(activity.action, 'replied_in_thread')
  assert.equal((activity.businessContext as { thread_ts: string }).thread_ts, '1752290000.000001')
})

test('slash commands and empty-ts inputs produce no activity', () => {
  assert.equal(slackActivityFromInput({ ...input, kind: 'slash_command', ts: '' }), null)
})

test('registry resolves the slack source with backfill + webhook capabilities', () => {
  const source = getActivitySource('slack')!
  assert.equal(source.source, 'slack')
  assert.equal(source.capabilities.backfill, true)
  assert.equal(source.capabilities.webhooks, true)
  assert.equal(getActivitySource('nope'), null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/activity/__tests__/slack-source.test.ts`
Expected: FAIL — cannot find modules

- [ ] **Step 3: Write `src/lib/activity/sources/slack.ts`**

The backfill implementation lands in Task 6; this task stubs it as an empty iterator so the interface is complete and the registry entry is honest about capabilities.

```ts
/**
 * Slack ActivitySource. Live events piggyback on the verified/deduped bot
 * ingress (routeSlackEvent fan-out) — handleEvent receives the already
 * normalized SlackTriggerInput, never a raw envelope. Backfill pages
 * conversations.history for bot-member channels (Task 6).
 */
import type { ActivitySource, BackfillBatch, BackfillWindow, NormalizedActivity, SourceContext } from '../types'
import type { SlackTriggerInput } from '@/lib/slack/payload'

/** Message ts (epoch seconds string) → Date; null on malformed input. */
function tsToDate(ts: string): Date | null {
  const seconds = Number(ts)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return new Date(seconds * 1000)
}

export function slackActivityFromInput(input: SlackTriggerInput): NormalizedActivity | null {
  // Slash commands are imperative bot invocations, not observed team
  // activity — and they carry no ts to anchor or dedupe on.
  if (input.kind === 'slash_command' || !input.ts) return null
  const occurredAt = tsToDate(input.ts)
  if (!occurredAt) return null
  return {
    source: 'slack',
    actorRef: input.user,
    action: input.thread_ts ? 'replied_in_thread' : 'posted_message',
    entityType: 'message',
    entityRef: `${input.channel}:${input.ts}`,
    entityName: input.channelName ?? null,
    businessContext: {
      channel: input.channel,
      ...(input.channelName ? { channelName: input.channelName } : {}),
      ...(input.thread_ts ? { thread_ts: input.thread_ts } : {}),
      team: input.team,
    },
    newState: { text: input.text.slice(0, 500) },
    occurredAt,
    dedupeKey: `slack:${input.channel}:${input.ts}`,
  }
}

export const slackActivitySource: ActivitySource = {
  source: 'slack',
  capabilities: { backfill: true, webhooks: true, incrementalSync: false },
  // eslint-disable-next-line require-yield -- implemented in Task 6 (backfill)
  async *backfill(_ctx: SourceContext, _window: BackfillWindow, _cursor?: string): AsyncIterable<BackfillBatch> {
    return
  },
  async handleEvent(_ctx, payload) {
    const activity = slackActivityFromInput(payload as SlackTriggerInput)
    return activity ? [activity] : []
  },
  async incrementalSync() {
    return []
  },
}
```

- [ ] **Step 4: Write `src/lib/activity/registry.ts`**

```ts
/** Activity source registry (spec §4) — mirrors src/lib/connectors/registry.ts. */
import type { ActivitySource } from './types'
import { slackActivitySource } from './sources/slack'

const SOURCES: Record<string, ActivitySource> = {
  [slackActivitySource.source]: slackActivitySource,
}

export function getActivitySource(source: string): ActivitySource | null {
  return SOURCES[source] ?? null
}

export function listActivitySources(): ActivitySource[] {
  return Object.values(SOURCES)
}
```

- [ ] **Step 5: Write `src/lib/activity/ingest.ts`**

```ts
/**
 * One funnel for every activity, however it arrived (spec §7): persist to the
 * ledger (deduped), project into the graph, then (live only) match flow
 * triggers — Task 8 wires routeActivity here. Best-effort throughout: an
 * ingest failure must never break the caller's hot path.
 */
import { apiLogger } from '@/lib/logger'
import { persistActivity, type PersistedActivity } from './ledger'
import { indexActivity } from './index-activity'
import type { IngestKind, NormalizedActivity } from './types'

export async function ingestActivity(
  organizationId: string,
  ingestKind: IngestKind,
  events: NormalizedActivity[],
): Promise<PersistedActivity[]> {
  if (events.length === 0) return []
  try {
    const { created } = await persistActivity(organizationId, ingestKind, events)
    await indexActivity(created)
    return created
  } catch (error) {
    apiLogger.warn('activity.ingest failed', { organizationId, ingestKind, error: error instanceof Error ? error.message : String(error) })
    return []
  }
}
```

- [ ] **Step 6: Fan out from the Slack ingress.** In `src/lib/slack/dispatch.ts`, add imports and a fire-and-forget observation at the TOP of `routeSlackEvent` (line ~154), before `tryThreadContinuation` — observation is unconditional; it must see messages whether or not any flow matches:

```ts
import { ingestActivity } from '@/lib/activity/ingest'
import { slackActivityFromInput } from '@/lib/activity/sources/slack'
```

```ts
export async function routeSlackEvent(args: SlackRouteArgs): Promise<void> {
  const { bindingId, organizationId, normalized } = args
  const input = normalized.input

  // Integration learnings: observe every verified, deduped, non-bot event
  // (spec §7). Fire-and-forget — learning must never delay flow dispatch.
  const observed = slackActivityFromInput(input)
  if (observed) void ingestActivity(organizationId, 'webhook', [observed]).catch(() => undefined)
```

(the rest of the function is unchanged)

- [ ] **Step 7: Run tests + typecheck**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/activity/__tests__/slack-source.test.ts && npm test && npx tsc --noEmit`
Expected: PASS — including existing slack dispatch tests (the fan-out is fire-and-forget; existing tests unaffected)

- [ ] **Step 8: Commit**

```bash
git add src/lib/activity src/lib/slack/dispatch.ts
git commit -m "feat(activity): slack source adapter, registry, ingest funnel + live fan-out from bot ingress"
```

---

### Task 6: Slack backfill — history paging + runner + queue + API

**Files:**
- Modify: `src/lib/activity/sources/slack.ts` (real `backfill`)
- Create: `src/lib/activity/backfill.ts` (source-agnostic runner)
- Modify: `src/lib/queue/config.ts:5-14` (add `ACTIVITY_BACKFILL: 'activity-backfill'` to `QUEUE_NAMES`)
- Modify: `src/lib/workers/runtime.ts:18-24` (worker spec for the new queue)
- Create: `src/app/api/activity/backfill/route.ts` (POST start, GET status)
- Test: `src/lib/activity/__tests__/backfill.test.ts`

**Interfaces:**
- Consumes: `ActivitySource.backfill`, `ingestActivity`, `windowStart`, `ActivityBackfill` model, `decryptSecretJson` (`@/lib/slack/connections`), `resolveExecutionMode`/`inlineExecution` (`@/lib/queue/execution-mode`), `createQueue`/`QUEUE_NAMES`/`workersEnabled` (`@/lib/queue/config`).
- Produces:
  - `runActivityBackfill(backfillId: string, opts?: { maxBatches?: number }): Promise<void>` — resumable runner; `maxBatches` is the inline bound.
  - `startActivityBackfill(params: { organizationId: string; source: string; connectionRef: string; window: BackfillWindow }): Promise<{ backfillId: string; mode: 'queued' | 'inline-partial' }>`
  - `executeActivityBackfillJob(job: { data: { backfillId: string } }): Promise<void>` (BullMQ processor)
  - `INLINE_BACKFILL_MAX_BATCHES = 15` (~30 days of pages at 200 msgs/page; spec §6 inline bound)
  - Slack backfill cursor format: JSON `{ channels: string[], channelIndex: number, pageCursor?: string }`.

- [ ] **Step 1: Write the failing test `src/lib/activity/__tests__/backfill.test.ts`**

The runner takes injectable `deps` so tests run without DB/queue/Slack:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runBackfillLoop } from '@/lib/activity/backfill'
import type { BackfillBatch, NormalizedActivity } from '@/lib/activity/types'

const ev = (key: string): NormalizedActivity => ({
  source: 'slack', actorRef: 'U1', action: 'posted_message', entityType: 'message',
  entityRef: key, occurredAt: new Date('2026-06-01T00:00:00Z'), dedupeKey: key,
})

function batches(...pages: Array<{ keys: string[]; nextCursor?: string }>): AsyncIterable<BackfillBatch> {
  return (async function* () {
    for (const page of pages) yield { events: page.keys.map(ev), nextCursor: page.nextCursor }
  })()
}

test('ingests every batch, checkpoints cursor after each, marks done', async () => {
  const checkpoints: Array<string | null> = []
  const ingested: string[][] = []
  const result = await runBackfillLoop({
    iterator: batches({ keys: ['a', 'b'], nextCursor: 'c1' }, { keys: ['c'] }),
    ingest: async (events) => { ingested.push(events.map((e) => e.dedupeKey)) },
    checkpoint: async (cursor, _count) => { checkpoints.push(cursor) },
  })
  assert.deepEqual(ingested, [['a', 'b'], ['c']])
  assert.deepEqual(checkpoints, ['c1', null]) // null cursor after final page
  assert.deepEqual(result, { status: 'done', batches: 2, events: 3 })
})

test('maxBatches bound stops early and reports partial with resume cursor', async () => {
  const result = await runBackfillLoop({
    iterator: batches({ keys: ['a'], nextCursor: 'c1' }, { keys: ['b'], nextCursor: 'c2' }, { keys: ['c'] }),
    ingest: async () => {},
    checkpoint: async () => {},
    maxBatches: 2,
  })
  assert.deepEqual(result, { status: 'partial', batches: 2, events: 2 })
})

test('an ingest error surfaces as failed (checkpointed work is preserved)', async () => {
  const result = await runBackfillLoop({
    iterator: batches({ keys: ['a'], nextCursor: 'c1' }, { keys: ['b'] }),
    ingest: async (events) => { if (events[0].dedupeKey === 'b') throw new Error('boom') },
    checkpoint: async () => {},
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.batches, 1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/activity/__tests__/backfill.test.ts`
Expected: FAIL — cannot find module `@/lib/activity/backfill`

- [ ] **Step 3: Write `src/lib/activity/backfill.ts`**

```ts
/**
 * Historical backfill (spec §6). Source-agnostic: the adapter yields pages,
 * this runner ingests each page and checkpoints the cursor AFTER it lands —
 * a crash or redeploy resumes from the last completed page, never re-reading
 * finished ones. Queue mode runs unbounded on the worker; inline mode (no
 * Redis) runs a bounded pass and marks the row `partial` so the full window
 * is honored after the worker deploys.
 */
import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { inlineExecution } from '@/lib/queue/execution-mode'
import { createQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { getActivitySource } from './registry'
import { ingestActivity } from './ingest'
import type { BackfillBatch, BackfillWindow, NormalizedActivity } from './types'

/** ~15 pages ≈ a month of typical channel volume — the inline bound. */
export const INLINE_BACKFILL_MAX_BATCHES = 15

export interface BackfillLoopResult {
  status: 'done' | 'partial' | 'failed'
  batches: number
  events: number
}

/** Pure-ish core, injectable for tests. Checkpoint receives the NEXT cursor
 * (null when the source is exhausted) plus the running event count. */
export async function runBackfillLoop(deps: {
  iterator: AsyncIterable<BackfillBatch>
  ingest: (events: NormalizedActivity[]) => Promise<void>
  checkpoint: (cursor: string | null, eventCount: number) => Promise<void>
  maxBatches?: number
}): Promise<BackfillLoopResult> {
  let batches = 0
  let events = 0
  try {
    for await (const batch of deps.iterator) {
      await deps.ingest(batch.events)
      batches++
      events += batch.events.length
      await deps.checkpoint(batch.nextCursor ?? null, events)
      if (!batch.nextCursor) return { status: 'done', batches, events }
      if (deps.maxBatches && batches >= deps.maxBatches) return { status: 'partial', batches, events }
    }
    return { status: 'done', batches, events }
  } catch (error) {
    apiLogger.warn('activity.backfill loop failed', { error: error instanceof Error ? error.message : String(error) })
    return { status: 'failed', batches, events }
  }
}

/** Load the row, drive the adapter from its checkpointed cursor, record the outcome. */
export async function runActivityBackfill(backfillId: string, opts: { maxBatches?: number } = {}): Promise<void> {
  const row = await systemPrisma.activityBackfill.findUnique({ where: { id: backfillId } })
  if (!row || row.status === 'done') return
  const adapter = getActivitySource(row.source)
  if (!adapter?.capabilities.backfill) return

  await prisma.activityBackfill.update({
    where: { id: row.id, organizationId: row.organizationId },
    data: { status: 'running', startedAt: row.startedAt ?? new Date(), error: null },
  })

  const ctx = { organizationId: row.organizationId, connectionRef: row.connectionRef }
  const result = await runBackfillLoop({
    iterator: adapter.backfill(ctx, row.window as BackfillWindow, row.cursor ?? undefined),
    ingest: async (events) => { await ingestActivity(row.organizationId, 'backfill', events) },
    checkpoint: async (cursor, count) =>
      void (await prisma.activityBackfill.update({
        where: { id: row.id, organizationId: row.organizationId },
        data: { cursor, eventsIngested: row.eventsIngested + count },
      })),
    ...(opts.maxBatches ? { maxBatches: opts.maxBatches } : {}),
  })

  await prisma.activityBackfill.update({
    where: { id: row.id, organizationId: row.organizationId },
    data: {
      status: result.status,
      ...(result.status === 'done' ? { completedAt: new Date() } : {}),
      ...(result.status === 'failed' ? { error: 'backfill batch failed — see logs; retry resumes from checkpoint' } : {}),
    },
  })
}

/** Entry point (spec §6): upsert the row, then queue or run inline-bounded. */
export async function startActivityBackfill(params: {
  organizationId: string
  source: string
  connectionRef: string
  window: BackfillWindow
}): Promise<{ backfillId: string; mode: 'queued' | 'inline-partial' }> {
  const row = await prisma.activityBackfill.upsert({
    where: { organizationId_source_connectionRef: { organizationId: params.organizationId, source: params.source, connectionRef: params.connectionRef } },
    create: { organizationId: params.organizationId, source: params.source, connectionRef: params.connectionRef, window: params.window },
    update: { window: params.window, status: 'pending', cursor: null, eventsIngested: 0, error: null, completedAt: null },
  })
  if (!inlineExecution && workersEnabled) {
    const queue = createQueue(QUEUE_NAMES.ACTIVITY_BACKFILL)
    await queue.add('activity-backfill', { backfillId: row.id }, { jobId: row.id })
    return { backfillId: row.id, mode: 'queued' }
  }
  // Inline topology: bounded pass now; the row stays `partial` so the full
  // window re-runs once the worker + Redis deploy lands.
  void runActivityBackfill(row.id, { maxBatches: INLINE_BACKFILL_MAX_BATCHES }).catch((error) =>
    apiLogger.warn('activity.backfill inline run failed', { backfillId: row.id, error: error instanceof Error ? error.message : String(error) }),
  )
  return { backfillId: row.id, mode: 'inline-partial' }
}

/** BullMQ processor (worker runtime). */
export async function executeActivityBackfillJob(job: { data: { backfillId: string } }): Promise<void> {
  await runActivityBackfill(job.data.backfillId)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/activity/__tests__/backfill.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Implement the real Slack `backfill` in `src/lib/activity/sources/slack.ts`** (replace the Task 5 stub):

```ts
import { prisma } from '@/lib/prisma'
import { decryptSecretJson } from '@/lib/slack/connections'
import { windowStart } from '../types'

const SLACK_API = 'https://slack.com/api'
const PAGE_SIZE = 200

type SlackCursor = { channels: string[]; channelIndex: number; pageCursor?: string }

async function slackGet(botToken: string, method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const query = new URLSearchParams(params).toString()
  const response = await fetch(`${SLACK_API}/${method}?${query}`, {
    headers: { Authorization: `Bearer ${botToken}` },
    signal: AbortSignal.timeout(30_000),
  })
  const body = (await response.json()) as Record<string, unknown>
  if (body.ok !== true) throw new Error(`Slack API error (${method}): ${body.error ?? 'unknown'}`)
  return body
}

function messageActivity(channel: string, message: Record<string, unknown>): NormalizedActivity | null {
  const ts = typeof message.ts === 'string' ? message.ts : ''
  const user = typeof message.user === 'string' ? message.user : ''
  if (!ts || !user || typeof message.subtype === 'string' || message.bot_id) return null
  const seconds = Number(ts)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  const threadTs = typeof message.thread_ts === 'string' && message.thread_ts !== ts ? message.thread_ts : undefined
  return {
    source: 'slack', actorRef: user,
    action: threadTs ? 'replied_in_thread' : 'posted_message',
    entityType: 'message', entityRef: `${channel}:${ts}`,
    businessContext: { channel, ...(threadTs ? { thread_ts: threadTs } : {}) },
    newState: { text: String(message.text ?? '').slice(0, 500) },
    occurredAt: new Date(seconds * 1000),
    dedupeKey: `slack:${channel}:${ts}`,
  }
}

export const slackActivitySource: ActivitySource = {
  source: 'slack',
  capabilities: { backfill: true, webhooks: true, incrementalSync: false },
  async *backfill(ctx, window, cursor) {
    const connection = await prisma.slackWorkspaceConnection.findFirst({
      where: { id: ctx.connectionRef, organizationId: ctx.organizationId, status: 'active' },
    })
    if (!connection) return
    const botToken = decryptSecretJson(connection.botToken)
    const oldest = windowStart(window, new Date())

    let state: SlackCursor
    if (cursor) {
      state = JSON.parse(cursor) as SlackCursor
    } else {
      // Bot-member public channels only — the scopes the manifest grants.
      const channels: string[] = []
      let listCursor = ''
      do {
        const body = await slackGet(botToken, 'users.conversations', {
          types: 'public_channel', limit: '200', ...(listCursor ? { cursor: listCursor } : {}),
        })
        for (const ch of (body.channels as Array<{ id: string }> | undefined) ?? []) channels.push(ch.id)
        listCursor = String((body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? '')
      } while (listCursor)
      state = { channels, channelIndex: 0 }
    }

    while (state.channelIndex < state.channels.length) {
      const channel = state.channels[state.channelIndex]
      const body = await slackGet(botToken, 'conversations.history', {
        channel, limit: String(PAGE_SIZE),
        ...(oldest ? { oldest: String(oldest.getTime() / 1000) } : {}),
        ...(state.pageCursor ? { cursor: state.pageCursor } : {}),
      })
      const messages = ((body.messages as Array<Record<string, unknown>> | undefined) ?? [])
      const events = messages.map((m) => messageActivity(channel, m)).filter((e): e is NormalizedActivity => e !== null)
      const nextPage = String((body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? '')
      const next: SlackCursor = nextPage
        ? { ...state, pageCursor: nextPage }
        : { channels: state.channels, channelIndex: state.channelIndex + 1 }
      const exhausted = !nextPage && next.channelIndex >= state.channels.length
      yield { events, ...(exhausted ? {} : { nextCursor: JSON.stringify(next) }) }
      state = next
    }
  },
  async handleEvent(_ctx, payload) {
    const activity = slackActivityFromInput(payload as SlackTriggerInput)
    return activity ? [activity] : []
  },
  async incrementalSync() {
    return []
  },
}
```

(Keep `slackActivityFromInput` from Task 5 unchanged; merge imports at the top of the file.)

- [ ] **Step 6: Register the queue.** In `src/lib/queue/config.ts` add to `QUEUE_NAMES`:

```ts
  ACTIVITY_BACKFILL: 'activity-backfill',
```

- [ ] **Step 7: Register the worker.** In `src/lib/workers/runtime.ts` add the import and a spec entry:

```ts
import { executeActivityBackfillJob } from '@/lib/activity/backfill'
```

```ts
    // Activity backfill: long paging jobs; failures stay on the row
    // (status=failed, resumable from cursor) — no dead-letter table needed.
    { queue: QUEUE_NAMES.ACTIVITY_BACKFILL, handler: executeActivityBackfillJob, onFailed: () => undefined },
```

- [ ] **Step 8: Write `src/app/api/activity/backfill/route.ts`** (follow the auth/org-scoping conventions of `src/app/api/slack/connections/route.ts` — copy its session/org resolution verbatim):

```ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getActivitySource } from '@/lib/activity/registry'
import { startActivityBackfill } from '@/lib/activity/backfill'
// + the same authenticated-session/org helper the slack connections route uses

export async function POST(request: Request) {
  // resolve { organizationId } from the session (401/403 exactly like slack/connections)
  const body = (await request.json().catch(() => null)) as
    | { source?: string; connectionRef?: string; window?: string }
    | null
  const window = body?.window
  if (!body?.source || !body.connectionRef || !window || !['90d', '1y', 'all'].includes(window)) {
    return NextResponse.json({ error: 'source, connectionRef, and window (90d|1y|all) are required' }, { status: 400 })
  }
  if (!getActivitySource(body.source)?.capabilities.backfill) {
    return NextResponse.json({ error: `source ${body.source} does not support backfill` }, { status: 400 })
  }
  const result = await startActivityBackfill({
    organizationId,
    source: body.source,
    connectionRef: body.connectionRef,
    window: window as '90d' | '1y' | 'all',
  })
  return NextResponse.json(result, { status: 202 })
}

export async function GET() {
  // resolve { organizationId } from the session as above
  const rows = await prisma.activityBackfill.findMany({
    where: { organizationId },
    select: { id: true, source: true, connectionRef: true, window: true, status: true, eventsIngested: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
  })
  return NextResponse.json({ backfills: rows })
}
```

- [ ] **Step 9: Run all tests + typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/lib/activity src/lib/queue/config.ts src/lib/workers/runtime.ts src/app/api/activity
git commit -m "feat(activity): cursor-resumable backfill — slack history paging, activity-backfill queue, start/status API"
```

---

### Task 7: Inference job — facts → evidence-linked patterns

**Files:**
- Create: `src/lib/intelligence/infer-patterns.ts`
- Test: `src/lib/intelligence/__tests__/infer-patterns.test.ts`

**Interfaces:**
- Consumes: `generateStructured`, `DEFAULT_SUMMARY_MODEL` (`@/lib/llm/model-runner`), `writeInference` (Task 4), `saveAgentMemory` (`@/lib/memory/agent-memory`), `orgIntelligenceAgentId` (`@/lib/intelligence/connection-scan`), `prisma.activityEvent`.
- Produces:
  - `parseInferences(raw: unknown, validEventIds: Set<string>): ParsedInference[]` (pure — drops hallucinated event ids, drops inferences left with zero valid citations)
  - `ParsedInference = { slug: string; kind: 'inferred_pattern' | 'recommendation'; text: string; evidenceEventIds: string[]; basedOnSlugs: string[] }`
  - `inferActivityPatterns(organizationId: string, opts?: { windowDays?: number; maxEvents?: number }): Promise<{ patterns: number; recommendations: number } | { skipped: string }>`

- [ ] **Step 1: Write the failing test `src/lib/intelligence/__tests__/infer-patterns.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInferences } from '@/lib/intelligence/infer-patterns'

const valid = new Set(['ev-1', 'ev-2'])

test('keeps inferences whose citations are real event ids', () => {
  const parsed = parseInferences(
    { inferences: [{ slug: 'legal-bottleneck', kind: 'inferred_pattern', text: 'Legal review is a bottleneck.', evidenceEventIds: ['ev-1', 'ev-2'] }] },
    valid,
  )
  assert.equal(parsed.length, 1)
  assert.deepEqual(parsed[0].evidenceEventIds, ['ev-1', 'ev-2'])
})

test('strips hallucinated event ids; drops an inference with none left', () => {
  const parsed = parseInferences(
    { inferences: [
      { slug: 'half-real', kind: 'inferred_pattern', text: 'x', evidenceEventIds: ['ev-1', 'ev-99'] },
      { slug: 'all-fake', kind: 'inferred_pattern', text: 'y', evidenceEventIds: ['ev-98', 'ev-99'] },
    ] },
    valid,
  )
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].slug, 'half-real')
  assert.deepEqual(parsed[0].evidenceEventIds, ['ev-1'])
})

test('recommendations must cite a pattern slug from the same batch', () => {
  const parsed = parseInferences(
    { inferences: [
      { slug: 'bottleneck', kind: 'inferred_pattern', text: 'p', evidenceEventIds: ['ev-1'] },
      { slug: 'add-check', kind: 'recommendation', text: 'r', basedOnSlugs: ['bottleneck'] },
      { slug: 'floating-rec', kind: 'recommendation', text: 'r2', basedOnSlugs: ['nonexistent'] },
    ] },
    valid,
  )
  assert.deepEqual(parsed.map((p) => p.slug).sort(), ['add-check', 'bottleneck'])
})

test('malformed payloads parse to empty, never throw', () => {
  assert.deepEqual(parseInferences(null, valid), [])
  assert.deepEqual(parseInferences({ inferences: 'nope' }, valid), [])
  assert.deepEqual(parseInferences({ inferences: [{ slug: 42 }] }, valid), [])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/intelligence/__tests__/infer-patterns.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Write `src/lib/intelligence/infer-patterns.ts`**

```ts
/**
 * Inference over the activity ledger (spec §8): read a window of observed
 * facts, ask the model for patterns/recommendations WITH the real event ids
 * in hand, and reject anything it can't tie back to those ids. Facts are
 * never synthesized; evidence edges are built from ledger ids, not model
 * output the model invented. Best-effort background pass on the cheap model
 * tier (same convention as connection-scan).
 */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { generateStructured, DEFAULT_SUMMARY_MODEL } from '@/lib/llm/model-runner'
import { saveAgentMemory } from '@/lib/memory/agent-memory'
import { writeInference, insightNodeId } from '@/lib/activity/insights'
import { orgIntelligenceAgentId } from '@/lib/intelligence/connection-scan'

export interface ParsedInference {
  slug: string
  kind: 'inferred_pattern' | 'recommendation'
  text: string
  evidenceEventIds: string[]
  basedOnSlugs: string[]
}

const INFERENCE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    inferences: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'stable-kebab-case-identifier' },
          kind: { type: 'string', enum: ['inferred_pattern', 'recommendation'] },
          text: { type: 'string' },
          evidenceEventIds: { type: 'array', items: { type: 'string' } },
          basedOnSlugs: { type: 'array', items: { type: 'string' } },
        },
        required: ['slug', 'kind', 'text'],
      },
    },
  },
  required: ['inferences'],
} as const

export function parseInferences(raw: unknown, validEventIds: Set<string>): ParsedInference[] {
  if (!raw || typeof raw !== 'object') return []
  const list = (raw as { inferences?: unknown }).inferences
  if (!Array.isArray(list)) return []
  const candidates: ParsedInference[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const { slug, kind, text } = item as Record<string, unknown>
    if (typeof slug !== 'string' || !slug || typeof text !== 'string' || !text) continue
    if (kind !== 'inferred_pattern' && kind !== 'recommendation') continue
    const rawEvidence = (item as { evidenceEventIds?: unknown }).evidenceEventIds
    const evidenceEventIds = (Array.isArray(rawEvidence) ? rawEvidence : [])
      .filter((id): id is string => typeof id === 'string' && validEventIds.has(id))
    const rawBased = (item as { basedOnSlugs?: unknown }).basedOnSlugs
    const basedOnSlugs = (Array.isArray(rawBased) ? rawBased : []).filter((s): s is string => typeof s === 'string')
    candidates.push({ slug, kind, text, evidenceEventIds, basedOnSlugs })
  }
  const patternSlugs = new Set(candidates.filter((c) => c.kind === 'inferred_pattern' && c.evidenceEventIds.length > 0).map((c) => c.slug))
  return candidates.filter((c) =>
    c.kind === 'inferred_pattern'
      ? c.evidenceEventIds.length > 0
      : (c.basedOnSlugs = c.basedOnSlugs.filter((s) => patternSlugs.has(s))).length > 0,
  )
}

function factLine(e: { id: string; actorName: string | null; actorRef: string; action: string; entityType: string; entityName: string | null; entityRef: string; source: string; occurredAt: Date; previousState: unknown; newState: unknown; outcome: string | null }): string {
  const state = e.previousState != null || e.newState != null
    ? ` [${JSON.stringify(e.previousState)} → ${JSON.stringify(e.newState)}]`
    : ''
  return `${e.id}: ${e.actorName ?? e.actorRef} ${e.action} ${e.entityType} ${e.entityName ?? e.entityRef} (${e.source}, ${e.occurredAt.toISOString().slice(0, 10)})${state}${e.outcome ? ` outcome=${e.outcome}` : ''}`
}

export async function inferActivityPatterns(
  organizationId: string,
  opts: { windowDays?: number; maxEvents?: number } = {},
): Promise<{ patterns: number; recommendations: number } | { skipped: string }> {
  try {
    const since = new Date(Date.now() - (opts.windowDays ?? 30) * 24 * 60 * 60 * 1000)
    const events = await prisma.activityEvent.findMany({
      where: { organizationId, occurredAt: { gte: since } },
      orderBy: { occurredAt: 'desc' },
      take: opts.maxEvents ?? 300,
      select: {
        id: true, actorRef: true, actorName: true, action: true, entityType: true,
        entityRef: true, entityName: true, source: true, occurredAt: true,
        previousState: true, newState: true, outcome: true,
      },
    })
    if (events.length < 10) return { skipped: 'too-few-events' }

    const validIds = new Set(events.map((e) => e.id))
    const system = [
      'You analyze a company\'s observed cross-tool business activity and infer operational patterns.',
      'Rules: (1) Every inferred_pattern MUST cite evidenceEventIds copied EXACTLY from the fact lines.',
      '(2) Never invent event ids. (3) Recommendations cite pattern slugs via basedOnSlugs, never event ids.',
      '(4) Only report patterns genuinely supported by repetition, delay, backward movement, or outcome data.',
      'Return at most 5 patterns and 3 recommendations.',
    ].join(' ')
    const user = `Observed facts (id: description):\n${events.map(factLine).join('\n')}`

    const model = process.env.AGENT_REFLECTION_MODEL?.trim() || DEFAULT_SUMMARY_MODEL
    const raw = await generateStructured({ system, user, schema: INFERENCE_JSON_SCHEMA, schemaName: 'activity_inferences', maxTokens: 2000, model })
    const inferences = parseInferences(raw, validIds)
    if (inferences.length === 0) return { skipped: 'no-inferences' }

    let patterns = 0
    let recommendations = 0
    const agentId = await orgIntelligenceAgentId(organizationId)
    for (const inference of inferences) {
      const ok = await writeInference({
        organizationId,
        kind: inference.kind,
        slug: inference.slug,
        text: inference.text,
        evidenceEventIds: inference.evidenceEventIds,
        basedOnInsightIds: inference.basedOnSlugs.map((s) => insightNodeId('inferred_pattern', s)),
      })
      if (!ok) continue
      inference.kind === 'inferred_pattern' ? patterns++ : recommendations++
      await saveAgentMemory({
        organizationId,
        agentId,
        kind: 'learning',
        title: `${inference.kind === 'recommendation' ? 'Recommendation' : 'Pattern'}: ${inference.text.slice(0, 80)}`,
        content: inference.text,
        sourceRef: `activity-inference:${inference.slug}`,
      })
    }
    return { patterns, recommendations }
  } catch (error) {
    apiLogger.warn('intelligence.inferActivityPatterns failed', { organizationId, error: error instanceof Error ? error.message : String(error) })
    return { skipped: 'error' }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/intelligence/__tests__/infer-patterns.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Wire the trigger points.** (a) Post-backfill: in `src/lib/activity/backfill.ts` `runActivityBackfill`, after the final status update, add:

```ts
  if (result.status === 'done') {
    void inferActivityPatterns(row.organizationId).catch(() => undefined)
  }
```

with `import { inferActivityPatterns } from '@/lib/intelligence/infer-patterns'`.

(b) Periodic: in the retention/dispatch cron (`src/app/api/cron/dispatch/route.ts`), add a best-effort pass over orgs with recent activity — read the file first and follow its existing per-org iteration pattern; the call is `void inferActivityPatterns(orgId).catch(() => undefined)` for orgs having ≥1 `ActivityEvent` in the last 24h (`prisma.activityEvent.groupBy({ by: ['organizationId'], where: { ingestedAt: { gte: dayAgo } } })`).

- [ ] **Step 6: Run all tests + typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/intelligence src/lib/activity/backfill.ts src/app/api/cron
git commit -m "feat(intelligence): activity inference job — evidence-linked patterns and recommendations"
```

---

### Task 8: Activity flow trigger — match + idempotent dispatch

**Files:**
- Create: `src/lib/activity/route-activity.ts`
- Modify: `src/features/flows/execute-flow.ts:51` (trigger type union — add `'activity'`)
- Modify: `src/lib/activity/ingest.ts` (call routing for live events)
- Test: `src/lib/activity/__tests__/route-activity.test.ts`

**Interfaces:**
- Consumes: `PersistedActivity`, `dispatchFlowExecution` (`@/features/flows/execute-flow`), `prisma.activityTriggerClaim`, flow rows (`systemPrisma.flow.findMany` — same query shape as `routeSlackEvent`).
- Produces:
  - `ActivityTriggerConfig = { type: 'activity'; sources?: string[]; actions?: string[]; entityTypes?: string[]; context?: Record<string, string> }`
  - `activityTriggerConfigOf(trigger: unknown): ActivityTriggerConfig | null` (pure)
  - `matchActivityFlows(event: PersistedActivity, flows: { id: string; trigger: unknown }[]): { id: string; config: ActivityTriggerConfig }[]` (pure)
  - `routeActivityEvent(event: PersistedActivity): Promise<void>` (dispatch; excluded for backfill by the caller)
  - Run trigger origin: `{ type: 'activity', activity: { eventId, source, action, entityType, entityRef } }`

- [ ] **Step 1: Write the failing test `src/lib/activity/__tests__/route-activity.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityTriggerConfigOf, matchActivityFlows } from '@/lib/activity/route-activity'
import type { PersistedActivity } from '@/lib/activity/ledger'

const event: PersistedActivity = {
  id: 'ev-1', organizationId: 'org-1', ingestKind: 'webhook',
  source: 'salesforce', actorRef: 'sarah', action: 'changed_stage',
  entityType: 'opportunity', entityRef: 'opp-abc',
  previousState: 'Proposal', newState: 'Qualification',
  businessContext: { accountId: 'acme' },
  occurredAt: new Date('2026-07-10T00:00:00Z'), dedupeKey: 'k',
}

test('parses a valid activity trigger config; rejects other types', () => {
  assert.deepEqual(
    activityTriggerConfigOf({ type: 'activity', sources: ['salesforce'], actions: ['changed_stage'] }),
    { type: 'activity', sources: ['salesforce'], actions: ['changed_stage'] },
  )
  assert.equal(activityTriggerConfigOf({ type: 'slack', events: ['app_mention'] }), null)
  assert.equal(activityTriggerConfigOf(null), null)
})

test('matches on source/action/entityType filters; empty filters match everything', () => {
  const flows = [
    { id: 'f-any', trigger: { type: 'activity' } },
    { id: 'f-sfdc-stage', trigger: { type: 'activity', sources: ['salesforce'], actions: ['changed_stage'] } },
    { id: 'f-github', trigger: { type: 'activity', sources: ['github'] } },
    { id: 'f-slack-trigger', trigger: { type: 'slack', events: ['app_mention'] } },
  ]
  assert.deepEqual(matchActivityFlows(event, flows).map((m) => m.id).sort(), ['f-any', 'f-sfdc-stage'])
})

test('context filter matches businessContext values by string equality', () => {
  const flows = [
    { id: 'f-acme', trigger: { type: 'activity', context: { accountId: 'acme' } } },
    { id: 'f-other', trigger: { type: 'activity', context: { accountId: 'globex' } } },
  ]
  assert.deepEqual(matchActivityFlows(event, flows).map((m) => m.id), ['f-acme'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/activity/__tests__/route-activity.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Write `src/lib/activity/route-activity.ts`**

```ts
/**
 * Activity → flow routing (spec §9): normalized business events are a flow
 * trigger type, matched on live ingest only — backfilled history NEVER fires
 * a flow (the caller filters ingestKind before we're reached; asserted again
 * here). Idempotency: an ActivityTriggerClaim row per (event, flow), decided
 * by the DB unique constraint — same pattern as SlackProcessedEvent.
 */
import { Prisma } from '@prisma/client'
import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { dispatchFlowExecution } from '@/features/flows/execute-flow'
import type { PersistedActivity } from './ledger'

export type ActivityTriggerConfig = {
  type: 'activity'
  sources?: string[]
  actions?: string[]
  entityTypes?: string[]
  /** String-equality filter over businessContext keys. */
  context?: Record<string, string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

const strArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.length && value.every((v) => typeof v === 'string') ? (value as string[]) : undefined

export function activityTriggerConfigOf(trigger: unknown): ActivityTriggerConfig | null {
  if (!isRecord(trigger) || trigger.type !== 'activity') return null
  const context = isRecord(trigger.context)
    ? Object.fromEntries(Object.entries(trigger.context).filter(([, v]) => typeof v === 'string')) as Record<string, string>
    : undefined
  return {
    type: 'activity',
    ...(strArray(trigger.sources) ? { sources: strArray(trigger.sources) } : {}),
    ...(strArray(trigger.actions) ? { actions: strArray(trigger.actions) } : {}),
    ...(strArray(trigger.entityTypes) ? { entityTypes: strArray(trigger.entityTypes) } : {}),
    ...(context && Object.keys(context).length ? { context } : {}),
  }
}

export function matchActivityFlows(
  event: PersistedActivity,
  flows: { id: string; trigger: unknown }[],
): { id: string; config: ActivityTriggerConfig }[] {
  const matches: { id: string; config: ActivityTriggerConfig }[] = []
  for (const flow of flows) {
    const config = activityTriggerConfigOf(flow.trigger)
    if (!config) continue
    if (config.sources && !config.sources.includes(event.source)) continue
    if (config.actions && !config.actions.includes(event.action)) continue
    if (config.entityTypes && !config.entityTypes.includes(event.entityType)) continue
    if (config.context) {
      const context = (event.businessContext ?? {}) as Record<string, unknown>
      const all = Object.entries(config.context).every(([key, expected]) => String(context[key]) === expected)
      if (!all) continue
    }
    matches.push({ id: flow.id, config })
  }
  return matches
}

function activityRunTrigger(event: PersistedActivity) {
  return {
    type: 'activity' as const,
    activity: {
      eventId: event.id, source: event.source, action: event.action,
      entityType: event.entityType, entityRef: event.entityRef,
    },
  }
}

/** Claim (eventId, flowId) atomically; false = someone else already did. */
async function claimActivityTrigger(eventId: string, flowId: string): Promise<boolean> {
  try {
    await prisma.activityTriggerClaim.create({ data: { eventId, flowId } })
    return true
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return false
    throw error
  }
}

export async function routeActivityEvent(event: PersistedActivity): Promise<void> {
  if (event.ingestKind === 'backfill') return // spec §9: history never fires flows
  try {
    const flows = await systemPrisma.flow.findMany({
      where: { organizationId: event.organizationId, status: 'ACTIVE' },
      select: { id: true, userId: true, organizationId: true, trigger: true, publishedGraph: true },
      take: 200,
    })
    const candidates = flows.filter((flow) => flow.publishedGraph != null)
    const matches = matchActivityFlows(event, candidates)
    for (const match of matches) {
      const flow = candidates.find((candidate) => candidate.id === match.id)
      if (!flow) continue
      if (!(await claimActivityTrigger(event.id, flow.id))) continue
      try {
        // Owner attribution mirrors slack/webhook dispatch.
        const owner = flow.userId
          ? await prisma.user.findFirst({ where: { id: flow.userId, organizationId: event.organizationId, isActive: true } })
          : await prisma.user.findFirst({ where: { organizationId: event.organizationId, isActive: true }, orderBy: { createdAt: 'asc' } })
        if (!owner) continue
        await dispatchFlowExecution({
          flowId: flow.id,
          organizationId: event.organizationId,
          userId: owner.id,
          input: activityRunTrigger(event).activity,
          usePublished: true,
          trigger: activityRunTrigger(event),
        })
      } catch (error) {
        apiLogger.error('activity flow dispatch failed', { flowId: flow.id, eventId: event.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
  } catch (error) {
    apiLogger.warn('activity.routeActivityEvent failed', { eventId: event.id, error: error instanceof Error ? error.message : String(error) })
  }
}
```

(If `dispatchFlowExecution`'s `input` param is typed `string`, pass `input: JSON.stringify(activityRunTrigger(event).activity)` instead — check the `FlowExecutionJob` type at `src/features/flows/execute-flow.ts:40-60` and match it.)

- [ ] **Step 4: Extend the trigger union.** In `src/features/flows/execute-flow.ts:51`:

```ts
  trigger?: { type: 'manual' | 'schedule' | 'webhook' | 'signal' | 'slack' | 'activity'; [key: string]: unknown }
```

- [ ] **Step 5: Wire routing into the ingest funnel.** In `src/lib/activity/ingest.ts` after `indexActivity(created)`:

```ts
import { routeActivityEvent } from './route-activity'
```

```ts
    if (ingestKind !== 'backfill') {
      for (const event of created) {
        await routeActivityEvent(event)
      }
    }
```

- [ ] **Step 6: Run test to verify it passes, then the full suite**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/activity/__tests__/route-activity.test.ts && npm test && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/activity src/features/flows/execute-flow.ts
git commit -m "feat(flows): activity trigger type — cross-tool business events dispatch flows idempotently"
```

---

### Task 9: Backfill UI on the Slack integration card + verification

**Files:**
- Modify: `src/components/integrations/slack-bot-card.tsx` (window picker + progress; read the file first and follow its existing fetch/state conventions)
- Verify: end-to-end smoke

**Interfaces:**
- Consumes: `POST /api/activity/backfill` `{ source: 'slack', connectionRef: <SlackWorkspaceConnection.id>, window: '90d'|'1y'|'all' }` → 202 `{ backfillId, mode }`; `GET /api/activity/backfill` → `{ backfills: [{ id, source, connectionRef, window, status, eventsIngested, updatedAt }] }`.

- [ ] **Step 1: Read `src/components/integrations/slack-bot-card.tsx`** and add, for a connected workspace, a "Learn from history" affordance: three buttons (or a select) for `Last 90 days / Last year / All available history` that POSTs to `/api/activity/backfill`, plus a status line rendered from GET (`status` + `eventsIngested`, e.g. "Learning from history — 1,240 events (partial)"). Match the card's existing styling and fetch patterns exactly; poll GET every 5s only while status is `pending`/`running`.

- [ ] **Step 2: Typecheck + full suite**

Run: `npx tsc --noEmit && npm test`
Expected: PASS

- [ ] **Step 3: End-to-end smoke (inline mode, no Redis/Neo4j needed)**

Run: `npm run dev`, then with a signed-in session:
1. `POST /api/activity/backfill` with a connected Slack workspace → expect 202 `{ mode: 'inline-partial' }` and `activity_events` rows appearing (`npx prisma studio` or psql).
2. Post a message in a bot-member channel → expect a new `activity_events` row with `ingestKind: 'webhook'` within seconds.
3. Publish a flow with trigger `{ "type": "activity", "sources": ["slack"] }` → next message dispatches a run with `trigger.type === 'activity'`; verify exactly one `activity_trigger_claims` row per (event, flow).

Expected: all three observed; graph indexing is silently skipped without Voyage/Neo4j (`ragEnabled()` false) — `indexedAt` stays null, which is the designed degraded mode.

- [ ] **Step 4: Commit**

```bash
git add src/components/integrations/slack-bot-card.tsx
git commit -m "feat(integrations): backfill window picker + learning progress on the Slack card"
```

---

## Deferred to Phase 2 (spec §13)

CRM (Nango) + GitHub adapters; `incrementalSync` cron tick; OKF discovery emission into the knowledge repo; People.ai `Signal` migration onto `ActivitySource`; builder-UI panel for configuring the `activity` trigger (Phase 1 accepts the JSON trigger config on published flows); retention-cron pruning of `activity:` graph nodes.
