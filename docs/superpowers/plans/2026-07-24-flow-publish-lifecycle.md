# Flow Publish Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-07-24-flow-publish-lifecycle-design.md` — read it first; it holds the rationale for every decision below.

**Goal:** One writer of flow publish state (`publishedGraph` + `status` move together), agents that can actually call published flows, a Publish/Unpublish button that reflects reality, a leaner canvas toolbar, list-page Disable instead of Delete, and exports that carry the credentials they need behind an owner-only opt-in.

**Architecture:** Extract the duplicated publish transaction from `activate.ts` and the publish route into `src/lib/flows/publish.ts`; every lifecycle change (publish, unpublish, disable) goes through it. Agent flow-tools swap a never-written metadata gate for `flowReadScope`. Exports keep converting one sanitized portable document, with an opt-in `credentials` block layered on top and the trigger secret made recoverable via the existing AES-256-GCM helper.

**Tech Stack:** Next.js 15 route handlers, Prisma 6, zod, node:test (`npm test`), React 18 client components, Tailwind.

## Global Constraints

- DB-backed tests follow the repo's e2e pattern: gated on `TEST_DATABASE_URL`, real route handlers, `seedTestOrg`/`installTestAuth` from `@/lib/server/__tests__/test-auth` (see `src/app/api/__tests__/behavior-e2e.test.ts` for the canonical shape).
- Test command: `npm test` runs every `*.test.ts(x)` under `__tests__` dirs. To run one file: `TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test <file>` (prefix `TEST_DATABASE_URL=...` for DB tests).
- Typecheck with `npm run typecheck` before each commit.
- Prisma JSON null: clearing `publishedGraph` uses `Prisma.DbNull` (matches `NOT: { publishedGraph: { equals: Prisma.DbNull } }` usage elsewhere).
- The redaction helpers in `src/features/flows/http.ts` and `src/lib/export/redact.ts` must NOT gain an "include credentials" parameter — the opt-in lives only in `sanitizeNode`/`toPortableFlow` (spec §5).
- The literal placeholder string `REPLACE_WITH_TRIGGER_SECRET` stays the fallback whenever no real secret is supplied.
- Copy strings in this plan are exact — use them verbatim.

---

### Task 1: Lifecycle module `src/lib/flows/publish.ts`

**Files:**
- Create: `src/lib/flows/publish.ts`
- Create: `src/app/api/__tests__/flow-publish-lifecycle-e2e.test.ts`
- Modify: `src/lib/flows/activate.ts` (becomes a thin wrapper)

**Interfaces:**
- Consumes: `flowGraphSchema`, `validateFlowGraph`/`validationErrorMessage`, `loadFlowToolCatalog`, `agentReadScope`, `triggerFromGraph`/`preserveWebhookSecretHash`, `recordAudit`, `recordUserEvent`, `prisma`.
- Produces (later tasks call these exact signatures):
  - `publishFlowDraft(flowId: string, organizationId: string, userId: string): Promise<PublishResult>` where `PublishResult = { published: true; version: number } | { published: false; reason: string }`
  - `unpublishFlow(flowId: string, organizationId: string, userId: string, options?: { disable?: boolean }): Promise<{ unpublished: true } | { unpublished: false; reason: string }>`
  - `activateFlow` keeps its existing exported signature and `ActivateFlowResult` type.

- [ ] **Step 1: Write the failing e2e test**

Create `src/app/api/__tests__/flow-publish-lifecycle-e2e.test.ts`:

```ts
/**
 * Publish lifecycle e2e — the single-writer contract (spec §1):
 * publish sets publishedGraph AND status ACTIVE in one transaction;
 * unpublish reverses both; disable parks the flow as DISABLED.
 * Real Postgres (TEST_DATABASE_URL), real module, no route mocking.
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
  let userId: string

  const validGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 't1', type: 'transform', data: { fields: [{ name: 'echo', value: 'ok' }] } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 't1' }],
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    organizationId = seeded.organizationId
    userId = seeded.userId
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  const createFlow = (over: Record<string, unknown> = {}) =>
    prisma.flow.create({
      data: { name: 'Lifecycle QA', organizationId, userId, trigger: { type: 'manual' }, graph: validGraph, ...over },
    })

  test('publishFlowDraft sets publishedGraph, ACTIVE, version+1, and a FlowVersion row', async () => {
    const { publishFlowDraft } = await import('@/lib/flows/publish')
    const flow = await createFlow()
    const result = await publishFlowDraft(flow.id, organizationId, userId)
    assert.deepEqual(result, { published: true, version: 2 })

    const row = await prisma.flow.findUnique({ where: { id: flow.id } })
    assert.equal(row.status, 'ACTIVE', 'publish must set status — the defect this spec exists for')
    assert.ok(row.publishedGraph, 'publishedGraph must be set')
    assert.equal(row.version, 2)
    const snapshot = await prisma.flowVersion.findFirst({ where: { flowId: flow.id, version: 2 } })
    assert.ok(snapshot, 'FlowVersion row must exist at the new number')
    assert.equal(snapshot.publishedBy, userId)
  })

  test('publishFlowDraft on an invalid graph returns a reason and mutates nothing', async () => {
    const { publishFlowDraft } = await import('@/lib/flows/publish')
    // An agent step pointing at a nonexistent agent fails validateFlowGraph.
    const badGraph = {
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        { id: 'a1', type: 'agent', data: { agentId: 'agt_does_not_exist' } },
      ],
      edges: [{ id: 'e1', source: 'trigger', target: 'a1' }],
    }
    const flow = await createFlow({ graph: badGraph })
    const result = await publishFlowDraft(flow.id, organizationId, userId)
    assert.equal(result.published, false)
    assert.ok((result as { reason: string }).reason.length > 0)
    const row = await prisma.flow.findUnique({ where: { id: flow.id } })
    assert.equal(row.status, 'DRAFT')
    assert.equal(row.publishedGraph, null)
    assert.equal(row.version, 1)
  })

  test('unpublishFlow nulls publishedGraph, sets DRAFT, keeps version + history', async () => {
    const { publishFlowDraft, unpublishFlow } = await import('@/lib/flows/publish')
    const flow = await createFlow()
    await publishFlowDraft(flow.id, organizationId, userId)
    const result = await unpublishFlow(flow.id, organizationId, userId)
    assert.deepEqual(result, { unpublished: true })
    const row = await prisma.flow.findUnique({ where: { id: flow.id } })
    assert.equal(row.status, 'DRAFT')
    assert.equal(row.publishedGraph, null)
    assert.equal(row.version, 2, 'version counter must survive unpublish')
    assert.ok(await prisma.flowVersion.findFirst({ where: { flowId: flow.id, version: 2 } }), 'history must survive')
  })

  test('unpublish on a never-published flow is an error; disable is allowed', async () => {
    const { unpublishFlow } = await import('@/lib/flows/publish')
    const flow = await createFlow()
    const bad = await unpublishFlow(flow.id, organizationId, userId)
    assert.equal(bad.unpublished, false)
    const disabled = await unpublishFlow(flow.id, organizationId, userId, { disable: true })
    assert.deepEqual(disabled, { unpublished: true })
    const row = await prisma.flow.findUnique({ where: { id: flow.id } })
    assert.equal(row.status, 'DISABLED')
  })

  test('publish → unpublish → publish continues the version sequence (no unique violation)', async () => {
    const { publishFlowDraft, unpublishFlow } = await import('@/lib/flows/publish')
    const flow = await createFlow()
    await publishFlowDraft(flow.id, organizationId, userId)
    await unpublishFlow(flow.id, organizationId, userId)
    const again = await publishFlowDraft(flow.id, organizationId, userId)
    assert.deepEqual(again, { published: true, version: 3 })
  })

  test('activateFlow still works as a wrapper (template-provisioning contract)', async () => {
    const { activateFlow } = await import('@/lib/flows/activate')
    const flow = await createFlow()
    const result = await activateFlow(flow.id, organizationId, userId)
    assert.deepEqual(result, { activated: true })
    const row = await prisma.flow.findUnique({ where: { id: flow.id } })
    assert.equal(row.status, 'ACTIVE')
    assert.ok(row.publishedGraph)
  })
} else {
  test('flow publish lifecycle e2e (skipped: TEST_DATABASE_URL not set)', () => {})
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL=<your test db> TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test src/app/api/__tests__/flow-publish-lifecycle-e2e.test.ts`
Expected: FAIL — `Cannot find module '@/lib/flows/publish'`.
(If you have no test DB, run without `TEST_DATABASE_URL`; the file must at least parse and print the skip line. Then rely on Step 4 + `npm run typecheck`.)

- [ ] **Step 3: Create `src/lib/flows/publish.ts`**

The body is the deduplicated union of today's `activate.ts` and `publish/route.ts` — including the audit/behavior events the route emitted and activate didn't (spec §1 moves them here so both entry points record them).

