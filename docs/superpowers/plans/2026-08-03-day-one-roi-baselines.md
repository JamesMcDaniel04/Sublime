# Day-One ROI Plan 1: Adapter Enrichment + Process Baselines

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make activity adapters emit state transitions, then compute deterministic, persisted process baselines (volume, cycle time, rework, confidence) from that history.

**Architecture:** Adapters gain new normalizers that populate `previousState` — the field the ledger already persists but nothing writes. A new `src/lib/baselines/` module reads `ActivityEvent` rows, groups them by `(source, action, entityType)`, and computes measured statistics with pure functions. No LLM anywhere in this plan; every number is arithmetic over observed rows. Baselines persist to a new `ProcessBaseline` table and project into the graph through the existing `writeInference` citation path.

**Tech Stack:** TypeScript, Prisma 6 / Postgres, Nango proxy for provider calls, `node:test` via `tsx --test`.

## Global Constraints

- Tests run with `npm test` (`tsx --test` over `src/**/__tests__/*.test.ts`). No vitest, no jest.
- Test style follows the existing activity suites: `import { test } from 'node:test'`, `import assert from 'node:assert/strict'`.
- Pure functions are exported and tested directly. DB-touching functions take an injectable db seam like `ActivityDb` in `src/lib/activity/ledger.ts`.
- Any event representing a change to an existing entity **must** populate `previousState`. This is the acceptance criterion for Phase 1.
- Never introduce a second cost model. Labor rate comes from `laborHourlyRate` in org settings, read the way `impactSettings` in `src/lib/goals/impact.ts` reads it (default `50`).
- Org settings writes use `mergeOrgSettings` from `src/lib/server/org-settings.ts` — never a raw settings overwrite.
- Provider credentials never enter this process. All provider calls go through the Nango proxy seam (`NangoProxy`), with a `proxyOverride` parameter for tests.
- PII discipline from the existing HubSpot adapter holds: deal names and stages only. Never read contact records or email bodies.
- New `dedupeKey` values must be stable across re-runs and unique per logical event. Backfills overlap; the `(organizationId, dedupeKey)` constraint is the only replay guard.

---

### Task 1: Verify HubSpot property-history availability

The spec flags this as the one risk that can invalidate the design. `POST /crm/v3/objects/deals/search` — what the adapter uses today — does **not** return property history. `GET /crm/v3/objects/deals?propertiesWithHistory=dealstage` does. This task confirms that endpoint returns usable history before any code is built on it.

**Files:**
- Create: `scripts/spikes/hubspot-history-probe.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: a go/no-go decision recorded in the plan. If history is unavailable, Tasks 2–3 are skipped and `medianCycleTimeHours`/`reworkRate` stay null throughout — Tasks 4–13 proceed unchanged.

- [ ] **Step 1: Write the probe script**

```javascript
// scripts/spikes/hubspot-history-probe.mjs
// One-shot: does this portal return dealstage property history?
// Usage: NANGO_SECRET_KEY=... node scripts/spikes/hubspot-history-probe.mjs <connectionId> <providerConfigKey>
import { Nango } from '@nangohq/node'

const [connectionId, providerConfigKey] = process.argv.slice(2)
if (!connectionId || !providerConfigKey) {
  console.error('usage: node hubspot-history-probe.mjs <connectionId> <providerConfigKey>')
  process.exit(1)
}

const nango = new Nango({ secretKey: process.env.NANGO_SECRET_KEY })
const response = await nango.proxy({
  method: 'GET',
  endpoint: '/crm/v3/objects/deals',
  connectionId,
  providerConfigKey,
  params: { limit: 5, propertiesWithHistory: 'dealstage', properties: 'dealname,dealstage,createdate,hubspot_owner_id' },
})

const results = response.data?.results ?? []
console.log(`deals returned: ${results.length}`)
for (const deal of results) {
  const history = deal.propertiesWithHistory?.dealstage
  console.log(JSON.stringify({
    id: deal.id,
    historyEntries: Array.isArray(history) ? history.length : 0,
    sample: Array.isArray(history) ? history.slice(0, 3).map((h) => ({ value: h.value, timestamp: h.timestamp })) : null,
  }, null, 2))
}
```

- [ ] **Step 2: Run the probe against a real portal**

Run: `NANGO_SECRET_KEY=<key> node scripts/spikes/hubspot-history-probe.mjs <connectionId> hubspot`

Expected on success: at least one deal with `historyEntries >= 2` and `sample` entries carrying `value` (a stage id) and `timestamp` (epoch ms as a string).

- [ ] **Step 3: Record the decision**

Append a short "Verification" note to `docs/superpowers/specs/2026-08-03-day-one-roi-design.md` stating whether `propertiesWithHistory` returned usable stage history, on which portal tier, and the observed field shapes.

If history came back empty or the endpoint 403'd: mark Tasks 2 and 3 as skipped in this plan, note that HubSpot baselines are volume-only, and continue at Task 4. Do not attempt to synthesize transitions from creation timestamps — a fabricated cycle time is worse than a null one.

- [ ] **Step 4: Commit**

```bash
git add scripts/spikes/hubspot-history-probe.mjs docs/superpowers/specs/2026-08-03-day-one-roi-design.md
git commit -m "spike: verify HubSpot dealstage property history availability"
```

---

### Task 2: HubSpot stage-change normalizer

Turn a deal's `propertiesWithHistory.dealstage` array into one `NormalizedActivity` per transition, each carrying `previousState` and `newState`.

HubSpot returns history newest-first. Entry *i* is the state entered at `timestamp`; entry *i+1* is the state it replaced. The oldest entry has no predecessor and is the initial stage, not a transition — it is dropped.

**Files:**
- Modify: `src/lib/activity/sources/hubspot.ts`
- Test: `src/lib/activity/__tests__/hubspot-source.test.ts`

**Interfaces:**
- Consumes: `NormalizedActivity` from `src/lib/activity/types.ts`.
- Produces: `hubspotStageChangeActivities(item: HubspotDeal): NormalizedActivity[]` — emits `action: 'deal_stage_changed'`, `entityType: 'deal'`, `dedupeKey: 'hubspot:deal:<id>:stage:<timestampMs>'`.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/activity/__tests__/hubspot-source.test.ts`:

```typescript
import { hubspotDealActivity, hubspotStageChangeActivities } from '../sources/hubspot'

const dealWithHistory = {
  id: 'deal_42',
  properties: {
    dealname: 'Acme expansion',
    dealstage: 'closedwon',
    createdate: '2026-07-01T12:00:00Z',
    hubspot_owner_id: 'owner_7',
  },
  propertiesWithHistory: {
    // HubSpot returns newest first.
    dealstage: [
      { value: 'closedwon', timestamp: '1754006400000' },
      { value: 'contractsent', timestamp: '1753920000000' },
      { value: 'qualifiedtobuy', timestamp: '1753833600000' },
    ],
  },
}

test('stage history becomes transitions carrying previousState', () => {
  const events = hubspotStageChangeActivities(dealWithHistory)
  // 3 history entries = 2 transitions; the oldest entry is the initial stage.
  assert.equal(events.length, 2)

  const [newest, older] = events
  assert.equal(newest.action, 'deal_stage_changed')
  assert.equal(newest.entityType, 'deal')
  assert.equal(newest.entityRef, 'deal_42')
  assert.equal(newest.actorRef, 'owner_7')
  assert.deepEqual(newest.previousState, { stage: 'contractsent' })
  assert.deepEqual(newest.newState, { stage: 'closedwon' })
  assert.equal(newest.occurredAt.toISOString(), '2026-08-01T00:00:00.000Z')
  assert.equal(newest.dedupeKey, 'hubspot:deal:deal_42:stage:1754006400000')

  assert.deepEqual(older.previousState, { stage: 'qualifiedtobuy' })
  assert.deepEqual(older.newState, { stage: 'contractsent' })
})

test('stage history edge cases: single entry, absent history, bad timestamps', () => {
  // One entry is the initial stage, not a transition.
  assert.deepEqual(
    hubspotStageChangeActivities({ ...dealWithHistory, propertiesWithHistory: { dealstage: [{ value: 'appointmentscheduled', timestamp: '1753833600000' }] } }),
    [],
  )
  assert.deepEqual(hubspotStageChangeActivities({ ...dealWithHistory, propertiesWithHistory: undefined }), [])
  assert.deepEqual(hubspotStageChangeActivities({ ...dealWithHistory, id: undefined }), [])
  // A malformed timestamp drops only the transition it belongs to.
  const partial = hubspotStageChangeActivities({
    ...dealWithHistory,
    propertiesWithHistory: {
      dealstage: [
        { value: 'closedwon', timestamp: 'garbage' },
        { value: 'contractsent', timestamp: '1753920000000' },
        { value: 'qualifiedtobuy', timestamp: '1753833600000' },
      ],
    },
  })
  assert.equal(partial.length, 1)
  assert.deepEqual(partial[0].newState, { stage: 'contractsent' })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/activity/__tests__/hubspot-source.test.ts`
Expected: FAIL — `hubspotStageChangeActivities is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/lib/activity/sources/hubspot.ts`, extend the deal type and add the normalizer below `hubspotDealActivity`:

