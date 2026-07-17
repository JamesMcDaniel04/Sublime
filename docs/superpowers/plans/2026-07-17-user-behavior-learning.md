# User Behavior Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The platform learns each user's in-app behavior (agent runs, flow edits, copilot asks) via a durable event ledger, mines evidence-gated patterns from it, and quietly converts eligible patterns into draft automations and grounded assistant/copilot context.

**Architecture:** A new `user_events` Postgres ledger (modeled on `activity_events`) is written server-side from existing API routes, projected into the existing GraphRAG store with per-user private visibility, and mined by a deterministic pattern miner (real counts, real evidence — the LLM never invents statistics). A single pure eligibility gate (`isPatternEligible`) is the only path from pattern to any downstream surface. Suggestions are tracked in a `user_suggestions` table (one un-actioned per user, weekly cadence) — a refinement of the spec's "suggestion memories" wording chosen so the quietness invariants are enforceable per-user; enhancement proposals targeting agents are additionally mirrored to `agent_memories` so the existing agent-page UI surfaces them.

**Tech Stack:** Next.js 15 App Router, Prisma 6/Postgres, Neo4j via `GraphRagStore` abstraction (MemoryGraphStore fallback), Voyage embeddings, node:test via `npm test`, Zod.

**Spec:** `docs/superpowers/specs/2026-07-17-user-behavior-learning-design.md`

## Global Constraints

- Gate constants (exact values from spec): `MIN_OCCURRENCES = 3`, `MIN_SPAN_DAYS = 7`, `LEARNING_PERIOD_DAYS = 7`, dismissal similarity threshold `0.86` (reuse `MEMORY_SIMILARITY_THRESHOLD`).
- Quietness (spec): max ONE un-actioned (`status: 'open'`) `user_suggestions` row per user; per-user synthesis at most weekly; drafts only — never auto-activate flows/agents.
- Privacy (spec): `user_events.context` stores references/metadata (ids, names, flags) — NEVER raw prompt or message text. Explicitly not captured: page views, clicks, navigation.
- Capture must never fail a user request: `recordUserEvent` swallows all errors (log + Sentry), mirroring `recordAudit` in `src/lib/audit.ts`.
- All graph/LLM work is best-effort and gated on `ragEnabled()` / `embeddingsConfigured()` from `src/lib/rag/get-store.ts` and `src/lib/rag/embeddings.ts` — every new job must no-op cleanly when unconfigured.
- Retention: `user_events` pruned after 180 days (env `BEHAVIOR_RETENTION_DAYS`), graph-first like executions.
- Tests: node:test files in `__tests__` dirs; run a single file with `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <file>`; full suite with `npm test`. Repo style is pure functions + injectable seams (see `SynthesisOverrides` in `src/lib/intelligence/suggest-workflows.ts`) — no DB in tests.
- Migrations are hand-authored SQL in `prisma/migrations/<timestamp>_<name>/migration.sql` (repo convention: hand-rounded timestamps like `20260716120000_assistant_chat`), then `npx prisma generate`.
- Commit after every task with a conventional-commits message ending in `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: `UserEvent` Prisma model + migration

**Files:**
- Modify: `prisma/schema.prisma` (add model after `ActivityEvent`, ~line 784; add back-relation on `Organization`)
- Create: `prisma/migrations/20260717090000_user_events/migration.sql`

**Interfaces:**
- Produces: Prisma model `UserEvent` (client accessor `prisma.userEvent`) with fields `id, organizationId, userId, kind, resourceType, resourceId, context, occurredAt, indexedAt` — every later task depends on these exact names.

- [ ] **Step 1: Add the model to `prisma/schema.prisma`** (directly after the `ActivityEvent` model block):

```prisma
/// In-app behavior ledger (user behavior learning spec §1). Immutable rows,
/// references-only context (never raw prompt/message text). indexedAt is the
/// graph-projection gate: null until indexed, so sweeps make the graph
/// rebuildable from this ledger.
model UserEvent {
  id             String    @id @default(cuid())
  organizationId String    @db.Uuid
  userId         String
  kind           String // bounded list — see USER_EVENT_KINDS in src/lib/behavior/record-event.ts
  resourceType   String? // 'agent' | 'flow' | 'suggestion' | ...
  resourceId     String?
  context        Json      @default("{}")
  occurredAt     DateTime  @default(now()) @db.Timestamptz(6)
  indexedAt      DateTime?

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId, occurredAt])
  @@index([userId, occurredAt])
  @@index([organizationId, indexedAt])
  @@map("user_events")
}
```

- [ ] **Step 2: Add the back-relation** to the `Organization` model's relation list (find the line with `activityEvents ActivityEvent[]` and add alongside):

```prisma
  userEvents      UserEvent[]
```

- [ ] **Step 3: Create `prisma/migrations/20260717090000_user_events/migration.sql`:**

```sql
CREATE TABLE "user_events" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "context" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "indexedAt" TIMESTAMP(3),

    CONSTRAINT "user_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_events_organizationId_occurredAt_idx" ON "user_events"("organizationId", "occurredAt");
CREATE INDEX "user_events_userId_occurredAt_idx" ON "user_events"("userId", "occurredAt");
CREATE INDEX "user_events_organizationId_indexedAt_idx" ON "user_events"("organizationId", "indexedAt");

ALTER TABLE "user_events" ADD CONSTRAINT "user_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