```ts
/**
 * The ONLY writer of flow publish state (spec 2026-07-24). Publishing means
 * BOTH publishedGraph and status move together — the drift between
 * activate.ts (set both) and the publish route (set only publishedGraph) is
 * the root cause of "published flows invisible to agents".
 *
 * Returns reasons rather than throwing: callers that must not fail a deploy
 * (template provisioning) degrade to DRAFT with the reason; the publish route
 * converts a reason into a 400.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { flowGraphSchema } from '@/lib/flows/graph'
import { validateFlowGraph, validationErrorMessage } from '@/lib/flows/validate'
import { loadFlowToolCatalog } from '@/lib/flows/tool-catalog'
import { agentReadScope } from '@/lib/server/visibility'
import { triggerFromGraph, preserveWebhookSecretHash } from '@/lib/flows/trigger'
import { recordAudit } from '@/lib/audit'
import { recordUserEvent } from '@/lib/behavior/record-event'

function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

export type PublishResult = { published: true; version: number } | { published: false; reason: string }

/** Validate the current draft and make it live (publishedGraph + ACTIVE + version row). */
export async function publishFlowDraft(
  flowId: string,
  organizationId: string,
  userId: string,
): Promise<PublishResult> {
  const existing = await prisma.flow.findFirst({ where: { id: flowId, organizationId } })
  if (!existing) return { published: false, reason: 'Flow not found' }

  const parsed = flowGraphSchema.safeParse(existing.graph)
  if (!parsed.success) return { published: false, reason: 'Flow graph is not valid' }
  const graph = parsed.data

  const usedConnectionIds = Array.from(new Set(graph.nodes.flatMap((node) =>
    node.type === 'tool' || node.type === 'http' ? [node.data.connectionId] : [],
  ).filter((id): id is string => Boolean(id))))
  const [agents, connections] = await Promise.all([
    prisma.agentTask.findMany({
      where: { organizationId, status: 'ACTIVE', ...agentReadScope(userId) },
      select: { id: true, description: true },
      take: 500,
    }),
    usedConnectionIds.length
      ? loadFlowToolCatalog(organizationId, { userId, connectionIds: usedConnectionIds, takeConnections: usedConnectionIds.length })
      : Promise.resolve([]),
  ])
  const validation = validateFlowGraph(graph, {
    agents: agents.map((agent) => ({ id: agent.id, title: agent.description })),
    toolCatalog: connections,
  })
  if (!validation.ok) return { published: false, reason: validationErrorMessage(validation) }

  const nextVersion = existing.version + 1
  const trigger = jsonValue(preserveWebhookSecretHash(triggerFromGraph(graph, existing.trigger), existing.trigger))
  await prisma.$transaction([
    prisma.flow.update({
      where: { id: flowId, organizationId },
      data: { status: 'ACTIVE', trigger, publishedGraph: jsonValue(graph), version: { increment: 1 } },
    }),
    prisma.flowVersion.create({
      data: { flowId, organizationId, version: nextVersion, graph: jsonValue(graph), trigger, publishedBy: userId },
    }),
  ])

  await recordAudit({
    organizationId, actorUserId: userId,
    action: 'flow.published', resourceType: 'flow', resourceId: flowId,
    detail: { version: nextVersion },
  }).catch(() => undefined)
  await recordUserEvent({
    organizationId, userId,
    kind: 'flow_published', resourceType: 'flow', resourceId: flowId,
    context: { name: existing.name, version: nextVersion },
  })
  // Activating a suggested draft = accepting the suggestion (behavioral-
  // intelligence spec §4 feedback loop) — previously only the editor route
  // recorded this; now both entry points do.
  const metadata = existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
    ? (existing.metadata as Record<string, unknown>) : {}
  if (metadata.suggested === true) {
    await recordUserEvent({
      organizationId, userId,
      kind: 'suggestion_accepted', resourceType: 'flow', resourceId: flowId,
      context: { name: existing.name },
    })
  }
  return { published: true, version: nextVersion }
}

/**
 * Retract a live flow. Keeps the version counter and every FlowVersion row —
 * reusing a number would violate @@unique([flowId, version]) on republish,
 * and destroying restore points is not the inverse of publishing.
 * `disable: true` parks the flow as DISABLED (the flows-list "Disable"
 * action) and is allowed even on a never-published draft.
 */
export async function unpublishFlow(
  flowId: string,
  organizationId: string,
  userId: string,
  options: { disable?: boolean } = {},
): Promise<{ unpublished: true } | { unpublished: false; reason: string }> {
  const existing = await prisma.flow.findFirst({ where: { id: flowId, organizationId } })
  if (!existing) return { unpublished: false, reason: 'Flow not found' }
  if (!options.disable && existing.publishedGraph == null) {
    return { unpublished: false, reason: 'Nothing is published' }
  }
  await prisma.flow.update({
    where: { id: flowId, organizationId },
    data: { publishedGraph: Prisma.DbNull, status: options.disable ? 'DISABLED' : 'DRAFT' },
  })
  await recordAudit({
    organizationId, actorUserId: userId,
    action: options.disable ? 'flow.disabled' : 'flow.unpublished',
    resourceType: 'flow', resourceId: flowId,
    detail: { previousVersion: existing.version },
  }).catch(() => undefined)
  await recordUserEvent({
    organizationId, userId,
    kind: 'flow_unpublished', resourceType: 'flow', resourceId: flowId,
    context: { name: existing.name, disabled: options.disable === true },
  })
  return { unpublished: true }
}
```

Check `recordAudit`'s actual parameter names against `src/lib/audit.ts` before writing (the publish route's existing call is the reference — copy its shape exactly).

- [ ] **Step 4: Rewrite `src/lib/flows/activate.ts` as a wrapper**

Replace the whole file with:

```ts
/**
 * Programmatic flow activation — a thin wrapper over the single publish
 * writer (src/lib/flows/publish.ts). Kept because template provisioning and
 * suggestion-acceptance callers depend on this exact contract: return the
 * reason rather than throw, so a bad graph degrades to DRAFT.
 */
import { publishFlowDraft } from '@/lib/flows/publish'

export type ActivateFlowResult = { activated: true } | { activated: false; reason: string }

export async function activateFlow(
  flowId: string,
  organizationId: string,
  userId: string,
): Promise<ActivateFlowResult> {
  const result = await publishFlowDraft(flowId, organizationId, userId)
  return result.published ? { activated: true } : { activated: false, reason: result.reason }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `TEST_DATABASE_URL=<test db> TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test src/app/api/__tests__/flow-publish-lifecycle-e2e.test.ts`
Expected: all 6 tests PASS. Also run `npm run typecheck` — expected clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/flows/publish.ts src/lib/flows/activate.ts src/app/api/__tests__/flow-publish-lifecycle-e2e.test.ts
git commit -m "feat(flows): single writer for publish state — publishedGraph and status move together"
```

---

### Task 2: Publish route modes + close the PUT status writer

**Files:**
- Modify: `src/app/api/flows/[id]/publish/route.ts` (rewrite around the module; add `unpublish`/`disable` modes)
- Modify: `src/app/api/flows/route.ts:32-45` (omit `status` from PUT) and `:143-146` (drop the status write)
- Test: extend `src/app/api/__tests__/flow-publish-lifecycle-e2e.test.ts`

**Interfaces:**
- Consumes: `publishFlowDraft` / `unpublishFlow` from Task 1.
- Produces: `POST /api/flows/[id]/publish` accepting `{ revert?: boolean; unpublish?: boolean; disable?: boolean }` (at most one true; 400 otherwise), always returning `{ success: true, flow: serializeFlow(flow) }`. Tasks 5 and 7 call these modes.

- [ ] **Step 1: Add failing route tests**

Add `import { NextRequest } from 'next/server'` at the top of `flow-publish-lifecycle-e2e.test.ts`, then append inside the `if (TEST_DB)` block (reuse the `createFlow` helper):

```ts
  const post = (path: string, body: unknown) =>
    new NextRequest(new URL(`http://test${path}`), { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } as never)
  const put = (path: string, body: unknown) =>
    new NextRequest(new URL(`http://test${path}`), { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } as never)

  test('route: publish then unpublish round-trips through serializeFlow', async () => {
    const route = await import('../flows/[id]/publish/route')
    const flow = await createFlow()
    const published = await route.POST(post(`/api/flows/${flow.id}/publish`, {}))
    assert.equal(published.status, 200)
    const pubBody = await published.json()
    assert.equal(pubBody.flow.published, true)
    assert.equal(pubBody.flow.status, 'active')

    const unpublished = await route.POST(post(`/api/flows/${flow.id}/publish`, { unpublish: true }))
    assert.equal(unpublished.status, 200)
    const unBody = await unpublished.json()
    assert.equal(unBody.flow.published, false)
    assert.equal(unBody.flow.status, 'draft')
  })

  test('route: disable parks the flow as disabled', async () => {
    const route = await import('../flows/[id]/publish/route')
    const flow = await createFlow()
    const res = await route.POST(post(`/api/flows/${flow.id}/publish`, { disable: true }))
    assert.equal(res.status, 200)
    assert.equal((await res.json()).flow.status, 'disabled')
  })

  test('route: two modes at once is a 400', async () => {
    const route = await import('../flows/[id]/publish/route')
    const flow = await createFlow()
    const res = await route.POST(post(`/api/flows/${flow.id}/publish`, { unpublish: true, disable: true }))
    assert.equal(res.status, 400)
  })

  test('PUT /api/flows ignores a status field (the third writer is closed)', async () => {
    const flows = await import('../flows/route')
    const flow = await createFlow()
    const res = await flows.PUT(put('/api/flows', { id: flow.id, status: 'ACTIVE' }))
    assert.equal(res.status, 200, 'older clients keep saving successfully')
    const row = await prisma.flow.findUnique({ where: { id: flow.id } })
    assert.equal(row.status, 'DRAFT', 'status must not move through PUT')
  })
