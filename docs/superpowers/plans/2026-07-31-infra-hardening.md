# Infrastructure Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every gap identified in the 2026-07-31 four-track audit (DB/connections, shared-state/scaling, settings persistence, stability) so the platform can serve 100+ concurrent users, never loses a settings write, and fails loudly instead of silently.

**Architecture:** Eight workstreams, ordered by blast radius: queue/Redis hardening, run-lifecycle correctness, cron dispatch, rate limiting, settings durability, external-service timeouts, query/payload discipline, and deploy/env safety. Each workstream is independently committable and keeps `npm run typecheck && npm test` green.

**Tech Stack:** Next.js 15 (Vercel serverless), Prisma 6 + Supabase Postgres (Supavisor pooler), BullMQ 5 + ioredis (Upstash), node:test.

## Global Constraints

- Every commit keeps `npm run typecheck`, `npm run lint`, and `npm test` green.
- All tenant-data queries carry `organizationId` (tenant guard); system-wide sweeps use `systemPrisma` with a justification comment.
- Schema changes must be additive/nullable (migrations run at build time before code promotion — see WS8).
- No behavioral change to dev inline mode: a bare `next dev` with no Redis must keep working.
- Follow existing patterns: `jsonb_set` claims (`suggest-workflows.ts:284`), `afterResponse()` (`after-response.ts`), status-guarded `updateMany` (`execute-agent.ts:440`), `AbortSignal.timeout` call sites.

---

## WS1 — Queue / Redis hardening

### Task 1.1: Split producer vs worker Redis connections; queue singletons; error listeners
**Files:** Modify `src/lib/queue/config.ts`; test `src/lib/queue/__tests__/config.test.ts` (create).
- `getRedisConnection()` keeps `maxRetriesPerRequest: null` (required by BullMQ Workers) — rename usage so only the worker runtime uses it.
- New `getProducerConnection()`: `maxRetriesPerRequest: 2`, `commandTimeout: 3000`, `enableOfflineQueue: false`, `connectTimeout: 3000`, `lazyConnect: true`, plus an `'error'` listener → `captureError` (throttled).
- New `getQueue(name)`: module-level `Map<string, Queue>` cache built on the producer connection — closes finding "createQueue per request leaks listeners" (§1.1/M8). `createQueue` stays for worker-side callers that close explicitly (registrar) but delegates to the same options.
- All API-route/producer callers switch to `getQueue`: `agents/[id]/execute`, `agents/[id]/trigger`, `executions/[id]/reply`, `cron/dispatch`, `execute-flow.ts`, `activity/backfill.ts`, `dead-letter.ts`, `flow-dead-letter.ts`.

### Task 1.2: Per-queue concurrency + worker error listeners + graceful shutdown
**Files:** Modify `src/lib/queue/config.ts`, `src/lib/workers/runtime.ts`, `render.yaml`.
- Concurrency: `AGENT_WORKER_CONCURRENCY` default 10 (I/O-bound runs), `FLOW_WORKER_CONCURRENCY` default 10, `BACKFILL_WORKER_CONCURRENCY` default 2; render.yaml sets 20 for agent queues. Document worker DATABASE_URL pool sizing next to it (WS8 asserts it).
- `worker.on('error')` + shared-connection `'error'` → `captureError` (M3).
- Shutdown (H2): re-entrancy guard; `worker.pause()` first; `Promise.race` between `worker.close()` and a 20s timer, then `worker.close(true)`; always `flushErrorReporting()` before exit.

### Task 1.3: Failed-run retries must rethrow (restore DLQ + Sentry) (C1)
**Files:** Modify `src/features/agents/execute-agent.ts` (early-return at ~:407); test in `src/features/agents/__tests__/`.
- When a queued job reloads its row and finds `status === 'failed'`, throw `Error('execution already failed — dead-lettering retry')` instead of resolving `skipped`, so BullMQ fires `'failed'` → DLQ + Sentry. Keep the benign skips (completed/cancelled) resolving.

### Task 1.4: DLQ retention + visibility (H4, L6)
**Files:** Modify `src/app/api/cron/retention/route.ts`, `src/app/api/health/route.ts`.
- Retention cron: `Queue.clean()` both DLQs of entries older than 30 days (bounded batch), log counts.
- `/api/health`: add queue-Redis ping + waiting/failed counts for the four live queues + DLQ depths, via producer connection with 3s command timeout; degraded ⇒ `queue: false` in payload (Postgres remains the only hard-fail).

## WS2 — Run lifecycle correctness