(Verify the referenced table name: open `prisma/schema.prisma` and confirm `Organization` maps to `organizations` via `@@map`; if the existing `activity_events` migration references a different casing, copy that file's FK line style exactly.)

- [ ] **Step 4: Regenerate the client and typecheck**

Run: `npx prisma generate && npx tsc --noEmit`
Expected: generate succeeds; typecheck passes (no code references the model yet).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260717090000_user_events
git commit -m "feat(behavior): add user_events ledger model

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `recordUserEvent` capture helper (TDD)

**Files:**
- Create: `src/lib/behavior/record-event.ts`
- Test: `src/lib/behavior/__tests__/record-event.test.ts`

**Interfaces:**
- Produces: `USER_EVENT_KINDS` (readonly array), `type UserEventKind`, `interface UserEventInput { organizationId; userId; kind; resourceType?; resourceId?; context? }`, `recordUserEvent(input, deps?: { create?: (data: UserEventCreateData) => Promise<unknown> }): Promise<void>` — never throws. All capture tasks (3, 4) call `recordUserEvent`.

- [ ] **Step 1: Write the failing test** at `src/lib/behavior/__tests__/record-event.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recordUserEvent, USER_EVENT_KINDS, type UserEventCreateData } from '@/lib/behavior/record-event'

test('writes the event row with defaults applied', async () => {
  const rows: UserEventCreateData[] = []
  await recordUserEvent(
    { organizationId: 'org-1', userId: 'u-1', kind: 'agent_run_manual', resourceType: 'agent', resourceId: 'a-1', context: { name: 'Pipeline review' } },
    { create: async (data) => { rows.push(data) } },
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].organizationId, 'org-1')
  assert.equal(rows[0].userId, 'u-1')
  assert.equal(rows[0].kind, 'agent_run_manual')
  assert.equal(rows[0].resourceType, 'agent')
  assert.equal(rows[0].resourceId, 'a-1')
  assert.deepEqual(rows[0].context, { name: 'Pipeline review' })
})

test('optional fields default to null / empty context', async () => {
  const rows: UserEventCreateData[] = []
  await recordUserEvent(
    { organizationId: 'org-1', userId: 'u-1', kind: 'assistant_prompt' },
    { create: async (data) => { rows.push(data) } },
  )
  assert.equal(rows[0].resourceType, null)
  assert.equal(rows[0].resourceId, null)
  assert.deepEqual(rows[0].context, {})
})

test('NEVER throws when the write fails', async () => {
  await assert.doesNotReject(
    recordUserEvent(
      { organizationId: 'org-1', userId: 'u-1', kind: 'flow_created' },
      { create: async () => { throw new Error('db down') } },
    ),
  )
})

test('kind list is the bounded spec set', () => {
  assert.deepEqual([...USER_EVENT_KINDS].sort(), [
    'agent_created', 'agent_edited', 'agent_run_manual',
    'assistant_prompt', 'connection_added', 'copilot_prompt',
    'flow_created', 'flow_edited', 'flow_published', 'flow_run_manual',
    'suggestion_accepted', 'suggestion_dismissed', 'template_used',
  ])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/behavior/__tests__/record-event.test.ts`
Expected: FAIL — cannot resolve `@/lib/behavior/record-event`.

- [ ] **Step 3: Implement `src/lib/behavior/record-event.ts`:**

```ts
/**
 * In-app behavior capture (user behavior learning spec §1). Fire-and-forget:
 * a capture failure must never break the user action it records — errors are
 * swallowed, logged, and reported to Sentry (mirrors recordAudit).
 *
 * Privacy contract: `context` carries references and metadata only (resource
 * names, message ids, flags) — NEVER raw prompt/message content.
 */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'

export const USER_EVENT_KINDS = [
  'agent_run_manual', 'agent_created', 'agent_edited',
  'flow_created', 'flow_edited', 'flow_published', 'flow_run_manual',
  'copilot_prompt', 'assistant_prompt',
  'suggestion_accepted', 'suggestion_dismissed',
  'template_used', 'connection_added',
] as const

export type UserEventKind = (typeof USER_EVENT_KINDS)[number]

export interface UserEventInput {
  organizationId: string
  userId: string
  kind: UserEventKind
  resourceType?: string | null
  resourceId?: string | null
  /** References only (ids, names, flags) — never raw prompt/message content. */
  context?: Record<string, unknown>
}

export interface UserEventCreateData {
  organizationId: string
  userId: string
  kind: string
  resourceType: string | null
  resourceId: string | null
  context: Record<string, unknown>
}

export async function recordUserEvent(
  input: UserEventInput,
  deps?: { create?: (data: UserEventCreateData) => Promise<unknown> },
): Promise<void> {
  const create =
    deps?.create ?? ((data: UserEventCreateData) => prisma.userEvent.create({ data: { ...data, context: data.context as never } }))
  try {
    await create({
      organizationId: input.organizationId,
      userId: input.userId,
      kind: input.kind,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      context: input.context ?? {},
    })
  } catch (error) {
    apiLogger.warn('behavior.recordUserEvent failed', {
      kind: input.kind,
      organizationId: input.organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
    captureError(error, { scope: 'behavior', kind: input.kind })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/behavior/__tests__/record-event.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/behavior
git commit -m "feat(behavior): add recordUserEvent capture helper

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Capture wiring — agent and flow routes

**Files:**
- Modify: `src/app/api/agents/route.ts` (POST ~line 104, PUT ~line 143)
- Modify: `src/app/api/agents/[id]/execute/route.ts` (POST ~line 24)
- Modify: `src/app/api/flows/route.ts` (POST ~line 70, PUT ~line 89)
- Modify: `src/app/api/flows/[id]/publish/route.ts` (POST ~line 18)
- Modify: `src/app/api/flows/[id]/execute/route.ts` (POST ~line 14)
- Modify: `src/app/api/flows/[id]/dismiss-suggestion/route.ts` (POST ~line 21)

**Interfaces:**
- Consumes: `recordUserEvent`, `UserEventInput` from Task 2. All handlers are `withAuthenticatedApi(async (request, auth) => ...)` with `auth.organizationId` and `auth.dbUser.id`.

All insertions are `await recordUserEvent({...})` placed immediately before the handler's success `return` (after the DB write succeeded). It never throws, so no try/catch needed at call sites. Add the import `import { recordUserEvent } from '@/lib/behavior/record-event'` to each file.

- [ ] **Step 1: `src/app/api/agents/route.ts`** — in POST, after `void indexAgentRow(agent)` and before the `return`:

```ts
  await recordUserEvent({
    organizationId: auth.organizationId, userId: auth.dbUser.id,
    kind: 'agent_created', resourceType: 'agent', resourceId: agent.id,
    context: { name: data.title || agent.description },
  })
```

In PUT, same position (after `void indexAgentRow(agent)`):

```ts
  await recordUserEvent({
    organizationId: auth.organizationId, userId: auth.dbUser.id,
    kind: 'agent_edited', resourceType: 'agent', resourceId: agent.id,
    context: { name: (agent.metadata as { title?: string } | null)?.title || agent.description },
  })
```

- [ ] **Step 2: `src/app/api/agents/[id]/execute/route.ts`** — immediately after the `prisma.agentExecution.create` call (before the `if (inlineExecution)` branch, so both inline and queued paths are captured):

```ts
  await recordUserEvent({
    organizationId: auth.organizationId, userId: auth.dbUser.id,
    kind: 'agent_run_manual', resourceType: 'agent', resourceId: agent.id,
    context: { executionId: execution.id, name: (agent.metadata as { title?: string } | null)?.title || agent.description },
  })
```

- [ ] **Step 3: `src/app/api/flows/route.ts`** — in POST, after `prisma.flow.create` and before the `return`:

```ts
  await recordUserEvent({
    organizationId: auth.organizationId, userId: auth.dbUser.id,
    kind: 'flow_created', resourceType: 'flow', resourceId: flow.id,
    context: { name: flow.name },
  })
```

In PUT, after the final `prisma.flow.findFirst` re-read succeeds (the `if (!flow) throw` guard) and before the `return`:

```ts
  await recordUserEvent({
    organizationId: auth.organizationId, userId: auth.dbUser.id,
    kind: 'flow_edited', resourceType: 'flow', resourceId: flow.id,
    context: { name: flow.name, graphChanged: body.graph !== undefined },
  })
```

- [ ] **Step 4: `src/app/api/flows/[id]/publish/route.ts`** — after the existing `recordAudit` call in the publish (non-revert) path:

```ts
  await recordUserEvent({
    organizationId: auth.organizationId, userId: auth.dbUser.id,
    kind: 'flow_published', resourceType: 'flow', resourceId: id,
    context: { name: existing.name, version: nextVersion },
  })
  // Activating a suggested draft = accepting the suggestion (spec §4 feedback loop).
  const publishedMeta = existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
    ? (existing.metadata as Record<string, unknown>) : {}
  if (publishedMeta.suggested === true) {
    await recordUserEvent({
      organizationId: auth.organizationId, userId: auth.dbUser.id,
      kind: 'suggestion_accepted', resourceType: 'flow', resourceId: id,
      context: { name: existing.name },
    })
  }
```

- [ ] **Step 5: `src/app/api/flows/[id]/execute/route.ts`** — capture only NEW manual runs, not replies resuming a paused run. Insert right before the call to `dispatchFlowExecution` (locate it in the latter half of the handler), guarded:

```ts
  if (!parsed.flowRunId) {
    await recordUserEvent({
      organizationId: auth.organizationId, userId: auth.dbUser.id,
      kind: 'flow_run_manual', resourceType: 'flow', resourceId: flow.id,
    })
  }
```

- [ ] **Step 6: `src/app/api/flows/[id]/dismiss-suggestion/route.ts`** — after `prisma.flow.deleteMany`, before `return { success: true }`:

```ts
  await recordUserEvent({
    organizationId: auth.organizationId, userId: auth.dbUser.id,
    kind: 'suggestion_dismissed', resourceType: 'flow', resourceId: id,
    context: { sourceMemoryId },
  })
```

- [ ] **Step 7: Typecheck and run the suite**

Run: `npx tsc --noEmit && npm test`
Expected: clean typecheck; existing tests still pass (capture is additive).

- [ ] **Step 8: Commit**

```bash
git add src/app/api/agents src/app/api/flows
git commit -m "feat(behavior): capture agent/flow user events in API routes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Capture wiring — chat routes, templates, connections

**Files:**
- Modify: `src/app/api/assistant/chat/route.ts` (POST ~line 126)
- Modify: `src/app/api/flows/copilot/chat/route.ts` (POST ~line 61)
- Modify: template-instantiation and connection-creation sites (located via grep in Step 3/4)

**Interfaces:**
- Consumes: `recordUserEvent` from Task 2.

- [ ] **Step 1: `src/app/api/assistant/chat/route.ts` POST** — after the user's message row is persisted (find the `assistantChatMessage.create` for the `user` role; capture references its id, never its content):

```ts
  await recordUserEvent({
    organizationId: auth.organizationId, userId: auth.dbUser.id,
    kind: 'assistant_prompt', resourceType: 'assistant_message', resourceId: userMessage.id,
    context: { sessionId: userMessage.sessionId },
  })
```

Adjust `userMessage` to the actual variable name holding the created user-role message row in that handler. Additionally, if this handler creates an agent from a draft (`createAgentFromDraft` / `createdAgent` metadata), add next to that success path:

```ts
  await recordUserEvent({
    organizationId: auth.organizationId, userId: auth.dbUser.id,
    kind: 'agent_created', resourceType: 'agent', resourceId: createdAgentId,
    context: { via: 'assistant' },
  })
```

(`createdAgentId` = the id of the agent the handler just created; use the local variable present at that site.)

- [ ] **Step 2: `src/app/api/flows/copilot/chat/route.ts` POST** — after request parsing succeeds and before the model call (the copilot may not persist messages; capture the ask itself with references only):

```ts
  await recordUserEvent({
    organizationId: auth.organizationId, userId: auth.dbUser.id,
    kind: 'copilot_prompt', resourceType: 'flow',
    resourceId: typeof (body as { flowId?: unknown }).flowId === 'string' ? (body as { flowId: string }).flowId : null,
  })
```

Adjust the resourceId expression to the handler's actual parsed-body shape (if it has a typed `flowId`/`id` field, use it directly; if none exists, pass `resourceId: null`).

- [ ] **Step 3: `template_used`** — Run: `grep -rn "agentTemplate" src/app/api --include=route.ts -l` and open the route that instantiates a template into an agent (creation from template, not CRUD). After its create succeeds, add:

```ts
  await recordUserEvent({
    organizationId: auth.organizationId, userId: auth.dbUser.id,
    kind: 'template_used', resourceType: 'agent_template', resourceId: templateId,
  })
```

(`templateId` = that handler's template id variable.) If no instantiation route exists (templates are only browsed), skip this step and note it in the commit message — the kind stays reserved in `USER_EVENT_KINDS`.

- [ ] **Step 4: `connection_added`** — Run: `grep -rn "mcpConnection.create\|nangoConnection.create" src/app --include=*.ts`. In each authenticated route handler that creates a connection (skip webhook/system callers with no `auth`), add after the create:

```ts
  await recordUserEvent({
    organizationId: auth.organizationId, userId: auth.dbUser.id,
    kind: 'connection_added', resourceType: 'connection', resourceId: connection.id,
    context: { provider: providerLabel },
  })
```

(`connection` / `providerLabel` = that site's local variables for the created row and its provider/name.)

- [ ] **Step 5: Typecheck + suite, then commit**

Run: `npx tsc --noEmit && npm test`
Expected: clean.

```bash
git add src/app/api
git commit -m "feat(behavior): capture chat, template, and connection user events

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Graph projection for user events (TDD)

**Files:**
- Modify: `src/lib/rag/indexer.ts` (extend `nodeIds`, ~line 22)
- Create: `src/lib/behavior/index-user-event.ts`
- Test: `src/lib/behavior/__tests__/index-user-event.test.ts`

**Interfaces:**
- Consumes: `commitGraph`, `nodeIds`, `PendingNode` from `src/lib/rag/indexer.ts`; `ragEnabled`, `graphRagPersistent`, `getGraphRagStore` from `src/lib/rag/get-store.ts`; `GraphEdge` from `src/lib/rag/store.ts`.
- Produces: `type PersistedUserEvent`, `userEventNodeId(id): string` (`uevent:<id>`), `userEventGraphParts(event, previousEventId?): { nodes; edges }` (pure), `indexUserEvents(events, db?): Promise<void>`, `sweepUnindexedUserEvents(db?, cap?): Promise<number>`, `removeUserEventNodesFromGraph(groups: Array<{organizationId; eventIds: string[]}>): Promise<void>`. Tasks 9 (evidence edges), 12 (cron/retention) depend on these names.

- [ ] **Step 1: Add two id builders to `nodeIds` in `src/lib/rag/indexer.ts`:**

```ts
  flow: (id: string) => `flow:${id}`,
  userEvent: (id: string) => `uevent:${id}`,
```

- [ ] **Step 2: Write the failing test** at `src/lib/behavior/__tests__/index-user-event.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { userEventGraphParts, type PersistedUserEvent } from '@/lib/behavior/index-user-event'

const base: PersistedUserEvent = {
  id: 'ue-1', organizationId: 'org-1', userId: 'u-1', kind: 'agent_run_manual',
  resourceType: 'agent', resourceId: 'a-1',
  context: { name: 'Pipeline review' }, occurredAt: new Date('2026-07-10T09:00:00Z'),
}

test('projects private actor→activity, edge to existing agent node, no agent stub', () => {
  const { nodes, edges } = userEventGraphParts(base)
  const activity = nodes.find((n) => n.id === 'uevent:ue-1')
  assert.ok(activity)
  assert.equal(activity.type, 'activity')
  assert.equal(activity.visibility, 'private')
  assert.equal(activity.ownerUserId, 'u-1')
  assert.ok(activity.text.includes('agent_run_manual'))
  assert.ok(activity.text.includes('Pipeline review'))
  const actor = nodes.find((n) => n.id === 'actor:sublime:u-1')
  assert.ok(actor)
  assert.equal(actor.visibility, 'private')
  // Agents are already indexed by indexAgent — emitting a stub here would
  // clobber the rich agent node text on upsert. Edge only.
  assert.ok(!nodes.some((n) => n.id === 'agent:a-1'))
  assert.deepEqual(
    edges.map((e) => `${e.from}-${e.rel}->${e.to}`).sort(),
    ['actor:sublime:u-1-performed->uevent:ue-1', 'uevent:ue-1-on->agent:a-1'].sort(),
  )
})

test('flow resource gets a stub entity node (no other indexer owns flow nodes)', () => {
  const { nodes, edges } = userEventGraphParts({ ...base, id: 'ue-2', kind: 'flow_edited', resourceType: 'flow', resourceId: 'f-1', context: { name: 'Follow-ups' } })
  const stub = nodes.find((n) => n.id === 'flow:f-1')
  assert.ok(stub)
  assert.equal(stub.type, 'entity')
  assert.ok(stub.text.includes('Follow-ups'))
  assert.ok(edges.some((e) => e.from === 'uevent:ue-2' && e.rel === 'on' && e.to === 'flow:f-1'))
})

test('preceded_by chains to the prior event of the SAME user', () => {
  const { edges } = userEventGraphParts({ ...base, id: 'ue-3' }, 'ue-1')
  assert.ok(edges.some((e) => e.from === 'uevent:ue-3' && e.rel === 'preceded_by' && e.to === 'uevent:ue-1'))
})

test('resource-less events (assistant_prompt) project actor→activity only', () => {
  const { nodes, edges } = userEventGraphParts({ ...base, id: 'ue-4', kind: 'assistant_prompt', resourceType: null, resourceId: null, context: {} })
  assert.equal(nodes.length, 2)
  assert.deepEqual(edges.map((e) => e.rel), ['performed'])
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/behavior/__tests__/index-user-event.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/lib/behavior/index-user-event.ts`:**

```ts
/**
 * Graph projection for in-app user events (spec §2):
 *   (actor:sublime:<userId>) -[:performed]-> (uevent activity) -[:on]-> (agent|flow entity)
 * plus per-user preceded_by chains (routine/sequence mining substrate).
 * Activity and actor nodes are PRIVATE to the user; agent/flow entities stay
 * shared (they are org objects that already exist in the graph).
 * Mirrors indexActivity: pure parts + best-effort side-effecting wrapper.
 */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { commitGraph, nodeIds, type PendingNode } from '@/lib/rag/indexer'
import { getGraphRagStore, graphRagPersistent, ragEnabled } from '@/lib/rag/get-store'
import type { GraphEdge } from '@/lib/rag/store'

export type PersistedUserEvent = {
  id: string
  organizationId: string
  userId: string
  kind: string
  resourceType: string | null
  resourceId: string | null
  context: unknown
  occurredAt: Date
}

export const userEventNodeId = (id: string) => nodeIds.userEvent(id)

function contextName(context: unknown): string | null {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null
  const name = (context as { name?: unknown }).name
  return typeof name === 'string' && name ? name : null
}

/** Entity node id for the event's resource; agents/flows use canonical ids. */
function resourceNodeId(event: PersistedUserEvent): string | null {
  if (!event.resourceType || !event.resourceId) return null
  if (event.resourceType === 'agent') return nodeIds.agent(event.resourceId)
  if (event.resourceType === 'flow') return nodeIds.flow(event.resourceId)
  return nodeIds.entity('sublime', event.resourceType, event.resourceId)
}

export function userEventGraphParts(
  event: PersistedUserEvent,
  previousEventId?: string | null,
): { nodes: PendingNode[]; edges: GraphEdge[] } {
  const org = event.organizationId
  const activityId = userEventNodeId(event.id)
  const actorId = nodeIds.actor('sublime', event.userId)
  const name = contextName(event.context)
  const target = event.resourceType ? `${event.resourceType} ${name ?? event.resourceId ?? ''}`.trim() : ''

  const nodes: PendingNode[] = [
    {
      id: activityId, type: 'activity',
      text: `User ${event.kind}${target ? ` ${target}` : ''} in Sublime.`,
      props: { kind: event.kind, resourceType: event.resourceType, resourceId: event.resourceId, occurredAt: event.occurredAt.toISOString(), eventId: event.id },
      ownerUserId: event.userId, visibility: 'private',
    },
    {
      id: actorId, type: 'actor',
      text: `Sublime user ${event.userId}`,
      props: { source: 'sublime', actorRef: event.userId },
      ownerUserId: event.userId, visibility: 'private',
    },
  ]

  const edges: GraphEdge[] = [{ organizationId: org, from: actorId, to: activityId, rel: 'performed' }]

  const entityId = resourceNodeId(event)
  if (entityId) {
    // Agents already have rich nodes from indexAgent — an upsert stub here
    // would overwrite them. Everything else gets a lightweight entity stub.
    if (event.resourceType !== 'agent') {
      nodes.push({
        id: entityId, type: 'entity',
        text: `${event.resourceType} ${name ?? event.resourceId} (sublime)`,
        props: { source: 'sublime', entityType: event.resourceType, entityRef: event.resourceId },
      })
    }
    edges.push({ organizationId: org, from: activityId, to: entityId, rel: 'on' })
  }
  if (previousEventId) {
    edges.push({ organizationId: org, from: activityId, to: userEventNodeId(previousEventId), rel: 'preceded_by' })
  }
  return { nodes, edges }
}

/** Best-effort projection; stamps indexedAt so the sweep skips done rows. */
export async function indexUserEvents(events: PersistedUserEvent[], db = prisma): Promise<void> {
  if (!ragEnabled() || events.length === 0) return
  for (const event of events) {
    try {
      const prior = await db.userEvent.findFirst({
        where: { userId: event.userId, organizationId: event.organizationId, occurredAt: { lt: event.occurredAt }, NOT: { id: event.id } },
        orderBy: { occurredAt: 'desc' },
        select: { id: true },
      })
      const { nodes, edges } = userEventGraphParts(event, prior?.id ?? null)
      await commitGraph(event.organizationId, nodes, edges)
      await db.userEvent.update({ where: { id: event.id }, data: { indexedAt: new Date() } })
    } catch (error) {
      apiLogger.warn('behavior.indexUserEvents failed', { eventId: event.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** Re-index sweep over unprojected rows (indexedAt IS NULL). Returns count attempted. */
export async function sweepUnindexedUserEvents(db = prisma, cap = 200): Promise<number> {
  if (!ragEnabled()) return 0
  const rows = await db.userEvent.findMany({
    where: { indexedAt: null },
    orderBy: { occurredAt: 'asc' },
    take: cap,
  })
  if (rows.length === 0) return 0
  await indexUserEvents(rows as PersistedUserEvent[], db)
  return rows.length
}

/** Retention parity: drop uevent nodes for rows being pruned. Best-effort. */
export async function removeUserEventNodesFromGraph(
  groups: Array<{ organizationId: string; eventIds: string[] }>,
): Promise<void> {
  if (!graphRagPersistent()) return
  const store = getGraphRagStore()
  for (const group of groups) {
    if (group.eventIds.length === 0) continue
    try {
      await store.deleteNodes(group.organizationId, group.eventIds.map(userEventNodeId))
    } catch (error) {
      apiLogger.warn('behavior.removeUserEventNodesFromGraph failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }
}
```

- [ ] **Step 5: Run tests, typecheck**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/behavior/__tests__/index-user-event.test.ts && npx tsc --noEmit`
Expected: 4 passing; clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add src/lib/rag/indexer.ts src/lib/behavior
git commit -m "feat(behavior): project user events into the graph with private visibility

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: `UserPattern` + `UserSuggestion` models + migration

**Files:**
- Modify: `prisma/schema.prisma` (add both models after `UserEvent`; add `userPatterns UserPattern[]` and `userSuggestions UserSuggestion[]` back-relations on `Organization`)
- Create: `prisma/migrations/20260717100000_user_patterns_suggestions/migration.sql`

**Interfaces:**
- Produces: `prisma.userPattern` with `id, organizationId, userId, slug, kind, summary, occurrenceCount, firstSeenAt, lastSeenAt, evidence, status, createdAt, updatedAt` and unique `(userId, slug)`; `prisma.userSuggestion` with `id, organizationId, userId, kind, title, description, flowId, targetType, targetId, sourcePatternSlugs, evidence, status, createdAt, updatedAt`.

- [ ] **Step 1: Add to `prisma/schema.prisma`:**

```prisma
/// Durable per-user behavior pattern (spec §3). Postgres is the source of
/// truth (the graph projection is a retrieval view). status 'dismissed'
/// permanently suppresses the slug and similar summaries.
model UserPattern {
  id              String   @id @default(cuid())
  organizationId  String   @db.Uuid
  userId          String
  slug            String // deterministic, from the miner
  kind            String // 'sequence' | 'temporal' | 'friction' | 'intent'
  summary         String
  occurrenceCount Int
  firstSeenAt     DateTime @db.Timestamptz(6)
  lastSeenAt      DateTime @db.Timestamptz(6)
  evidence        Json     @default("[]") // supporting user_event ids
  status          String   @default("open") // open | dismissed
  createdAt       DateTime @default(now()) @db.Timestamptz(6)
  updatedAt       DateTime @updatedAt @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@unique([userId, slug])
  @@index([organizationId, userId, status])
  @@map("user_patterns")
}

/// One quiet, evidence-cited suggestion per user at a time (spec §4).
model UserSuggestion {
  id                 String   @id @default(cuid())
  organizationId     String   @db.Uuid
  userId             String
  kind               String // 'new_flow' | 'enhancement'
  title              String
  description        String
  flowId             String? // draft flow created for new_flow suggestions
  targetType         String? // 'agent' | 'flow' (enhancements)
  targetId           String?
  sourcePatternSlugs Json     @default("[]")
  evidence           Json     @default("[]") // rendered "why this exists" lines
  status             String   @default("open") // open | accepted | dismissed
  createdAt          DateTime @default(now()) @db.Timestamptz(6)
  updatedAt          DateTime @updatedAt @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId, userId, status])
  @@map("user_suggestions")
}
```

- [ ] **Step 2: Create `prisma/migrations/20260717100000_user_patterns_suggestions/migration.sql`:**

```sql
CREATE TABLE "user_patterns" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "occurrenceCount" INTEGER NOT NULL,
    "firstSeenAt" TIMESTAMPTZ(6) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_patterns_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_patterns_userId_slug_key" ON "user_patterns"("userId", "slug");
CREATE INDEX "user_patterns_organizationId_userId_status_idx" ON "user_patterns"("organizationId", "userId", "status");
ALTER TABLE "user_patterns" ADD CONSTRAINT "user_patterns_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "user_suggestions" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "flowId" TEXT,
    "targetType" TEXT,
    "targetId" TEXT,
    "sourcePatternSlugs" JSONB NOT NULL DEFAULT '[]',
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_suggestions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_suggestions_organizationId_userId_status_idx" ON "user_suggestions"("organizationId", "userId", "status");
ALTER TABLE "user_suggestions" ADD CONSTRAINT "user_suggestions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: `npx prisma generate && npx tsc --noEmit`** — expect clean.

- [ ] **Step 4: Commit**

```bash
git add prisma
git commit -m "feat(behavior): add user_patterns and user_suggestions models

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Deterministic pattern miner (TDD)

**Files:**
- Create: `src/lib/behavior/mine-patterns.ts`
- Test: `src/lib/behavior/__tests__/mine-patterns.test.ts`

**Interfaces:**
- Produces: `type LedgerEvent = Pick<PersistedUserEvent, 'id'|'userId'|'kind'|'resourceType'|'resourceId'|'context'|'occurredAt'>`, `interface PatternCandidate { slug; kind: 'sequence'|'temporal'|'friction'|'intent'; summary; occurrenceCount; firstSeenAt: Date; lastSeenAt: Date; evidenceEventIds: string[] }`, `mineUserPatternCandidates(events: LedgerEvent[]): PatternCandidate[]` (pure; events assumed sorted ascending by occurredAt), `mineIntentClusters(prompts: Array<{eventId; text; occurredAt: Date}>, embed: (texts: string[]) => Promise<number[][]>): Promise<PatternCandidate[]>`.

The miner computes REAL statistics — occurrence counts and evidence ids are facts, never LLM output. This is what makes the eligibility gate trustworthy.

Mining rules (v1):
- **sequence**: two events by the same user on different resources within 60 minutes form an ordered pair keyed `seq:<kindA>:<resA>>><kindB>:<resB>`; each occurrence contributes both event ids as evidence. Resource key is `${resourceType}:${resourceId}` (or the kind itself when resource-less). Only pairs of *adjacent* events count (no skip-pairs — keeps counts honest).
- **temporal**: same `(kind, resourceKey)` recurring on the same UTC weekday, keyed `routine:<kind>:<resKey>:<weekday>`; occurrences on ≥ distinct dates only (two runs the same Monday count once).
- **friction**: ≥3 `agent_run_manual` events on the same agent within any rolling 60-minute window (a retry burst), keyed `friction:agent:<id>`; counts the number of distinct burst windows.
- **intent** (in `mineIntentClusters`): greedy clustering of prompt texts by cosine ≥ 0.80; clusters with ≥3 members become candidates keyed `intent:<eventId-of-first-member>`; summary is the shortest member text truncated to 140 chars.

- [ ] **Step 1: Write the failing test** at `src/lib/behavior/__tests__/mine-patterns.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mineUserPatternCandidates, mineIntentClusters, type LedgerEvent } from '@/lib/behavior/mine-patterns'

const at = (iso: string) => new Date(iso)
let n = 0
const ev = (kind: string, resourceType: string | null, resourceId: string | null, occurredAt: Date): LedgerEvent => ({
  id: `e${++n}`, userId: 'u-1', kind, resourceType, resourceId, context: {}, occurredAt,
})

test('sequence: adjacent pairs within 60min accumulate real counts + evidence', () => {
  const events = [
    ev('agent_run_manual', 'agent', 'a-1', at('2026-06-01T09:00:00Z')),
    ev('flow_edited', 'flow', 'f-1', at('2026-06-01T09:10:00Z')),
    ev('agent_run_manual', 'agent', 'a-1', at('2026-06-08T09:00:00Z')),
    ev('flow_edited', 'flow', 'f-1', at('2026-06-08T09:05:00Z')),
    ev('agent_run_manual', 'agent', 'a-1', at('2026-06-15T09:00:00Z')),
    ev('flow_edited', 'flow', 'f-1', at('2026-06-15T09:20:00Z')),
  ]
  const seq = mineUserPatternCandidates(events).find((c) => c.kind === 'sequence')
  assert.ok(seq)
  assert.equal(seq.occurrenceCount, 3)
  assert.equal(seq.evidenceEventIds.length, 6)
  assert.equal(seq.firstSeenAt.toISOString(), '2026-06-01T09:00:00.000Z')
  assert.equal(seq.lastSeenAt.toISOString(), '2026-06-15T09:20:00.000Z')
})

test('sequence: pairs more than 60min apart do not count', () => {
  const events = [
    ev('agent_run_manual', 'agent', 'a-1', at('2026-06-01T09:00:00Z')),
    ev('flow_edited', 'flow', 'f-1', at('2026-06-01T11:00:00Z')),
  ]
  assert.equal(mineUserPatternCandidates(events).filter((c) => c.kind === 'sequence').length, 0)
})

test('temporal: same action+resource on the same weekday across distinct dates', () => {
  const events = [
    ev('agent_run_manual', 'agent', 'a-2', at('2026-06-01T09:00:00Z')), // Monday
    ev('agent_run_manual', 'agent', 'a-2', at('2026-06-08T09:30:00Z')), // Monday
    ev('agent_run_manual', 'agent', 'a-2', at('2026-06-08T09:45:00Z')), // same date — dedupes
    ev('agent_run_manual', 'agent', 'a-2', at('2026-06-15T10:00:00Z')), // Monday
  ]
  const routine = mineUserPatternCandidates(events).find((c) => c.kind === 'temporal')
  assert.ok(routine)
  assert.equal(routine.occurrenceCount, 3)
  assert.ok(routine.slug.endsWith(':1')) // UTC weekday 1 = Monday
})

test('friction: >=3 manual runs of one agent within 60 minutes', () => {
  const events = [
    ev('agent_run_manual', 'agent', 'a-3', at('2026-06-02T10:00:00Z')),
    ev('agent_run_manual', 'agent', 'a-3', at('2026-06-02T10:10:00Z')),
    ev('agent_run_manual', 'agent', 'a-3', at('2026-06-02T10:20:00Z')),
  ]
  const friction = mineUserPatternCandidates(events).find((c) => c.kind === 'friction')
  assert.ok(friction)
  assert.equal(friction.slug, 'friction:agent:a-3')
})

test('intent: greedy clusters of similar prompts (fake embeddings)', async () => {
  const embed = async (texts: string[]) =>
    texts.map((t) => (t.startsWith('summarize') ? [1, 0] : [0, 1]))
  const prompts = [
    { eventId: 'p1', text: 'summarize my pipeline', occurredAt: at('2026-06-01T09:00:00Z') },
    { eventId: 'p2', text: 'summarize pipeline again', occurredAt: at('2026-06-05T09:00:00Z') },
    { eventId: 'p3', text: 'summarize the pipeline please', occurredAt: at('2026-06-09T09:00:00Z') },
    { eventId: 'p4', text: 'draft an email', occurredAt: at('2026-06-09T10:00:00Z') },
  ]
  const clusters = await mineIntentClusters(prompts, embed)
  assert.equal(clusters.length, 1)
  assert.equal(clusters[0].occurrenceCount, 3)
  assert.deepEqual(clusters[0].evidenceEventIds, ['p1', 'p2', 'p3'])
})
```

- [ ] **Step 2: Run to verify FAIL** (module not found).

- [ ] **Step 3: Implement `src/lib/behavior/mine-patterns.ts`:**

```ts
/**
 * Deterministic behavior-pattern miner (spec §3). Counts and evidence are
 * computed facts from the ledger — the LLM never asserts a statistic. Input
 * events must be sorted ascending by occurredAt.
 */
import { cosineSimilarity } from '@/lib/rag/embeddings'
import type { PersistedUserEvent } from './index-user-event'

export type LedgerEvent = Pick<PersistedUserEvent, 'id' | 'userId' | 'kind' | 'resourceType' | 'resourceId' | 'context' | 'occurredAt'>

export interface PatternCandidate {
  slug: string
  kind: 'sequence' | 'temporal' | 'friction' | 'intent'
  summary: string
  occurrenceCount: number
  firstSeenAt: Date
  lastSeenAt: Date
  evidenceEventIds: string[]
}

const SEQUENCE_WINDOW_MS = 60 * 60 * 1000
const FRICTION_WINDOW_MS = 60 * 60 * 1000
export const INTENT_SIMILARITY_THRESHOLD = 0.8

const resourceKey = (e: LedgerEvent) => (e.resourceType && e.resourceId ? `${e.resourceType}:${e.resourceId}` : e.kind)
const eventName = (e: LedgerEvent): string => {
  const ctx = e.context
  const name = ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? (ctx as { name?: unknown }).name : null
  return typeof name === 'string' && name ? `"${name}"` : (e.resourceId ?? '')
}
const dateOf = (d: Date) => d.toISOString().slice(0, 10)

type Acc = { count: number; first: Date; last: Date; evidence: string[]; summary: string }
const bump = (map: Map<string, Acc>, key: string, when: Date, evidence: string[], summary: string) => {
  const acc = map.get(key)
  if (acc) {
    acc.count += 1
    acc.last = when > acc.last ? when : acc.last
    acc.first = when < acc.first ? when : acc.first
    acc.evidence.push(...evidence)
  } else {
    map.set(key, { count: 1, first: when, last: when, evidence: [...evidence], summary })
  }
}

export function mineUserPatternCandidates(events: LedgerEvent[]): PatternCandidate[] {
  const sequences = new Map<string, Acc>()
  const temporal = new Map<string, Acc>()
  const temporalDates = new Map<string, Set<string>>()
  const friction = new Map<string, Acc>()

  for (let i = 0; i < events.length; i++) {
    const event = events[i]

    // sequence: adjacent pair with the NEXT event when close in time and on a different resource
    const next = events[i + 1]
    if (next && next.occurredAt.getTime() - event.occurredAt.getTime() <= SEQUENCE_WINDOW_MS && resourceKey(next) !== resourceKey(event)) {
      const slug = `seq:${event.kind}:${resourceKey(event)}>>${next.kind}:${resourceKey(next)}`
      bump(sequences, slug, next.occurredAt, [event.id, next.id],
        `Does ${event.kind} on ${eventName(event)} then ${next.kind} on ${eventName(next)} shortly after`)
      // extend first back to the pair's start
      const acc = sequences.get(slug)!
      if (event.occurredAt < acc.first) acc.first = event.occurredAt
    }

    // temporal: same (kind, resource) on the same UTC weekday, distinct dates only
    const weekday = event.occurredAt.getUTCDay()
    const tKey = `routine:${event.kind}:${resourceKey(event)}:${weekday}`
    const dates = temporalDates.get(tKey) ?? new Set<string>()
    if (!dates.has(dateOf(event.occurredAt))) {
      dates.add(dateOf(event.occurredAt))
      temporalDates.set(tKey, dates)
      bump(temporal, tKey, event.occurredAt, [event.id],
        `Does ${event.kind} on ${eventName(event)} on the same weekday (UTC day ${weekday})`)
    }

    // friction: >=3 manual runs of the same agent inside a rolling window
    if (event.kind === 'agent_run_manual' && event.resourceId) {
      const windowIds = [event.id]
      for (let j = i + 1; j < events.length; j++) {
        const later = events[j]
        if (later.occurredAt.getTime() - event.occurredAt.getTime() > FRICTION_WINDOW_MS) break
        if (later.kind === 'agent_run_manual' && later.resourceId === event.resourceId) windowIds.push(later.id)
      }
      if (windowIds.length >= 3) {
        const slug = `friction:agent:${event.resourceId}`
        const existing = friction.get(slug)
        // count distinct bursts: only start a new burst if this event isn't already evidence
        if (!existing || !existing.evidence.includes(event.id)) {
          bump(friction, slug, event.occurredAt, windowIds,
            `Repeatedly re-runs agent ${eventName(event)} in short bursts (possible friction)`)
        }
      }
    }
  }

  const finish = (map: Map<string, Acc>, kind: PatternCandidate['kind']): PatternCandidate[] =>
    [...map.entries()].map(([slug, acc]) => ({
      slug, kind, summary: acc.summary,
      occurrenceCount: acc.count,
      firstSeenAt: acc.first, lastSeenAt: acc.last,
      evidenceEventIds: [...new Set(acc.evidence)],
    }))

  return [...finish(sequences, 'sequence'), ...finish(temporal, 'temporal'), ...finish(friction, 'friction')]
}

/** Greedy single-pass clustering of prompt texts; >=3 similar asks = a theme. */
export async function mineIntentClusters(
  prompts: Array<{ eventId: string; text: string; occurredAt: Date }>,
  embed: (texts: string[]) => Promise<number[][]>,
): Promise<PatternCandidate[]> {
  if (prompts.length < 3) return []
  const vectors = await embed(prompts.map((p) => p.text))
  const clusters: Array<{ members: number[] }> = []
  for (let i = 0; i < prompts.length; i++) {
    const vec = vectors[i]
    if (!vec || vec.length === 0) continue
    const home = clusters.find((c) => cosineSimilarity(vectors[c.members[0]], vec) >= INTENT_SIMILARITY_THRESHOLD)
    if (home) home.members.push(i)
    else clusters.push({ members: [i] })
  }
  return clusters
    .filter((c) => c.members.length >= 3)
    .map((c) => {
      const members = c.members.map((i) => prompts[i])
      const shortest = members.reduce((a, b) => (a.text.length <= b.text.length ? a : b))
      const times = members.map((m) => m.occurredAt.getTime())
      return {
        slug: `intent:${members[0].eventId}`,
        kind: 'intent' as const,
        summary: `Recurring assistant request: ${shortest.text.slice(0, 140)}`,
        occurrenceCount: members.length,
        firstSeenAt: new Date(Math.min(...times)),
        lastSeenAt: new Date(Math.max(...times)),
        evidenceEventIds: members.map((m) => m.eventId),
      }
    })
}
```

- [ ] **Step 4: Run tests** — expect 5 passing. Then `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/behavior
git commit -m "feat(behavior): deterministic pattern miner with real evidence counts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Eligibility gate — the single choke point (TDD)

**Files:**
- Create: `src/lib/behavior/eligibility.ts`
- Test: `src/lib/behavior/__tests__/eligibility.test.ts`

**Interfaces:**
- Consumes: `prisma.userPattern`, `prisma.userEvent`.
- Produces: `MIN_OCCURRENCES = 3`, `MIN_SPAN_DAYS = 7`, `LEARNING_PERIOD_DAYS = 7`, `type GateablePattern = { occurrenceCount: number; firstSeenAt: Date; lastSeenAt: Date; status: string }`, `isPatternEligible(pattern: GateablePattern, userFirstEventAt: Date | null, now?: Date): boolean` (pure), `type EligiblePattern = { slug; kind; summary; occurrenceCount; firstSeenAt: Date; lastSeenAt: Date; evidence: string[] }`, `listEligiblePatterns(organizationId: string, userId: string, db?): Promise<EligiblePattern[]>`. Tasks 10, 13, 14 consume `listEligiblePatterns`; NOTHING else may implement eligibility logic.

- [ ] **Step 1: Write the failing test** at `src/lib/behavior/__tests__/eligibility.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPatternEligible, MIN_OCCURRENCES, MIN_SPAN_DAYS, LEARNING_PERIOD_DAYS } from '@/lib/behavior/eligibility'

const day = 24 * 60 * 60 * 1000
const now = new Date('2026-07-17T12:00:00Z')
const daysAgo = (d: number) => new Date(now.getTime() - d * day)
const good = { occurrenceCount: 3, firstSeenAt: daysAgo(10), lastSeenAt: daysAgo(1), status: 'open' }
const learnedUser = daysAgo(30) // first event 30 days ago — past learning period

test('constants are the spec values', () => {
  assert.equal(MIN_OCCURRENCES, 3)
  assert.equal(MIN_SPAN_DAYS, 7)
  assert.equal(LEARNING_PERIOD_DAYS, 7)
})

test('a 3x/10-day open pattern for a learned user is eligible', () => {
  assert.equal(isPatternEligible(good, learnedUser, now), true)
})

test('below occurrence threshold is ineligible', () => {
  assert.equal(isPatternEligible({ ...good, occurrenceCount: 2 }, learnedUser, now), false)
})

test('a burst (span < 7 days) is ineligible — one busy day is not a routine', () => {
  assert.equal(isPatternEligible({ ...good, firstSeenAt: daysAgo(2) }, learnedUser, now), false)
})

test('user inside the 7-day learning period gets NOTHING, even a strong pattern', () => {
  assert.equal(isPatternEligible(good, daysAgo(3), now), false)
})

test('unknown first-event date means still learning', () => {
  assert.equal(isPatternEligible(good, null, now), false)
})

test('dismissed patterns are never eligible', () => {
  assert.equal(isPatternEligible({ ...good, status: 'dismissed' }, learnedUser, now), false)
})

test('boundaries are inclusive: exactly 3 occurrences over exactly 7 days, learning period exactly over', () => {
  const boundary = { occurrenceCount: 3, firstSeenAt: daysAgo(7), lastSeenAt: now, status: 'open' }
  assert.equal(isPatternEligible(boundary, daysAgo(7), now), true)
})
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement `src/lib/behavior/eligibility.ts`:**

```ts
/**
 * THE eligibility gate (spec §3). Every consumer of behavior patterns —
 * synthesis, assistant context, copilot grounding, per-agent proposals —
 * goes through isPatternEligible/listEligiblePatterns. No other module may
 * implement pattern-eligibility logic. This is the choke point that keeps
 * the platform non-prescriptive by construction: no evidence, no suggestion.
 */
import { prisma } from '@/lib/prisma'

export const MIN_OCCURRENCES = 3
export const MIN_SPAN_DAYS = 7
export const LEARNING_PERIOD_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

export type GateablePattern = {
  occurrenceCount: number
  firstSeenAt: Date
  lastSeenAt: Date
  status: string
}

export function isPatternEligible(
  pattern: GateablePattern,
  userFirstEventAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (pattern.status !== 'open') return false
  if (pattern.occurrenceCount < MIN_OCCURRENCES) return false
  if (pattern.lastSeenAt.getTime() - pattern.firstSeenAt.getTime() < MIN_SPAN_DAYS * DAY_MS) return false
  if (userFirstEventAt == null) return false
  if (now.getTime() - userFirstEventAt.getTime() < LEARNING_PERIOD_DAYS * DAY_MS) return false
  return true
}

export type EligiblePattern = {
  slug: string
  kind: string
  summary: string
  occurrenceCount: number
  firstSeenAt: Date
  lastSeenAt: Date
  evidence: string[]
}

/** Open patterns for this user that pass the gate. Never throws — returns []. */
export async function listEligiblePatterns(
  organizationId: string,
  userId: string,
  db = prisma,
): Promise<EligiblePattern[]> {
  try {
    const [patterns, firstEvent] = await Promise.all([
      db.userPattern.findMany({
        where: { organizationId, userId, status: 'open' },
        orderBy: { occurrenceCount: 'desc' },
        take: 50,
      }),
      db.userEvent.findFirst({
        where: { organizationId, userId },
        orderBy: { occurredAt: 'asc' },
        select: { occurredAt: true },
      }),
    ])
    return patterns
      .filter((p) => isPatternEligible(p, firstEvent?.occurredAt ?? null))
      .map((p) => ({
        slug: p.slug, kind: p.kind, summary: p.summary,
        occurrenceCount: p.occurrenceCount, firstSeenAt: p.firstSeenAt, lastSeenAt: p.lastSeenAt,
        evidence: Array.isArray(p.evidence) ? (p.evidence as string[]) : [],
      }))
  } catch {
    return []
  }
}
```

- [ ] **Step 4: Run tests** — 8 passing; `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/behavior
git commit -m "feat(behavior): evidence-threshold eligibility gate

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Private graph inference + `inferUserBehaviorPatterns` job

**Files:**
- Create: `src/lib/behavior/user-insights.ts`
- Create: `src/lib/behavior/infer-user-patterns.ts`
- Test: `src/lib/behavior/__tests__/user-insights.test.ts`

**Interfaces:**
- Consumes: `commitGraph`, `PendingNode` from indexer; `userEventNodeId` (Task 5); `mineUserPatternCandidates`, `mineIntentClusters` (Task 7); `embedTexts`, `embeddingsConfigured`, `cosineSimilarity` from `src/lib/rag/embeddings.ts`; `MEMORY_SIMILARITY_THRESHOLD` from `src/lib/memory/agent-memory.ts`.
- Produces: `userPatternNodeId(slug): string` (`insight:behavior:<slug>`), `userInferenceGraphParts(write): { nodes; edges }` (pure, throws on empty evidence), `writeUserInference(write): Promise<boolean>`, `inferUserBehaviorPatterns(organizationId, userId, overrides?: { db?; embed?; now? }): Promise<{ patterns: number } | { skipped: string }>`. Task 12 dispatches the job.

- [ ] **Step 1: Write the failing test** at `src/lib/behavior/__tests__/user-insights.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { userInferenceGraphParts, userPatternNodeId } from '@/lib/behavior/user-insights'

const write = {
  organizationId: 'org-1', userId: 'u-1', slug: 'seq:a>>b',
  text: 'Runs A then edits B', evidenceEventIds: ['ue-1', 'ue-2'],
}

test('pattern node is PRIVATE, owned by the user, with evidence edges to uevent nodes', () => {
  const { nodes, edges } = userInferenceGraphParts(write)
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].id, userPatternNodeId('seq:a>>b'))
  assert.equal(nodes[0].type, 'insight')
  assert.equal(nodes[0].visibility, 'private')
  assert.equal(nodes[0].ownerUserId, 'u-1')
  assert.deepEqual(
    edges.map((e) => `${e.from}-${e.rel}->${e.to}`).sort(),
    [
      `${userPatternNodeId('seq:a>>b')}-evidence->uevent:ue-1`,
      `${userPatternNodeId('seq:a>>b')}-evidence->uevent:ue-2`,
    ].sort(),
  )
})

test('no evidence → structural rejection (throws)', () => {
  assert.throws(() => userInferenceGraphParts({ ...write, evidenceEventIds: [] }), /no evidence/)
})
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement `src/lib/behavior/user-insights.ts`:**

```ts
/**
 * Per-user trust layer (spec §3): behavior patterns are insight nodes that
 * MUST cite user_event evidence, private to their owner. Mirrors
 * src/lib/activity/insights.ts with uevent evidence targets + private scope.
 */
import { apiLogger } from '@/lib/logger'
import { commitGraph, type PendingNode } from '@/lib/rag/indexer'
import type { GraphEdge } from '@/lib/rag/store'
import { userEventNodeId } from './index-user-event'

export interface UserInferenceWrite {
  organizationId: string
  userId: string
  slug: string
  text: string
  evidenceEventIds: string[]
}

export const userPatternNodeId = (slug: string) => `insight:behavior:${slug}`

export function userInferenceGraphParts(write: UserInferenceWrite): { nodes: PendingNode[]; edges: GraphEdge[] } {
  if (write.evidenceEventIds.length === 0) throw new Error('inference rejected: no evidence')
  const id = userPatternNodeId(write.slug)
  const nodes: PendingNode[] = [{
    id, type: 'insight',
    text: `Behavior pattern: ${write.text}`.slice(0, 1800),
    props: { insightKind: 'behavior_pattern', slug: write.slug, evidenceCount: write.evidenceEventIds.length },
    ownerUserId: write.userId, visibility: 'private',
  }]
  const edges: GraphEdge[] = write.evidenceEventIds.map((eventId) => ({
    organizationId: write.organizationId, from: id, to: userEventNodeId(eventId), rel: 'evidence' as const,
  }))
  return { nodes, edges }
}

/** Invariant violations throw; graph-store failures remain best-effort. */
export async function writeUserInference(write: UserInferenceWrite): Promise<boolean> {
  const { nodes, edges } = userInferenceGraphParts(write)
  try {
    await commitGraph(write.organizationId, nodes, edges)
    return true
  } catch (error) {
    apiLogger.warn('behavior.writeUserInference failed', { slug: write.slug, error: error instanceof Error ? error.message : String(error) })
    return false
  }
}
```

- [ ] **Step 4: Implement `src/lib/behavior/infer-user-patterns.ts`:**

```ts
/**
 * Daily per-user pattern inference (spec §3). Deterministic mining over the
 * user's ledger + optional intent clustering over their assistant prompts.
 * Dismissal suppression: a candidate matching a dismissed pattern's slug, or
 * embedding-similar (>= MEMORY_SIMILARITY_THRESHOLD) to a dismissed summary,
 * is dropped before it can be written. Never throws.
 */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { embedTexts, embeddingsConfigured, cosineSimilarity } from '@/lib/rag/embeddings'
import { MEMORY_SIMILARITY_THRESHOLD } from '@/lib/memory/agent-memory'
import { mineUserPatternCandidates, mineIntentClusters, type PatternCandidate } from './mine-patterns'
import { writeUserInference } from './user-insights'

const WINDOW_DAYS = 90
const MAX_EVENTS = 500
const MIN_EVENTS = 10

export type InferOverrides = {
  db?: typeof prisma
  embed?: (texts: string[]) => Promise<number[][]>
  now?: () => Date
}

export async function inferUserBehaviorPatterns(
  organizationId: string,
  userId: string,
  overrides: InferOverrides = {},
): Promise<{ patterns: number } | { skipped: string }> {
  const db = overrides.db ?? prisma
  try {
    const now = overrides.now ? overrides.now() : new Date()
    const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000)
    const events = await db.userEvent.findMany({
      where: { organizationId, userId, occurredAt: { gte: since } },
      orderBy: { occurredAt: 'asc' },
      take: MAX_EVENTS,
    })
    if (events.length < MIN_EVENTS) return { skipped: 'too-few-events' }

    let candidates: PatternCandidate[] = mineUserPatternCandidates(events)

    // Intent clustering over assistant prompts (needs message text by reference).
    const embed = overrides.embed ?? (embeddingsConfigured() ? (texts: string[]) => embedTexts(texts, { inputType: 'document' }) : null)
    if (embed) {
      const promptEvents = events.filter((e) => e.kind === 'assistant_prompt' && e.resourceId)
      if (promptEvents.length >= 3) {
        const messages = await db.assistantChatMessage.findMany({
          where: { id: { in: promptEvents.map((e) => e.resourceId as string) } },
          select: { id: true, content: true },
        })
        const textById = new Map(messages.map((m) => [m.id, m.content]))
        const prompts = promptEvents
          .map((e) => ({ eventId: e.id, text: textById.get(e.resourceId as string) ?? '', occurredAt: e.occurredAt }))
          .filter((p) => p.text.trim().length > 0)
        candidates = [...candidates, ...(await mineIntentClusters(prompts, embed))]
      }
    }
    if (candidates.length === 0) return { skipped: 'no-candidates' }

    // Dismissal suppression: exact slug + embedding similarity to dismissed summaries.
    const dismissed = await db.userPattern.findMany({
      where: { organizationId, userId, status: 'dismissed' },
      select: { slug: true, summary: true },
    })
    const dismissedSlugs = new Set(dismissed.map((d) => d.slug))
    candidates = candidates.filter((c) => !dismissedSlugs.has(c.slug))
    if (embed && dismissed.length > 0 && candidates.length > 0) {
      const vectors = await embed([...dismissed.map((d) => d.summary), ...candidates.map((c) => c.summary)])
      const dismissedVecs = vectors.slice(0, dismissed.length)
      candidates = candidates.filter((_, i) => {
        const vec = vectors[dismissed.length + i]
        if (!vec || vec.length === 0) return true
        return !dismissedVecs.some((dv) => dv.length > 0 && cosineSimilarity(dv, vec) >= MEMORY_SIMILARITY_THRESHOLD)
      })
    }

    let written = 0
    for (const candidate of candidates) {
      await db.userPattern.upsert({
        where: { userId_slug: { userId, slug: candidate.slug } },
        create: {
          organizationId, userId, slug: candidate.slug, kind: candidate.kind,
          summary: candidate.summary, occurrenceCount: candidate.occurrenceCount,
          firstSeenAt: candidate.firstSeenAt, lastSeenAt: candidate.lastSeenAt,
          evidence: candidate.evidenceEventIds,
        },
        // Recompute stats from the sliding window; status is preserved so a
        // dismissed row (raced past the filter) can never be resurrected.
        update: {
          summary: candidate.summary, occurrenceCount: candidate.occurrenceCount,
          firstSeenAt: candidate.firstSeenAt, lastSeenAt: candidate.lastSeenAt,
          evidence: candidate.evidenceEventIds,
        },
      })
      const ok = await writeUserInference({
        organizationId, userId, slug: candidate.slug,
        text: candidate.summary, evidenceEventIds: candidate.evidenceEventIds,
      })
      if (ok) written += 1
    }
    return { patterns: written }
  } catch (error) {
    apiLogger.warn('behavior.inferUserBehaviorPatterns failed', {
      organizationId, userId, error: error instanceof Error ? error.message : String(error),
    })
    return { skipped: 'error' }
  }
}
```

Note: verify the assistant message model/field names — open `prisma/schema.prisma`, find the model mapped to `assistant_chat_messages`, and use its actual accessor (`assistantChatMessage`) and text field (`content`; if the field is named differently, e.g. `text` or `body`, adjust both here and in the test expectations).

- [ ] **Step 5: Run tests + typecheck**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/behavior/__tests__/user-insights.test.ts && npx tsc --noEmit`
Expected: 2 passing; clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/behavior
git commit -m "feat(behavior): per-user pattern inference with private evidence-cited graph nodes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Per-user suggestion synthesis (TDD on pure parts)

**Files:**
- Modify: `src/lib/intelligence/suggest-workflows.ts` (export `loadExistingFlows` and `loadExistingAgents` — change `async function` to `export async function`, nothing else)
- Create: `src/lib/intelligence/suggest-user-workflows.ts`
- Test: `src/lib/intelligence/__tests__/suggest-user-workflows.test.ts`

**Interfaces:**
- Consumes: `listEligiblePatterns`, `EligiblePattern` (Task 8); `loadExistingFlows`, `loadExistingAgents`, `parseSuggestions`-style tolerant parsing; `buildCopilotGrounding`, `generateFlowGraph`, `generateStructured`, `DEFAULT_SUMMARY_MODEL`, `saveAgentMemory`, `notify`.
- Produces: `parseUserSuggestions(raw: string, validSlugs: Set<string>): UserSuggestionCandidate | null` (pure — returns AT MOST ONE candidate), `renderPatternEvidence(patterns: EligiblePattern[]): string[]` (pure), `synthesizeUserSuggestions(organizationId, userId, overrides?: { generate?; generateGraph?; now? }): Promise<UserSynthesisResult>`. Task 12 dispatches; Task 11's route reads the `user_suggestions` rows this writes.

Design notes (implement exactly):
- Guard order (read-only first, claim last): (1) open `user_suggestions` row exists → `{ skipped: 'pending-suggestion' }`; (2) `listEligiblePatterns` empty → `{ skipped: 'no-eligible-patterns' }`; (3) atomic weekly claim on `users.metadata.lastBehaviorSynthesisAt` (raw SQL `jsonb_set` UPDATE with `WHERE ... < now - interval '7 days'`, modeled on `claimSynthesisSlotAtomic`; note `users.id` is TEXT, not uuid — compare as text) → `{ skipped: 'throttled' }` when not claimed.
- LLM output schema: `{ suggestion: { kind: 'new_flow'|'enhancement', title, description, flowPrompt?, targetType?, targetId?, sourcePatternSlugs: string[] } | null }`. `parseUserSuggestions` validates: `sourcePatternSlugs` filtered to `validSlugs`, must be non-empty after filtering (evidence contract — no cited pattern, no suggestion); `new_flow` requires non-empty `flowPrompt`; `enhancement` requires `targetType` + `targetId`. Returns null otherwise.
- `new_flow` path: `buildCopilotGrounding(organizationId, userId)` → `generateGraph`; on `validation.ok` create the flow `{ status: 'DRAFT', userId, metadata: { suggested: true, suggestedForUserId: userId, sourcePatternSlugs } }` then the `user_suggestions` row (`kind: 'new_flow'`, `flowId`, `evidence: renderPatternEvidence(citedPatterns)`); on validation failure → release the claim (restore prior timestamp, mirroring `releaseSynthesisSlot`) and `{ skipped: 'generation-failed' }`.
- `enhancement` path: validate `targetId` against `loadExistingFlows`/`loadExistingAgents` ids (never trust the model); create the `user_suggestions` row; when `targetType === 'agent'`, mirror via `saveAgentMemory({ organizationId, agentId: targetId, kind: 'suggestion', title, content: description })` so the existing agent page shows it.
- End with one `notify({ organizationId, type: 'intelligence.user-suggestion', title: 'Sublime noticed a routine', body: <suggestion title>, link: '/dashboard' })`.
- `renderPatternEvidence` output line format (exact): `"<summary> — <occurrenceCount> times between <firstSeenAt as YYYY-MM-DD> and <lastSeenAt as YYYY-MM-DD> (events: <first 5 evidence ids joined ', '>)"`.

- [ ] **Step 1: Write the failing test** at `src/lib/intelligence/__tests__/suggest-user-workflows.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUserSuggestions, renderPatternEvidence } from '@/lib/intelligence/suggest-user-workflows'

const valid = new Set(['seq:a>>b', 'routine:x:1'])

test('valid new_flow suggestion with cited slugs parses', () => {
  const parsed = parseUserSuggestions(JSON.stringify({
    suggestion: { kind: 'new_flow', title: 'Automate Monday review', description: 'd', flowPrompt: 'build it', sourcePatternSlugs: ['seq:a>>b'] },
  }), valid)
  assert.ok(parsed)
  assert.equal(parsed.kind, 'new_flow')
  assert.deepEqual(parsed.sourcePatternSlugs, ['seq:a>>b'])
})

test('uncited or invalid-slug suggestions are rejected — no evidence, no suggestion', () => {
  assert.equal(parseUserSuggestions(JSON.stringify({
    suggestion: { kind: 'new_flow', title: 't', description: 'd', flowPrompt: 'p', sourcePatternSlugs: ['made-up'] },
  }), valid), null)
  assert.equal(parseUserSuggestions(JSON.stringify({
    suggestion: { kind: 'new_flow', title: 't', description: 'd', flowPrompt: 'p', sourcePatternSlugs: [] },
  }), valid), null)
})

test('enhancement requires target; new_flow requires flowPrompt; null passes through', () => {
  assert.equal(parseUserSuggestions(JSON.stringify({
    suggestion: { kind: 'enhancement', title: 't', description: 'd', sourcePatternSlugs: ['routine:x:1'] },
  }), valid), null)
  assert.equal(parseUserSuggestions(JSON.stringify({
    suggestion: { kind: 'new_flow', title: 't', description: 'd', sourcePatternSlugs: ['routine:x:1'] },
  }), valid), null)
  assert.equal(parseUserSuggestions(JSON.stringify({ suggestion: null }), valid), null)
  assert.equal(parseUserSuggestions('garbage', valid), null)
})

test('evidence lines carry counts, dates, and event ids', () => {
  const lines = renderPatternEvidence([{
    slug: 'seq:a>>b', kind: 'sequence', summary: 'Runs A then edits B',
    occurrenceCount: 4, firstSeenAt: new Date('2026-06-02T00:00:00Z'), lastSeenAt: new Date('2026-07-10T00:00:00Z'),
    evidence: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'],
  }])
  assert.equal(lines.length, 1)
  assert.equal(lines[0], 'Runs A then edits B — 4 times between 2026-06-02 and 2026-07-10 (events: e1, e2, e3, e4, e5)')
})
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Export the loaders** in `src/lib/intelligence/suggest-workflows.ts`: change `async function loadExistingFlows(` → `export async function loadExistingFlows(` and same for `loadExistingAgents`.

- [ ] **Step 4: Implement `src/lib/intelligence/suggest-user-workflows.ts`** — complete implementation:

```ts
/**
 * Per-user suggestion synthesis (spec §4). Quietness invariants are hard:
 * one open suggestion per user, weekly cadence via an atomic claim on
 * users.metadata.lastBehaviorSynthesisAt, drafts only, and every suggestion
 * cites eligible patterns (validated against the gate's output, never
 * trusted from the model).
 */
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { generateStructured, DEFAULT_SUMMARY_MODEL } from '@/lib/llm/model-runner'
import { saveAgentMemory } from '@/lib/memory/agent-memory'
import { notify } from '@/lib/notifications/service'
import { buildCopilotGrounding } from '@/lib/flows/copilot-grounding'
import { generateFlowGraph } from '@/lib/flows/copilot-generate'
import { listEligiblePatterns, type EligiblePattern } from '@/lib/behavior/eligibility'
import { loadExistingFlows, loadExistingAgents } from './suggest-workflows'

export const USER_SYNTHESIS_COOLDOWN_DAYS = 7

export type UserSuggestionCandidate = {
  kind: 'new_flow' | 'enhancement'
  title: string
  description: string
  flowPrompt?: string
  targetType?: 'flow' | 'agent'
  targetId?: string
  sourcePatternSlugs: string[]
}

const candidateSchema = z.object({
  suggestion: z.object({
    kind: z.enum(['new_flow', 'enhancement']),
    title: z.string().min(1),
    description: z.string().min(1),
    flowPrompt: z.string().optional(),
    targetType: z.enum(['flow', 'agent']).optional(),
    targetId: z.string().optional(),
    sourcePatternSlugs: z.array(z.string()).default([]),
  }).nullable(),
})

export const USER_SUGGESTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    suggestion: {
      type: ['object', 'null'],
      properties: {
        kind: { type: 'string', enum: ['new_flow', 'enhancement'] },
        title: { type: 'string' },
        description: { type: 'string' },
        flowPrompt: { type: 'string' },
        targetType: { type: 'string', enum: ['flow', 'agent'] },
        targetId: { type: 'string' },
        sourcePatternSlugs: { type: 'array', items: { type: 'string' } },
      },
      required: ['kind', 'title', 'description', 'sourcePatternSlugs'],
    },
  },
  required: ['suggestion'],
}

/** Tolerant parse + evidence contract. At most ONE candidate; null on any violation. */
export function parseUserSuggestions(raw: string, validSlugs: Set<string>): UserSuggestionCandidate | null {
  const trimmed = raw.trim()
  const candidates = [trimmed]
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidates.push(fence[1].trim())
  const braces = trimmed.match(/\{[\s\S]*\}/)
  if (braces) candidates.push(braces[0])
  for (const candidate of candidates) {
    try {
      const result = candidateSchema.safeParse(JSON.parse(candidate))
      if (!result.success) continue
      const suggestion = result.data.suggestion
      if (!suggestion) return null
      const slugs = suggestion.sourcePatternSlugs.filter((slug) => validSlugs.has(slug))
      if (slugs.length === 0) return null
      if (suggestion.kind === 'new_flow' && !suggestion.flowPrompt?.trim()) return null
      if (suggestion.kind === 'enhancement' && (!suggestion.targetType || !suggestion.targetId)) return null
      return { ...suggestion, sourcePatternSlugs: slugs }
    } catch {
      /* try next */
    }
  }
  return null
}

const day = (date: Date) => date.toISOString().slice(0, 10)

/** "why this exists" lines — dated, citing the specific events (spec §4). */
export function renderPatternEvidence(patterns: EligiblePattern[]): string[] {
  return patterns.map((pattern) =>
    `${pattern.summary} — ${pattern.occurrenceCount} times between ${day(pattern.firstSeenAt)} and ${day(pattern.lastSeenAt)} (events: ${pattern.evidence.slice(0, 5).join(', ')})`,
  )
}

export type UserSynthesisResult =
  | { skipped: 'pending-suggestion' | 'no-eligible-patterns' | 'throttled' | 'no-suggestion' | 'generation-failed' | 'error' }
  | { created: true; suggestionId: string; kind: 'new_flow' | 'enhancement' }

export type UserSynthesisOverrides = {
  generate?: typeof generateStructured
  generateGraph?: typeof generateFlowGraph
  now?: () => Date
}

export async function synthesizeUserSuggestions(
  organizationId: string,
  userId: string,
  overrides: UserSynthesisOverrides = {},
): Promise<UserSynthesisResult> {
  const generate = overrides.generate ?? generateStructured
  const generateGraph = overrides.generateGraph ?? generateFlowGraph
  const now = overrides.now ? overrides.now() : new Date()
  try {
    // Quietness guard 1: one un-actioned suggestion at a time.
    const open = await prisma.userSuggestion.findFirst({ where: { organizationId, userId, status: 'open' }, select: { id: true } })
    if (open) return { skipped: 'pending-suggestion' }

    // Evidence guard: only gate-passing patterns exist downstream of here.
    const patterns = await listEligiblePatterns(organizationId, userId)
    if (patterns.length === 0) return { skipped: 'no-eligible-patterns' }

    // Quietness guard 2: atomic weekly claim on users.metadata (mirrors
    // claimSynthesisSlotAtomic; users.id is TEXT).
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { metadata: true } })
    const previous = readClaim(user?.metadata)
    const nowIso = now.toISOString()
    const affected = await prisma.$executeRaw`
      UPDATE users
      SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{lastBehaviorSynthesisAt}', to_jsonb(${nowIso}::text))
      WHERE id = ${userId}
        AND (
          COALESCE(metadata->>'lastBehaviorSynthesisAt', '') = ''
          OR (metadata->>'lastBehaviorSynthesisAt')::timestamptz < (${nowIso}::timestamptz - interval '7 days')
        )
    `
    if (affected === 0) return { skipped: 'throttled' }

    try {
      const [flows, agents, feedback] = await Promise.all([
        loadExistingFlows(organizationId),
        loadExistingAgents(organizationId),
        prisma.userSuggestion.findMany({
          where: { organizationId, userId, status: { in: ['accepted', 'dismissed'] } },
          orderBy: { updatedAt: 'desc' }, take: 20, select: { title: true, status: true },
        }),
      ])
      const system = [
        "You are the personal automation-suggestion engine for ONE user of a workflow platform. You are given behavior patterns OBSERVED from their real usage (counts and dates are facts, computed — not guesses).",
        'Propose AT MOST ONE suggestion — the single highest-value one — or null if nothing is clearly worth their attention. Be conservative: a mediocre suggestion costs trust.',
        'kind "new_flow": a new automation replacing a repeated manual routine; include flowPrompt detailed enough for a flow-builder AI. kind "enhancement": a concrete improvement to one EXISTING flow/agent from the lists (exact targetId; never invent one).',
        'sourcePatternSlugs MUST cite the exact slugs of the observed patterns that justify the suggestion. Do not repeat previously dismissed ideas.',
      ].join(' ')
      const userPrompt = [
        'Observed behavior patterns (slug | summary | count | first..last):',
        ...patterns.map((p) => `- ${p.slug} | ${p.summary} | ${p.occurrenceCount}x | ${day(p.firstSeenAt)}..${day(p.lastSeenAt)}`),
        '',
        'Existing flows:',
        flows.length ? flows.map((f) => `- id:${f.id} "${f.name}" (trigger:${f.triggerType})`).join('\n') : '- None',
        '',
        'Existing agents:',
        agents.length ? agents.map((a) => `- id:${a.id} "${a.title}"`).join('\n') : '- None',
        '',
        'Prior suggestion feedback:',
        feedback.length ? feedback.map((f) => `- ${f.status}: ${f.title}`).join('\n') : '- None yet',
      ].join('\n')

      const model = process.env.AGENT_REFLECTION_MODEL?.trim() || DEFAULT_SUMMARY_MODEL
      const raw = await generate({ system, user: userPrompt, schema: USER_SUGGESTION_JSON_SCHEMA, schemaName: 'user_suggestion', maxTokens: 1500, model })
      const candidate = parseUserSuggestions(raw, new Set(patterns.map((p) => p.slug)))
      if (!candidate) {
        await releaseClaim(userId, previous)
        return { skipped: 'no-suggestion' }
      }
      const cited = patterns.filter((p) => candidate.sourcePatternSlugs.includes(p.slug))
      const evidence = renderPatternEvidence(cited)

      if (candidate.kind === 'new_flow') {
        const { roster, toolCatalog, contextBlock, graphRules } = await buildCopilotGrounding(organizationId, userId)
        const { graph, validation } = await generateGraph({
          system: graphRules,
          user: [`Build a flow that: ${candidate.flowPrompt}`, '', contextBlock].join('\n'),
          roster, toolCatalog,
        })
        if (!validation.ok) {
          await releaseClaim(userId, previous)
          return { skipped: 'generation-failed' }
        }
        const flow = await prisma.flow.create({
          data: {
            name: candidate.title.slice(0, 200), description: candidate.description,
            organizationId, userId, status: 'DRAFT', visibility: 'private',
            graph: JSON.parse(JSON.stringify(graph)),
            metadata: { suggested: true, suggestedForUserId: userId, sourcePatternSlugs: candidate.sourcePatternSlugs },
          },
        })
        const suggestion = await prisma.userSuggestion.create({
          data: {
            organizationId, userId, kind: 'new_flow', title: candidate.title, description: candidate.description,
            flowId: flow.id, sourcePatternSlugs: candidate.sourcePatternSlugs, evidence,
          },
        })
        await notify({ organizationId, type: 'intelligence.user-suggestion', title: 'Sublime noticed a routine', body: candidate.title, link: '/dashboard' })
        return { created: true, suggestionId: suggestion.id, kind: 'new_flow' }
      }

      // enhancement: target must exist in THIS org (never trust the model)
      const validTarget =
        candidate.targetType === 'flow'
          ? flows.some((f) => f.id === candidate.targetId)
          : agents.some((a) => a.id === candidate.targetId)
      if (!validTarget) {
        await releaseClaim(userId, previous)
        return { skipped: 'no-suggestion' }
      }
      const suggestion = await prisma.userSuggestion.create({
        data: {
          organizationId, userId, kind: 'enhancement', title: candidate.title, description: candidate.description,
          targetType: candidate.targetType, targetId: candidate.targetId,
          sourcePatternSlugs: candidate.sourcePatternSlugs, evidence,
        },
      })
      if (candidate.targetType === 'agent' && candidate.targetId) {
        await saveAgentMemory({ organizationId, agentId: candidate.targetId, kind: 'suggestion', title: candidate.title, content: candidate.description })
      }
      await notify({ organizationId, type: 'intelligence.user-suggestion', title: 'Sublime noticed a routine', body: candidate.title, link: '/dashboard' })
      return { created: true, suggestionId: suggestion.id, kind: 'enhancement' }
    } catch (error) {
      await releaseClaim(userId, previous)
      throw error
    }
  } catch (error) {
    apiLogger.warn('synthesizeUserSuggestions failed', { organizationId, userId, error: error instanceof Error ? error.message : String(error) })
    return { skipped: 'error' }
  }
}

function readClaim(metadata: unknown): Date | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const value = (metadata as Record<string, unknown>).lastBehaviorSynthesisAt
  if (typeof value !== 'string') return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

async function releaseClaim(userId: string, previous: Date | null): Promise<void> {
  try {
    if (previous) {
      const iso = previous.toISOString()
      await prisma.$executeRaw`UPDATE users SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{lastBehaviorSynthesisAt}', to_jsonb(${iso}::text)) WHERE id = ${userId}`
    } else {
      await prisma.$executeRaw`UPDATE users SET metadata = COALESCE(metadata, '{}'::jsonb) - 'lastBehaviorSynthesisAt' WHERE id = ${userId}`
    }
  } catch (error) {
    apiLogger.warn('synthesizeUserSuggestions: claim release failed', { userId, error: error instanceof Error ? error.message : String(error) })
  }
}
```

- [ ] **Step 5: Run tests + typecheck + full suite**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/intelligence/__tests__/suggest-user-workflows.test.ts && npx tsc --noEmit && npm test`
Expected: new tests pass; existing `suggest-workflows` tests unaffected by the export change.

- [ ] **Step 6: Commit**

```bash
git add src/lib/intelligence
git commit -m "feat(behavior): per-user suggestion synthesis with quietness invariants

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: User-suggestions API (GET current, POST accept/dismiss)

**Files:**
- Create: `src/app/api/intelligence/user-suggestions/route.ts`

**Interfaces:**
- Consumes: `prisma.userSuggestion`, `prisma.userPattern`, `recordUserEvent`, `withAuthenticatedApi`/`ApiError` from `@/lib/server/api-handler`.
- Produces: `GET /api/intelligence/user-suggestions` → `{ success: true, suggestion: { id, kind, title, description, flowId, targetType, targetId, evidence: string[] } | null }`; `POST` body `{ id: string, action: 'accept' | 'dismiss' }` → `{ success: true }`. Task 13's dashboard card consumes both.

- [ ] **Step 1: Implement the route:**

```ts
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordUserEvent } from '@/lib/behavior/record-event'

export const runtime = 'nodejs'

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const suggestion = await prisma.userSuggestion.findFirst({
    where: { organizationId: auth.organizationId, userId: auth.dbUser.id, status: 'open' },
    orderBy: { createdAt: 'desc' },
  })
  return {
    success: true,
    suggestion: suggestion
      ? {
          id: suggestion.id, kind: suggestion.kind, title: suggestion.title,
          description: suggestion.description, flowId: suggestion.flowId,
          targetType: suggestion.targetType, targetId: suggestion.targetId,
          evidence: Array.isArray(suggestion.evidence) ? (suggestion.evidence as string[]) : [],
        }
      : null,
  }
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { id, action } = z.object({ id: z.string().min(1), action: z.enum(['accept', 'dismiss']) }).parse(await request.json())
  const suggestion = await prisma.userSuggestion.findFirst({
    where: { id, organizationId: auth.organizationId, userId: auth.dbUser.id, status: 'open' },
  })
  if (!suggestion) throw new ApiError('Suggestion not found', 404, 'NOT_FOUND')

  await prisma.userSuggestion.update({
    where: { id: suggestion.id },
    data: { status: action === 'accept' ? 'accepted' : 'dismissed' },
  })

  if (action === 'dismiss') {
    // Feedback loop (spec §4): dismissing a suggestion dismisses its source
    // patterns, and the inference job's similarity check suppresses lookalikes.
    const slugs = Array.isArray(suggestion.sourcePatternSlugs) ? (suggestion.sourcePatternSlugs as string[]) : []
    if (slugs.length > 0) {
      await prisma.userPattern.updateMany({
        where: { organizationId: auth.organizationId, userId: auth.dbUser.id, slug: { in: slugs } },
        data: { status: 'dismissed' },
      })
    }
    // A dismissed new_flow suggestion also removes its unreviewed draft.
    if (suggestion.kind === 'new_flow' && suggestion.flowId) {
      await prisma.flow.deleteMany({
        where: { id: suggestion.flowId, organizationId: auth.organizationId, status: 'DRAFT' },
      })
    }
  }

  await recordUserEvent({
    organizationId: auth.organizationId, userId: auth.dbUser.id,
    kind: action === 'accept' ? 'suggestion_accepted' : 'suggestion_dismissed',
    resourceType: 'suggestion', resourceId: suggestion.id,
    context: { suggestionKind: suggestion.kind },
  })
  return { success: true }
})
```

- [ ] **Step 2: `npx tsc --noEmit && npm test`** — clean.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/intelligence/user-suggestions
git commit -m "feat(behavior): user-suggestion accept/dismiss API with pattern feedback

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Cron dispatch + retention wiring

**Files:**
- Create: `src/lib/behavior/run-behavior-intelligence.ts`
- Modify: `src/app/api/cron/dispatch/route.ts` (next to the `void inferActivityPatterns(organizationId)` call, ~line 405)
- Modify: `src/app/api/cron/retention/route.ts`

**Interfaces:**
- Consumes: `sweepUnindexedUserEvents`, `removeUserEventNodesFromGraph` (Task 5); `inferUserBehaviorPatterns` (Task 9); `synthesizeUserSuggestions` (Task 10); `systemPrisma`.
- Produces: `runBehaviorIntelligence(organizationId, db?): Promise<void>` — never throws.

- [ ] **Step 1: Implement `src/lib/behavior/run-behavior-intelligence.ts`:**

```ts
/**
 * Per-org behavior-intelligence tick (spec §3/§4 cadence). For each user with
 * fresh events: daily pattern inference, then synthesis (self-throttled to
 * weekly by its atomic claim; one open suggestion per user). Never throws —
 * cron dispatch fires it best-effort.
 */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { inferUserBehaviorPatterns } from './infer-user-patterns'
import { synthesizeUserSuggestions } from '@/lib/intelligence/suggest-user-workflows'

const FRESH_WINDOW_MS = 25 * 60 * 60 * 1000 // 25h: daily tick with slack

export async function runBehaviorIntelligence(organizationId: string, db = prisma): Promise<void> {
  try {
    const since = new Date(Date.now() - FRESH_WINDOW_MS)
    const active = await db.userEvent.findMany({
      where: { organizationId, occurredAt: { gte: since } },
      select: { userId: true },
      distinct: ['userId'],
      take: 50,
    })
    for (const { userId } of active) {
      await inferUserBehaviorPatterns(organizationId, userId, { db })
      await synthesizeUserSuggestions(organizationId, userId)
    }
  } catch (error) {
    apiLogger.warn('behavior.runBehaviorIntelligence failed', {
      organizationId, error: error instanceof Error ? error.message : String(error),
    })
  }
}
```

- [ ] **Step 2: Wire into `src/app/api/cron/dispatch/route.ts`** — add imports:

```ts
import { runBehaviorIntelligence } from '@/lib/behavior/run-behavior-intelligence'
import { sweepUnindexedUserEvents } from '@/lib/behavior/index-user-event'
```

Directly after the existing `void inferActivityPatterns(organizationId).catch(() => undefined)` line, add:

```ts
      void runBehaviorIntelligence(organizationId).catch(() => undefined)
```

And once per tick (near the other global maintenance like `reapStuckFlowRuns` / `pruneSlackProcessedEvents`, NOT inside the per-org loop), add:

```ts
    // Behavior-ledger graph parity: project any rows the write-time indexer missed.
    void sweepUnindexedUserEvents(systemPrisma).catch(() => undefined)
```

- [ ] **Step 3: Retention** — in `src/app/api/cron/retention/route.ts`, after the existing execution pruning block, add (import `removeUserEventNodesFromGraph` from `@/lib/behavior/index-user-event`):

```ts
    // user_events: 180-day ledger (patterns/graph distillations persist on
    // their own). Graph-first, same reasoning as executions above.
    const behaviorDays = Number(process.env.BEHAVIOR_RETENTION_DAYS) || 180
    const behaviorCutoff = new Date(Date.now() - behaviorDays * 24 * 60 * 60 * 1000)
    const staleUserEvents = await systemPrisma.userEvent.findMany({
      where: { occurredAt: { lt: behaviorCutoff } }, select: { id: true, organizationId: true }, take: CAP,
    })
    if (staleUserEvents.length > 0) {
      const eventGroups = new Map<string, { organizationId: string; eventIds: string[] }>()
      for (const e of staleUserEvents) {
        const group = eventGroups.get(e.organizationId) ?? { organizationId: e.organizationId, eventIds: [] }
        group.eventIds.push(e.id)
        eventGroups.set(e.organizationId, group)
      }
      await removeUserEventNodesFromGraph([...eventGroups.values()])
      await systemPrisma.userEvent.deleteMany({ where: { id: { in: staleUserEvents.map((e) => e.id) } } })
    }
```

Match the surrounding file's response payload style — add the pruned count to the handler's returned JSON the same way execution counts are reported.

- [ ] **Step 4: `npx tsc --noEmit && npm test`** — clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/behavior src/app/api/cron
git commit -m "feat(behavior): cron dispatch + retention wiring for behavior intelligence

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: Home assistant surface — grounded context + suggestion card

**Files:**
- Create: `src/features/assistant/intelligence-context.ts`
- Modify: `src/app/api/assistant/chat/route.ts` (system-prompt assembly, ~line 28 and the POST handler)
- Modify: `src/app/dashboard/home-assistant.tsx` (suggestion card)
- Test: `src/features/assistant/__tests__/intelligence-context.test.ts`

**Interfaces:**
- Consumes: `retrieveContext`, `renderContext` from `src/lib/rag/retrieve.ts`; `getGraphRagStore` from `src/lib/rag/get-store.ts`; `listEligiblePatterns` (Task 8); `prisma.userSuggestion`; GET/POST `/api/intelligence/user-suggestions` (Task 11).
- Produces: `buildAssistantIntelligence(params: { organizationId; userId; query }): Promise<string>` — bounded (≤ 3000 chars), empty string when nothing eligible/configured; `renderIntelligenceBlock(parts: { graphContext: string; patterns: EligiblePattern[]; openSuggestion: { title: string; evidence: string[] } | null }): string` (pure).

- [ ] **Step 1: Write the failing test** at `src/features/assistant/__tests__/intelligence-context.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderIntelligenceBlock } from '@/features/assistant/intelligence-context'

const pattern = {
  slug: 's', kind: 'sequence', summary: 'Runs A then edits B', occurrenceCount: 4,
  firstSeenAt: new Date('2026-06-02T00:00:00Z'), lastSeenAt: new Date('2026-07-10T00:00:00Z'), evidence: ['e1'],
}

test('renders patterns and open suggestion into a bounded block', () => {
  const block = renderIntelligenceBlock({
    graphContext: 'Graph facts here.',
    patterns: [pattern],
    openSuggestion: { title: 'Automate Monday review', evidence: ['line 1'] },
  })
  assert.ok(block.includes('Observed usage patterns'))
  assert.ok(block.includes('Runs A then edits B'))
  assert.ok(block.includes('4x'))
  assert.ok(block.includes('Automate Monday review'))
  assert.ok(block.length <= 3000)
})

test('empty inputs render an empty string — surfaces degrade silently', () => {
  assert.equal(renderIntelligenceBlock({ graphContext: '', patterns: [], openSuggestion: null }), '')
})
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Implement `src/features/assistant/intelligence-context.ts`:**

```ts
/**
 * Behavior-intelligence context for the Home assistant (spec §5.1). Adds
 * GraphRAG retrieval scoped to the user, gate-passing behavior patterns, and
 * the (at most one) open suggestion. Best-effort and bounded: any failure or
 * unconfigured dependency yields '' and the assistant behaves exactly as today.
 */
import { prisma } from '@/lib/prisma'
import { getGraphRagStore } from '@/lib/rag/get-store'
import { retrieveContext, renderContext } from '@/lib/rag/retrieve'
import { listEligiblePatterns, type EligiblePattern } from '@/lib/behavior/eligibility'

const MAX_BLOCK_CHARS = 3000

export function renderIntelligenceBlock(parts: {
  graphContext: string
  patterns: EligiblePattern[]
  openSuggestion: { title: string; evidence: string[] } | null
}): string {
  const sections: string[] = []
  if (parts.graphContext.trim()) {
    sections.push(`## Workspace knowledge (retrieved)\n${parts.graphContext.trim()}`)
  }
  if (parts.patterns.length > 0) {
    const day = (d: Date) => d.toISOString().slice(0, 10)
    sections.push([
      '## Observed usage patterns (evidence-gated — safe to extrapolate from)',
      ...parts.patterns.slice(0, 8).map((p) => `- ${p.summary} (${p.occurrenceCount}x, ${day(p.firstSeenAt)}..${day(p.lastSeenAt)})`),
    ].join('\n'))
  }
  if (parts.openSuggestion) {
    sections.push([
      '## Pending suggestion (mention only if relevant; the user accepts/dismisses it in the UI)',
      `- ${parts.openSuggestion.title}`,
      ...parts.openSuggestion.evidence.slice(0, 3).map((line) => `  - why: ${line}`),
    ].join('\n'))
  }
  if (sections.length === 0) return ''
  return sections.join('\n\n').slice(0, MAX_BLOCK_CHARS)
}