```

- [ ] **Step 2: Run to verify the new tests fail**

Run the same command as Task 1 Step 5. Expected: the four new tests FAIL (unpublish/disable modes unknown → validation or wrong status; PUT still writes status).

- [ ] **Step 3: Rewrite the publish route**

Replace the `POST` in `src/app/api/flows/[id]/publish/route.ts` with (imports shrink accordingly — the validation/transaction code moved to the module in Task 1; keep `serializeFlow`, `flowOwnerScope`, `prisma`, `z`, `ApiError`, `withAuthenticatedApi`):

```ts
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { flowOwnerScope } from '@/lib/server/visibility'
import { serializeFlow } from '@/lib/flows/serialize'
import { publishFlowDraft, unpublishFlow } from '@/lib/flows/publish'

const bodySchema = z
  .object({
    revert: z.boolean().default(false),
    unpublish: z.boolean().default(false),
    disable: z.boolean().default(false),
  })
  .refine((body) => [body.revert, body.unpublish, body.disable].filter(Boolean).length <= 1, {
    message: 'Choose one of revert, unpublish, or disable',
  })

// POST /api/flows/[id]/publish — lifecycle endpoint. Default: publish the
// draft. { revert } restores the draft from the published graph. { unpublish }
// retracts to DRAFT. { disable } parks as DISABLED (flows-list "Disable").
// All state changes go through src/lib/flows/publish.ts — the single writer.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const { revert, unpublish, disable } = bodySchema.parse(await request.json().catch(() => ({})))

  const existing = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...flowOwnerScope(auth.dbUser.id) },
  })
  if (!existing) throw new ApiError('Flow not found', 404, 'NOT_FOUND')

  if (revert) {
    if (existing.publishedGraph == null) throw new ApiError('Nothing published to revert to', 400, 'NO_PUBLISHED')
    const flow = await prisma.flow.update({ where: { id, organizationId: auth.organizationId }, data: { graph: existing.publishedGraph } })
    return { success: true, flow: serializeFlow(flow) }
  }

  if (unpublish || disable) {
    const result = await unpublishFlow(id, auth.organizationId, auth.dbUser.id, { disable })
    if (!result.unpublished) throw new ApiError(result.reason, 400, 'NO_PUBLISHED')
  } else {
    const result = await publishFlowDraft(id, auth.organizationId, auth.dbUser.id)
    if (!result.published) throw new ApiError(result.reason, 400, 'FLOW_VALIDATION_ERROR')
  }

  const flow = await prisma.flow.findFirst({ where: { id, organizationId: auth.organizationId } })
  if (!flow) throw new ApiError('Flow not found after update', 404, 'NOT_FOUND')
  return { success: true, flow: serializeFlow(flow) }
})
```

Note the zod `.refine` produces a 400 through `withAuthenticatedApi`'s zod handling — verify by the test; if the handler wraps zod errors differently, catch `bodySchema.safeParse` and throw `ApiError(message, 400, 'INVALID_MODE')` instead.

- [ ] **Step 4: Close the PUT status writer in `src/app/api/flows/route.ts`**

Two edits. First, where `PUT` parses its body:

```ts
export const PUT = withAuthenticatedApi(async (request, auth) => {
  const body = z
    .object({ id: z.string().min(1), baseUpdatedAt: z.string().optional() })
    // status is deliberately omitted: publish state has ONE writer
    // (src/lib/flows/publish.ts). zod strips an incoming status key, so older
    // clients keep saving — they just stop moving publish state.
    .merge(flowSchema.omit({ status: true }).partial())
    .parse(await request.json())
```

Second, in the `updateMany` data object, delete the line:

```ts
      ...(body.status !== undefined && { status: body.status }),
```

`POST /api/flows` is untouched (template provisioning sets status at creation).

- [ ] **Step 5: Run tests + typecheck, verify pass**

Run the e2e file (all tests incl. Task 1's) and `npm run typecheck`. Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/flows/[id]/publish/route.ts src/app/api/flows/route.ts src/app/api/__tests__/flow-publish-lifecycle-e2e.test.ts
git commit -m "feat(flows): unpublish + disable modes on the lifecycle route; PUT can no longer write status"
```

---

### Task 3: Agent flow-tools — read scope replaces the dead metadata gate

**Files:**
- Modify: `src/features/agents/tool-planes.ts:386-406` (`loadFlowPlaneGroups`)
- Modify: `src/features/agents/execute-agent.ts:293-296` (drop `explicit`)
- Modify: `src/lib/flows/flow-tool.ts` (delete `isAgentCallableFlow`)
- Modify: `src/lib/flows/__tests__/flow-tool.test.ts` (delete its tests)
- Modify: `src/app/api/__tests__/tool-capture-e2e.test.ts:114-120` (fixture)
- Test: extend `src/app/api/__tests__/flow-publish-lifecycle-e2e.test.ts`

**Interfaces:**
- Consumes: `flowReadScope` from `@/lib/server/visibility`; `publishFlowDraft` (test only).
- Produces: `loadFlowPlaneGroups(organizationId: string, userId: string, options: { flowIds?: string[] } = {})` — the `explicit` option is gone. Tool names remain `flow_<slug>`.

- [ ] **Step 1: Write the failing tests**

Append to the e2e file:

```ts
  // Tool names are built from flowToolSlug(flow.name) — assert on those, not
  // on flow ids (ids are not guaranteed to appear in a serialized group).
  const toolNames = async () => {
    const { loadFlowPlaneGroups } = await import('@/features/agents/tool-planes')
    const groups = await loadFlowPlaneGroups(organizationId, userId)
    return groups.flatMap((group: any) => (group.tools ?? []).map((tool: any) => tool.name))
  }
  const slugOf = async (name: string) => {
    const { flowToolSlug } = await import('@/lib/flows/flow-tool')
    return flowToolSlug(name)
  }

  test('tool-planes: a published flow is offered with allowFlows and NO flowIds (defect-1 regression)', async () => {
    const { publishFlowDraft } = await import('@/lib/flows/publish')
    const flow = await createFlow({ name: 'Planes QA Alpha' })
    await publishFlowDraft(flow.id, organizationId, userId)
    assert.ok((await toolNames()).includes(await slugOf('Planes QA Alpha')),
      'published flow must appear without any metadata flag')
  })

  test('tool-planes: another user\'s private flow is NOT offered; org-shared is', async () => {
    const { publishFlowDraft } = await import('@/lib/flows/publish')
    const stranger = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), organizationId, isActive: true },
    })
    const privateFlow = await createFlow({ name: 'Planes QA Private', userId: stranger.id })
    const sharedFlow = await createFlow({ name: 'Planes QA Shared', userId: stranger.id, visibility: 'org_viewer' })
    await publishFlowDraft(privateFlow.id, organizationId, stranger.id)
    await publishFlowDraft(sharedFlow.id, organizationId, stranger.id)

    const names = await toolNames()
    assert.equal(names.includes(await slugOf('Planes QA Private')), false, 'private flow of another user must not leak')
    assert.equal(names.includes(await slugOf('Planes QA Shared')), true, 'org-shared flow must be offered')
  })

  test('tool-planes: an unpublished flow is not offered', async () => {
    await createFlow({ name: 'Planes QA Draft' })
    assert.equal((await toolNames()).includes(await slugOf('Planes QA Draft')), false)
  })
```

Add `import crypto from 'node:crypto'` at the file top. If `group.tools[].name` is not the actual shape of `ToolPlaneGroup` (check the type in `src/features/agents/tool-planes.ts` — the field carrying tool definitions may be named differently), adjust `toolNames()` to the real field once, keeping the slug-based assertions.

- [ ] **Step 2: Run to verify failure**

The first test FAILS today: without `metadata.agentCallable` the flow is skipped.

- [ ] **Step 3: Edit `loadFlowPlaneGroups`**

In `src/features/agents/tool-planes.ts`:

```ts
import { flowReadScope } from '@/lib/server/visibility'   // add to the existing visibility import

export async function loadFlowPlaneGroups(
  organizationId: string,
  userId: string,
  options: { flowIds?: string[] } = {},
): Promise<ToolPlaneGroup[]> {
  // Authorization is the OWNER'S read scope: the agent can call exactly the
  // flows its owner can open. The old metadata.agentCallable gate was never
  // writable from the product (its settings UI was never built) and the
  // per-agent allowFlows toggle is the real opt-in.
  const flows = await prisma.flow.findMany({
    where: {
      organizationId,
      status: 'ACTIVE',
      ...flowReadScope(userId),
      ...(options.flowIds?.length ? { id: { in: options.flowIds } } : {}),
    },
    take: 100,
  })
```

Delete the line `if (!options.explicit && !isAgentCallableFlow(flow.metadata)) continue` and remove `isAgentCallableFlow` from the `@/lib/flows/flow-tool` import. Update the doc comment above the function (it describes the metadata gate).

In `src/features/agents/execute-agent.ts` change:

```ts
    const flowGroups = await loadFlowPlaneGroups(organizationId, ownerUserId, {
      ...(flowOptions.flowIds?.length ? { flowIds: flowOptions.flowIds } : {}),
    })
```

(drop `explicit: true`), and update the comment block above it that explains the two authorization paths — it now reads: explicit per-agent selection, else every ACTIVE flow within the owner's read scope.

In `src/lib/flows/flow-tool.ts` delete the `isAgentCallableFlow` function and its doc comment; in `src/lib/flows/__tests__/flow-tool.test.ts` delete its two assertions/tests and the import.

- [ ] **Step 4: Fix the tool-capture e2e fixture**

In `src/app/api/__tests__/tool-capture-e2e.test.ts` the seeded child flow relied on the metadata flag. Replace:

```ts
        metadata: { agentCallable: true },
```

with nothing (delete the line) — the fixture already sets `status: 'ACTIVE'`, `publishedGraph: childGraph`, and `userId`, which is exactly what the new scope requires. Verify `visibility: 'shared'` doesn't matter here because the flow's `userId` is the seeded user (owner passes `flowReadScope`).

- [ ] **Step 5: Run tests + typecheck**

Run the lifecycle e2e file AND `TEST_DATABASE_URL=... TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test src/app/api/__tests__/tool-capture-e2e.test.ts` AND the flow-tool unit test. Expected: PASS. `npm run typecheck` clean (it will catch any remaining `explicit`/`isAgentCallableFlow` references).

- [ ] **Step 6: Commit**

```bash
git add src/features/agents/tool-planes.ts src/features/agents/execute-agent.ts src/lib/flows/flow-tool.ts src/lib/flows/__tests__/flow-tool.test.ts src/app/api/__tests__/tool-capture-e2e.test.ts src/app/api/__tests__/flow-publish-lifecycle-e2e.test.ts
git commit -m "fix(agents): flow tools use the owner's read scope, not the never-written agentCallable flag"
```

---

### Task 4: Agent config picker filters on `published`

**Files:**
- Modify: `src/app/agents/agent-config-form.tsx:394-401`

No new test (pure client filter; the serialized `published` field is covered by Task 2's route test).

- [ ] **Step 1: Edit the fetch handler**

```ts
    fetch('/api/flows', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        // Published flows are what loadFlowPlaneGroups offers at runtime —
        // filter on the same serialized predicate so picker and runtime agree.
        const flows = Array.isArray(data.flows) ? data.flows : []
        setOrgFlows(flows.filter((f: any) => f.published === true).map((f: any) => ({ id: f.id, name: f.name })))
      })
      .catch(() => {})
```

(After Task 1, `published === true` and `status === 'active'` coincide for newly-published flows, but `published` is the field the runtime semantically depends on, and it also catches pre-fix rows that have `publishedGraph` without ACTIVE.)

- [ ] **Step 2: Verify + commit**

Run `npm run typecheck` and `npm run lint`. Expected: clean.

```bash
git add src/app/agents/agent-config-form.tsx
git commit -m "fix(agents): flow picker counts published flows, matching the runtime loader"
```

---

### Task 5: Editor Publish / Unpublish state machine + remove the status select

**Files:**
- Modify: `src/app/flows/[id]/page.tsx` — status select (`:1419-1427`), save payload (`:882`), dirty snapshot (`:467`), publish callback (`:900-935`), button JSX (`:1585-1592`), plus every `status`/`setStatus` reference.

Manual verification task (client-only state wiring; the server contract is already tested).

- [ ] **Step 1: Add `unpublishedChanges` state, remove `status` state**

- Delete `const [status, setStatus] = useState('draft')` (find the exact line; it's near the other flow-meta state).
- Add alongside `published`: `const [unpublishedChanges, setUnpublishedChanges] = useState(false)`.
- In the load effect where `setPublished(Boolean(flow.published))` happens (`:497`), add `setUnpublishedChanges(Boolean(flow.unpublishedChanges))` and remove any `setStatus(...)` call there.
- Dirty snapshot (`:467`) and `setSavedSnapshot` calls: remove `status` from every `JSON.stringify({ name, description, graph, status, errorFlowId })` — the key set becomes `{ name, description, graph, errorFlowId }` (there are several call sites: initial load, save, publish-revert, restoreVersion; grep `savedSnapshot` and fix each).
- Save body (`:882`): remove `status: status.toUpperCase(),`. In the save success handler, the PUT returns `serializeFlow` — add `setUnpublishedChanges(Boolean(data.flow?.unpublishedChanges))`.
- `downloadFlow` (`:1255-1264`): remove the `status` key from the payload.
- Remove `status` from the `publish` and `save` dependency arrays.

- [ ] **Step 2: Extend the publish callback and add unpublish**

Replace the `publish` callback body's toast/state section and add a sibling:

```ts
        setVersion(data.flow?.version ?? version)
        setPublished(Boolean(data.flow?.published))
        setUnpublishedChanges(Boolean(data.flow?.unpublishedChanges))
        toast.success(revert ? 'Reverted to the published version.' : 'Published — this version is now live.')
```

```ts
  const unpublish = useCallback(async () => {
    if (!window.confirm('Unpublish this flow? Scheduled runs and webhook triggers stop firing, and any agent wired to call it loses the tool. Your draft and version history are kept.')) return
    setPublishing(true)
    try {
      const response = await fetch(`/api/flows/${id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unpublish: true }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'Could not unpublish.')
        return
      }
      setPublished(Boolean(data.flow?.published))
      setUnpublishedChanges(Boolean(data.flow?.unpublishedChanges))
      toast.success('Unpublished — triggers and agent calls are stopped.')
    } finally {
      setPublishing(false)
    }
  }, [id])