### Task 2.1: `queuedAt` column + guarded pending→running claim (§2.2)
**Files:** Modify `prisma/schema.prisma` (`AgentExecution.queuedAt DateTime?` + `@@index([status, startedAt])`), new migration; `src/features/agents/execute-agent.ts`; `src/app/api/cron/dispatch/route.ts`; enqueue sites set `queuedAt: new Date()`.
- Pending reaper keys on `queuedAt` (fallback `startedAt` for legacy rows): `OR: [{ queuedAt: { lt: cutoff } }, { queuedAt: null, startedAt: { lt: cutoff } }]`.
- Claim becomes `updateMany({ where: { id, status: 'pending' } })`; count 0 → job resolves as skipped-with-log (someone else terminalized it) — but per Task 1.3, a `failed` row on a retry attempt rethrows.

### Task 2.2: Resume refreshes `startedAt`; terminal writes status-guarded (C3, L5, L3)
**Files:** Modify `src/features/agents/execute-agent.ts`.
- Resume claim adds `startedAt: new Date()` (mirrors `execute-flow.ts:183`).
- Terminal completion/failure writes become `updateMany` guarded on `status: { in: ['running', 'waiting_for_input'] }`; on count 0, log + capture (the reaper won).
- Turn checkpoint metadata: re-read current metadata inside the checkpoint update instead of spreading the boot-time snapshot (L3) — merge `pendingQuestion/pendingApproval` keys only.

### Task 2.3: Reaper thresholds + missing indexes (M1, M13, F7)
**Files:** Modify `src/lib/agents/timeouts.ts`, `src/app/api/cron/dispatch/route.ts`, `prisma/schema.prisma` (+ migration).
- `STUCK_RUN_TIMEOUT_MS = AGENT_RUN_TIMEOUT_MS * 2 + 5min` (> lockDuration × (maxStalledCount+1) + cron jitter).
- `AgentExecution @@index([status, startedAt])` (Task 2.1 migration), `AgentTask @@index([status])`.

### Task 2.4: Flow stall recovery consults the step ledger (H1); null-userId waits (M12)
**Files:** Modify `src/features/flows/execute-flow.ts`, `src/lib/flows/reap.ts`.
- When adopting a pre-created run that already has `flowRunStep` rows (stall redelivery), run `resolveResumeState` exactly as the `resuming` branch does, so completed side-effecting nodes replay as no-ops.
- Reap: extend `reapStuckFlowRuns` to terminalize `waiting` runs whose `userId` is null and `wakeAt` is > 24h past due (`failed`, error `'wait expired with no resumable user'`).

## WS3 — Cron dispatch hardening

### Task 3.1: All background sweeps through `afterResponse()` + bounded fan-out (C4, H5)
**Files:** Modify `src/app/api/cron/dispatch/route.ts`; new `src/lib/server/concurrency.ts` (`mapWithConcurrency<T,R>(items, limit, fn)`); test `src/lib/server/__tests__/concurrency.test.ts`.
- Every `void sweep()` becomes `afterResponse(() => sweep())`.
- Per-org loops (`inferActivityPatterns`, `runBehaviorIntelligence`, `runGoalWorkLearning`) run through `mapWithConcurrency(orgs, 5, …)` inside one `afterResponse`.
- `groupBy` calls get `orderBy` + `take: 500` with a logged drop count (no silent caps).

### Task 3.2: Deterministic scans, no silent caps (H3, §4.4, F7 select)
**Files:** Modify `src/app/api/cron/dispatch/route.ts`.
- Agent scan: `where: { status: 'ACTIVE' }, orderBy: { updatedAt: 'asc' }` — wait; fairness needs rotation: order by `lastRunAt asc nulls first` equivalent via `orderBy: [{ updatedAt: 'asc' }]` on a bumped column. Implementation: order by `id asc` with a persisted cursor in `PlatformState`-like row is overkill; instead raise `take` to 1000, `select` only needed columns, and log when `agents.length === take` (visible saturation). Same for flows (`take: 500`) and due-waits (`take: 200`, ordered `wakeAt asc` so oldest resume first).
- `MAX_AGENTS_PER_TICK`/`MAX_FLOWS_PER_TICK`: make env-tunable, log dropped counts when the cap binds.

## WS4 — Rate limiting

