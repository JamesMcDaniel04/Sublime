# Integration Learnings — Graph-Backed Activity Intelligence — Design Spec

**Date:** 2026-07-12 · **Status:** DRAFT (awaiting user review)

**Goal:** When a customer connects a tool, the platform learns from it — first by backfilling permitted history, then by continuously observing new activity. Everything is normalized into one cross-tool business event graph, and the platform strictly separates **observed facts** from **inferred patterns** from **recommendations**, with every inference citing the facts it rests on.

**One-line architecture:** Per-source **`ActivitySource` adapters** (backfill + webhook + incremental sync) → **`ActivityEvent` Postgres ledger** (durable, deduped, replayable) → **Graph RAG index** (Neo4j nodes + edges; the primary cross-tool representation) → **inference jobs** (facts → evidence-linked `insight` nodes) → consumed by **agent context retrieval**, **flow activity triggers**, and (phase 2) **OKF knowledge-substrate discoveries**.

---

## 1. Motivation (user's framing)

> Historical business reconstruction from records and communications. Live operational learning from ongoing events. Cross-tool process discovery by connecting activity across systems. Optimization recommendations based on bottlenecks, repetition, delays, and outcomes.

Canonical example of the target normalized event:

```
Actor: Sarah · Action: changed_stage · Entity: Opportunity ABC
Previous state: Qualification · New state: Proposal
Timestamp: 2026-07-10 · Source: Salesforce · Related account: Acme
```

And the trust-critical three-tier output:

- **Observed fact** — "Three opportunities were moved backward in stage after legal review."
- **Inferred pattern** — "Legal review appears to be a recurring bottleneck."
- **Recommendation** — "Add a legal-readiness check before opportunities enter the proposal stage."

## 2. What exists today (this is a generalization, not a green-field build)

The platform already runs a **single-source version of this exact pipeline** for People.ai SalesAI:

| Existing piece | Location | Role today |
|---|---|---|
| Webhook receiver | `src/app/api/signals/people-ai/route.ts` | HMAC-verified, rate-limited, persists then routes via `after()` |
| Normalized event table | `Signal` (prisma `signals`) | Typed events, entity refs, `dedupeKey` unique-per-org replay guard |
| Normalizer | `src/lib/signals/map.ts` | Provider event → normalized signal |
| Routing | `src/lib/signals/router.ts` + `SignalSubscription` | Filter-match → idempotent `AgentExecution` per match |
| Graph indexing | `src/lib/rag/indexer.ts` | Signals → signal/account/opp/stakeholder nodes |
| Graph store | `src/lib/rag/neo4j-store.ts` (+ `memory-store.ts` dev fallback) | Typed nodes/edges, per-rep `visibility`/`ownerUserId` isolation |
| Retrieval | `src/lib/rag/retrieve.ts` | Two-stage vector + graph-expansion, already injected into agent context |
| Connect-time learning | `src/lib/intelligence/connection-scan.ts` | Bounded read-only tool sampling → org usage profile as graph `insight` node + org-wide memory |
| Inference surface | `src/lib/intelligence/learnings.ts`, `suggest-workflows.ts` | Learnings panel, workflow suggestions |
| Background jobs | BullMQ queues + Fastify worker (`src/lib/workers/runtime.ts`) | `agent-execution`, `flow-execution` (worker deploy pending; `EXECUTION_MODE=inline` in prod for now) |

**Gaps this spec closes:**

1. **No multi-source activity ledger** — `Signal` is People.ai-shaped; Slack/CRM/GitHub activity has nowhere normalized to land.
2. **No historical backfill** — every ingest surface is live-only; connecting a tool learns nothing from its past. `connection-scan` samples current state, not history.
3. **No explicit fact/inference separation** — `insight` nodes exist but carry no evidence links; nothing distinguishes an observation from a guess.
4. **No cross-tool event triggers for flows** — `SignalSubscription` routes only People.ai signals to agents; flows can't fire on normalized business events.