```

- [ ] **Step 3: Replace the button JSX and delete the status select**

Delete the whole `<select value={status} ...>` block (`:1419-1427`). Replace the Publish/Revert buttons (`:1585-1592`) with:

```tsx
        {(() => {
          // Server-side unpublishedChanges is computed against the SAVED
          // draft; `dirty` covers what's on screen but not yet saved.
          const behind = unpublishedChanges || dirty
          if (!published || behind) {
            return (
              <Button
                variant="outline"
                size="sm"
                onClick={() => publish(false)}
                loading={publishing}
                title={published ? 'Draft differs from the published version' : 'Not yet published'}
              >
                {published ? 'Publish changes' : 'Publish'}
              </Button>
            )
          }
          return (
            <Button variant="outline" size="sm" onClick={() => void unpublish()} loading={publishing} title={`Published v${version}`}>
              Unpublish
            </Button>
          )
        })()}
        {published && (unpublishedChanges || dirty) && (
          <Button variant="ghost" size="sm" onClick={() => publish(true)} title="Discard draft changes and restore the published version">
            Revert
          </Button>
        )}
```

- [ ] **Step 4: Verify**

`npm run typecheck` (catches every orphaned `status` reference in the file) and `npm run lint`. Then run the app (`npm run dev`) and click through: publish a new flow → button flips to Unpublish; edit a node → flips to "Publish changes" + Revert; Unpublish → confirm dialog → back to Publish. Check `/api/flows` in devtools shows `status: "active"` after publish.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/flows/[id]/page.tsx'
git commit -m "feat(flows): Publish/Unpublish/Publish-changes button; status dropdown removed"
```

---

### Task 6: Toolbar — remove reactions, relocate Spotlight, float Jam/Huddle over the canvas

**Files:**
- Modify: `src/components/flows/jam-button.tsx` (delete `ReactionPicker`, keep Spotlight via the presence popover)
- Modify: `src/components/flows/use-flow-jam.ts` (remove `sendReaction`, `onReaction`, the `reaction` broadcast listener)
- Modify: `src/components/flows/flow-comments.tsx` (delete `JAM_REACTION_EMOJI`, `FloatingReaction`, `JamReactionsOverlay`)
- Modify: `src/app/flows/[id]/page.tsx` (remove reaction wiring; move `<JamButton>` into a canvas overlay)
- Modify: `src/components/flows/__tests__/jam-button.test.tsx` (drop reaction cases if present)

- [ ] **Step 1: Strip reactions from the transport (`use-flow-jam.ts`)**

- Delete the `onReaction?: ...` member from the callbacks type (`:86`).
- Delete the `.on('broadcast', { event: 'reaction' }, ...)` listener (`:563-571`).
- Delete the `sendReaction` function (`:778-786`) and its entry in the returned object (`:839`).

- [ ] **Step 2: Strip the overlay from `flow-comments.tsx`**