### Task 4.1: Rate limit support in the shared API wrapper (§3.1, §3.2)
**Files:** Modify `src/lib/server/api-handler.ts`, `src/lib/ratelimit.ts`; tests.
- `withAuthenticatedApi(handler, { requires, rateLimit?: { feature, perUser, perOrg?, windowSeconds? } })` — checks user key then org key (org limit = perUser × 10 default). 429 with `Retry-After`.
- Apply to LLM routes: `agents/draft` (10/min user), `agents/[id]/chat` (30/min), `flows/[id]/execute` (30/min), `flows/[id]/runs/[runId]/resubmit` (30/min), `executions/[id]/reply` (30/min), `integrations/ai-search` (20/min), `templates/ai-search` (20/min), `templates/provision` (6/min), `agents` POST (12/min), `system/capabilities` (6/min), `flows/copilot/chat` (30/min), `flows/signals/[name]` (30/min).
- Redis-down behavior stays fail-open but now logs + captures once per instance (deliberate availability choice, made visible).

### Task 4.2: `emitFlowSignal` goes through the queue (§3.3)
**Files:** Modify `src/features/flows/signals.ts`.
- Replace direct `runFlowExecution` with `dispatchFlowExecution` (queue in prod, inline in dev), batch the owner lookup (`user.findMany` once), and return `{ dispatched }` counts. Signals route gets `maxDuration = 60` (it only enqueues now).

### Task 4.3: Month-budget aggregate caching (§3.4, F6 partial)
**Files:** Modify `src/lib/usage/budget.ts`, `src/lib/server/snapshot.ts`.
- Cache the month `aggregate` per org for 60s (`cacheGetNumber`/`cacheSet` — existing helpers), key `usage:month:{org}:{yyyymm}`. `recordTokenUsage` already increments the cache atomically — reconcile by re-aggregating on cache miss only.
- `/api/snapshot` uses the same cached number.

## WS5 — Settings durability