## 3. Locked decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Primary representation | **Graph-first: extend Graph RAG (Neo4j)** | User choice; graph is largely built (store, indexer, retrieval, isolation); cross-tool correlation is inherently relational |
| Durable record | **Postgres `ActivityEvent` ledger beneath the graph** | Neo4j retention prunes nodes; the ledger makes ingest replayable and the graph rebuildable |
| Source scope | **Source-agnostic contract; concrete v1 adapters: Slack, CRM (Salesforce/HubSpot via Nango), GitHub** | Slack is live on this branch; CRM matches the motivating example; GitHub reuses the knowledge-substrate GitHub App |
| Backfill window | **User-chosen at connect: 90 days / 1 year / all history** | User requirement |
| Consumers (v1) | **Agent context, flow triggers, knowledge-substrate docs** | User choice; no dedicated insights UI in v1 (learnings panel already exists as a light surface) |
| Trust model | **Fact / inferred-pattern / recommendation tiers; inferences require `EVIDENCE` edges** | User requirement — "that distinction will be important for user trust" |
| Deliverable | **Full design spec first; implementation planned after review** | User choice |

## 4. Connector contract — `ActivitySource`

Each participating integration implements one adapter (new: `src/lib/activity/sources/<source>.ts`):

```ts
interface ActivitySource {
  source: string;                        // 'slack' | 'salesforce' | 'hubspot' | 'github' | ...
  capabilities: {
    backfill: boolean;                   // history APIs available
    webhooks: boolean;                   // push events available
    incrementalSync: boolean;            // cursor/updated-since polling
  };
  // Historical reconstruction: page through permitted history, oldest→newest,
  // yielding normalized events. Cursor makes jobs resumable after crash/redeploy.
  backfill(ctx: SourceContext, window: BackfillWindow, cursor?: string):
    AsyncIterable<{ events: NormalizedActivity[]; nextCursor?: string }>;
  // Live observation: translate one provider webhook payload into 0..n events.
  handleEvent(ctx: SourceContext, payload: unknown): Promise<NormalizedActivity[]>;
  // Poll fallback for sources/objects without webhooks.
  incrementalSync(ctx: SourceContext, since: Date): Promise<NormalizedActivity[]>;
}
```

`SourceContext` carries org, connecting user, and the credential handle from the relevant integration plane (`Integration`, `NangoConnection`, `McpConnection`, or `SlackWorkspaceConnection`) — adapters never hold raw tokens.

**What backfill pulls, per the product framing:** business objects, relationships, modification timestamps, status histories, activities/communications, users/teams/ownership, and audit or usage events where the API grants them.

**v1 adapters:**

- **Slack** — backfill: `conversations.list` + `conversations.history`/`replies` (bot-member channels only); live: the existing events route (`src/app/api/slack/events/[bindingId]/route.ts`) grows a fan-out to the activity pipeline alongside its flow-trigger duty. Actions: `posted_message`, `joined_channel`, `reacted`, thread participation.
- **CRM (Salesforce/HubSpot via Nango)** — backfill: objects + field/stage history (Salesforce `OpportunityFieldHistory`, HubSpot property history); live: Nango webhook relay; sync fallback: `updated_since` polling. Actions: `created`, `changed_stage`, `changed_owner`, `changed_amount`, `closed_won/lost`, `logged_activity`.
- **GitHub** — backfill: issues/PRs/reviews/comments via REST (GitHub App installation token, shared with the knowledge-substrate plan); live: App webhooks. Actions: `opened_pr`, `reviewed`, `merged`, `closed_issue`, `commented`.

Adapters are registered in `src/lib/activity/registry.ts` (mirroring `src/lib/connectors/registry.ts`).

## 5. Normalized activity model

**Postgres ledger (new Prisma model `ActivityEvent`, table `activity_events`):**

| Field | Notes |
|---|---|
| `id`, `organizationId` | — |
| `source` | `slack` / `salesforce` / `github` / … |
| `actorRef`, `actorName` | provider user id + display name; resolved to platform users when an identity mapping exists |
| `action` | normalized verb: `changed_stage`, `posted_message`, `merged`, … |
| `entityType`, `entityRef`, `entityName` | `opportunity` / `message` / `pull_request` / … + provider id |
| `previousState`, `newState` | nullable JSON — state transitions |
| `participants` | JSON array of actor refs |
| `businessContext` | JSON — related account/opp/channel/repo refs |
| `outcome` | nullable normalized outcome (`won`, `merged`, `resolved`, …) |
| `occurredAt`, `ingestedAt` | provider timestamp vs. our receipt |
| `ingestKind` | `backfill` / `webhook` / `sync` |
| `dedupeKey` | `@@unique([organizationId, dedupeKey])` — same replay guard as `Signal`/`SlackProcessedEvent` |
| `indexedAt` | null until graph indexing succeeds (re-index scans for nulls) |