Delete the "Ephemeral reactions" section: `JAM_REACTION_EMOJI`, `type FloatingReaction`, and `JamReactionsOverlay` (from the `// ── Ephemeral reactions` comment to the component's end). Keep everything above it.

- [ ] **Step 3: Rework `jam-button.tsx`**

- Delete the `ReactionPicker` component and the `onReact` prop (type + destructure).
- Delete the `<ReactionPicker ... />` render line and the `SmilePlus` import; keep `Megaphone`.
- Keep the `onSpotlight?: () => void` prop. Inside the invite `DropdownMenuContent` (the presence popover that opens for everyone), add above the owner-gated invite section:

```tsx
          {onSpotlight && peers.length > 0 && (
            <button
              type="button"
              className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-indigo-700"
              onClick={() => { onSpotlight(); setOpen(false) }}
            >
              <Megaphone className="h-3.5 w-3.5" /> Spotlight me — ask everyone to follow
            </button>
          )}
```

- [ ] **Step 4: Rewire `src/app/flows/[id]/page.tsx`**

- Remove: `floatingReactions` state + `pushReaction` (`:350-358`), `onReaction:` callback (`:384`), `handleReact` (`:400-402`), `sendReaction` from the `useFlowJam` destructure (`:367`), `onReact={handleReact}` prop (`:1541`), `<JamReactionsOverlay reactions={floatingReactions} />` (`:1975`), and the `JamReactionsOverlay`/`FloatingReaction` names from the `flow-comments` import (`:53`).
- Move the entire `<JamButton ... />` element out of the top bar. Inside the body wrapper `<div className="relative flex min-h-0 flex-1">` (`:1625`), immediately after `<CanvasErrorBoundary>`'s children begin is wrong — place it as a **sibling of the canvas**, direct child of the relative wrapper, before `<CanvasErrorBoundary>`:

```tsx
        {/* Jam presence + huddle float over the canvas (both modes share this
            one overlay because the wrapper is position:relative). The wrapper
            is pointer-transparent so it never blocks canvas interactions. */}
        <div className="pointer-events-none absolute right-4 top-3 z-30">
          <div className="pointer-events-auto rounded-full border border-border bg-card/95 px-2 py-1 shadow-sm backdrop-blur">
            <JamButton
              flowId={id}
              peers={peers}
              connectionState={connectionState}
              connectionDetail={connectionDetail}
              canManage={canManageJam}
              onAccessChanged={broadcastAccessChange}
              followingClientId={followingClientId}
              onToggleFollow={(peerClientId) => setFollowingClientId((current) => (current === peerClientId ? null : peerClientId))}
              huddle={huddle}
              onSpotlight={handleSpotlight}
            />
          </div>
        </div>
```

- [ ] **Step 5: Verify**

`npm run typecheck` + `npm run lint`, then run the two jam component test files:
`TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test src/components/flows/__tests__/jam-button.test.tsx src/components/flows/__tests__/use-jam-huddle.test.tsx` — fix any test referencing `onReact`/`sendReaction` by deleting the case. In the dev app: the pill floats top-right of the canvas in both Stack and Canvas modes; dragging/clicking the canvas under it still works; the popover shows Spotlight when a peer is present.

- [ ] **Step 6: Commit**

```bash
git add src/components/flows/jam-button.tsx src/components/flows/use-flow-jam.ts src/components/flows/flow-comments.tsx 'src/app/flows/[id]/page.tsx' src/components/flows/__tests__
git commit -m "refactor(flows): reactions removed; Jam/Huddle float over the canvas; Spotlight lives in the presence popover"
```

---

### Task 7: Flows list — Disable replaces Delete on live cards

**Files:**
- Modify: `src/app/flows/page.tsx` (menu, handler, dialog)

**Interfaces:**
- Consumes: `POST /api/flows/[id]/publish` with `{ disable: true }` (Task 2).

- [ ] **Step 1: Add the disable handler + state**

Next to `deleteTarget` add `const [disableTarget, setDisableTarget] = useState<FlowItem | null>(null)`, and beside `deleteFlow`:

```ts
  /** Optimistic disable: flip the card to disabled immediately, restore + toast on failure. */
  const disableFlow = async (flow: FlowItem) => {
    const previous = data
    mutate({ ...data, flows: flows.map((entry) => (entry.id === flow.id ? { ...entry, status: 'disabled' } : entry)) })
    setDisableTarget(null)
    try {
      const response = await fetch(`/api/flows/${flow.id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disable: true }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error)
      }
      void refresh()
    } catch (cause) {
      if (previous) mutate(previous)
      toast.error(cause instanceof Error && cause.message ? cause.message : 'Could not disable the flow.')
    }
  }
```

- [ ] **Step 2: Branch the card menu**

Replace the single Delete item in the card's `DropdownMenuContent`:

```tsx
                              {flow.status === 'disabled' ? (
                                <DropdownMenuItem className="text-red-600 focus:text-red-600" onSelect={() => setDeleteTarget(flow)}>
                                  <Trash2 /> Delete
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem className="text-red-600 focus:text-red-600" onSelect={() => setDisableTarget(flow)}>
                                  <CircleOff /> Disable
                                </DropdownMenuItem>
                              )}
