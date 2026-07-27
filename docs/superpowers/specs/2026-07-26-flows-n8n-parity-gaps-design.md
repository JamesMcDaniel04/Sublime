# Flows — n8n Parity Gaps 6–8 Design

**Date:** 2026-07-26
**Status:** Approved
**Scope:** Gap 6 (node `typeVersion`), Gap 7 (polling triggers + durable per-flow trigger state), Gap 8 (managed webhook subscription lifecycle via Nango). Gaps 9–12 from the parity analysis are explicitly out of scope — they are deliberate philosophy differences we are not chasing.

**Delivery:** three sub-projects with separate implementation plans, executed in order 6 → 7 → 8. typeVersion lands first because it reshapes the node schema the other two touch, and it must exist before the node set or user base grows.

---

## Decisions (locked with product owner)

| Decision | Choice |
|---|---|
| Scope | Gaps 6–8 only |
| Poll cadence floor | 15 min, via the existing Vercel cron dispatch leg (no BullMQ flow scheduler now) |
| Poll authoring model | Generic tool-poll (any catalog tool + interval + dedupe path + cursor mapping); curated presets can layer later |
| Poll run fan-out | One FlowRun per new record |
| Webhook ingress | Hybrid: Nango webhook forwarding as default; direct per-subscription endpoints where forwarding is unsupported |
| Subscription registration failure at publish | Blocks the publish (`{published:false, reason}`) |
| First webhook providers | GitHub + HubSpot |

---

## Section 1 — Gap 6: Node `typeVersion`

### Approach

Version field on every node + a read-time upgrade pipeline, so the executor almost always sees latest-version nodes. Rejected alternatives: (a) branching on version throughout `execNode` in `src/features/flows/interpret.ts` — permanently grows an already ~1,100-line dispatch; (b) extending the `actionSchemaHash` drift-hash pattern — detects change but cannot express migrations.

### Schema (`src/lib/flows/graph.ts`)

- Introduce a `nodeSchema(type, dataShape)` helper that builds each variant as `{ id, type: z.literal(type), typeVersion: z.number().int().min(1).default(1), data }`. All 23 variants are converted to it so a future variant cannot forget the field. Zod (v3, strip mode) silently drops unknown keys today, so the field must be explicit in every variant.
- `typeVersion` is **not** a discriminator. `z.discriminatedUnion('type', …)` stays as-is. If a future version needs a different `data` shape, the schema holds the superset and the upgrade function normalizes.
- New constant `LATEST_TYPE_VERSION: Record<FlowNode['type'], number>` (all `1` initially), exported next to the union.

### Creation and node-preserving paths (`src/lib/flows/mutate.ts`)

- `makeNode` stamps `typeVersion: LATEST_TYPE_VERSION[type]` on create.
- `pasteNodeAfter` currently rebuilds `{ id, type, data }` by hand and would drop the field — fixed to carry it.
- `collaboration.ts`, `undo.ts`, `copilot-ops.ts` spread existing nodes and survive automatically once the schema accepts the key. The collaboration patch guard (`nodeFieldsChangeSchema` in `src/lib/flows/collaboration.ts`) additionally guards on `typeVersion` so a stale peer's patch cannot land on an upgraded node.

### Upgrade pipeline

- New module `src/lib/flows/upgrade.ts`: a per-type registry of pure step functions `(node at vN) => node at vN+1`, and `upgradeFlowGraph(graph): { graph, upgraded: Array<{nodeId, from, to}> }` that walks nodes to latest.
- Applied at the read chokepoints, immediately after `flowGraphSchema.parse`:
  - `src/features/flows/execute-flow.ts` graph load (covers runs, including pinned `FlowRun.graphSnapshot` on resume),
  - `src/lib/flows/publish.ts` parse,
  - builder graph load in `src/app/flows/[id]/page.tsx`.
- **Non-destructive:** `FlowVersion.graph` and `FlowRun.graphSnapshot` are never rewritten; upgrades happen at read. The builder naturally persists upgraded drafts on the next save (lazy forward migration).
- **Policy:** every version bump ships a lossless upgrader whenever a lossless mapping exists. Only a genuinely behavior-breaking bump omits one, and then — and only then — the specific per-type branch in `execNode` checks `typeVersion`. The interpreter is otherwise version-blind.