export async function buildAssistantIntelligence(params: {
  organizationId: string
  userId: string
  query: string
}): Promise<string> {
  try {
    const [context, patterns, suggestion] = await Promise.all([
      retrieveContext(getGraphRagStore(), {
        organizationId: params.organizationId,
        viewerUserId: params.userId,
        query: params.query,
        topK: 6,
      }).catch(() => ({ hits: [], related: [] })),
      listEligiblePatterns(params.organizationId, params.userId),
      prisma.userSuggestion.findFirst({
        where: { organizationId: params.organizationId, userId: params.userId, status: 'open' },
        select: { title: true, evidence: true },
      }).catch(() => null),
    ])
    const graphContext = context.hits.length || context.related.length ? renderContext(context) : ''
    return renderIntelligenceBlock({
      graphContext,
      patterns,
      openSuggestion: suggestion
        ? { title: suggestion.title, evidence: Array.isArray(suggestion.evidence) ? (suggestion.evidence as string[]) : [] }
        : null,
    })
  } catch {
    return ''
  }
}
```

Check `retrieveContext`'s `RetrieveOptions` interface at `src/lib/rag/retrieve.ts:22` — if `query`/`organizationId`/`viewerUserId` names differ, use the interface's actual field names.

- [ ] **Step 4: Wire into `src/app/api/assistant/chat/route.ts` POST** — where the model call's system/user prompt is assembled (after `buildWorkspaceContext` is folded in), add:

```ts
  const intelligence = await buildAssistantIntelligence({
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    query: message, // the user's chat message variable in this handler
  })