The ledger is intentionally thin: it exists for durability, dedup, replay, and degraded mode. **Queries and correlation happen in the graph.**

**Graph projection (extends `src/lib/rag/store.ts` + `indexer.ts`):**

- New node types: `actor`, `activity`, `entity` (joining existing `account`/`opportunity`/`stakeholder`/`signal`/`run`/`insight`).
- Edges: `(actor)-[:PERFORMED]->(activity)`, `(activity)-[:ON]->(entity)`, `(activity)-[:RELATES_TO]->(account|opportunity)`, `(activity)-[:PARTICIPANT]->(actor)`, `(activity)-[:PRECEDED_BY]->(activity)` for state-history chains on the same entity.
- Cross-tool joins happen at `entity`/`account`/`actor` nodes: a Salesforce opportunity, the Slack channel discussing it, and the GitHub PR implementing it converge on shared `account`/`entity` anchors — this is the "business event graph rather than disconnected integrations."
- Existing per-rep isolation applies unchanged: nodes carry `ownerUserId`/`visibility`; org-level activity defaults to `shared`, rep-private sources stay `private`.
- `Signal` keeps working as-is; the indexer already handles it. Migrating People.ai onto `ActivitySource` is a follow-up, not v1.

## 6. Backfill on connect

1. On successful connect of a participating tool, the integration card asks: **Last 90 days / Last year / All available history** (stored on a new `ActivityBackfill` row: source, window, status, cursor, counts).
2. A job is enqueued on a new BullMQ queue `activity-backfill` (added to `QUEUE_NAMES` in `src/lib/queue/config.ts`). The worker pages via `adapter.backfill()`, persisting + indexing each batch, checkpointing `cursor` after every batch — resumable across crashes and deploys.
3. Rate-limit respect is the adapter's duty (providers differ); the job runner provides retry-with-backoff and routes poison batches to the existing dead-letter pattern.
4. Progress (`fetched / indexed / done`) is surfaced on the integration card.
5. **Inline mode** (current prod topology, `EXECUTION_MODE=inline`): backfill runs via `after()` with a bounded window (30 days, capped pages) regardless of the user's selection, and the `ActivityBackfill` row is marked `partial` so the full window can be re-run once the worker + Redis deploy lands. The choice UI is not hidden — the selection is honored later.

## 7. Live observation

- **Webhooks first:** Slack events route (exists), Nango webhook relay for CRM, GitHub App webhooks. All follow the People.ai receiver pattern: verify → persist ledger row (202 fast-ack) → `after()` for indexing + trigger matching. Dedupe via `dedupeKey` makes provider retries safe.
- **Incremental sync fallback:** the existing cron dispatch (`src/app/api/cron/dispatch`) gains an activity-sync tick that calls `incrementalSync(since = lastSyncAt)` for connected sources whose objects lack webhook coverage.
- Webhooks tell you what happens **after** installation; they do not replace backfill — both paths funnel through the identical normalize → persist → index pipeline, so consumers never care how an event arrived.

## 8. Facts vs. inferences (trust layer)

Three tiers, structurally distinct in the graph:

1. **Observed facts** — `activity` nodes + ledger rows. Always carry `source`, provider refs, and `occurredAt`. Never synthesized by an LLM.
2. **Inferred patterns** — `insight` nodes with new metadata `insightKind: 'inferred_pattern'`, written by inference jobs. **Write-time invariant: an inference must carry ≥1 `(insight)-[:EVIDENCE]->(activity)` edge or the write is rejected** (enforced in the indexer wrapper, not by convention).
3. **Recommendations** — `insight` nodes with `insightKind: 'recommendation'`, each linked `(recommendation)-[:BASED_ON]->(inferred_pattern)`. Recommendations never cite raw facts directly; they cite patterns, which cite facts — the full chain is traversable.

**Inference jobs** live in `src/lib/intelligence/infer-patterns.ts`, following the `connection-scan.ts` shape (bounded, best-effort, LLM-driven): on a schedule (post-backfill completion + periodic cron), read graph windows per org — stage-transition chains, delay distributions, repetition, backward movements — and prompt for patterns with the fact node ids in hand, so evidence edges are constructed from real ids rather than model output. Pattern/recommendation text also lands in org-wide `AgentMemory` (kind `learning`) for the existing learnings panel, with `sourceRef` pointing at the insight node.