### Validation (`src/lib/flows/validate.ts`)

- New issue `UNKNOWN_TYPE_VERSION` (error): `node.typeVersion > LATEST_TYPE_VERSION[type]` — a node authored by a newer client. Raised at publish/run validation **and** rejected at save: `PUT /api/flows` does schema-parse only today, and an older server silently accepting future nodes is the realistic corruption path (zod's default would otherwise mangle nothing but validation would pass).
- Nodes with an available upgrade are normalized silently — no warning noise for upgradeable states.

### Export / import

- `src/lib/export/portable.ts`: bump `PORTABLE_VERSION` to 2. `sanitizeNode` spreads and carries the field. Import defaults missing `typeVersion` to 1 (schema default handles it).
- `src/lib/export/n8n.ts` already emits an unrelated n8n-side `typeVersion`; no interaction, but beware the name collision when editing.

### Persistence

No Prisma migration — the field lives inside graph JSON and defaults to 1 on parse. No backfill required.

---

## Section 2 — Gap 7: Poll trigger + durable per-flow trigger state

### Approach

Generic tool-poll: a scheduled poll that invokes any list/search-shaped tool from the existing flow tool catalog, with a durable cursor and record-level dedupe, dispatching one run per new record with the **raw provider record** as input. The activity plane stays the normalized ledger — it does not become the polling substrate (its vocabulary is lossy and its sync cursor is org-scoped, not flow-scoped).

### Trigger type

- Add `'poll'` to `FLOW_TRIGGER_TYPES` (`src/lib/flows/trigger.ts`), the API zod enum, `FlowExecutionJob['trigger']` union (`src/features/flows/execute-flow.ts`), and the trigger editor (`src/components/flows/nodes/trigger-body.tsx` — tool picker mirroring the tool node's).
- Config shape (lives on the trigger node / `Flow.trigger` like every other type):

```ts
{
  type: 'poll',
  connectionId: string,      // flow tool catalog connection (mcp | native | nango plane)
  toolName: string,
  params: Record<string, unknown>,
  intervalMinutes: number,   // >= 15, enforced by validation
  recordsPath: string,       // where the array lives in the tool response
  dedupeKeyPath: string,     // per-record key, e.g. $.id
  cursor?: {
    responsePath: string,    // field to persist after a poll
    requestParam: string,    // param to feed it back into next poll
  },
  maxRecordsPerTick?: number, // default 25
  filter?: TriggerFilter,    // existing "Only run when…" clauses
}
```

- Validation branch in `validateTriggerConfig`: `MISSING_POLL_CONNECTION`, `MISSING_POLL_TOOL`, `MISSING_POLL_INTERVAL` (also floors at 15), `MISSING_DEDUPE_PATH`.

### Persistence (Prisma migration)

```prisma
/// Durable per-flow trigger state (poll cursors etc.). Deliberately NOT
/// Flow.metadata: cursor writes there would race editor saves and bump
/// Flow.updatedAt, breaking the input-reuse freshness check.
model FlowTriggerState {
  id             String    @id @default(cuid())
  flowId         String
  organizationId String    @db.Uuid
  key            String    // 'poll' today; room for other trigger kinds
  cursor         String?
  data           Json      @default("{}")
  lastPolledAt   DateTime?
  updatedAt      DateTime  @updatedAt
  createdAt      DateTime  @default(now())

  flow Flow @relation(fields: [flowId], references: [id], onDelete: Cascade)

  @@unique([flowId, key])
  @@map("flow_trigger_state")
}

/// At-most-once per record across concurrent ticks. The unique constraint IS
/// the mechanism (same pattern as ActivityTriggerClaim / SlackProcessedEvent).
model FlowTriggerDedupe {
  id        String   @id @default(cuid())
  flowId    String
  recordKey String
  createdAt DateTime @default(now())

  @@unique([flowId, recordKey])
  @@index([createdAt])
  @@map("flow_trigger_dedupe")
}
```

Both cascade off `Flow` (org teardown relies on FK cascade). `FlowTriggerDedupe` is pruned by `/api/cron/retention` after a 30-day window; the cursor bounds how far a poll can look back, so the window is a documented correctness bound, not a guess.

### Firing (cron dispatch leg)

- New poll leg in `src/app/api/cron/dispatch/route.ts` alongside the schedule leg, with the same gates: `status='ACTIVE'`, `trigger.type='poll'`, `publishedGraph != null`, `blocksSchedule` overlap guard.
- Due-check reads `FlowTriggerState.lastPolledAt + intervalMinutes`, **not** `runs[0].startedAt` (a poll that yields no records must still advance).
- The poll scan is its own query with its own per-tick cap; the existing `take: 100` / `MAX_FLOWS_PER_TICK = 10` caps become per-leg so schedules and polls don't starve each other, and both are raised.
- No BullMQ flow scheduler now. The trigger config carries `intervalMinutes` so a future sub-15-min BullMQ path (mirroring the agent schedule registrar, with the cron/worker single-owner guard) needs no config change. Documented follow-up, out of scope.

### Poll execution

New module `src/lib/flows/poll.ts` — `runFlowPoll(flow)`:

1. Resolve the tool through the flow tool catalog and invoke it via the same action adapter the tool node uses, feeding the persisted cursor into `cursor.requestParam` when configured.
2. Extract the record array at `recordsPath`; cap at `maxRecordsPerTick`.
3. For each record: compute `recordKey` from `dedupeKeyPath`; claim a `FlowTriggerDedupe` row (P2002 = already seen, skip); evaluate `trigger.filter`; dispatch `dispatchFlowExecution` with `trigger: { type: 'poll', poll: { connectionId, toolName, recordKey } }` and the raw record as input — one FlowRun per record.
4. Checkpoint `cursor` + `lastPolledAt` on `FlowTriggerState` **after** dispatch (crash → re-poll overlaps → dedupe claims make it a no-op; same correctness argument as `ActivityBackfill`).
5. Poll-level errors (tool failure, bad `recordsPath`) are recorded on `FlowTriggerState.data.lastError` and surfaced in the builder; they do not create FlowRuns.

### Folded-in fix

`trigger.filter` ("Only run when…") is authored in the UI today but evaluated nowhere at runtime. The condition-clause evaluator that already serves `condition`/`filter` nodes gets wired into run dispatch so the gate works for **all** trigger types, not just poll.

---

## Section 3 — Gap 8: Managed webhook subscription lifecycle

### Approach

Provider webhook subscriptions created on publish and deleted on unpublish (and every other teardown path), via per-provider adapters that call through the existing Nango proxy seam. GitHub + HubSpot first. Hybrid ingress: Nango webhook forwarding by default, direct per-subscription endpoints where forwarding is unsupported. Registration failure blocks the publish.

### Trigger type

- Add `'provider_webhook'` to `FLOW_TRIGGER_TYPES` + editor + validation. Config: `{ type: 'provider_webhook', connectionId, capability, events: string[] }` (e.g. GitHub `['issues.opened', 'pull_request.opened']`, HubSpot `['contact.creation']`).

### Persistence (Prisma migration)

```prisma
model FlowWebhookSubscription {
  id                     String    @id @default(cuid())
  flowId                 String
  organizationId         String    @db.Uuid
  connectionId           String    // Nango connection id
  provider               String    // providerConfigKey
  capability             String    // delivery capability (github, hubspot, …)
  events                 Json      // string[]
  providerSubscriptionId String?
  secretEnc              String?   // provider-issued signing secret, encrypted
  status                 String    @default("active") // active | pending_delete | error
  error                  String?
  createdAt              DateTime  @default(now())
  updatedAt              DateTime  @updatedAt

  flow Flow @relation(fields: [flowId], references: [id], onDelete: Cascade)

  @@index([organizationId, status])
  @@index([connectionId])
  @@map("flow_webhook_subscriptions")
}
```

Plus a delivery idempotency claim: `FlowWebhookDeliveryClaim` with `@@unique([subscriptionId, deliveryId])` (GitHub `X-GitHub-Delivery`, HubSpot event ids), pruned by retention.

### Adapter interface

New module family `src/lib/flows/webhook-subscriptions/`:

```ts
type WebhookSubscriptionAdapter = {
  capability: string
  create(ctx: { connection, events, callbackUrl, flowId }): Promise<{ providerSubscriptionId: string; secret?: string }>
  delete(ctx: { connection, providerSubscriptionId }): Promise<void>
  verify?(req: Request, secret: string | null): Promise<boolean> // direct-ingress providers only
}
```

Implemented over `defaultProxy()` / `runNangoAction` from `src/lib/nango/delivery.ts` — the same seam the delivery adapters use. First adapters: GitHub (repo/org webhooks API) and HubSpot (webhook subscriptions API).

### Publish lifecycle (`src/lib/flows/publish.ts`)

Ordering honors fail-the-publish:

1. Validate graph (existing).
2. **Diff** desired subscriptions (from the trigger config) against existing `FlowWebhookSubscription` rows for the flow.
3. Create/update provider subscriptions **before** the DB transaction. Any failure → return `{ published: false, reason }` — the existing contract, so template provisioning still degrades to DRAFT gracefully.
4. Commit the existing `$transaction` (flow update + `FlowVersion`), now also persisting subscription rows.
5. If the transaction itself fails, attempt a compensating provider delete for anything created in step 3.
6. Stale subscriptions (trigger changed on re-publish) are deleted after commit, best-effort.

### Teardown coverage

Every path that can currently leak a subscription (all bypass `publish.ts` today):

- `unpublishFlow` (covers unpublish and disable),
- `DELETE /api/flows` (row cascade deletes our rows; provider delete added),
- Nango connection disconnect route + the stale-connection sweep in `/api/nango/status` (alongside the existing purge-on-disconnect `after()` blocks),
- org teardown (`src/lib/org-teardown.ts`, which already loops connections).

Deletes are best-effort: provider failure marks the row `pending_delete`; a cron reconcile sweep retries. A leaked provider webhook is the explicit failure mode we guard against.

### Ingress

**Primary — Nango forwarding:** `POST /api/nango/webhook`. New `NANGO_WEBHOOK_SECRET` env; verify `x-nango-signature` HMAC; fast-ack then dispatch in `after()`, modeled on the Slack events route including its anti-enumeration posture (identical 401 for unknown/invalid/bad-signature). Payload → resolve connection + event → match `FlowWebhookSubscription` rows → claim `FlowWebhookDeliveryClaim` → `dispatchFlowExecution` per matched flow with `trigger: { type: 'provider_webhook', provider, event }` and the raw provider payload as input.

**Fallback — direct:** `POST /api/webhooks/[subscriptionId]` for providers where Nango forwarding is unsupported. Opaque cuid in the path, per-provider `adapter.verify()` with the stored decrypted secret, same claim + dispatch pipeline, same anti-enumeration 401s. The adapter's `callbackUrl` decides which ingress a provider uses.

---

## Testing

- **Gap 6:** unit tests for `upgradeFlowGraph` (identity at latest, chained upgrades, unknown-future rejection), `pasteNodeAfter`/`makeNode` stamping, portable import of v1 exports without `typeVersion`; validation tests for `UNKNOWN_TYPE_VERSION` at save and publish.
- **Gap 7:** unit tests for due-check off `lastPolledAt`, record extraction/dedupe claims (P2002 path), cursor checkpoint-after-dispatch, per-tick caps, filter gating; an integration test running a fake catalog tool through `runFlowPoll` to FlowRun creation. Route-smoke per the project's `verify` protocol (throwaway Postgres).
- **Gap 8:** adapter tests against recorded Nango proxy fixtures; publish-blocking on create failure; teardown coverage tests per path (unpublish, delete, disconnect, org teardown); ingress signature verification + idempotency claim tests; anti-enumeration behavior.

## Out of scope (documented follow-ups)

- Sub-15-minute polling via a BullMQ flow JobScheduler (config already carries `intervalMinutes`).
- Curated poll presets layered on the generic engine.
- Additional webhook providers beyond GitHub + HubSpot (Salesforce, Intercom, Asana, ClickUp, Monday, Confluence follow the adapter interface).
- Gaps 9–12 (item-stream lineage, full-JS sandbox, node SDK, binary pipeline) — deliberate philosophy differences, not pursued.