```

and append `intelligence` (when non-empty) to the same prompt section that carries the workspace-context snapshot, e.g. `` `${workspaceBlock}\n\n${intelligence}` ``. Use the handler's actual local variable names for the message and context block.

- [ ] **Step 5: Suggestion card in `src/app/dashboard/home-assistant.tsx`** — follow the component's existing styling/state conventions:
  - On mount, `fetch('/api/intelligence/user-suggestions')`; when `suggestion` is non-null, render a card above the chat input: title, description, a collapsible **"Why this exists"** list of `evidence` lines, and two buttons.
  - **Accept** → `POST /api/intelligence/user-suggestions` `{ id, action: 'accept' }`; if `flowId` present, navigate to the flow builder for that draft (match how the app links to `/flows/<id>` elsewhere in this file or the flows list page).
  - **Dismiss** → same POST with `action: 'dismiss'`; remove the card.
  - Card copy must be non-prescriptive: header text `Noticed a routine` (not "You should...").

- [ ] **Step 6: Run tests + typecheck**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/assistant/__tests__/intelligence-context.test.ts && npx tsc --noEmit && npm test`
Expected: all green (including the existing `workspace-context.test.ts`).

- [ ] **Step 7: Commit**

```bash
git add src/features/assistant src/app/api/assistant src/app/dashboard
git commit -m "feat(behavior): ground Home assistant in graph + patterns, add suggestion card

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 14: Flow copilot surface — pattern-aware grounding

**Files:**
- Modify: `src/lib/flows/copilot-grounding.ts` (`buildCopilotGrounding`, ~line 50)

**Interfaces:**
- Consumes: `listEligiblePatterns` (Task 8).
- Produces: `buildCopilotGrounding` unchanged signature; its `contextBlock` gains a trailing "How this user works" section when eligible patterns exist.

- [ ] **Step 1: Edit `buildCopilotGrounding`** — add the import `import { listEligiblePatterns } from '@/lib/behavior/eligibility'`, fetch patterns alongside the existing `Promise.all` (add `listEligiblePatterns(organizationId, userId)` as a fourth member; it never throws), and where `contextBlock` is assembled (the function's return construction), append:

```ts
  const patternLines = userPatterns.slice(0, 6).map((p) => `- ${p.summary} (observed ${p.occurrenceCount}x)`)
  const patternsBlock = patternLines.length
    ? ['', 'How this user actually works (observed, evidence-gated — prefer flows that match these habits):', ...patternLines].join('\n')
    : ''