```typescript
type HubspotHistoryEntry = { value?: unknown; timestamp?: unknown }

type HubspotDeal = {
  id?: unknown
  properties?: {
    dealname?: unknown
    dealstage?: unknown
    createdate?: unknown
    hubspot_owner_id?: unknown
    amount?: unknown
  }
  propertiesWithHistory?: {
    dealstage?: HubspotHistoryEntry[]
  }
}

/** HubSpot history timestamps are epoch-ms strings. Null on anything else. */
function historyTimestamp(raw: unknown): Date | null {
  const ms = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN
  if (!Number.isFinite(ms)) return null
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * One event per stage transition. HubSpot returns history newest-first, so
 * entry i is the state entered and entry i+1 the state it replaced. The
 * oldest entry has no predecessor — it is the initial stage, not a
 * transition, and is dropped.
 */
export function hubspotStageChangeActivities(item: HubspotDeal): NormalizedActivity[] {
  const id = typeof item.id === 'string' ? item.id : null
  const history = item.propertiesWithHistory?.dealstage
  if (!id || !Array.isArray(history) || history.length < 2) return []

  const owner =
    typeof item.properties?.hubspot_owner_id === 'string' && item.properties.hubspot_owner_id
      ? item.properties.hubspot_owner_id
      : 'unknown'
  const dealName = typeof item.properties?.dealname === 'string' ? item.properties.dealname.slice(0, 200) : null

  const events: NormalizedActivity[] = []
  for (let index = 0; index < history.length - 1; index += 1) {
    const entered = history[index]
    const replaced = history[index + 1]
    const occurredAt = historyTimestamp(entered?.timestamp)
    const toStage = typeof entered?.value === 'string' ? entered.value : null
    const fromStage = typeof replaced?.value === 'string' ? replaced.value : null
    if (!occurredAt || !toStage || !fromStage) continue

    events.push({
      source: 'hubspot',
      actorRef: owner,
      action: 'deal_stage_changed',
      entityType: 'deal',
      entityRef: id,
      entityName: dealName,
      previousState: { stage: fromStage },
      newState: { stage: toStage },
      businessContext: { stage: toStage },
      occurredAt,
      dedupeKey: `hubspot:deal:${id}:stage:${occurredAt.getTime()}`,
    })
  }
  return events
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/lib/activity/__tests__/hubspot-source.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/lib/activity/sources/hubspot.ts src/lib/activity/__tests__/hubspot-source.test.ts
git commit -m "feat(activity): normalize HubSpot deal stage transitions with previousState"
```

---

### Task 3: Fetch stage history in the HubSpot backfill

The normalizer is useless until the backfill requests history. The search endpoint cannot return it, so backfill switches to `GET /crm/v3/objects/deals` with `propertiesWithHistory`, which paginates by the same `after` cursor.

Incremental sync keeps using search — it only needs recent creations, and the list endpoint has no `since` filter.

**Files:**
- Modify: `src/lib/activity/sources/hubspot.ts`
- Test: `src/lib/activity/__tests__/hubspot-source.test.ts`

**Interfaces:**
- Consumes: `hubspotDealActivity`, `hubspotStageChangeActivities` from Task 2.
- Produces: backfill batches containing both creation and stage-change events.

- [ ] **Step 1: Write the failing test**

```typescript
test('one deal page maps to creation plus stage-change events', () => {
  // The adapter resolves its Nango connection from the DB, so this test
  // drives the page-to-events mapping the generator performs, not the
  // generator itself. The cursor plumbing is covered by the next test.
  const events = [
    hubspotDealActivity(dealWithHistory),
    ...hubspotStageChangeActivities(dealWithHistory),
  ].filter((event): event is NonNullable<typeof event> => event !== null)

  assert.equal(events.length, 3)
  assert.deepEqual(
    events.map((event) => event.action).sort(),
    ['created_deal', 'deal_stage_changed', 'deal_stage_changed'],
  )
  // Every non-creation event carries a previousState — the Phase 1 criterion.
  for (const event of events) {
    if (event.action !== 'created_deal') assert.ok(event.previousState)
  }
})

test('listDealsWithHistory requests propertiesWithHistory and follows the cursor', async () => {
  const seen: Record<string, unknown>[] = []
  const proxy = (async (args: Record<string, unknown>) => {
    seen.push(args.params as Record<string, unknown>)
    return { data: { results: [dealWithHistory], paging: { next: { after: 'cursor_2' } } } }
  }) as never

  const page = await listDealsWithHistory(proxy, { connectionId: 'c1', providerConfigKey: 'hubspot' }, undefined)
  assert.equal(page.after, 'cursor_2')
  assert.equal(page.deals.length, 1)
  assert.equal(seen[0].propertiesWithHistory, 'dealstage')
  assert.equal(seen[0].limit, 100)
})
```

Add `listDealsWithHistory` to the import list at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/activity/__tests__/hubspot-source.test.ts`
Expected: FAIL — `listDealsWithHistory is not exported`.

- [ ] **Step 3: Write the implementation**

Add the list fetcher next to `searchDeals` in `src/lib/activity/sources/hubspot.ts`:

```typescript
/**
 * Backfill reads through the list endpoint, not search: only this one returns
 * `propertiesWithHistory`, which is where stage transitions live. Pagination
 * is the same opaque `after` cursor, so the backfill loop is unchanged.
 */
export async function listDealsWithHistory(
  proxy: NangoProxy,
  connection: { connectionId: string; providerConfigKey: string },
  after?: string,
): Promise<SearchPage> {
  const response = await proxy({
    method: 'GET',
    endpoint: '/crm/v3/objects/deals',
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    params: {
      limit: PAGE_SIZE,
      ...(after ? { after } : {}),
      properties: 'dealname,dealstage,createdate,hubspot_owner_id',
      propertiesWithHistory: 'dealstage',
    },
  })
  const data = response.data as { results?: unknown[]; paging?: { next?: { after?: unknown } } }
  return {
    deals: Array.isArray(data.results) ? (data.results as HubspotDeal[]) : [],
    after: typeof data.paging?.next?.after === 'string' ? data.paging.next.after : undefined,
  }
}
```

Then in the `backfill` generator, replace the `searchDeals` call and the event mapping:

```typescript
        let page: SearchPage
        try {
          page = await listDealsWithHistory(proxy, connection, after)
        } catch (error) {
          apiLogger.warn('hubspot backfill: page fetch failed, stopping run', {
            error: error instanceof Error ? error.message : String(error),
          })
          yield { events: [], ...(after ? { nextCursor: after } : {}) }
          return
        }
        const events = page.deals
          .flatMap((deal) => [hubspotDealActivity(deal), ...hubspotStageChangeActivities(deal)])
          .filter((event): event is NormalizedActivity => event !== null)
          // The list endpoint has no createdate filter; drop pre-window
          // creations client-side. Transitions inside the window are kept
          // even when the deal itself is older — the transition is the fact.
          .filter((event) => !since || event.occurredAt >= since)
```

The `since` binding stays as it is; it is now a client-side filter rather than a server-side one.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/lib/activity/__tests__/hubspot-source.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/activity/sources/hubspot.ts src/lib/activity/__tests__/hubspot-source.test.ts
git commit -m "feat(activity): backfill HubSpot deals through the history endpoint"
```

---

### Task 4: HubSpot engagement events

Deals alone under-describe RevOps work. Logged emails, calls, and completed tasks are the recurring, automatable actions a baseline should measure. HubSpot exposes them at `/crm/v3/objects/{emails,calls,tasks}`.

Task completion is a transition (`not_started`/`waiting` → `completed`) and populates `previousState`. Logged emails and calls are point events with no prior state.

**Files:**
- Modify: `src/lib/activity/sources/hubspot.ts`
- Test: `src/lib/activity/__tests__/hubspot-source.test.ts`

**Interfaces:**
- Consumes: `NormalizedActivity`.
- Produces: `hubspotEngagementActivity(kind: 'email' | 'call' | 'task', item: HubspotEngagement): NormalizedActivity | null` — actions `logged_email`, `logged_call`, `completed_task`; entity types `email`, `call`, `task`.

- [ ] **Step 1: Write the failing test**

```typescript
import { hubspotEngagementActivity } from '../sources/hubspot'

test('logged emails and calls normalize as point events', () => {
  const email = hubspotEngagementActivity('email', {
    id: 'eng_1',
    properties: { hs_timestamp: '2026-07-15T09:00:00Z', hubspot_owner_id: 'owner_7', hs_email_subject: 'Follow-up' },
  })
  assert.ok(email)
  assert.equal(email.action, 'logged_email')
  assert.equal(email.entityType, 'email')
  assert.equal(email.actorRef, 'owner_7')
  assert.equal(email.dedupeKey, 'hubspot:email:eng_1')
  assert.equal(email.previousState, undefined)
  // Subjects can carry customer PII; only the presence of one is recorded.
  assert.equal(email.entityName, null)

  const call = hubspotEngagementActivity('call', {
    id: 'eng_2',
    properties: { hs_timestamp: '2026-07-15T10:00:00Z', hubspot_owner_id: 'owner_7' },
  })
  assert.equal(call?.action, 'logged_call')
  assert.equal(call?.dedupeKey, 'hubspot:call:eng_2')
})

test('completed tasks carry a status transition; open tasks are dropped', () => {
  const done = hubspotEngagementActivity('task', {
    id: 'task_9',
    properties: {
      hs_timestamp: '2026-07-16T08:00:00Z',
      hubspot_owner_id: 'owner_7',
      hs_task_status: 'COMPLETED',
      hs_task_type: 'TODO',
    },
  })
  assert.ok(done)
  assert.equal(done.action, 'completed_task')
  assert.deepEqual(done.previousState, { status: 'open' })
  assert.deepEqual(done.newState, { status: 'COMPLETED' })
  assert.deepEqual(done.businessContext, { taskType: 'TODO' })

  // An open task is not work observed — it is work pending.
  assert.equal(
    hubspotEngagementActivity('task', {
      id: 'task_10',
      properties: { hs_timestamp: '2026-07-16T08:00:00Z', hubspot_owner_id: 'owner_7', hs_task_status: 'NOT_STARTED' },
    }),
    null,
  )
  // No timestamp is unusable.
  assert.equal(hubspotEngagementActivity('email', { id: 'eng_3', properties: {} }), null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/activity/__tests__/hubspot-source.test.ts`