### Task 5.1: Atomic org-settings merge (#1)
**Files:** Modify `src/app/api/organizations/route.ts`, `src/app/api/goals/settings/route.ts`; new `src/lib/server/org-settings.ts` (`mergeOrgSettings(orgId, patch)` using `jsonb || jsonb` via `$executeRaw` with key-level patch semantics); tests.
### Task 5.2: `scanExclusions` add/remove verbs (#4)
**Files:** Modify `src/app/api/organizations/route.ts` (accept `{ scanExclusions: { add?: ref, remove?: ref } }`), `src/lib/client/use-scan-exclusions.ts`; tests.
### Task 5.3: Profile cache invalidation + admin gates (#2, #3, #7, #8)
**Files:** Modify `src/app/api/settings/profile/route.ts` (PATCH calls `invalidateDbUserCache`), `src/app/api/goals/settings/route.ts` (`requires: 'settings:workspace'`), `src/app/api/intelligence/learnings/route.ts` DELETE (`settings:workspace`), `src/components/goals/impact-strip.tsx` (isAdmin gate + resync-on-open + dirty-field-only save — #9), `src/components/connections/mcp-servers-panel.tsx` (`|| !isAdmin`).
### Task 5.4: Client save error handling (#6, #10)
**Files:** Modify `src/app/(app)/settings/tabs/profile.tsx`, `src/app/(app)/g/[scope]/agents/page.tsx` (`saveAgent`), `src/app/(app)/g/[scope]/agents/agent-config-form.tsx` (`submit` catch + `applySuggestion` rollback), `src/app/(app)/g/[scope]/flows/[id]/page.tsx` (suggestion rollback), `src/lib/client/use-scan-exclusions.ts` (surface failure).
### Task 5.5: Theme key unification + avatar cap (#11, #12)
**Files:** Modify `src/components/auth/auth-shell.tsx`, `src/components/landing/landing-page.tsx`, `src/components/landing/marketing-shell.tsx` (use `sublime-theme`), `src/app/(app)/settings/tabs/profile.tsx` (`AVATAR_URL_MAX = 300_000`, target ~512px q0.85).
### Task 5.6: Push subscription server reconcile (#13)
**Files:** Modify `src/app/api/push/subscribe/route.ts` (add GET returning whether the posted endpoint is registered), `src/components/notifications/notification-bell.tsx` (reconcile enabled state).

## WS6 — External-service timeouts

### Task 6.1: Neo4j driver options + ping reuse + health caching (§6.2, §6.3)
**Files:** Modify `src/lib/rag/neo4j-store.ts`, `src/lib/rag/get-store.ts`, `src/app/api/health/route.ts`.
- Driver options: `connectionTimeout: 5000`, `connectionAcquisitionTimeout: 10000`, `maxConnectionPoolSize: 10`. Per-query `timeout` on `executeQuery` (15s). `upsertEdges` batches with UNWIND.
- `neo4jPing` reuses the singleton driver + 3s bound; `/api/health` caches the Neo4j probe 30s per instance.
### Task 6.2: Nango timeouts + client reuse (M10, M9 partial)
**Files:** Modify `src/lib/nango/client.ts` (singleton + axios timeout if SDK exposes; else bounded wrappers), call sites bounded with 15s deadline; `triggerAction` 60s.
### Task 6.3: LLM deadlines + maxDuration corrections (M5, M6, H6)
**Files:** Modify `src/lib/llm/model-runner.ts` (`generateText`/`generateHeadline` get `AbortSignal.timeout(60_000)`), routes: `maxDuration = 1200` → `800` (7 files), add `maxDuration = 120` to `agents/draft`, `flows/copilot/chat`, `templates/ai-search`, `integrations/ai-search`, `contact` (+ Resend `AbortSignal.timeout(30_000)` — L1), webpush `timeout: 10_000` (L2).
### Task 6.4: `notify()` visibility (L4)
**Files:** Modify `src/lib/notifications/service.ts` — capture + log on failure (still returns null; callers unaffected).

## WS7 — Query/payload discipline

### Task 7.1: List-endpoint payload trims (F3, F4, F10)
**Files:** Modify `src/app/api/flows/route.ts` (select list columns; `unpublishedChanges` from `publishedVersion !== version` — verify schema fields at implementation), `src/app/api/goals/route.ts` (`take: 200` + select), `src/app/api/knowledge/route.ts` (select w/o `contentEncrypted` except download branch).
### Task 7.2: Run-watch poll discipline (F5, F9)
**Files:** Modify `src/app/(app)/g/[scope]/flows/[id]/page.tsx` (pass `summary=1`; backoff 2s→5s after 60s→15s after 5min), `src/components/flows/run-panel.tsx` + `agent-activity-pane.tsx` (same backoff), `src/app/api/workflows/executions/route.ts` + `src/app/api/flows/[id]/runs/route.ts` (bounded child `take` tails: steps 200, events 500, messages 100).
### Task 7.3: Cron/registrar query hygiene (§2.3, M2, F7, F11, F12)
**Files:** Modify `src/lib/workers/agent-schedule-registrar.ts` (`where: { status: 'ACTIVE' }` + select + batched owner `findMany` + null-schedule guard inside per-agent try + Redis `SET NX` lock 55s TTL), `src/lib/rag/re-embed.ts` (batch VALUES-join updates like `knowledge/store.ts:172`), `src/app/api/goals/route.ts` + `goals/[id]/components/route.ts` (`createMany` / batched upserts).
### Task 7.4: Backfill failure truth (M11)
**Files:** Modify `src/lib/activity/backfill.ts` — persist real error message; unique per-enqueue `jobId` (`${row.id}:${retryCount}`); wire `onFailed` in runtime.ts to `captureError`.

## WS8 — Env / deploy safety

### Task 8.1: render.yaml env completeness + worker env assertion (C2)
**Files:** Modify `render.yaml` (add `SENTRY_DSN`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — all `sync: false`), new `assertWorkerEnv()` in `src/lib/env.ts` (required: DATABASE_URL, REDIS_URL, ENCRYPTION_KEY, model key; warn-only: SENTRY_DSN, VAPID keys) called from `runtime.ts start()`.
### Task 8.2: Prisma URL assertions (F2)
**Files:** Modify `src/lib/env.ts` / `instrumentation.ts` — in production Next.js boot, fail fast unless `DATABASE_URL` contains `pgbouncer=true` and `connection_limit`; worker boot instead *warns* if `connection_limit` < its concurrency and documents the required worker URL in render.yaml comments.
### Task 8.3: Migration runbook (M7)
**Files:** Create `docs/runbooks/migrations.md` — expand/contract rule (no destructive enum renames in one deploy), concurrent-build advisory-lock behavior, `prisma migrate resolve` recovery, worker/web deploy ordering.
### Task 8.4: Docs
**Files:** Modify `ARCHITECTURE.md` known-follow-ups — record closed items and the deliberately-deferred set (below).

## Deferred (documented, not implemented — product/infra decisions)
- Server-side cross-device preference sync (theme/sidebar/favorites) — new table + product surface.
- Notification preferences table — feature, not a gap fix.
- Supabase Realtime run-completion delivery (replaces polling) — follow-up epic; poll backoff lands now.
- Flow trigger denormalization (F8) — schema + backfill; bounded now by select-trim only.
- Pyodide/vm isolation (per-tenant sandboxes) — separate infra effort.
- Second worker replica — enabled by registrar lock (7.3) but a deploy action, not code.
- Dashboard-side env values (actual SENTRY_DSN, worker DATABASE_URL pool params) — operator action; code now asserts/warns.

---
Execution: inline in this session (superpowers:executing-plans), one commit per task, `npm run typecheck && npm test` at each workstream boundary, full `npm run check` at the end.