```

and concatenate `patternsBlock` onto the end of the existing `contextBlock` value (`contextBlock: existingContextBlock + patternsBlock`). Use the local variable name the function already uses for the block.

- [ ] **Step 2: `npx tsc --noEmit && npm test`** — clean (note `synthesizeWorkflowSuggestions` and Task 10 also call `buildCopilotGrounding`; the addition is additive and safe for both).

- [ ] **Step 3: Commit**

```bash
git add src/lib/flows/copilot-grounding.ts
git commit -m "feat(behavior): feed eligible user patterns into flow copilot grounding

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 15: End-to-end pipeline test (MemoryGraphStore, no DB, no LLM)

**Files:**
- Test: `src/lib/behavior/__tests__/pipeline.test.ts`

**Interfaces:**
- Consumes: `userEventGraphParts` (Task 5), `mineUserPatternCandidates` (Task 7), `isPatternEligible` (Task 8), `userInferenceGraphParts` (Task 9), `MemoryGraphStore` from `src/lib/rag/memory-store.ts`, `parseUserSuggestions` (Task 10).

This is the spec's integration test: capture → project → mine → gate → suggest, plus the negative case, exercised through the pure seams against the in-memory graph store (check `MemoryGraphStore`'s constructor/`upsertNodes` usage in `src/lib/rag/__tests__/store-contract.test.ts` and mirror it).