```

Add `CircleOff` to the `lucide-react` import.

- [ ] **Step 3: Add the disable dialog**

Next to the existing delete `Dialog`:

```tsx
      <Dialog open={Boolean(disableTarget)} onOpenChange={(next) => { if (!next) setDisableTarget(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Disable “{disableTarget?.name}”?</DialogTitle>
            <DialogDescription>
              Scheduled runs and webhook triggers stop firing, and agents can no longer call this flow. It stays here with its history — open it and publish to re-enable, or delete it permanently once disabled.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisableTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { if (disableTarget) void disableFlow(disableTarget) }}>
              Disable flow
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
```

- [ ] **Step 4: Verify + commit**

`npm run typecheck` + `npm run lint`. In the dev app: Disable a live flow → badge flips to `disabled`, triggers/agents lose it (its card menu now shows Delete); Delete on the disabled card permanently removes it; open the disabled flow and Publish → card returns to `active`.

```bash
git add src/app/flows/page.tsx
git commit -m "feat(flows): list-page Disable replaces Delete; permanent delete only from a disabled card"
```

---

### Task 8: Recoverable trigger secrets (`webhookSecretEnc` / `triggerSecretEnc`)

**Files:**
- Create: `src/lib/flows/webhook-secret.ts`
- Modify: `src/lib/flows/trigger.ts:38-44` (`preserveWebhookSecretHash` carries the ciphertext)
- Modify: `src/app/api/flows/[id]/trigger-secret/route.ts`
- Modify: `src/app/api/agents/[id]/trigger-secret/route.ts`
- Test: `src/lib/flows/__tests__/webhook-secret.test.ts` (create), extend `src/lib/flows/__tests__` trigger tests if present

**Interfaces:**
- Produces:
  - `newTriggerSecret(): string` — 24 random bytes, base64url
  - `withTriggerSecret(trigger: Record<string, unknown>, secret: string): Record<string, unknown>` — returns `{ ...trigger, type: 'webhook', webhookSecretHash: hashToken(secret), webhookSecretEnc: encryptSecret(secret) }`
  - `readTriggerSecret(trigger: unknown): string | null` — decrypts `webhookSecretEnc` if present/decryptable, else `null`
- Task 11 consumes all three.

- [ ] **Step 1: Write the failing unit test**

Create `src/lib/flows/__tests__/webhook-secret.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newTriggerSecret, withTriggerSecret, readTriggerSecret } from '../webhook-secret'
import { hashToken } from '@/lib/crypto/secrets'
import { preserveWebhookSecretHash } from '../trigger'

test('mint → store → read round-trips, and the hash still validates', () => {
  const secret = newTriggerSecret()
  assert.ok(secret.length >= 30)
  const trigger = withTriggerSecret({ type: 'webhook' }, secret)
  assert.equal(trigger.webhookSecretHash, hashToken(secret))
  assert.equal(readTriggerSecret(trigger), secret)
})

test('readTriggerSecret returns null for legacy hash-only triggers', () => {
  assert.equal(readTriggerSecret({ type: 'webhook', webhookSecretHash: 'abc' }), null)
  assert.equal(readTriggerSecret(undefined), null)
})

test('preserveWebhookSecretHash carries BOTH hash and ciphertext across edits', () => {
  const secret = newTriggerSecret()
  const stored = withTriggerSecret({ type: 'webhook' }, secret)
  const next = preserveWebhookSecretHash({ type: 'webhook', schedule: 'x' }, stored)
  assert.equal(next.webhookSecretHash, stored.webhookSecretHash)
  assert.equal(next.webhookSecretEnc, stored.webhookSecretEnc, 'a plain save must not wipe the ciphertext')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test src/lib/flows/__tests__/webhook-secret.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/flows/webhook-secret.ts`**

```ts
/**
 * Webhook trigger secrets, recoverable form (spec §5). The SHA-256 hash
 * remains the ONLY validation path (trigger routes are untouched); the
 * AES-256-GCM ciphertext exists so an owner-only export can embed the
 * plaintext without rotating — rotation would silently break every previous
 * export and live integration.
 */
import { randomBytes } from 'crypto'
import { hashToken, encryptSecret, decryptSecret } from '@/lib/crypto/secrets'

export function newTriggerSecret(): string {
  return randomBytes(24).toString('base64url')
}

export function withTriggerSecret(trigger: Record<string, unknown>, secret: string): Record<string, unknown> {
  return { ...trigger, type: 'webhook', webhookSecretHash: hashToken(secret), webhookSecretEnc: encryptSecret(secret) }
}

/** Decrypt the stored secret; null for legacy hash-only rows or bad ciphertext. */
export function readTriggerSecret(trigger: unknown): string | null {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return null
  const enc = (trigger as Record<string, unknown>).webhookSecretEnc
  if (typeof enc !== 'string') return null
  try {
    return decryptSecret(enc)
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Extend `preserveWebhookSecretHash` in `src/lib/flows/trigger.ts`**

```ts
export function preserveWebhookSecretHash(next: unknown, existing: unknown): FlowTrigger {
  const trigger = normalizeFlowTrigger(next)
  if (isRecord(existing)) {
    // The client never sees either field, so a plain PUT would wipe them.
    if (typeof existing.webhookSecretHash === 'string') trigger.webhookSecretHash = existing.webhookSecretHash
    if (typeof existing.webhookSecretEnc === 'string') trigger.webhookSecretEnc = existing.webhookSecretEnc
  }
  return trigger
}
```

- [ ] **Step 5: Update both mint routes**

`src/app/api/flows/[id]/trigger-secret/route.ts` — replace the mint tail:

```ts
  const { newTriggerSecret, withTriggerSecret } = await import('@/lib/flows/webhook-secret')
```

No — use a top-level import (`import { newTriggerSecret, withTriggerSecret } from '@/lib/flows/webhook-secret'`), drop the now-unused `randomBytes`/`hashToken` imports, and:

```ts
  const secret = newTriggerSecret()
  await prisma.flow.update({
    where: { id: flow.id, organizationId: auth.organizationId },
    data: { trigger: withTriggerSecret(trigger, secret) },
  })
  return { ...base, hasSecret: true, secret }
```

`src/app/api/agents/[id]/trigger-secret/route.ts` — where it builds `nextMetadata = { ...metadata, triggerSecretHash: hashToken(secret) }`, change to:

```ts
  const nextMetadata = { ...metadata, triggerSecretHash: hashToken(secret), triggerSecretEnc: encryptSecret(secret) }
```

adding `encryptSecret` to the `@/lib/crypto/secrets` import. (The legacy plaintext `metadata.triggerSecret` stays read-tolerated, never written — matching current behavior.)

- [ ] **Step 6: Run tests + typecheck, commit**

Unit test PASSES; `npm run typecheck` clean.

```bash
git add src/lib/flows/webhook-secret.ts src/lib/flows/trigger.ts 'src/app/api/flows/[id]/trigger-secret/route.ts' 'src/app/api/agents/[id]/trigger-secret/route.ts' src/lib/flows/__tests__/webhook-secret.test.ts
git commit -m "feat(flows): trigger secrets stored recoverably (AES-GCM) alongside the validation hash"
```

---

### Task 9: Portable document — `includeCredentials` option + `credentials` block

**Files:**
- Modify: `src/lib/export/portable.ts`
- Test: extend `src/lib/export/__tests__/export.test.ts`

**Interfaces:**
- Produces (Tasks 10–11 consume):
  - `type PortableCredentials = { triggerSecret?: string; agentTriggerSecrets?: Record<string, string> }`
  - `type PortableExportOptions = { includeCredentials?: boolean } & PortableCredentials`
  - `toPortableFlow(flow, agents, exportedAt, options?: PortableExportOptions): PortableFlow`
  - `PortableFlow` gains `containsCredentials?: true` and `credentials?: PortableCredentials`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/export/__tests__/export.test.ts` (the existing `flow`/`graph`/`agents` fixtures are reused; the `SUPER_SECRET`/`SECRET_COOKIE` values are already in the graph):

```ts
// ── Opt-in credentialed export (spec §5) ───────────────────────────────────

const withCreds = () =>
  toPortableFlow(flow, agents, AT, {
    includeCredentials: true,
    triggerSecret: 'FLOW_SECRET_PLAINTEXT',
    agentTriggerSecrets: { agt_1: 'AGENT_SECRET_PLAINTEXT' },
  })

test('default call shape is unchanged: no credentials key, still redacted', () => {
  const doc = portable()
  assert.equal('credentials' in doc, false)
  assert.equal('containsCredentials' in doc, false)
})

test('includeCredentials carries the secrets in the credentials block only', () => {
  const doc = withCreds()
  assert.equal(doc.containsCredentials, true)
  assert.equal(doc.credentials?.triggerSecret, 'FLOW_SECRET_PLAINTEXT')
  assert.equal(doc.credentials?.agentTriggerSecrets?.agt_1, 'AGENT_SECRET_PLAINTEXT')
  // The trigger object itself STILL never carries hash or ciphertext.
  const triggerJson = JSON.stringify(doc.flow.trigger)
  assert.equal(triggerJson.includes('webhookSecretHash'), false)
  assert.equal(triggerJson.includes('webhookSecretEnc'), false)
  assert.equal(triggerJson.includes('HASHED_SECRET'), false)
})

test('includeCredentials keeps user-typed HTTP credentials in the steps', () => {
  const json = JSON.stringify(withCreds())
  assert.equal(json.includes('SUPER_SECRET'), true, 'bearer token travels when opted in')
  assert.equal(json.includes('SECRET_COOKIE'), true, 'cookie travels when opted in')
})

test('includeCredentials leads requirements with the live-credentials warning', () => {
  const doc = withCreds()
  assert.match(doc.requirements[0] ?? '', /live credentials/i)
})
```

Also update the top-of-file fixture flow trigger to carry a ciphertext-shaped field, proving it is stripped:
in the `flow` const, change `trigger` to `{ type: 'webhook', webhookSecretHash: 'HASHED_SECRET', webhookSecretEnc: 'v1:AAA:BBB:CCC' }`, and extend the first safety test:

```ts
  assert.equal(json.includes('webhookSecretEnc'), false)
  assert.equal(json.includes('v1:AAA'), false)
```

- [ ] **Step 2: Run to verify failure**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test src/lib/export/__tests__/export.test.ts`
Expected: new tests FAIL (`toPortableFlow` takes 3 args; no credentials block).

- [ ] **Step 3: Implement in `portable.ts`**

Type additions:

```ts
export type PortableCredentials = {
  /** Plaintext webhook trigger secret for this flow, if it has one. */
  triggerSecret?: string
  /** Plaintext trigger secrets for inlined agents, keyed by PortableAgent.ref. */
  agentTriggerSecrets?: Record<string, string>
}

export type PortableExportOptions = { includeCredentials?: boolean } & PortableCredentials
```

On `PortableFlow` add:

```ts
  /** Present (true) only when the export was made with credentials embedded. */
  containsCredentials?: true
  /** Live secrets — present only when containsCredentials. NEVER placed inside flow.trigger. */
  credentials?: PortableCredentials
```

`sanitizeTrigger` — strip both fields (unconditionally):

```ts
function sanitizeTrigger(trigger: unknown): unknown {
  if (!isRecord(trigger)) return trigger ?? { type: 'manual' }
  const rest = { ...trigger }
  delete rest.webhookSecretHash
  // Ciphertext is a credential too, and useless off-platform; the PLAINTEXT
  // travels (opt-in) in the top-level credentials block, never here.
  delete rest.webhookSecretEnc
  return rest
}
```

`sanitizeNode` gains a flag — the helpers stay unconditional (Global Constraints):

```ts
function sanitizeNode(node: FlowNode, includeCredentials: boolean): FlowNode {
  if (includeCredentials) return node // owner opted in: user-typed secrets travel verbatim
  ...existing body unchanged...
}
```

`toPortableFlow`:

```ts
export function toPortableFlow(
  flow: { name: string; description?: string; trigger?: unknown; graph: FlowGraph },
  agents: { id: string; title: string; instructions: string; goal?: string | null; model?: string; integrations?: string[] }[],
  exportedAt: string,
  options: PortableExportOptions = {},
): PortableFlow {
  const includeCredentials = options.includeCredentials === true
  const nodes = (flow.graph.nodes ?? []).map((node) => sanitizeNode(node, includeCredentials))
```

Requirements adjustments inside the function:
- When `includeCredentials`, unshift as the FIRST requirement:
  `'⚠ This file contains live credentials (trigger secrets and any keys typed into HTTP steps). Anyone holding it can trigger your flow — share it like a password.'`
- The HTTP-steps requirement (`'Re-enter any API keys/tokens…'`) is only pushed when `!includeCredentials`.
- The tool-connections requirement is ALWAYS pushed (OAuth grants still cannot travel), but when `includeCredentials` change its trailing sentence from `'Credentials are never exported.'` to `'OAuth connections cannot travel — reconnect them on the target.'`

Return-object tail:

```ts
  return {
    format: PORTABLE_FORMAT,
    version: PORTABLE_VERSION,
    exportedAt,
    ...(includeCredentials ? {
      containsCredentials: true as const,
      credentials: {
        ...(options.triggerSecret ? { triggerSecret: options.triggerSecret } : {}),
        ...(options.agentTriggerSecrets && Object.keys(options.agentTriggerSecrets).length
          ? { agentTriggerSecrets: options.agentTriggerSecrets } : {}),
      },
    } : {}),
    flow: { ... as before ... },
    agents: inlined,
    requirements,
  }
```

Update the file-top SAFETY comment: sanitization is the default; `includeCredentials` is the owner-only, opt-in exception whose secrets live exclusively in `credentials`.

- [ ] **Step 4: Run tests, verify all pass (old safety tests included), commit**

```bash
git add src/lib/export/portable.ts src/lib/export/__tests__/export.test.ts
git commit -m "feat(export): opt-in credentials block on the portable document; trigger ciphertext always stripped"
```

---

### Task 10: Target emitters substitute the real secrets

**Files:**
- Modify: `src/lib/export/n8n.ts` (`:50-63` agent case), `src/lib/export/workato.ts` (`:42-66`), `src/lib/export/power-automate.ts` (`:65-75`), `src/lib/export/instructions.ts` (warning line)
- Test: extend `src/lib/export/__tests__/export.test.ts` (and check `targets.test.ts` still passes)

**Interfaces:**
- Consumes: `portable.credentials` / `portable.containsCredentials` from Task 9. Emitter signatures are unchanged — they already receive the whole `PortableFlow`.

- [ ] **Step 1: Write the failing test**

```ts
test('every target carries the real secrets when the document does', () => {
  const doc = withCreds()
  const outputs = [
    JSON.stringify(toN8nWorkflow(doc, { triggerBaseUrl: 'https://app.example' })),
    JSON.stringify(toWorkatoRecipe(doc, { triggerBaseUrl: 'https://app.example' })),
    JSON.stringify(toPowerAutomateFlow(doc, { triggerBaseUrl: 'https://app.example' })),
    toInstructions(doc),
  ]
  for (const out of outputs) {
    assert.equal(out.includes('AGENT_SECRET_PLAINTEXT'), true, 'agent trigger secret must be filled in')
    assert.equal(out.includes('REPLACE_WITH_TRIGGER_SECRET'), false, 'no placeholder when the secret is known')
  }
  assert.match(toInstructions(doc).split('\n')[0] ?? '', /live credentials/i)
})

test('targets keep the placeholder when the document has no credentials', () => {
  const doc = portable()
  const n8n = JSON.stringify(toN8nWorkflow(doc, { triggerBaseUrl: 'https://app.example' }))
  assert.equal(n8n.includes('REPLACE_WITH_TRIGGER_SECRET'), true)
})
```

Run the file; expected: FAIL.

- [ ] **Step 2: Implement per emitter**

Each emitter's agent case resolves the secret the same way; n8n (`mapNode` currently receives `(node, triggerBaseUrl)`) — change the signature to `(node, portable, triggerBaseUrl)` (its callers pass `portable` already in scope) and:

```ts
    case 'agent': {
      const agentId = typeof data.agentId === 'string' ? data.agentId : ''
      if (!triggerBaseUrl || !agentId) break
      const secret = portable.credentials?.agentTriggerSecrets?.[agentId] ?? 'REPLACE_WITH_TRIGGER_SECRET'
      const filled = secret !== 'REPLACE_WITH_TRIGGER_SECRET'
      return {
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.2,
        parameters: {
          method: 'POST',
          url: `${triggerBaseUrl}/api/agents/${agentId}/trigger`,
          sendHeaders: true,
          headerParameters: { parameters: [{ name: 'x-trigger-secret', value: secret }] },
          sendBody: true,
          specifyBody: 'json',
          jsonBody: '={{ JSON.stringify({ input: $json }) }}',
        },
        notes: filled
          ? 'Runs the live Sublime agent. The trigger secret is embedded — treat this workflow file like a password.'
          : 'Runs the live Sublime agent. Paste the trigger secret from the agent’s Webhook settings into the x-trigger-secret header.',
      }
    }
```

Apply the same `const secret = portable.credentials?.agentTriggerSecrets?.[agentId] ?? 'REPLACE_WITH_TRIGGER_SECRET'` substitution at `workato.ts:52` (`headers: \`x-trigger-secret: ${secret}\``) and `power-automate.ts:72` (`headers: { 'x-trigger-secret': secret, 'Content-Type': 'application/json' }`), threading `portable` into their node-mapping helpers the same way (both files build nodes inside functions that already close over or receive the portable doc — match each file's local structure).

`instructions.ts`: at the very top of `toInstructions`'s output, when `portable.containsCredentials`, emit first:

```ts
  if (portable.containsCredentials) {
    lines.push('> ⚠ **This document contains live credentials.** Trigger secrets below are real — anyone holding this file can trigger your flow. Share it like a password.', '')
  }
```

(match the local `lines` accumulator name; `instructions.ts:102` area shows the pattern).

- [ ] **Step 3: Run all export tests + targets.test.ts, typecheck, commit**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test src/lib/export/__tests__/export.test.ts src/lib/export/__tests__/targets.test.ts`
Expected: PASS (targets.test.ts asserts the placeholder in the no-credentials path — unchanged).

```bash
git add src/lib/export/n8n.ts src/lib/export/workato.ts src/lib/export/power-automate.ts src/lib/export/instructions.ts src/lib/export/__tests__/export.test.ts
git commit -m "feat(export): targets embed real trigger secrets when the portable doc carries them"
```

---

### Task 11: Export route POST + editor menu variants

**Files:**
- Modify: `src/app/api/flows/[id]/export/route.ts` (GET → POST, per-request scope, secret resolution/minting)
- Modify: `src/app/flows/[id]/page.tsx` (`exportFlow` POSTs; menu offers both variants; toast honesty)
- Test: extend `src/app/api/__tests__/flow-publish-lifecycle-e2e.test.ts`

**Interfaces:**
- Consumes: `readTriggerSecret`/`newTriggerSecret`/`withTriggerSecret` (Task 8), `PortableExportOptions` (Task 9), `decryptSecret` from `@/lib/crypto/secrets`.
- Produces: `POST /api/flows/[id]/export` with body `{ target: 'portable'|'n8n'|'workato'|'power-automate'|'instructions', includeCredentials?: boolean }`; same download headers as today.

- [ ] **Step 1: Write the failing route tests**

Append to the lifecycle e2e file:

```ts
  test('export: non-owner gets 403 for includeCredentials, 200 for sanitized', async () => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'qa-test-key'
    const route = await import('../flows/[id]/export/route')
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    const owner = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId, isActive: true } })
    const flow = await createFlow({ name: 'Export QA', userId: owner.id, visibility: 'org_viewer' })

    // Caller is the seeded (non-owner) user.
    const denied = await route.POST(post(`/api/flows/${flow.id}/export`, { target: 'portable', includeCredentials: true }))
    assert.equal(denied.status, 403)
    const allowed = await route.POST(post(`/api/flows/${flow.id}/export`, { target: 'portable' }))
    assert.equal(allowed.status, 200)
    const doc = await allowed.json()
    assert.equal('credentials' in doc, false)
  })

  test('export: owner with a webhook flow gets a working secret; re-export returns the SAME one', async () => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'qa-test-key'
    const route = await import('../flows/[id]/export/route')
    const webhookGraph = {
      nodes: [
        { id: 'trigger', type: 'trigger', data: { trigger: { type: 'webhook' } } },
        { id: 't1', type: 'transform', data: { fields: [{ name: 'echo', value: 'ok' }] } },
      ],
      edges: [{ id: 'e1', source: 'trigger', target: 't1' }],
    }
    const flow = await createFlow({ name: 'Export Secret QA', graph: webhookGraph, trigger: { type: 'webhook' } })

    const first = await route.POST(post(`/api/flows/${flow.id}/export`, { target: 'portable', includeCredentials: true }))
    assert.equal(first.status, 200)
    const doc1 = await first.json()
    assert.equal(doc1.containsCredentials, true)
    const secret1 = doc1.credentials?.triggerSecret
    assert.ok(secret1, 'a webhook flow must get a minted secret')

    const second = await route.POST(post(`/api/flows/${flow.id}/export`, { target: 'portable', includeCredentials: true }))
    const doc2 = await second.json()
    assert.equal(doc2.credentials?.triggerSecret, secret1, 'export must not rotate an existing secret')

    // The stored hash validates the exported plaintext.
    const { hashToken } = await import('@/lib/crypto/secrets')
    const row = await prisma.flow.findUnique({ where: { id: flow.id } })
    assert.equal((row.trigger as any).webhookSecretHash, hashToken(secret1))
  })
```

Note the env guard: `decryptSecret`/`encryptSecret` fall back to `b64:` without a key in non-production, which round-trips fine, but set `ENCRYPTION_KEY` anyway so the test exercises the real path. Run → expected FAIL (route only exports GET).

- [ ] **Step 2: Rewrite the export route**

Replace `export const GET` with `export const POST` in `src/app/api/flows/[id]/export/route.ts`:

```ts
import { z } from 'zod'
import { flowReadScope, flowOwnerScope, agentReadScope } from '@/lib/server/visibility'
import { readTriggerSecret, newTriggerSecret, withTriggerSecret } from '@/lib/flows/webhook-secret'
import { decryptSecret } from '@/lib/crypto/secrets'
```

```ts
/**
 * POST /api/flows/<id>/export  { target, includeCredentials }
 *
 * Sanitized export (default): read scope — a copy of what the builder already
 * shows. includeCredentials: OWNER ONLY; embeds live trigger secrets (minting
 * one if none is recoverable) and keeps user-typed HTTP credentials, so the
 * response itself is a credential. POST because minting is a side effect.
 */
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const { target, includeCredentials } = z.object({
    target: z.enum(TARGETS).default('portable'),
    includeCredentials: z.boolean().default(false),
  }).parse(await request.json().catch(() => ({})))

  const scope = includeCredentials ? flowOwnerScope(auth.dbUser.id) : flowReadScope(auth.dbUser.id)
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...scope },
    select: { id: true, name: true, description: true, trigger: true, graph: true, userId: true },
  })
  if (!flow) {
    // Distinguish "can read but not own" from "cannot see at all" honestly.
    if (includeCredentials) {
      const readable = await prisma.flow.findFirst({
        where: { id, organizationId: auth.organizationId, ...flowReadScope(auth.dbUser.id) },
        select: { id: true },
      })
      if (readable) throw new ApiError('Only the flow owner can export with credentials', 403, 'FORBIDDEN')
    }
    throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  }