## 9. Consumers

- **Agent context** — no assembler changes: `activity` and evidence-linked `insight` nodes flow through the existing two-stage retrieval in `retrieve.ts`. Prompt rendering labels tiers explicitly (`[observed]` / `[inferred]` / `[recommendation]`) so agents inherit the trust distinction.
- **Flow triggers** — new flow trigger type `activity` (joining `slack` from this branch): a subscription filter over `{source, action, entityType, businessContext}` (generalizing `SignalSubscription`'s type+JSON-filter design), matched during live ingest, dispatching flows with `trigger.activity` origin and the same idempotency discipline as `signals/router.ts` (`eventId:flowId`). Backfilled events **never** fire triggers (`ingestKind === 'backfill'` is excluded).
- **Knowledge substrate (phase 2)** — inference jobs additionally emit OKF markdown discoveries (`type: discovery`) into the per-org knowledge repo, per the 2026-07-11 knowledge-substrate spec. Deferred until that spec's Phase 1 ships; the insight-node path above works without it.

## 10. Topology, gating, degradation

- **Full pipeline requires:** `ragEnabled()` (Voyage + Neo4j) for the graph, and worker + Redis for real backfill. This aligns with the pending Render worker deploy.
- **Degraded (graph off):** ledger writes continue (`indexedAt = null`); a re-index job (same pattern as `/api/rag/backfill`) sweeps unindexed rows once the graph comes online. Nothing is lost, only deferred. Trigger matching still works off the ledger row (it doesn't need the graph).
- **Degraded (no worker):** §6 inline-bounded backfill; live ingestion is unaffected (webhooks already run inline via `after()`).
- **Retention:** activity graph nodes join the existing daily retention cron; the Postgres ledger is the long-lived record and follows org data-retention policy. Org teardown clears both (extend `src/lib/org-teardown.ts`).
- **Privacy:** backfill window is user-chosen at connect; per-rep `visibility` isolation applies; adapters only read what granted scopes permit; `scan-exclusions.ts` patterns extend to activity sources.

## 11. Error handling

- Adapter failures during backfill: batch-level retry with backoff → dead-letter (existing pattern), cursor checkpoint prevents re-reading completed pages; `ActivityBackfill.status = 'failed'` is user-visible on the card with a retry affordance.
- Webhook ingest: fast-ack then best-effort processing (People.ai pattern); processing failures leave the ledger row with `indexedAt = null` for the sweep job.
- Inference jobs: best-effort, swallow-and-log (RAG convention); a failed inference run never blocks ingest.
- Malformed provider payloads: adapter returns zero events + structured log; never throws through the receiver.

## 12. Testing

- **Adapter contract tests:** shared suite every adapter must pass (normalization shape, dedupe-key stability, cursor resumability) with fixture payloads per provider.
- **Ledger:** unique-constraint replay tests (mirroring `SlackProcessedEvent` tests); `ingestKind` trigger-exclusion test.
- **Graph projection:** `MemoryGraphStore` assertions on node/edge shapes, `PRECEDED_BY` chains, evidence-edge invariant rejection.
- **Backfill jobs:** cursor checkpoint/resume under simulated crash; inline-mode bounded-window behavior.
- **Trigger matching:** filter semantics + idempotency, patterned on existing `signals/router` tests.

## 13. Phasing

- **Phase 1:** `ActivityEvent` ledger + graph projection + `ActivitySource` contract + **Slack adapter** (live + backfill) + evidence-linked inference job + activity flow trigger. Ships value on the current branch's momentum.
- **Phase 2:** CRM (Nango) + GitHub adapters; incremental-sync cron; OKF discovery emission; People.ai `Signal` migration onto the contract.

## 14. Explicitly out of scope (v1)

- Dedicated insights/recommendations UI beyond the existing learnings panel.
- Cross-org benchmarking; administrative usage-intelligence APIs (SIEM/audit-log ingestion).
- Identity resolution beyond simple provider-ref ↔ platform-user mapping.
- Real-time streaming/CDC transports; polling + webhooks suffice at current scale.