- [ ] **Step 1: Write the test:**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryGraphStore } from '@/lib/rag/memory-store'
import { userEventGraphParts, type PersistedUserEvent } from '@/lib/behavior/index-user-event'
import { mineUserPatternCandidates } from '@/lib/behavior/mine-patterns'
import { isPatternEligible } from '@/lib/behavior/eligibility'
import { userInferenceGraphParts } from '@/lib/behavior/user-insights'
import { parseUserSuggestions } from '@/lib/intelligence/suggest-user-workflows'

const now = new Date('2026-07-17T12:00:00Z')
const day = 24 * 60 * 60 * 1000
let n = 0
const run = (agent: string, at: Date): PersistedUserEvent => ({
  id: `e${++n}`, organizationId: 'org-1', userId: 'u-1', kind: 'agent_run_manual',
  resourceType: 'agent', resourceId: agent, context: { name: 'Pipeline review' }, occurredAt: at,
})

// A Monday routine: same agent, same weekday, three weeks running.
const events = [
  run('a-1', new Date('2026-06-22T09:00:00Z')),
  run('a-1', new Date('2026-06-29T09:05:00Z')),
  run('a-1', new Date('2026-07-06T09:10:00Z')),
]

test('full pipeline: project → mine → gate → evidence-cited pattern node → validated suggestion', async () => {
  const store = new MemoryGraphStore()
  const fakeEmbedding = () => [1, 0, 0]

  // 1. project the ledger (as commitGraph would, with a fake embedding)
  for (const event of events) {
    const { nodes, edges } = userEventGraphParts(event)
    await store.upsertNodes(nodes.map((node) => ({
      ...node, organizationId: 'org-1', embedding: fakeEmbedding(),
      ownerUserId: node.ownerUserId ?? null, visibility: node.visibility ?? 'shared',
      updatedAt: now.toISOString(),
    })))
    await store.upsertEdges(edges)
  }

  // 2. mine real patterns
  const candidates = mineUserPatternCandidates(events)
  const routine = candidates.find((c) => c.kind === 'temporal')
  assert.ok(routine, 'expected a temporal routine')
  assert.equal(routine.occurrenceCount, 3)

  // 3. gate passes (3x over 14 days, user learning-period long over)
  const firstEventAt = new Date(now.getTime() - 30 * day)
  assert.equal(isPatternEligible({ ...routine, status: 'open' }, firstEventAt, now), true)

  // 4. pattern node cites its evidence in the graph
  const { nodes, edges } = userInferenceGraphParts({
    organizationId: 'org-1', userId: 'u-1', slug: routine.slug,
    text: routine.summary, evidenceEventIds: routine.evidenceEventIds,
  })
  await store.upsertNodes(nodes.map((node) => ({
    ...node, organizationId: 'org-1', embedding: fakeEmbedding(),
    ownerUserId: node.ownerUserId ?? null, visibility: node.visibility ?? 'shared',
    updatedAt: now.toISOString(),
  })))
  await store.upsertEdges(edges)
  const neighborhood = await store.expand('org-1', 'u-1', [nodes[0].id], 1)
  assert.ok(neighborhood.some((node) => node.id === `uevent:${events[0].id}`), 'evidence edge must reach the ledger event node')

  // 5. private visibility: another user cannot see the pattern
  const foreign = await store.expand('org-1', 'u-2', [nodes[0].id], 1)
  assert.equal(foreign.length, 0)

  // 6. a suggestion citing the mined slug validates; an uncited one dies
  const validSlugs = new Set([routine.slug])
  assert.ok(parseUserSuggestions(JSON.stringify({
    suggestion: { kind: 'new_flow', title: 'Schedule the Monday review', description: 'd', flowPrompt: 'p', sourcePatternSlugs: [routine.slug] },
  }), validSlugs))
  assert.equal(parseUserSuggestions(JSON.stringify({
    suggestion: { kind: 'new_flow', title: 'Vibes', description: 'd', flowPrompt: 'p', sourcePatternSlugs: ['invented'] },
  }), validSlugs), null)
})