```

Graph/agents loading: unchanged from today's GET (same `agentIds` collection, same `agentTask.findMany` with `agentReadScope`, same `agents` mapping — but add `userId: true, metadata: true` to the select so secret resolution below can check ownership and read `triggerSecretEnc`).

Secret resolution (only when `includeCredentials`):

```ts
  let credentialOptions: PortableExportOptions = {}
  const extraRequirements: string[] = []
  if (includeCredentials) {
    // Flow webhook secret: decrypt if recoverable; mint if the flow has a
    // webhook trigger but no recoverable secret. A pre-encryption secret is
    // REPLACED — the export must state the old one is now invalid.
    const trigger = (flow.trigger && typeof flow.trigger === 'object' && !Array.isArray(flow.trigger) ? flow.trigger : {}) as Record<string, unknown>
    let triggerSecret = readTriggerSecret(trigger)
    const hasWebhook = trigger.type === 'webhook' || typeof trigger.webhookSecretHash === 'string'
    if (!triggerSecret && hasWebhook) {
      const hadLegacySecret = typeof trigger.webhookSecretHash === 'string'
      triggerSecret = newTriggerSecret()
      await prisma.flow.update({
        where: { id: flow.id, organizationId: auth.organizationId },
        data: { trigger: withTriggerSecret(trigger, triggerSecret) },
      })
      if (hadLegacySecret) {
        extraRequirements.push('A new webhook trigger secret was minted for this export — the previous secret no longer works.')
      }
    }

    // Agent trigger secrets: decrypt (or accept legacy plaintext); mint ONLY
    // for agents the caller owns — rotating someone else's agent secret from
    // an export would break their integrations.
    const agentTriggerSecrets: Record<string, string> = {}
    for (const row of rows) {
      const metadata = (row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {}) as Record<string, unknown>
      let secret: string | null = null
      if (typeof metadata.triggerSecretEnc === 'string') {
        try { secret = decryptSecret(metadata.triggerSecretEnc) } catch { secret = null }
      }
      if (!secret && typeof metadata.triggerSecret === 'string') secret = metadata.triggerSecret // legacy plaintext
      if (!secret && row.userId === auth.dbUser.id) {
        secret = newTriggerSecret()
        const { hashToken, encryptSecret } = await import('@/lib/crypto/secrets')
        await prisma.agentTask.update({
          where: { id: row.id, organizationId: auth.organizationId },
          data: { metadata: { ...metadata, triggerSecretHash: hashToken(secret), triggerSecretEnc: encryptSecret(secret) } },
        })
        if (typeof metadata.triggerSecretHash === 'string') {
          extraRequirements.push(`A new trigger secret was minted for agent "${readAgentMetadata(row.metadata).title || 'agent'}" — its previous secret no longer works.`)
        }
      }
      if (secret) agentTriggerSecrets[row.id] = secret
    }
    credentialOptions = { includeCredentials: true, ...(triggerSecret ? { triggerSecret } : {}), agentTriggerSecrets }
  }

  const portable = toPortableFlow({ name: flow.name, description: flow.description, trigger: flow.trigger, graph }, agents, new Date().toISOString(), credentialOptions)
  portable.requirements.push(...extraRequirements)