Expected: FAIL — `hubspotEngagementActivity is not a function`.

- [ ] **Step 3: Write the implementation**

```typescript
export type HubspotEngagement = {
  id?: unknown
  properties?: {
    hs_timestamp?: unknown
    hubspot_owner_id?: unknown
    hs_task_status?: unknown
    hs_task_type?: unknown
    hs_email_subject?: unknown
  }
}

const ENGAGEMENT_ACTIONS = {
  email: { action: 'logged_email', entityType: 'email' },
  call: { action: 'logged_call', entityType: 'call' },
  task: { action: 'completed_task', entityType: 'task' },
} as const

/**
 * Engagements are the recurring RevOps work deals alone miss. Task
 * completion is a transition and carries previousState; emails and calls are
 * point events. Subjects and bodies are never recorded — they carry customer
 * PII and the baseline layer needs only counts and timing.
 */
export function hubspotEngagementActivity(
  kind: 'email' | 'call' | 'task',
  item: HubspotEngagement,
): NormalizedActivity | null {
  const id = typeof item.id === 'string' ? item.id : null
  const raw = item.properties?.hs_timestamp
  const occurredAt = typeof raw === 'string' ? new Date(raw) : null
  if (!id || !occurredAt || Number.isNaN(occurredAt.getTime())) return null

  const status = typeof item.properties?.hs_task_status === 'string' ? item.properties.hs_task_status : null
  // Only completed tasks are observed work. An open task is work pending.
  if (kind === 'task' && status !== 'COMPLETED') return null

  const owner =
    typeof item.properties?.hubspot_owner_id === 'string' && item.properties.hubspot_owner_id
      ? item.properties.hubspot_owner_id
      : 'unknown'
  const taskType = typeof item.properties?.hs_task_type === 'string' ? item.properties.hs_task_type : null

  return {
    source: 'hubspot',
    actorRef: owner,
    action: ENGAGEMENT_ACTIONS[kind].action,
    entityType: ENGAGEMENT_ACTIONS[kind].entityType,
    entityRef: id,
    entityName: null,
    ...(kind === 'task' ? { previousState: { status: 'open' }, newState: { status } } : {}),
    businessContext: taskType ? { taskType } : {},
    occurredAt,
    dedupeKey: `hubspot:${kind}:${id}`,
  }
}
```

Then extend the backfill generator to walk engagements after deals. Replace the `SearchPage`-only cursor with a phased cursor:

```typescript
type HubspotCursor = { phase: 'deals' | 'email' | 'call' | 'task'; after?: string }

const ENGAGEMENT_PHASES = ['email', 'call', 'task'] as const

const ENGAGEMENT_PROPERTIES: Record<string, string> = {
  email: 'hs_timestamp,hubspot_owner_id',
  call: 'hs_timestamp,hubspot_owner_id',
  task: 'hs_timestamp,hubspot_owner_id,hs_task_status,hs_task_type',
}

export async function listEngagements(
  proxy: NangoProxy,
  connection: { connectionId: string; providerConfigKey: string },
  kind: 'email' | 'call' | 'task',
  after?: string,
): Promise<{ items: HubspotEngagement[]; after?: string }> {
  const response = await proxy({
    method: 'GET',
    endpoint: `/crm/v3/objects/${kind}s`,
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    params: { limit: PAGE_SIZE, ...(after ? { after } : {}), properties: ENGAGEMENT_PROPERTIES[kind] },
  })
  const data = response.data as { results?: unknown[]; paging?: { next?: { after?: unknown } } }
  return {
    items: Array.isArray(data.results) ? (data.results as HubspotEngagement[]) : [],
    after: typeof data.paging?.next?.after === 'string' ? data.paging.next.after : undefined,
  }
}
```

Rewrite the `backfill` generator body to drive the phased cursor:

```typescript
    async *backfill(ctx: SourceContext, window: BackfillWindow, cursor?: string): AsyncIterable<BackfillBatch> {
      const connection = await resolveConnection(ctx)
      if (!connection) return
      const proxy = proxyOverride ?? defaultProxy()
      const since = windowStart(window, new Date())
      let state: HubspotCursor = cursor ? (JSON.parse(cursor) as HubspotCursor) : { phase: 'deals' }

      while (true) {
        let events: NormalizedActivity[] = []
        let nextAfter: string | undefined
        try {
          if (state.phase === 'deals') {
            const page = await listDealsWithHistory(proxy, connection, state.after)
            events = page.deals
              .flatMap((deal) => [hubspotDealActivity(deal), ...hubspotStageChangeActivities(deal)])
              .filter((event): event is NormalizedActivity => event !== null)
            nextAfter = page.after
          } else {
            const page = await listEngagements(proxy, connection, state.phase, state.after)
            events = page.items
              .map((item) => hubspotEngagementActivity(state.phase as 'email' | 'call' | 'task', item))
              .filter((event): event is NormalizedActivity => event !== null)
            nextAfter = page.after
          }
        } catch (error) {
          apiLogger.warn('hubspot backfill: page fetch failed, stopping run', {
            phase: state.phase,
            error: error instanceof Error ? error.message : String(error),
          })
          yield { events: [], nextCursor: JSON.stringify(state) }
          return
        }

        const inWindow = events.filter((event) => !since || event.occurredAt >= since)

        if (nextAfter) {
          state = { phase: state.phase, after: nextAfter }
          yield { events: inWindow, nextCursor: JSON.stringify(state) }
          continue
        }

        const phaseIndex = state.phase === 'deals' ? -1 : ENGAGEMENT_PHASES.indexOf(state.phase)
        const nextPhase = ENGAGEMENT_PHASES[phaseIndex + 1]
        if (!nextPhase) {
          yield { events: inWindow }
          return
        }
        state = { phase: nextPhase }
        yield { events: inWindow, nextCursor: JSON.stringify(state) }
      }
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/lib/activity/__tests__/hubspot-source.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full activity suite for regressions**

Run: `npx tsx --test $(find src/lib/activity -name '*.test.ts')`
Expected: PASS. The backfill loop in `backfill.ts` is cursor-agnostic, so the cursor format change must not break `backfill.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/activity/sources/hubspot.ts src/lib/activity/__tests__/hubspot-source.test.ts
git commit -m "feat(activity): ingest HubSpot emails, calls, and completed tasks"
```

---

### Task 5: GitHub PR lifecycle events

`opened_pr` alone gives volume with no duration. Merges and closes are transitions that make review latency computable.

**Files:**
- Modify: `src/lib/activity/sources/github.ts`
- Test: `src/lib/activity/__tests__/github-source.test.ts`

**Interfaces:**
- Consumes: `NormalizedActivity`.
- Produces: `githubPullLifecycleActivity(repo: string, item: Record<string, unknown>): NormalizedActivity | null` — action `merged_pr` or `closed_pr`, `entityType: 'pull_request'`.

- [ ] **Step 1: Write the failing test**

```typescript
import { githubPullLifecycleActivity } from '../sources/github'

const mergedPr = {
  number: 12,
  title: 'Add baseline module',
  user: { login: 'alice' },
  pull_request: {},
  state: 'closed',
  created_at: '2026-07-10T09:00:00Z',
  closed_at: '2026-07-12T15:00:00Z',
  merged_at: '2026-07-12T15:00:00Z',
}

test('a merged PR becomes a transition from open', () => {
  const event = githubPullLifecycleActivity('acme/api', mergedPr)
  assert.ok(event)
  assert.equal(event.action, 'merged_pr')
  assert.equal(event.entityType, 'pull_request')
  assert.equal(event.entityRef, 'acme/api#12')
  assert.equal(event.actorRef, 'alice')
  assert.deepEqual(event.previousState, { state: 'open' })
  assert.deepEqual(event.newState, { state: 'merged' })
  assert.equal(event.outcome, 'merged')
  assert.equal(event.occurredAt.toISOString(), '2026-07-12T15:00:00.000Z')
  assert.equal(event.dedupeKey, 'github:acme/api:pr:12:merged')
})