test('negative case: a burst pattern or learning-period user produces NOTHING', () => {
  const burst = [
    run('a-9', new Date('2026-07-16T09:00:00Z')),
    run('a-9', new Date('2026-07-16T10:30:00Z')),
    run('a-9', new Date('2026-07-16T12:00:00Z')),
  ]
  const candidates = mineUserPatternCandidates(burst)
  for (const candidate of candidates) {
    // same-day repetition: span < 7 days → the gate rejects every candidate
    assert.equal(isPatternEligible({ ...candidate, status: 'open' }, new Date(now.getTime() - 30 * day), now), false)
  }
  // and even a strong pattern is silenced during the learning period
  const routine = mineUserPatternCandidates(events).find((c) => c.kind === 'temporal')!
  assert.equal(isPatternEligible({ ...routine, status: 'open' }, new Date(now.getTime() - 3 * day), now), false)
})
```

If `MemoryGraphStore`'s `expand` scoping or node shape differs, mirror the exact usage in `src/lib/rag/__tests__/store-contract.test.ts`.

- [ ] **Step 2: Run the test, then the full suite**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/behavior/__tests__/pipeline.test.ts && npm test && npx tsc --noEmit`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add src/lib/behavior/__tests__/pipeline.test.ts
git commit -m "test(behavior): end-to-end pipeline test over MemoryGraphStore

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Spec coverage map (self-review)

- Spec §1 ledger/capture/privacy/retention → Tasks 1–4, 12 (retention)
- Spec §2 projection, private visibility, preceded_by chains, sweep → Task 5
- Spec §3 mining kinds, evidence-mandatory inference, THE gate → Tasks 6–9 (miner is deterministic rather than "one LLM pass" — a strengthening: counts/evidence are computed facts, so the gate can't be gamed by model output; the LLM's judgment enters only at synthesis, where citations are validated)
- Spec §4 per-user synthesis, quietness rules, drafts-only, evidence trail, agent-memory mirror → Tasks 10–11 (storage refinement: `user_suggestions` table instead of overloading memories — flagged in Architecture)
- Spec §5 surfaces: assistant (5.1) → Task 13; copilot (5.2) → Task 14; per-agent proposals (5.3) → Task 10's agent-memory mirror surfaces in the existing agent page UI
- Spec §6 degradation → every module gates on `ragEnabled()`/`embeddingsConfigured()` and never throws into request paths
- Spec §7 testing → Tasks 2, 5, 7, 8, 9, 10, 13 (unit) + Task 15 (pipeline + negative case)