```

(Import `PortableExportOptions` type from `./portable`'s module path `@/lib/export/portable`. Hoist the `hashToken, encryptSecret` import to the top of the file instead of the inline dynamic import.) The response tail (BY_TARGET map, filename, headers) is unchanged from the current GET.

- [ ] **Step 3: Update the editor**

In `src/app/flows/[id]/page.tsx`:

`exportFlow` becomes:

```ts
  const exportFlow = useCallback(
    async (target: 'portable' | 'n8n' | 'workato' | 'power-automate' | 'instructions', includeCredentials: boolean) => {
      try {
        const response = await fetch(`/api/flows/${id}/export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target, includeCredentials }),
        })
        if (!response.ok) {
          const data = await response.json().catch(() => ({}))
          throw new Error(data.error || 'Export failed')
        }
        const blob = await response.blob()
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? 'workflow'
        link.click()
        URL.revokeObjectURL(url)
        toast.success(
          includeCredentials
            ? 'Exported with live credentials — treat the file like a password.'
            : target === 'instructions'
              ? 'Rebuild instructions downloaded — paste them into any builder.'
              : 'Exported. Credentials were not included — the file lists what to reconnect.',
        )
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Export failed')
      }
    },
    [id],
  )
```

Menu (`:1453-1468`): each target renders the credentialed default plus a sanitized variant; owners only see the credentialed items (`canManageJam` is the editor's ownership predicate):

```tsx
            <DropdownMenuLabel>Export to another platform</DropdownMenuLabel>
            {([
              ['portable', 'Portable JSON (any platform)'],
              ['n8n', 'n8n workflow (import-ready)'],
              ['workato', 'Workato recipe (linear — merges noted)'],
              ['power-automate', 'Power Automate flow (import-ready)'],
            ] as const).map(([target, label]) => (
              canManageJam ? (
                <DropdownMenuItem key={target} onSelect={() => exportFlow(target, true)}>
                  <Download className="h-4 w-4" /> {label}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem key={target} onSelect={() => exportFlow(target, false)}>
                  <Download className="h-4 w-4" /> {label}
                </DropdownMenuItem>
              )
            ))}
            {canManageJam && (
              <DropdownMenuItem onSelect={() => exportFlow('portable', false)}>
                <Download className="h-4 w-4" /> Portable JSON (no credentials)
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => exportFlow('instructions', canManageJam)}>
              <ScrollText className="h-4 w-4" /> Rebuild instructions (Zapier &amp; anything else)
            </DropdownMenuItem>
```

Also update the comment above the label (`:1451-1452`) — it currently states credentials are never included.

- [ ] **Step 4: Run everything, verify, commit**

Run the lifecycle e2e file (all tests), both export test files, `npm run typecheck`, `npm run lint`. Expected: PASS/clean. In the dev app: as owner, export n8n → file contains a real `x-trigger-secret` value and the warning requirement; "(no credentials)" variant contains the placeholder.

```bash
git add 'src/app/api/flows/[id]/export/route.ts' 'src/app/flows/[id]/page.tsx' src/app/api/__tests__/flow-publish-lifecycle-e2e.test.ts
git commit -m "feat(export): owner-only credentialed export — POST route mints/decrypts trigger secrets"
```

---

### Task 12: Full-suite verification

**Files:** none new.

- [ ] **Step 1:** `npm run typecheck` — clean.
- [ ] **Step 2:** `npm run lint` — clean.
- [ ] **Step 3:** `TEST_DATABASE_URL=<test db> npm test` — all suites pass (watch specifically: `flow-publish-lifecycle-e2e`, `tool-capture-e2e`, `export.test`, `targets.test`, `flow-tool.test`, `webhook-secret.test`, jam component tests).
- [ ] **Step 4:** Manual smoke in `npm run dev` — the end-to-end user story from the bug report: create flow → Publish → open an agent's config → "Call flows" shows **1 available**; button reads Unpublish; edit → "Publish changes"; flows list → Disable → agent shows 0 again; export n8n with credentials → import file carries the secret.
- [ ] **Step 5:** Commit any test-only fixups, then hand off per superpowers:finishing-a-development-branch.