test('closed-unmerged is distinct; open PRs and issues yield nothing', () => {
  const closed = githubPullLifecycleActivity('acme/api', { ...mergedPr, merged_at: null })
  assert.equal(closed?.action, 'closed_pr')
  assert.deepEqual(closed?.newState, { state: 'closed' })
  assert.equal(closed?.outcome, 'closed')
  assert.equal(closed?.dedupeKey, 'github:acme/api:pr:12:closed')

  assert.equal(githubPullLifecycleActivity('acme/api', { ...mergedPr, closed_at: null, merged_at: null }), null)
  // Issues are not pull requests.
  assert.equal(githubPullLifecycleActivity('acme/api', { ...mergedPr, pull_request: undefined }), null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/activity/__tests__/github-source.test.ts`
Expected: FAIL — `githubPullLifecycleActivity is not a function`.

- [ ] **Step 3: Write the implementation**

Add below `githubIssueActivity` in `src/lib/activity/sources/github.ts`:

```typescript
/**
 * The close/merge half of a PR's life. `opened_pr` gives volume; this gives
 * duration — pairing the two on entityRef is what makes review latency a
 * measurable cycle time. Issues are excluded: they close for reasons that
 * are not completion.
 */
export function githubPullLifecycleActivity(repo: string, item: Record<string, unknown>): NormalizedActivity | null {
  if (!item.pull_request) return null
  const number = typeof item.number === 'number' ? item.number : null
  const actor = (item.user as { login?: unknown } | undefined)?.login
  if (number === null || typeof actor !== 'string') return null

  const mergedAt = typeof item.merged_at === 'string' ? new Date(item.merged_at) : null
  const closedAt = typeof item.closed_at === 'string' ? new Date(item.closed_at) : null
  const merged = mergedAt !== null && !Number.isNaN(mergedAt.getTime())
  const occurredAt = merged ? mergedAt : closedAt
  if (!occurredAt || Number.isNaN(occurredAt.getTime())) return null

  return {
    source: 'github',
    actorRef: actor,
    action: merged ? 'merged_pr' : 'closed_pr',
    entityType: 'pull_request',
    entityRef: `${repo}#${number}`,
    entityName: typeof item.title === 'string' ? item.title.slice(0, 200) : null,
    previousState: { state: 'open' },
    newState: { state: merged ? 'merged' : 'closed' },
    businessContext: { repo },
    outcome: merged ? 'merged' : 'closed',
    occurredAt,
    dedupeKey: `github:${repo}:pr:${number}:${merged ? 'merged' : 'closed'}`,
  }
}
```

In the `backfill` generator, the issues phase currently maps one event per item. Change that mapping to emit both:

```typescript
          events = items
            .flatMap((item) =>
              state.phase === 'issues'
                ? [githubIssueActivity(repo, item), githubPullLifecycleActivity(repo, item)]
                : [githubCommitActivity(repo, item)],
            )
            .filter((event): event is NormalizedActivity => event !== null)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/lib/activity/__tests__/github-source.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/activity/sources/github.ts src/lib/activity/__tests__/github-source.test.ts
git commit -m "feat(activity): ingest GitHub PR merge and close transitions"
```

---

### Task 6: Trigger Slack backfill on connect

Slack has a working adapter and real history, but sits outside auto-backfill. It cannot simply join `NANGO_BACKFILL_SOURCES`: its `connectionRef` keys on `SlackWorkspaceConnection.id`, not a Nango connection id, so it needs a trigger on its own connect path.

**Files:**
- Modify: `src/lib/activity/auto-backfill.ts`
- Test: `src/lib/activity/__tests__/auto-backfill.test.ts`

**Interfaces:**
- Consumes: `startActivityBackfill` from `src/lib/activity/backfill.ts`.
- Produces: `triggerSlackBackfill(organizationId: string, workspaceConnectionId: string): Promise<void>`.

- [ ] **Step 1: Find the Slack connect completion point**

Run: `grep -rn "slackWorkspaceConnection.create\|slackWorkspaceConnection.upsert" src --include=*.ts`

Note the file and line. That is where the trigger is called from in Step 5.

- [ ] **Step 2: Write the failing test**

Add to `src/lib/activity/__tests__/auto-backfill.test.ts`:

```typescript
import { autoBackfillSource, SLACK_BACKFILL_WINDOW } from '../auto-backfill'

test('slack stays out of the Nango auto-backfill set', () => {
  // Its adapter keys connectionRef on SlackWorkspaceConnection.id, so a
  // Nango connection id would be the wrong ref entirely.
  assert.equal(autoBackfillSource('slack'), null)
})

test('slack backfill uses the same 90d window as the Nango sources', () => {
  assert.equal(SLACK_BACKFILL_WINDOW, '90d')
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx --test src/lib/activity/__tests__/auto-backfill.test.ts`
Expected: FAIL — `SLACK_BACKFILL_WINDOW is not exported`.

- [ ] **Step 4: Write the implementation**

Add to `src/lib/activity/auto-backfill.ts`:

```typescript
/** Slack rides the same window as the Nango sources — the divergence would
 *  otherwise show up as inconsistent windowDays across an org's baselines. */
export const SLACK_BACKFILL_WINDOW: BackfillWindow = AUTO_BACKFILL_WINDOW

/**
 * Slack's connect path is its own (OAuth install, not Nango status polling),
 * so it gets its own trigger keyed on the workspace connection id its
 * adapter actually resolves. Never throws — a failed backfill start must not
 * fail the install.
 */
export async function triggerSlackBackfill(organizationId: string, workspaceConnectionId: string): Promise<void> {
  const adapter = getActivitySource('slack')
  if (!adapter?.capabilities.backfill) return
  try {
    const { backfillId, mode } = await startActivityBackfill({
      organizationId,
      source: 'slack',
      connectionRef: workspaceConnectionId,
      window: SLACK_BACKFILL_WINDOW,
    })
    apiLogger.info('auto-backfill: slack started on connect', { organizationId, backfillId, mode })
  } catch (error) {
    apiLogger.warn('auto-backfill: slack start failed', {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
```

- [ ] **Step 5: Wire it into the Slack connect path**

At the file and line found in Step 1, immediately after the workspace connection row is created or upserted, add:

```typescript
void triggerSlackBackfill(organizationId, connection.id).catch(() => undefined)
```

Match the fire-and-forget style already used for `scanConnection` at `src/app/api/mcp-connections/route.ts:172` — the install response must not wait on a backfill.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test src/lib/activity/__tests__/auto-backfill.test.ts`
Expected: PASS.

- [ ] **Step 7: Verify the Slack adapter declares backfill capability**

Run: `grep -n "capabilities" src/lib/activity/sources/slack.ts`

If `backfill: false`, the trigger is a no-op by design. Record that in the commit message and open the gap as a follow-up rather than changing the adapter's capabilities here — implementing Slack history pagination is its own task.

- [ ] **Step 8: Commit**

```bash
git add src/lib/activity/auto-backfill.ts src/lib/activity/__tests__/auto-backfill.test.ts
git commit -m "feat(activity): trigger Slack history backfill on workspace connect"
```

---

### Task 7: ProcessBaseline model

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<generated>/migration.sql`

**Interfaces:**
- Produces: Prisma model `ProcessBaseline` with unique key `(organizationId, source, action, entityType)`, consumed by Tasks 11–13.

- [ ] **Step 1: Add the model**

Append to `prisma/schema.prisma`, following the `ActivityBackfill` model's conventions:

```prisma
/// Deterministic, measured statistics for one recurring process, computed
/// from ActivityEvent rows. Facts only — no estimate, no LLM output. The
/// handling-time table version is recorded so a later table revision cannot
/// silently restate historical figures.
model ProcessBaseline {
  id             String   @id @default(cuid())
  organizationId String   @db.Uuid
  source         String
  action         String
  entityType     String

  volume         Int
  /// Observation window actually covered, not the window requested.
  windowDays     Int
  /// Median inter-event interval. Null when fewer than 2 events.
  periodDays     Float?
  distinctActors Int
  /// Null unless the process carries state transitions.
  medianCycleTimeHours Float?
  /// Null when no entity in the process has transitions.
  reworkRate     Float?
  /// 0..1, from volume and window coverage.
  confidence     Float

  handlingTimeTableVersion Int
  /// Resolved minutes per occurrence: curated table, or the org override.
  handlingMinutes Float?

  computedAt DateTime @default(now())
  updatedAt  DateTime @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@unique([organizationId, source, action, entityType])
  @@index([organizationId, confidence])
  @@map("process_baselines")
}
```

Add the back-relation to the `Organization` model alongside its existing `ActivityBackfill` relation:

```prisma
  processBaselines ProcessBaseline[]
```

- [ ] **Step 2: Generate and apply the migration**

Run: `npx prisma migrate dev --name process_baselines`
Expected: a new directory under `prisma/migrations/` and `prisma generate` succeeding.

- [ ] **Step 3: Verify the client types**

Run: `npx tsc --noEmit`
Expected: PASS. `prisma.processBaseline` is now typed.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(baselines): add ProcessBaseline model"
```

---

### Task 8: Curated handling-time table with org override

**Files:**
- Create: `src/lib/baselines/handling-time.ts`
- Test: `src/lib/baselines/__tests__/handling-time.test.ts`

**Interfaces:**
- Consumes: org settings blob (`Organization.settings`).
- Produces:
  - `HANDLING_TIME_TABLE_VERSION: number`
  - `HANDLING_TIME_MINUTES: Readonly<Record<string, number>>`
  - `resolveHandlingMinutes(action: string, settings: unknown): number | null`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/baselines/__tests__/handling-time.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HANDLING_TIME_MINUTES,
  HANDLING_TIME_TABLE_VERSION,
  resolveHandlingMinutes,
} from '../handling-time'

test('curated table covers every action the adapters emit', () => {
  const emitted = [
    'created_deal', 'deal_stage_changed', 'logged_email', 'logged_call', 'completed_task',
    'opened_pr', 'opened_issue', 'pushed_commit', 'merged_pr', 'closed_pr',
    'posted_message', 'replied_in_thread', 'held_meeting', 'took_meeting_notes',
  ]
  for (const action of emitted) {
    assert.equal(typeof HANDLING_TIME_MINUTES[action], 'number', `missing handling time for ${action}`)
    assert.ok(HANDLING_TIME_MINUTES[action] > 0, `${action} must be positive`)
  }
})

test('unknown actions resolve to null rather than a guess', () => {
  assert.equal(resolveHandlingMinutes('invented_action', {}), null)
})

test('org overrides win over the curated default', () => {
  const settings = { handlingTimeOverrides: { logged_email: 9 } }
  assert.equal(resolveHandlingMinutes('logged_email', settings), 9)
  // Untouched actions keep the curated value.
  assert.equal(resolveHandlingMinutes('logged_call', settings), HANDLING_TIME_MINUTES.logged_call)
})

test('invalid overrides are ignored, not trusted', () => {
  for (const bad of [{ logged_email: 0 }, { logged_email: -3 }, { logged_email: '9' }, { logged_email: 100_000 }]) {
    assert.equal(
      resolveHandlingMinutes('logged_email', { handlingTimeOverrides: bad }),
      HANDLING_TIME_MINUTES.logged_email,
    )
  }
  assert.equal(resolveHandlingMinutes('logged_email', { handlingTimeOverrides: 'nope' }), HANDLING_TIME_MINUTES.logged_email)
  assert.equal(resolveHandlingMinutes('logged_email', null), HANDLING_TIME_MINUTES.logged_email)
})

test('table version is a positive integer', () => {
  assert.ok(Number.isInteger(HANDLING_TIME_TABLE_VERSION) && HANDLING_TIME_TABLE_VERSION > 0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/baselines/__tests__/handling-time.test.ts`
Expected: FAIL — cannot resolve `../handling-time`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/baselines/handling-time.ts
/**
 * Estimated minutes of human handling per occurrence of an action.
 *
 * This table is the ONE estimated input in an otherwise measured pipeline:
 * volume, cycle time, and rework are counted from observed events, and only
 * minutes-per-action is judged. Keeping it curated, versioned, and identical
 * across customers is what makes a day-one ROI figure auditable — an LLM
 * estimating here would reintroduce exactly the unfalsifiability the
 * baselines layer exists to remove.
 *
 * Bump HANDLING_TIME_TABLE_VERSION on any value change. Baselines record the
 * version they were computed under so a revision cannot silently restate
 * historical figures.
 */
export const HANDLING_TIME_TABLE_VERSION = 1

/** Upper bound on an override, mirroring the guard on laborHourlyRate. */
const MAX_OVERRIDE_MINUTES = 480

export const HANDLING_TIME_MINUTES: Readonly<Record<string, number>> = Object.freeze({
  // CRM — the click plus the thinking around it, not the raw keystroke time.
  created_deal: 6,
  deal_stage_changed: 2,
  logged_email: 4,
  logged_call: 3,
  completed_task: 5,

  // Engineering.
  opened_pr: 10,
  opened_issue: 5,
  pushed_commit: 2,
  merged_pr: 4,
  closed_pr: 2,

  // Communication and meetings.
  posted_message: 1,
  replied_in_thread: 1,
  held_meeting: 30,
  took_meeting_notes: 15,
})

function overrideFor(action: string, settings: unknown): number | null {
  const blob = (settings ?? {}) as Record<string, unknown>
  const overrides = blob.handlingTimeOverrides
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) return null
  const value = (overrides as Record<string, unknown>)[action]
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value <= 0 || value > MAX_OVERRIDE_MINUTES) return null
  return value
}

/**
 * Minutes per occurrence for an action. Org override wins; otherwise the
 * curated default. Null for actions the table does not cover — an unknown
 * action yields no cost estimate rather than a fabricated one.
 */
export function resolveHandlingMinutes(action: string, settings: unknown): number | null {
  const override = overrideFor(action, settings)
  if (override !== null) return override
  return HANDLING_TIME_MINUTES[action] ?? null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/lib/baselines/__tests__/handling-time.test.ts`
Expected: PASS, all five tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/baselines/handling-time.ts src/lib/baselines/__tests__/handling-time.test.ts
git commit -m "feat(baselines): curated handling-time table with per-org overrides"
```

---

### Task 9: Volume, period, and actor aggregation

**Files:**
- Create: `src/lib/baselines/types.ts`
- Create: `src/lib/baselines/aggregate.ts`
- Test: `src/lib/baselines/__tests__/aggregate.test.ts`

**Interfaces:**
- Produces:
  - `BaselineEvent` — `{ source, action, entityType, entityRef, actorRef, occurredAt, previousState, newState }`
  - `ProcessKey` — `{ source, action, entityType }`
  - `processKeyOf(key: ProcessKey): string` — `'<source>|<action>|<entityType>'`
  - `groupByProcess(events: BaselineEvent[]): Map<string, BaselineEvent[]>`
  - `volumeStats(events: BaselineEvent[]): { volume: number; distinctActors: number; periodDays: number | null }`
  - `median(values: number[]): number | null`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/baselines/__tests__/aggregate.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupByProcess, median, processKeyOf, volumeStats } from '../aggregate'
import type { BaselineEvent } from '../types'

const at = (iso: string): Date => new Date(iso)

function event(overrides: Partial<BaselineEvent> = {}): BaselineEvent {
  return {
    source: 'hubspot',
    action: 'logged_email',
    entityType: 'email',
    entityRef: 'e1',
    actorRef: 'owner_7',
    occurredAt: at('2026-07-01T00:00:00Z'),
    previousState: null,
    newState: null,
    ...overrides,
  }
}

test('median handles odd, even, and empty', () => {
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 2, 3]), 2.5)
  assert.equal(median([]), null)
})

test('groups by source, action, and entityType', () => {
  const groups = groupByProcess([
    event(),
    event({ entityRef: 'e2' }),
    event({ action: 'logged_call', entityType: 'call', entityRef: 'c1' }),
    event({ source: 'github', action: 'opened_pr', entityType: 'pull_request', entityRef: 'r#1' }),
  ])
  assert.equal(groups.size, 3)
  assert.equal(groups.get('hubspot|logged_email|email')?.length, 2)
  assert.equal(groups.get('hubspot|logged_call|call')?.length, 1)
  assert.equal(processKeyOf({ source: 'github', action: 'opened_pr', entityType: 'pull_request' }), 'github|opened_pr|pull_request')
})

test('volume counts events, actors are distinct, period is the median gap in days', () => {
  const stats = volumeStats([
    event({ entityRef: 'e1', occurredAt: at('2026-07-01T00:00:00Z'), actorRef: 'a' }),
    event({ entityRef: 'e2', occurredAt: at('2026-07-03T00:00:00Z'), actorRef: 'b' }),
    event({ entityRef: 'e3', occurredAt: at('2026-07-04T00:00:00Z'), actorRef: 'a' }),
  ])
  assert.equal(stats.volume, 3)
  assert.equal(stats.distinctActors, 2)
  // Gaps are 2d and 1d; median 1.5.
  assert.equal(stats.periodDays, 1.5)
})

test('a single event has volume but no period', () => {
  const stats = volumeStats([event()])
  assert.equal(stats.volume, 1)
  assert.equal(stats.distinctActors, 1)
  assert.equal(stats.periodDays, null)
})

test('unsorted input still yields the correct period', () => {
  const stats = volumeStats([
    event({ entityRef: 'e3', occurredAt: at('2026-07-04T00:00:00Z') }),
    event({ entityRef: 'e1', occurredAt: at('2026-07-01T00:00:00Z') }),
    event({ entityRef: 'e2', occurredAt: at('2026-07-03T00:00:00Z') }),
  ])
  assert.equal(stats.periodDays, 1.5)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/baselines/__tests__/aggregate.test.ts`
Expected: FAIL — cannot resolve `../aggregate`.

- [ ] **Step 3: Write the types**

```typescript
// src/lib/baselines/types.ts
/**
 * The baseline layer's view of an activity row. Deliberately narrower than
 * ActivityEvent: baselines measure shape and timing, never content.
 */
export interface ProcessKey {
  source: string
  action: string
  entityType: string
}

export interface BaselineEvent extends ProcessKey {
  entityRef: string
  actorRef: string
  occurredAt: Date
  previousState: unknown
  newState: unknown
}

export interface ComputedBaseline extends ProcessKey {
  volume: number
  windowDays: number
  periodDays: number | null
  distinctActors: number
  medianCycleTimeHours: number | null
  reworkRate: number | null
  confidence: number
}
```

- [ ] **Step 4: Write the aggregation**

```typescript
// src/lib/baselines/aggregate.ts
/**
 * Pure aggregation over activity rows. No DB, no LLM, no estimates — every
 * value here is counted or timed from observed events, which is what lets a
 * downstream ROI figure survive scrutiny.
 */
import type { BaselineEvent, ProcessKey } from './types'

const MS_PER_DAY = 24 * 60 * 60 * 1000

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function processKeyOf(key: ProcessKey): string {
  return `${key.source}|${key.action}|${key.entityType}`
}

export function groupByProcess(events: BaselineEvent[]): Map<string, BaselineEvent[]> {
  const groups = new Map<string, BaselineEvent[]>()
  for (const event of events) {
    const key = processKeyOf(event)
    const bucket = groups.get(key)
    if (bucket) bucket.push(event)
    else groups.set(key, [event])
  }
  return groups
}

/**
 * periodDays is the MEDIAN gap between consecutive occurrences, not the mean:
 * a single burst of backfilled history would drag a mean far from the org's
 * actual cadence. Fewer than 2 events yields null — one occurrence evidences
 * no rhythm at all.
 */
export function volumeStats(events: BaselineEvent[]): {
  volume: number
  distinctActors: number
  periodDays: number | null
} {
  const volume = events.length
  const distinctActors = new Set(events.map((event) => event.actorRef)).size
  if (volume < 2) return { volume, distinctActors, periodDays: null }

  const times = events.map((event) => event.occurredAt.getTime()).sort((a, b) => a - b)
  const gaps: number[] = []
  for (let index = 1; index < times.length; index += 1) {
    gaps.push((times[index] - times[index - 1]) / MS_PER_DAY)
  }
  return { volume, distinctActors, periodDays: median(gaps) }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test src/lib/baselines/__tests__/aggregate.test.ts`
Expected: PASS, all five tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/baselines/types.ts src/lib/baselines/aggregate.ts src/lib/baselines/__tests__/aggregate.test.ts
git commit -m "feat(baselines): group activity by process and measure volume, actors, cadence"
```

---

### Task 10: Cycle time and rework from transitions

**Files:**
- Create: `src/lib/baselines/transitions.ts`
- Test: `src/lib/baselines/__tests__/transitions.test.ts`

**Interfaces:**
- Consumes: `BaselineEvent` from `src/lib/baselines/types.ts`, `median` from `src/lib/baselines/aggregate.ts`.
- Produces:
  - `hasTransitions(events: BaselineEvent[]): boolean`
  - `medianCycleTimeHours(events: BaselineEvent[]): number | null`
  - `reworkRate(events: BaselineEvent[]): number | null`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/baselines/__tests__/transitions.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTransitions, medianCycleTimeHours, reworkRate } from '../transitions'
import type { BaselineEvent } from '../types'

function transition(entityRef: string, from: string, to: string, iso: string): BaselineEvent {
  return {
    source: 'hubspot',
    action: 'deal_stage_changed',
    entityType: 'deal',
    entityRef,
    actorRef: 'owner_7',
    occurredAt: new Date(iso),
    previousState: { stage: from },
    newState: { stage: to },
  }
}

const pointEvent: BaselineEvent = {
  source: 'hubspot',
  action: 'logged_email',
  entityType: 'email',
  entityRef: 'e1',
  actorRef: 'owner_7',
  occurredAt: new Date('2026-07-01T00:00:00Z'),
  previousState: null,
  newState: null,
}

test('transitions are detected by the presence of previousState', () => {
  assert.equal(hasTransitions([transition('d1', 'a', 'b', '2026-07-01T00:00:00Z')]), true)
  assert.equal(hasTransitions([pointEvent]), false)
})

test('cycle time is the median gap between an entity\'s consecutive transitions', () => {
  const events = [
    transition('d1', 'new', 'qualified', '2026-07-01T00:00:00Z'),
    transition('d1', 'qualified', 'proposal', '2026-07-03T00:00:00Z'), // 48h
    transition('d2', 'new', 'qualified', '2026-07-01T00:00:00Z'),
    transition('d2', 'qualified', 'closedwon', '2026-07-02T00:00:00Z'), // 24h
  ]
  // Gaps are 48h and 24h; median 36.
  assert.equal(medianCycleTimeHours(events), 36)
})

test('cycle time is null without transitions or without a second event per entity', () => {
  assert.equal(medianCycleTimeHours([pointEvent]), null)
  assert.equal(medianCycleTimeHours([transition('d1', 'a', 'b', '2026-07-01T00:00:00Z')]), null)
})

test('rework counts entities re-entering a state they previously left', () => {
  const events = [
    // d1 goes forward then back into qualified — rework.
    transition('d1', 'new', 'qualified', '2026-07-01T00:00:00Z'),
    transition('d1', 'qualified', 'proposal', '2026-07-02T00:00:00Z'),
    transition('d1', 'proposal', 'qualified', '2026-07-03T00:00:00Z'),
    // d2 only moves forward.
    transition('d2', 'new', 'qualified', '2026-07-01T00:00:00Z'),
    transition('d2', 'qualified', 'closedwon', '2026-07-02T00:00:00Z'),
  ]
  assert.equal(reworkRate(events), 0.5)
})

test('rework is null when nothing transitions, zero when nothing regresses', () => {
  assert.equal(reworkRate([pointEvent]), null)
  assert.equal(
    reworkRate([
      transition('d1', 'new', 'qualified', '2026-07-01T00:00:00Z'),
      transition('d1', 'qualified', 'closedwon', '2026-07-02T00:00:00Z'),
    ]),
    0,
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/baselines/__tests__/transitions.test.ts`
Expected: FAIL — cannot resolve `../transitions`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/baselines/transitions.ts
/**
 * Duration and rework, derived from state transitions.
 *
 * Both metrics require `previousState`, which is why Phase 1 makes adapters
 * populate it. Where a process has no transitions these return null rather
 * than a zero — "no rework observed" and "rework unmeasurable" are different
 * claims, and only the second is honest about a point-event feed.
 */
import { median } from './aggregate'
import type { BaselineEvent } from './types'

const MS_PER_HOUR = 60 * 60 * 1000

/** The stage/status label inside a state blob, if it has one. */
function stateLabel(state: unknown): string | null {
  if (typeof state !== 'object' || state === null) return null
  const blob = state as Record<string, unknown>
  for (const field of ['stage', 'status', 'state']) {
    if (typeof blob[field] === 'string') return blob[field] as string
  }
  return null
}

export function hasTransitions(events: BaselineEvent[]): boolean {
  return events.some((event) => event.previousState != null)
}

function byEntity(events: BaselineEvent[]): Map<string, BaselineEvent[]> {
  const groups = new Map<string, BaselineEvent[]>()
  for (const event of events) {
    const bucket = groups.get(event.entityRef)
    if (bucket) bucket.push(event)
    else groups.set(event.entityRef, [event])
  }
  for (const bucket of groups.values()) {
    bucket.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
  }
  return groups
}

/**
 * Median hours between consecutive transitions on the same entity. Median,
 * not mean: one stalled deal sitting open for a year would otherwise define
 * the org's "typical" cycle time.
 */
export function medianCycleTimeHours(events: BaselineEvent[]): number | null {
  if (!hasTransitions(events)) return null
  const gaps: number[] = []
  for (const bucket of byEntity(events).values()) {
    for (let index = 1; index < bucket.length; index += 1) {
      gaps.push((bucket[index].occurredAt.getTime() - bucket[index - 1].occurredAt.getTime()) / MS_PER_HOUR)
    }
  }
  return median(gaps)
}

/**
 * Fraction of entities that re-enter a state they previously left. Walking
 * each entity in time order, a transition INTO a state already recorded as
 * departed is a backwards step — the signal that a process loops rather than
 * flows.
 */
export function reworkRate(events: BaselineEvent[]): number | null {
  if (!hasTransitions(events)) return null
  const entities = byEntity(events)
  let considered = 0
  let reworked = 0

  for (const bucket of entities.values()) {
    const departed = new Set<string>()
    let counts = false
    let regressed = false
    for (const event of bucket) {
      const from = stateLabel(event.previousState)
      const to = stateLabel(event.newState)
      if (from === null || to === null) continue
      counts = true
      if (departed.has(to)) regressed = true
      departed.add(from)
    }
    if (!counts) continue
    considered += 1
    if (regressed) reworked += 1
  }

  return considered === 0 ? null : reworked / considered
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/lib/baselines/__tests__/transitions.test.ts`
Expected: PASS, all five tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/baselines/transitions.ts src/lib/baselines/__tests__/transitions.test.ts
git commit -m "feat(baselines): derive cycle time and rework rate from state transitions"
```

---

### Task 11: Confidence scoring and baseline assembly

**Files:**
- Create: `src/lib/baselines/compute.ts`
- Test: `src/lib/baselines/__tests__/compute.test.ts`

**Interfaces:**
- Consumes: `volumeStats`, `groupByProcess` (Task 9); `medianCycleTimeHours`, `reworkRate` (Task 10); `ComputedBaseline` (Task 9).
- Produces:
  - `MIN_MEASURED_CONFIDENCE = 0.4`
  - `confidenceOf(input: { volume: number; windowDays: number }): number`
  - `computeBaseline(events: BaselineEvent[], windowDays: number): ComputedBaseline | null`
  - `computeBaselines(events: BaselineEvent[], windowDays: number): ComputedBaseline[]`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/baselines/__tests__/compute.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeBaseline, computeBaselines, confidenceOf, MIN_MEASURED_CONFIDENCE } from '../compute'
import type { BaselineEvent } from '../types'

function emailAt(entityRef: string, iso: string, actorRef = 'owner_7'): BaselineEvent {
  return {
    source: 'hubspot',
    action: 'logged_email',
    entityType: 'email',
    entityRef,
    actorRef,
    occurredAt: new Date(iso),
    previousState: null,
    newState: null,
  }
}

test('confidence rises with volume and window coverage, capped at 1', () => {
  assert.equal(confidenceOf({ volume: 0, windowDays: 90 }), 0)
  // 15 of 30 events, full coverage.
  assert.equal(confidenceOf({ volume: 15, windowDays: 30 }), 0.5)
  // Full volume but half the coverage.
  assert.equal(confidenceOf({ volume: 30, windowDays: 15 }), 0.5)
  assert.equal(confidenceOf({ volume: 300, windowDays: 900 }), 1)
})

test('the measured floor is reachable with a month of modest volume', () => {
  assert.ok(confidenceOf({ volume: 12, windowDays: 30 }) >= MIN_MEASURED_CONFIDENCE)
  assert.ok(confidenceOf({ volume: 3, windowDays: 30 }) < MIN_MEASURED_CONFIDENCE)
})

test('a baseline carries measured stats and its window', () => {
  const events = [
    emailAt('e1', '2026-07-01T00:00:00Z'),
    emailAt('e2', '2026-07-03T00:00:00Z', 'owner_8'),
    emailAt('e3', '2026-07-04T00:00:00Z'),
  ]
  const baseline = computeBaseline(events, 30)
  assert.ok(baseline)
  assert.equal(baseline.source, 'hubspot')
  assert.equal(baseline.action, 'logged_email')
  assert.equal(baseline.entityType, 'email')
  assert.equal(baseline.volume, 3)
  assert.equal(baseline.distinctActors, 2)
  assert.equal(baseline.periodDays, 1.5)
  assert.equal(baseline.windowDays, 30)
  // Point events cannot yield duration or rework.
  assert.equal(baseline.medianCycleTimeHours, null)
  assert.equal(baseline.reworkRate, null)
})

test('an empty group yields no baseline', () => {
  assert.equal(computeBaseline([], 30), null)
})

test('computeBaselines produces one baseline per process, sorted by confidence', () => {
  const events = [
    emailAt('e1', '2026-07-01T00:00:00Z'),
    emailAt('e2', '2026-07-02T00:00:00Z'),
    emailAt('e3', '2026-07-03T00:00:00Z'),
    {
      source: 'github',
      action: 'opened_pr',
      entityType: 'pull_request',
      entityRef: 'acme/api#1',
      actorRef: 'alice',
      occurredAt: new Date('2026-07-01T00:00:00Z'),
      previousState: null,
      newState: null,
    } satisfies BaselineEvent,
  ]
  const baselines = computeBaselines(events, 30)
  assert.equal(baselines.length, 2)
  // Highest confidence first — the caller's cutoff work is then a prefix.
  assert.ok(baselines[0].confidence >= baselines[1].confidence)
  assert.equal(baselines[0].action, 'logged_email')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/baselines/__tests__/compute.test.ts`
Expected: FAIL — cannot resolve `../compute`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/baselines/compute.ts
/**
 * Assembles measured statistics into ComputedBaseline records.
 *
 * Confidence is the product of two independent shortfalls — too few events,
 * or too little history — because either alone invalidates the figure. An
 * org with 200 events across three days has a burst, not a cadence; an org
 * with a full quarter of history and four events has noise.
 */
import { groupByProcess, volumeStats } from './aggregate'
import { medianCycleTimeHours, reworkRate } from './transitions'
import type { BaselineEvent, ComputedBaseline } from './types'

/** Below this, a suggestion must be labeled a benchmark, never "measured". */
export const MIN_MEASURED_CONFIDENCE = 0.4

/** Volume at which the count stops limiting confidence. */
const VOLUME_SATURATION = 30
/** Days of history at which coverage stops limiting confidence. */
const WINDOW_SATURATION = 30

export function confidenceOf(input: { volume: number; windowDays: number }): number {
  const volumeFactor = Math.min(1, Math.max(0, input.volume) / VOLUME_SATURATION)
  const coverageFactor = Math.min(1, Math.max(0, input.windowDays) / WINDOW_SATURATION)
  return volumeFactor * coverageFactor
}

/** One process's events → one baseline. Null on an empty group. */
export function computeBaseline(events: BaselineEvent[], windowDays: number): ComputedBaseline | null {
  const first = events[0]
  if (!first) return null
  const stats = volumeStats(events)
  return {
    source: first.source,
    action: first.action,
    entityType: first.entityType,
    volume: stats.volume,
    windowDays,
    periodDays: stats.periodDays,
    distinctActors: stats.distinctActors,
    medianCycleTimeHours: medianCycleTimeHours(events),
    reworkRate: reworkRate(events),
    confidence: confidenceOf({ volume: stats.volume, windowDays }),
  }
}

/** Every process in the feed, most trustworthy first. */
export function computeBaselines(events: BaselineEvent[], windowDays: number): ComputedBaseline[] {
  const baselines: ComputedBaseline[] = []
  for (const group of groupByProcess(events).values()) {
    const baseline = computeBaseline(group, windowDays)
    if (baseline) baselines.push(baseline)
  }
  return baselines.sort((a, b) => b.confidence - a.confidence)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/lib/baselines/__tests__/compute.test.ts`
Expected: PASS, all five tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/baselines/compute.ts src/lib/baselines/__tests__/compute.test.ts
git commit -m "feat(baselines): confidence scoring and baseline assembly"
```

---

### Task 12: Persist baselines for an organization

Reads `ActivityEvent` rows, computes baselines, resolves handling minutes, and upserts `ProcessBaseline`. `windowDays` is the coverage actually observed — the span from the earliest event to now — not the window requested, so a partial backfill reports honestly and gets a correspondingly lower confidence.

**Files:**
- Create: `src/lib/baselines/persist.ts`
- Test: `src/lib/baselines/__tests__/persist.test.ts`

**Interfaces:**
- Consumes: `computeBaselines` (Task 11), `resolveHandlingMinutes` + `HANDLING_TIME_TABLE_VERSION` (Task 8), `ProcessBaseline` model (Task 7).
- Produces:
  - `BaselineDb` — injectable seam, `Pick<typeof prisma, 'activityEvent' | 'processBaseline' | 'organization'>`
  - `observedWindowDays(events: { occurredAt: Date }[], now: Date): number`
  - `recomputeOrgBaselines(organizationId: string, opts?: { now?: Date; db?: BaselineDb }): Promise<{ baselines: number; events: number }>`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/baselines/__tests__/persist.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observedWindowDays, recomputeOrgBaselines } from '../persist'
import { HANDLING_TIME_MINUTES, HANDLING_TIME_TABLE_VERSION } from '../handling-time'

test('observed window spans the earliest event to now, floored at 1 day', () => {
  const now = new Date('2026-08-03T00:00:00Z')
  assert.equal(observedWindowDays([{ occurredAt: new Date('2026-07-04T00:00:00Z') }], now), 30)
  // Same-day history is one day of coverage, never zero — a zero would make
  // confidence identically zero and hide an otherwise valid low-coverage row.
  assert.equal(observedWindowDays([{ occurredAt: new Date('2026-08-03T00:00:00Z') }], now), 1)
  assert.equal(observedWindowDays([], now), 0)
})

test('recompute upserts one baseline per process with resolved handling minutes', async () => {
  const upserts: Record<string, unknown>[] = []
  const db = {
    activityEvent: {
      findMany: async () => [
        { source: 'hubspot', action: 'logged_email', entityType: 'email', entityRef: 'e1', actorRef: 'a', occurredAt: new Date('2026-07-04T00:00:00Z'), previousState: null, newState: null },
        { source: 'hubspot', action: 'logged_email', entityType: 'email', entityRef: 'e2', actorRef: 'b', occurredAt: new Date('2026-07-20T00:00:00Z'), previousState: null, newState: null },
      ],
    },
    processBaseline: {
      upsert: async (args: Record<string, unknown>) => { upserts.push(args); return {} },
    },
    organization: {
      findUnique: async () => ({ settings: { handlingTimeOverrides: { logged_email: 9 } } }),
    },
  } as never

  const result = await recomputeOrgBaselines('org_1', { now: new Date('2026-08-03T00:00:00Z'), db })
  assert.equal(result.events, 2)
  assert.equal(result.baselines, 1)

  const created = upserts[0].create as Record<string, unknown>
  assert.equal(created.organizationId, 'org_1')
  assert.equal(created.action, 'logged_email')
  assert.equal(created.volume, 2)
  assert.equal(created.windowDays, 30)
  // The org override wins over the curated 4.
  assert.equal(created.handlingMinutes, 9)
  assert.notEqual(created.handlingMinutes, HANDLING_TIME_MINUTES.logged_email)
  assert.equal(created.handlingTimeTableVersion, HANDLING_TIME_TABLE_VERSION)
})

test('an org with no activity writes nothing', async () => {
  let upsertCalls = 0
  const db = {
    activityEvent: { findMany: async () => [] },
    processBaseline: { upsert: async () => { upsertCalls += 1; return {} } },
    organization: { findUnique: async () => ({ settings: {} }) },
  } as never

  const result = await recomputeOrgBaselines('org_2', { now: new Date('2026-08-03T00:00:00Z'), db })
  assert.deepEqual(result, { baselines: 0, events: 0 })
  assert.equal(upsertCalls, 0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/baselines/__tests__/persist.test.ts`
Expected: FAIL — cannot resolve `../persist`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/baselines/persist.ts
/**
 * The one DB-touching step in the baselines module. Everything it depends on
 * is pure and separately tested; this file only reads rows, calls those
 * functions, and writes results.
 */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { computeBaselines } from './compute'
import { HANDLING_TIME_TABLE_VERSION, resolveHandlingMinutes } from './handling-time'
import type { BaselineEvent } from './types'

/** Injectable seam for tests, mirroring ActivityDb in the activity ledger. */
export type BaselineDb = Pick<typeof prisma, 'activityEvent' | 'processBaseline' | 'organization'>

const MS_PER_DAY = 24 * 60 * 60 * 1000
/** Ceiling on rows pulled per recompute; keeps a large org's pass bounded. */
const MAX_EVENTS = 50_000

/**
 * Coverage ACTUALLY observed, not the window requested. A backfill that
 * returned 40 days of a 90-day request must report 40 — overstating coverage
 * would inflate confidence on history that was never read.
 */
export function observedWindowDays(events: { occurredAt: Date }[], now: Date): number {
  if (events.length === 0) return 0
  const earliest = Math.min(...events.map((event) => event.occurredAt.getTime()))
  const days = (now.getTime() - earliest) / MS_PER_DAY
  return Math.max(1, Math.round(days))
}

export async function recomputeOrgBaselines(
  organizationId: string,
  opts: { now?: Date; db?: BaselineDb } = {},
): Promise<{ baselines: number; events: number }> {
  const db = opts.db ?? prisma
  const now = opts.now ?? new Date()

  const rows = await db.activityEvent.findMany({
    where: { organizationId },
    select: {
      source: true,
      action: true,
      entityType: true,
      entityRef: true,
      actorRef: true,
      occurredAt: true,
      previousState: true,
      newState: true,
    },
    orderBy: { occurredAt: 'asc' },
    take: MAX_EVENTS,
  })
  if (rows.length === 0) return { baselines: 0, events: 0 }

  const events = rows as BaselineEvent[]
  const windowDays = observedWindowDays(events, now)
  const baselines = computeBaselines(events, windowDays)

  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { settings: true } })
  const settings = org?.settings ?? {}

  for (const baseline of baselines) {
    const handlingMinutes = resolveHandlingMinutes(baseline.action, settings)
    const values = {
      volume: baseline.volume,
      windowDays: baseline.windowDays,
      periodDays: baseline.periodDays,
      distinctActors: baseline.distinctActors,
      medianCycleTimeHours: baseline.medianCycleTimeHours,
      reworkRate: baseline.reworkRate,
      confidence: baseline.confidence,
      handlingTimeTableVersion: HANDLING_TIME_TABLE_VERSION,
      handlingMinutes,
      computedAt: now,
    }
    await db.processBaseline.upsert({
      where: {
        organizationId_source_action_entityType: {
          organizationId,
          source: baseline.source,
          action: baseline.action,
          entityType: baseline.entityType,
        },
      },
      create: {
        organizationId,
        source: baseline.source,
        action: baseline.action,
        entityType: baseline.entityType,
        ...values,
      },
      update: values,
    })
  }

  apiLogger.info('baselines: recomputed', { organizationId, baselines: baselines.length, events: events.length, windowDays })
  return { baselines: baselines.length, events: events.length }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/lib/baselines/__tests__/persist.test.ts`
Expected: PASS, all three tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS. The `organizationId_source_action_entityType` compound key name must match what Prisma generated in Task 7 — if it does not, the error names the correct key; use that.

- [ ] **Step 6: Commit**

```bash
git add src/lib/baselines/persist.ts src/lib/baselines/__tests__/persist.test.ts
git commit -m "feat(baselines): compute and persist per-org process baselines"
```

---

### Task 13: Project baselines into the graph as cited inferences

`writeInference` refuses any `inferred_pattern` without at least one evidence edge. Routing baselines through it is what makes them citable by the Plan 2 suggestion layer.

**Files:**
- Create: `src/lib/baselines/project.ts`
- Test: `src/lib/baselines/__tests__/project.test.ts`
- Modify: `src/lib/baselines/persist.ts`

**Interfaces:**
- Consumes: `writeInference` and `InferenceWrite` from `src/lib/activity/insights.ts`; `ComputedBaseline` from Task 9.
- Produces:
  - `baselineSlug(baseline: ProcessKey): string`
  - `baselineInferenceText(baseline: ComputedBaseline): string`
  - `projectBaseline(organizationId: string, baseline: ComputedBaseline, evidenceEventIds: string[]): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/baselines/__tests__/project.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baselineInferenceText, baselineSlug } from '../project'
import type { ComputedBaseline } from '../types'

const baseline: ComputedBaseline = {
  source: 'hubspot',
  action: 'deal_stage_changed',
  entityType: 'deal',
  volume: 214,
  windowDays: 90,
  periodDays: 0.4,
  distinctActors: 6,
  medianCycleTimeHours: 264,
  reworkRate: 0.4,
  confidence: 1,
}

test('slug is stable and filesystem-safe', () => {
  assert.equal(baselineSlug(baseline), 'hubspot-deal_stage_changed-deal')
})

test('inference text states the measured facts, not an interpretation', () => {
  const text = baselineInferenceText(baseline)
  assert.match(text, /214/)
  assert.match(text, /90 days/)
  assert.match(text, /6 people/)
  assert.match(text, /264/)
  assert.match(text, /40%/)
  // No recommendation language — this node is a fact, and the citation
  // invariant distinguishes facts from the recommendations built on them.
  assert.doesNotMatch(text, /should|recommend|consider/i)
})

test('unmeasurable fields are omitted rather than rendered as zero', () => {
  const text = baselineInferenceText({ ...baseline, medianCycleTimeHours: null, reworkRate: null, periodDays: null })
  assert.doesNotMatch(text, /cycle time/i)
  assert.doesNotMatch(text, /rework/i)
  assert.match(text, /214/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/baselines/__tests__/project.test.ts`
Expected: FAIL — cannot resolve `../project`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/baselines/project.ts
/**
 * Baselines as graph facts. Routing them through writeInference is
 * deliberate: that path structurally rejects an inference with no evidence,
 * so a baseline in the graph is always traceable to the activity rows it was
 * measured from. Plan 2's suggestions cite these nodes in turn.
 */
import { writeInference } from '@/lib/activity/insights'
import type { ComputedBaseline, ProcessKey } from './types'

export function baselineSlug(key: ProcessKey): string {
  return `${key.source}-${key.action}-${key.entityType}`
}

/** Facts, phrased as facts. Interpretation belongs to the recommendation
 *  nodes that cite this one, never to the fact itself. */
export function baselineInferenceText(baseline: ComputedBaseline): string {
  const parts = [
    `${baseline.action} on ${baseline.entityType} (${baseline.source}): ${baseline.volume} occurrences over ${baseline.windowDays} days`,
    `${baseline.distinctActors} people involved`,
  ]
  if (baseline.periodDays !== null) parts.push(`typical gap ${baseline.periodDays.toFixed(1)} days`)
  if (baseline.medianCycleTimeHours !== null) {
    parts.push(`median cycle time ${baseline.medianCycleTimeHours.toFixed(0)} hours`)
  }
  if (baseline.reworkRate !== null) parts.push(`rework ${Math.round(baseline.reworkRate * 100)}%`)
  return parts.join('; ')
}

export async function projectBaseline(
  organizationId: string,
  baseline: ComputedBaseline,
  evidenceEventIds: string[],
): Promise<boolean> {
  if (evidenceEventIds.length === 0) return false
  return writeInference({
    organizationId,
    kind: 'inferred_pattern',
    slug: baselineSlug(baseline),
    text: baselineInferenceText(baseline),
    evidenceEventIds,
  })
}
```

- [ ] **Step 4: Wire projection into the recompute**

In `src/lib/baselines/persist.ts`, add the `id` field to the `select` so evidence ids are available:

```typescript
    select: {
      id: true,
      source: true,
```

Widen the local event type and collect ids per process. Replace the `const events = rows as BaselineEvent[]` line and the write loop:

```typescript
  const events = rows as (BaselineEvent & { id: string })[]
  const windowDays = observedWindowDays(events, now)
  const baselines = computeBaselines(events, windowDays)
```

Then inside the `for (const baseline of baselines)` loop, after the `upsert`, add:

```typescript
    // Cap the citation set: the invariant needs evidence, not exhaustive
    // evidence, and an unbounded edge list per baseline would bloat the graph.
    const evidenceEventIds = events
      .filter(
        (event) =>
          event.source === baseline.source &&
          event.action === baseline.action &&
          event.entityType === baseline.entityType,
      )
      .slice(0, MAX_EVIDENCE_PER_BASELINE)
      .map((event) => event.id)
    await projectBaseline(organizationId, baseline, evidenceEventIds)
```

Add the import and the constant near the top of the file:

```typescript
import { projectBaseline } from './project'

const MAX_EVIDENCE_PER_BASELINE = 25
```

- [ ] **Step 5: Run the baselines suite**

Run: `npx tsx --test $(find src/lib/baselines -name '*.test.ts')`
Expected: PASS. The `persist.test.ts` fakes have no graph store, so `writeInference` fails soft and returns false — the tests assert on upsert calls, which are unaffected.

- [ ] **Step 6: Full test suite and typecheck**

Run: `npm test`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/baselines/project.ts src/lib/baselines/__tests__/project.test.ts src/lib/baselines/persist.ts
git commit -m "feat(baselines): project baselines into the graph as cited inferences"
```

---

## Verification

Before declaring Plan 1 complete, confirm the Phase 1 acceptance criterion against real data rather than fixtures. Follow the `verify` skill's throwaway-Postgres protocol.

- [ ] Run a backfill against a seeded org and confirm `previousState` is populated:

```sql
SELECT source, action, count(*) AS events,
       count(*) FILTER (WHERE "previousState" IS NOT NULL) AS with_prev
FROM activity_events
GROUP BY source, action
ORDER BY events DESC;
```

Every transition action (`deal_stage_changed`, `completed_task`, `merged_pr`, `closed_pr`) must show `with_prev = events`. Point events (`logged_email`, `posted_message`, `pushed_commit`) must show `with_prev = 0`.

Note the Prisma jsonb gotcha: `persistActivity` writes `Prisma.JsonNull` for absent state, which is a JSON `null`, **not** SQL `NULL`. If `with_prev` equals `events` for point actions too, the check needs `"previousState" <> 'null'::jsonb` instead — confirm which before trusting the numbers.

- [ ] Run `recomputeOrgBaselines` for that org and hand-check one baseline:

```sql
SELECT source, action, volume, "windowDays", "periodDays", "distinctActors",
       "medianCycleTimeHours", "reworkRate", confidence
FROM process_baselines ORDER BY confidence DESC;
```

Pick the highest-volume row and verify `volume` matches `SELECT count(*) FROM activity_events WHERE action = '<action>'`. A mismatch means the `MAX_EVENTS` ceiling truncated the read — raise it or paginate before proceeding to Plan 2.

## Self-Review Notes

Checked against `docs/superpowers/specs/2026-08-03-day-one-roi-design.md`:

- Phase 1 "deepen the event feed" → Tasks 1–6. HubSpot stage changes, tasks, emails, calls, owner changes (owner is carried as `actorRef` on every event rather than as a separate action — a reassignment with no other activity is not observable through the list endpoints, and inventing an event for it would violate the measured-only rule); GitHub merges and closes; Slack backfill trigger.
- Phase 2 "process baselines" → Tasks 7–13. Every field named in the spec's baseline list has a computing function and a test.
- Handling-time decision (curated default, optional override) → Task 8.
- Graph projection through the citation invariant → Task 13.
- Deferred to Plan 2 by design: suggestion payload changes, gate replacement, onboarding state machine.

Known gap carried forward: GitHub PR *review* events are named in the spec's Phase 1 but not implemented here. Reviews need a per-PR `/reviews` fetch, which multiplies API calls by PR count and needs its own rate-limit design. Merge and close transitions already make review latency computable from `opened_pr` → `merged_pr` pairing, so the measurement goal is met without them. Track separately.
