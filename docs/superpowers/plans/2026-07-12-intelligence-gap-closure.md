# Implementation Plan: Behavioral-Intelligence Gap Closure

**Date:** 2026-07-12
**Status:** Ready to execute
**Format:** superpowers/writing-plans (TDD, bite-sized, dependency-ordered)

---

## Goal

Close the remaining **feature-level** gaps in the shipped Behavioral-Intelligence layer
(connection scans → org-shared learnings → workflow suggestions). The cheap gaps
(write-verb denylist, DELETE-400, `scanExclusion` length bound) are already fixed and are
**out of scope**. This plan closes eight gaps surfaced by an adversarial audit:

1. Wire the already-built **Rescan** action into the three per-connection Learning UIs.
2. **Auto re-scan** OAuth-based Klavis connections when they transition `pending_auth → active`.
3. **Edit/correct learnings** — `PATCH /api/intelligence/learnings` + inline edit; admin-gate the mutations.
4. **Per-claim citations** — append a resolved source label to each injected learning.
5. **Per-org template pagination** — never drop an org's own template to a global recency cutoff.
6. Minors: (a) client-disable the non-admin Learning toggle on the Klavis/MCP cards;
   (b) scope suggestion dedup by `question`; (c) remove the orphaned `insight:mem:<id>` graph node
   when suggest-workflows deletes a memory row.

## Architecture

- **Next.js 15 App Router** API routes wrapped by `withAuthenticatedApi` (`src/lib/server/api-handler.ts`);
  handlers receive `auth: AuthContext` (`{ user, dbUser, userId, organizationId }`,
  `dbUser.role ∈ {'ADMIN','USER'}`). Throw `ApiError(message, status, code)` for typed failures;
  `ZodError` auto-maps to 400.
- **Data:** Prisma (`prisma` = org/RLS-scoped, `systemPrisma` = cross-org-by-design). Learnings live
  under a hidden per-org `AgentTask` (`agentType:'SYSTEM'`, `status:'SYSTEM'`, no `userId`) resolved by
  `findOrgIntelligenceAgentId` (read-only) / `orgIntelligenceAgentId` (get-or-create).
- **Scan pipeline:** `scanConnection({organizationId,userId,plane,connectionRef,connectionName})`
  (`src/lib/intelligence/connection-scan.ts`) — read-only tool sampling → LLM distillation →
  `indexConnectionScan` (graph) + `saveAgentMemory(kind:'learning', sourceRef:'<plane>:<ref>')`.
  Never throws; degrades to `{ skipped }`. Scan triggers are keyed off **status transitions**
  (`shouldScanNangoConnection`), fired via `after()` from routes.
- **Memory:** `saveAgentMemory` (dedup via pgvector nearest-neighbor + pure `decideMemoryDedup`),
  `retrieveAgentMemory` → `MemoryHit[]`, `renderAgentMemories` (pure prompt block).
  Rendered into the agent system prompt in `src/features/agents/execute-agent.ts`.
- **Graph-RAG indexer** (`src/lib/rag/indexer.ts`): stable node-id scheme (`nodeIds`), all writes
  gated on `ragEnabled()`, all deletes on `graphRagPersistent()`.
- **Client:** integration surfaces are React client components using `useCachedJson`
  (stale-while-revalidate), `useScanExclusions` (per-connection learning opt-out via
  `PATCH /api/organizations` — already admin-gated). Role reaches the client via
  `GET /api/settings/profile` (`{ profile: { role } }`), the pattern the Nango grid already uses.

## Tech Stack

TypeScript, Next.js 15 (App Router, `after` from `next/server`), Prisma + Postgres/pgvector,
Zod, React 18 client components, `sonner` toasts, shadcn/ui (`Button`, `Switch`, `Input`, `Badge`,
`Card`). Tests: `node:test` + `node:assert/strict`, run via
`TSX_TSCONFIG_PATH=tsconfig.test.json tsx --test <glob>` (`npm test`). Typecheck: `npm run typecheck`
(`prisma generate && tsc --noEmit`). DB-gated tests self-skip (report 0 tests) when
`TEST_DATABASE_URL` is unset by wrapping the whole file body in `if (process.env.TEST_DATABASE_URL) { … }`.

## Global Constraints

- **No cross-tenant leak.** Every DB read/write stays scoped by `organizationId`. Cross-org reads use
  `systemPrisma` *only* where already established (community templates) and must exclude auto-generated
  org intelligence. New queries added here that touch other orgs (Task 5 community window) MUST filter
  `organizationId: { not: caller }`. Learnings/rescan/scan operate strictly within `auth.organizationId`.
- **No regression.** Preserve existing invariants: `scanConnection` never throws; `saveAgentMemory`
  never throws; durable dismiss (dismissing a learning/suggestion is permanent — never resurrected by a
  re-scan); `after()` (not bare `void`) for post-response background work on serverless; the hidden
  holder agent is never conjured into existence by a read.
- **Idempotent scan triggers.** A re-scan of an already-scanned connection must be safe: learnings dedup
  by `sourceRef`, so at worst a duplicate scan bumps `timesUsed`. Never fire a scan on a status that has
  not genuinely transitioned into active/connected.
- **Admin gating consistency.** The learnings **mutations** (DELETE + new PATCH) and the manual **rescan**
  are org-mutating / cost-incurring, and their sibling controls are already admin-gated
  (`PATCH /api/organizations` line 49, `mcp/connections` POST/DELETE). Gate them on
  `dbUser.role === 'ADMIN'`. Keep `GET /api/intelligence/learnings` open (read-only transparency).
- **Token frugality.** Injected-learning citations must be short (`(source: X)`), only on `kind:'learning'`,
  and resolved *before* rendering (never N DB calls inside the pure renderer).
- **Best-effort background work** (graph node removal, citation resolution) must be `.catch`-guarded and
  never fail the hot path.

## File Structure

```
src/
  app/
    api/
      intelligence/
        rescan/route.ts            [T1: add ADMIN gate]
        learnings/route.ts         [T2: import shared resolveSourceLabel; T3: ADMIN gate + PATCH]
      mcp/connections/route.ts     [T6: fire after() klavis re-scan]
      agent-templates/route.ts     [T7: own-full + community-window queries]
    settings/
      learnings-panel.tsx          [T3: inline edit + admin-gated controls]
  components/
    connections/mcp-servers-panel.tsx        [T1: Rescan; T5: !isAdmin disable]
    integrations/mcp-integration-cards.tsx   [T1: Rescan; T5: !isAdmin disable]
  app/integrations/oauth-integrations-grid.tsx [T1: Rescan]
  features/agents/execute-agent.ts           [T2: resolve + attach citations before render]
  lib/
    client/
      use-rescan-connection.ts     [T1: NEW hook]
    intelligence/
      connection-scan.ts           [T6: shouldScanKlavisConnection pure fn]
      learnings.ts                 [unchanged pure helpers, reused]
      source-label.ts              [T2: NEW — extracted resolveSourceLabel + batch resolver]
      template-visibility.ts       [T7: id-dedup]
      suggest-workflows.ts         [T8: remove orphan graph node]
    memory/agent-memory.ts         [T4: dedup-by-question; T2: MemoryHit.source + renderAgentMemories]
    mcp/server-provisioning.ts     [T6: onNewlyActive seam in getConnectionStatuses]
    rag/indexer.ts                 [T8: nodeIds.insightMem + removeAgentMemoryFromGraph]
  ...__tests__/                    [pure node:test files per task]
```

## Task order (dependency-ordered; each labelled with its gap)

1. **Task 1 — Gap 6b:** suggestion dedup by `question` (pure `agent-memory.ts`).
2. **Task 2 — Gap 4:** shared `source-label.ts` + per-claim citations (`agent-memory.ts`, `execute-agent.ts`, learnings route reuse).
3. **Task 3 — Gap 3:** learnings `PATCH` + admin-gated mutations + inline edit UI.
4. **Task 4 — Gap 1:** `useRescanConnection` hook + Rescan controls in 3 UIs + rescan-route admin gate.
5. **Task 5 — Gap 6a:** non-admin Learning-toggle disable on the Klavis/MCP surfaces.
6. **Task 6 — Gap 2:** Klavis auto re-scan (pure `shouldScanKlavisConnection` + `getConnectionStatuses` seam + route).
7. **Task 7 — Gap 5:** per-org template pagination (route query split + `selectVisibleTemplates` id-dedup).
8. **Task 8 — Gap 6c:** remove orphaned `insight:mem:<id>` graph node on transient-failure memory delete.

> Tasks 1→2→3 and 6 all touch shared files but different functions; execute in order. Tasks 4 and 5
> both edit the two Klavis/MCP components — do Task 4 first, then Task 5 layers `!isAdmin` onto the
> same controls.

---

## Task 1 — Gap 6b: scope suggestion dedup by `question`

**Problem (grounded).** In `saveAgentMemory` the suggestion nearest-neighbor query
(`src/lib/memory/agent-memory.ts` ~L102-114) filters `kind='suggestion'` + `status IN ('open','dismissed')`
but ignores `question`. New-workflow suggestions carry `question=null`; flow-improvement suggestions carry
`question='flow:<id>'` (see `FLOW_TARGET_MARKER_PREFIX`). A textually similar pair across those two
namespaces cross-contaminates: one dedupes into the other, silently dropping a distinct artifact. Fix at
**both** layers: scope the SQL to the same `question` (null-safe) so the *right* nearest neighbor is found,
and thread `question` into the pure `decideMemoryDedup` as a hard guard.

**Files**
- `src/lib/memory/agent-memory.ts`
- `src/lib/memory/__tests__/agent-memory.test.ts` (append)

**Interfaces (exact)**
```ts
export type MemoryDedupMatch = { status: string; sourceRef: string | null; question: string | null }

export function decideMemoryDedup(params: {
  kind: MemoryKind
  similarity: number
  match: MemoryDedupMatch | null
  requestSourceRef?: string | null
  requestQuestion?: string | null
}): 'insert' | 'dedupe'
```

### Steps

1. **Failing test** — append to `src/lib/memory/__tests__/agent-memory.test.ts`:
```ts
test('decideMemoryDedup: suggestions with different question namespaces do not merge', () => {
  const base = { status: 'open' as const, sourceRef: null }
  // new-workflow (question=null) vs flow-improvement (question='flow:1') — must NOT dedupe.
  assert.equal(
    decideMemoryDedup({ kind: 'suggestion', similarity: 0.99, match: { ...base, question: 'flow:1' }, requestQuestion: null }),
    'insert',
  )
  assert.equal(
    decideMemoryDedup({ kind: 'suggestion', similarity: 0.99, match: { ...base, question: null }, requestQuestion: 'flow:1' }),
    'insert',
  )
  // different flow targets — must NOT dedupe.
  assert.equal(
    decideMemoryDedup({ kind: 'suggestion', similarity: 0.99, match: { ...base, question: 'flow:1' }, requestQuestion: 'flow:2' }),
    'insert',
  )
})

test('decideMemoryDedup: suggestions in the same question namespace dedupe', () => {
  const base = { status: 'open' as const, sourceRef: null }
  assert.equal(
    decideMemoryDedup({ kind: 'suggestion', similarity: 0.99, match: { ...base, question: null }, requestQuestion: null }),
    'dedupe',
  )
  assert.equal(
    decideMemoryDedup({ kind: 'suggestion', similarity: 0.99, match: { ...base, question: 'flow:1' }, requestQuestion: 'flow:1' }),
    'dedupe',
  )
})

test('decideMemoryDedup: below-threshold suggestion still inserts regardless of question', () => {
  assert.equal(
    decideMemoryDedup({ kind: 'suggestion', similarity: 0.5, match: { status: 'open', sourceRef: null, question: null }, requestQuestion: null }),
    'insert',
  )
})
```
> Existing `decideMemoryDedup` tests that build `match` without `question` will fail to typecheck once
> `MemoryDedupMatch` gains `question`. Update those existing suggestion/learning match literals in the
> same file to include `question: null` (mechanical).

2. **Run fails:** `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/memory/__tests__/agent-memory.test.ts` (type error / assertion fail).

3. **Minimal impl** in `src/lib/memory/agent-memory.ts`:

   a. Extend the type + the pure decision:
```ts
export type MemoryDedupMatch = { status: string; sourceRef: string | null; question: string | null }

export function decideMemoryDedup(params: {
  kind: MemoryKind
  similarity: number
  match: MemoryDedupMatch | null
  requestSourceRef?: string | null
  requestQuestion?: string | null
}): 'insert' | 'dedupe' {
  if (!params.match || params.similarity < MEMORY_SIMILARITY_THRESHOLD) return 'insert'
  if (params.kind === 'suggestion') {
    // Different provenance must not merge: a new-workflow suggestion
    // (question=null) and a flow-improvement suggestion (question='flow:<id>')
    // can be textually similar but are distinct artifacts. Null-safe compare.
    return (params.match.question ?? null) === (params.requestQuestion ?? null) ? 'dedupe' : 'insert'
  }
  if (params.kind === 'learning') {
    return params.match.sourceRef === (params.requestSourceRef ?? null) ? 'dedupe' : 'insert'
  }
  return 'insert'
}
```

   b. In `saveAgentMemory`, scope the **suggestion** raw query by `question` and select it. Replace the
   suggestion branch query:
```ts
        if (params.kind === 'suggestion') {
          return tx.$queryRaw<Array<{ id: string; status: string; sourceRef: string | null; question: string | null; distance: number }>>`
            SELECT "id", "status", "sourceRef", "question", ("embeddingVec" <=> ${vectorLiteral}::vector(1024)) AS distance
            FROM "agent_memories"
            WHERE "organizationId" = ${params.organizationId}::uuid
              AND "agentId" = ${params.agentId}
              AND "kind" = 'suggestion'
              AND ("question" IS NOT DISTINCT FROM ${params.question ?? null})
              AND "status" IN ('open', 'dismissed')
              AND "embeddingVec" IS NOT NULL
            ORDER BY distance ASC
            LIMIT 1
          `
        }
```
   And add `"question"` to the **learning** branch SELECT + its row type so `nearest[0]` has a uniform shape:
```ts
        return tx.$queryRaw<Array<{ id: string; status: string; sourceRef: string | null; question: string | null; distance: number }>>`
          SELECT "id", "status", "sourceRef", "question", ("embeddingVec" <=> ${vectorLiteral}::vector(1024)) AS distance
          FROM "agent_memories"
          WHERE "organizationId" = ${params.organizationId}::uuid
            AND "agentId" = ${params.agentId}
            AND "kind" = 'learning'
            AND "sourceRef" = ${params.sourceRef}
            AND "status" IN ('open', 'dismissed')
            AND "embeddingVec" IS NOT NULL
          ORDER BY distance ASC
          LIMIT 1
        `
```

   c. Pass `question` into the decision:
```ts
      const decision = decideMemoryDedup({
        kind: params.kind,
        similarity: match ? 1 - match.distance : -1,
        match: match ? { status: match.status, sourceRef: match.sourceRef, question: match.question } : null,
        requestSourceRef: params.sourceRef ?? null,
        requestQuestion: params.question ?? null,
      })
```

4. **Run passes:** the test file above.

5. **Verify:** `npm run typecheck`. `IS NOT DISTINCT FROM` gives null=null → true, so new-workflow
   suggestions dedup only against other `question=null` rows; `flow:<id>` rows dedup within their own id.

6. **Commit:** `feat(memory): scope suggestion dedup by question namespace`

---

## Task 2 — Gap 4: per-claim source citations for injected learnings

**Problem (grounded).** `renderAgentMemories` (`src/lib/memory/agent-memory.ts` L320-335) emits each
learning as `— ${title}: ${content}` with no provenance. `MemoryHit` carries no `sourceRef`, and the
only source resolver (`resolveSourceLabel`) is a **DB-touching async** function living privately inside
the learnings route. `renderAgentMemories` is **pure/sync** and runs on the agent hot path, so resolution
must happen upstream (batched, best-effort), attaching a short `source` string that the renderer appends.

**Design calls**
- Extract `resolveSourceLabel` into a shared server module `src/lib/intelligence/source-label.ts` and add a
  deduped batch resolver `resolveSourceLabels`. The learnings route (Task 3) reuses it — no duplicate logic.
- `MemoryHit` gains `sourceRef` (populated by `retrieveAgentMemory`) and an optional `source` (resolved by
  the caller). Resolution happens in `execute-agent.ts` on the **budgeted** hit set (≤ a handful), so at most
  a few deduped light queries, never inside the renderer.
- Citation only for `kind:'learning'` (user_answer / suggestion are not scan-sourced).

**Files**
- `src/lib/intelligence/source-label.ts` (NEW)
- `src/app/api/intelligence/learnings/route.ts` (reuse the extracted helper)
- `src/lib/memory/agent-memory.ts` (`MemoryHit`, `retrieveAgentMemory`, `renderAgentMemories`)
- `src/features/agents/execute-agent.ts` (attach `source` before render)
- `src/lib/memory/__tests__/agent-memory.test.ts` (append — pure renderer test)

**Interfaces (exact)**
```ts
// source-label.ts
export async function resolveSourceLabel(organizationId: string, sourceRef: string | null): Promise<string | null>
export async function resolveSourceLabels(organizationId: string, sourceRefs: (string | null)[]): Promise<Map<string, string>>

// agent-memory.ts
export type MemoryHit = {
  id: string; kind: string; title: string; content: string
  question?: string | null; score: number
  sourceRef?: string | null; source?: string | null
}
export function renderAgentMemories(hits: MemoryHit[], latestCritique?: string | null): string
```

### Steps

1. **Failing test** — append to `src/lib/memory/__tests__/agent-memory.test.ts`:
```ts
test('renderAgentMemories: learning with a resolved source is cited', () => {
  const block = renderAgentMemories([
    { id: '1', kind: 'learning', title: 'Deploys on Fridays', content: 'team ships weekly', score: 1, sourceRef: 'klavis:abc', source: 'GitHub' },
  ])
  assert.match(block, /— Deploys on Fridays: team ships weekly \(source: GitHub\)/)
})

test('renderAgentMemories: learning without a source has no citation', () => {
  const block = renderAgentMemories([
    { id: '1', kind: 'learning', title: 'Fact', content: 'body', score: 1, sourceRef: null, source: null },
  ])
  assert.doesNotMatch(block, /\(source:/)
})

test('renderAgentMemories: user_answer is never cited', () => {
  const block = renderAgentMemories([
    { id: '1', kind: 'user_answer', title: 't', content: 'blue', question: 'favorite color?', score: 1, source: 'GitHub' },
  ])
  assert.match(block, /Previously asked/)
  assert.doesNotMatch(block, /\(source:/)
})
```

2. **Run fails:** `…tsx --test src/lib/memory/__tests__/agent-memory.test.ts`.

3. **Minimal impl:**

   a. NEW `src/lib/intelligence/source-label.ts` — move the route's resolver verbatim + add the batch fn:
```ts
/**
 * Best-effort human labels for a memory's sourceRef ("<plane>:<connectionRef>").
 * Shared by the learnings transparency view and the agent-memory citation pass
 * so both resolve provenance identically. DB-touching + server-only; a
 * connection that no longer exists falls back to the plane's generic label
 * rather than failing the caller.
 */
import { prisma } from '@/lib/prisma'
import { parseSourceRef, planeLabel } from '@/lib/intelligence/learnings'
import { fromKlavisAgentType, fromNangoProviderKey } from '@/lib/connectors/registry'
import { DELIVERY_PROVIDERS, type DeliveryCapability } from '@/lib/nango/delivery'

export async function resolveSourceLabel(organizationId: string, sourceRef: string | null): Promise<string | null> {
  const parsed = parseSourceRef(sourceRef)
  if (!parsed) return null
  const { plane, ref } = parsed
  try {
    if (plane === 'mcp') {
      const connection = await prisma.mcpConnection.findFirst({ where: { id: ref, organizationId }, select: { name: true } })
      return connection?.name ?? planeLabel(plane)
    }
    if (plane === 'klavis') {
      const agent = await prisma.mCPAgent.findFirst({ where: { id: ref, organizationId }, select: { agentType: true } })
      return agent ? fromKlavisAgentType(agent.agentType).label : planeLabel(plane)
    }
    if (plane === 'nango') {
      const keys = DELIVERY_PROVIDERS[ref as DeliveryCapability] as readonly string[] | undefined
      if (!keys) return planeLabel(plane)
      const connected = await prisma.nangoConnection.findFirst({
        where: { organizationId, providerConfigKey: { in: [...keys] } },
        select: { providerConfigKey: true },
      })
      return fromNangoProviderKey(connected?.providerConfigKey ?? keys[0]).label
    }
    return planeLabel(plane)
  } catch {
    return planeLabel(plane)
  }
}

/**
 * Deduped batch resolution — N memories sharing one connection cost a single
 * lookup. Best-effort: refs that resolve to null are omitted from the map.
 */
export async function resolveSourceLabels(organizationId: string, sourceRefs: (string | null)[]): Promise<Map<string, string>> {
  const distinct = [...new Set(sourceRefs.filter((r): r is string => Boolean(r)))]
  const map = new Map<string, string>()
  await Promise.all(
    distinct.map(async (ref) => {
      const label = await resolveSourceLabel(organizationId, ref)
      if (label) map.set(ref, label)
    }),
  )
  return map
}
```

   b. `src/app/api/intelligence/learnings/route.ts` — delete the local `resolveSourceLabel` and its now-unused
   imports (`parseSourceRef`, `planeLabel`, `fromKlavisAgentType`, `fromNangoProviderKey`, `DELIVERY_PROVIDERS`,
   `DeliveryCapability`), and import the shared one:
```ts
import { resolveSourceLabel } from '@/lib/intelligence/source-label'
```
   (Keep `findOrgIntelligenceAgentId`, `prisma`, `z`, `ApiError`, `withAuthenticatedApi`.)

   c. `src/lib/memory/agent-memory.ts` — extend `MemoryHit`, select `sourceRef` in both retrieval paths, and
   append the citation in the renderer:
```ts
export type MemoryHit = { id: string; kind: string; title: string; content: string; question?: string | null; score: number; sourceRef?: string | null; source?: string | null }
```
   pgvector path query + map:
```ts
        return tx.$queryRaw<Array<{ id: string; kind: string; title: string; content: string; question: string | null; sourceRef: string | null; distance: number }>>`
          SELECT "id", "kind", "title", "content", "question", "sourceRef",
                 ("embeddingVec" <=> ${vectorLiteral}::vector(1024)) AS distance
          FROM "agent_memories"
          WHERE "organizationId" = ${params.organizationId}::uuid
            AND ${agentPredicate}
            AND "status" = 'open'
            AND "embeddingVec" IS NOT NULL
          ORDER BY distance ASC
          LIMIT ${k}
        `
      })
      return rows.map((row) => ({ id: row.id, kind: row.kind, title: row.title, content: row.content, question: row.question, score: 1 - row.distance, sourceRef: row.sourceRef }))
```
   keyword-fallback path select + map:
```ts
      select: { id: true, kind: true, title: true, content: true, question: true, sourceRef: true },
      orderBy: { createdAt: 'desc' },
      take: AGENT_MEMORY_CAP,
    })
    if (!rows.length) return []
    const scored = rows.map((row) => {
      const text = `${row.title}\n${row.question ?? ''}\n${row.content}`
      return { id: row.id, kind: row.kind, title: row.title, content: row.content, question: row.question, score: keywordScore(params.query, text), sourceRef: row.sourceRef }
    })
```
   renderer:
```ts
export function renderAgentMemories(hits: MemoryHit[], latestCritique?: string | null): string {
  const parts: string[] = []
  if (hits.length) {
    const body = hits
      .map((h) => {
        if (h.kind === 'user_answer' && h.question) return `— Previously asked: "${h.question}" → the user answered: ${h.content}`
        const citation = h.kind === 'learning' && h.source ? ` (source: ${h.source})` : ''
        return `— ${h.title}: ${h.content}${citation}`
      })
      .join('\n')
    parts.push(`## What you've learned (from previous runs)\nApply these remembered facts and lessons; do not re-ask questions the user already answered unless something changed.\n\n${body}`)
  }
  if (latestCritique?.trim()) {
    parts.push(`## Notes to self from last run\n${latestCritique.trim()}`)
  }
  return parts.join('\n\n')
}
```

   d. `src/features/agents/execute-agent.ts` — resolve labels on the budgeted set right before rendering
   (L779-780). Add the import and the two lines:
```ts
import { resolveSourceLabels } from '@/lib/intelligence/source-label'
```
```ts
      const budgetedMemories = contextAssembler.take(memoryHits, (h) => `${h.title}\n${h.content}`, (h) => h.score)
      // Resolve per-learning provenance (best-effort, deduped) so each injected
      // learning can be cited — never blocks the run.
      const sourceLabels = await resolveSourceLabels(organizationId, budgetedMemories.map((h) => h.sourceRef ?? null))
      const citedMemories = budgetedMemories.map((h) => ({ ...h, source: h.sourceRef ? sourceLabels.get(h.sourceRef) ?? null : null }))
      const memoryBlock = renderAgentMemories(citedMemories, critique)
```
   (`markMemoriesUsed(budgetedMemories.map((h) => h.id))` still uses `budgetedMemories` — `citedMemories`
   share the same ids, so leave that line unchanged.)

4. **Run passes:** the renderer test file.

5. **Verify:** `npm run typecheck`. DB resolution is covered by tsc + the existing pure `parseSourceRef`/
   `planeLabel` tests (unchanged); the render behavior by the new pure tests. (Optional: a DB-gated test could
   assert `resolveSourceLabels` dedups, but tsc + reuse of the already-shipped resolver is sufficient.)

6. **Commit:** `feat(memory): cite the source of each injected learning`

---

## Task 3 — Gap 3: edit/correct learnings (PATCH) + admin-gated mutations + inline edit UI

**Problem (grounded).** Parity row 2 is documented-deferred: learnings can be dismissed (soft delete) but not
corrected. Also, the audit flagged that `GET/DELETE /api/intelligence/learnings` have **no admin check**,
unlike sibling org-settings controls (`PATCH /api/organizations` is admin-gated at L49; that route is exactly
what the "Learning" toggle writes through, so a non-admin already can't change scan settings).

**Design call — admin gating.** Admin-gate the **mutations** only: DELETE (retro-fit) and the new PATCH.
Keep GET open (read-only transparency; every member may see what the org learned). Mirror the exact idiom
`if (auth.dbUser.role !== 'ADMIN') throw new ApiError('Admin access required', 403, 'FORBIDDEN')`.

**Design call — durable-dismiss preservation.** PATCH updates `title`/`content` only where `status='open'`
(same `updateMany` scoping DELETE uses). A dismissed row is never edited (invisible + must stay dismissed).
PATCH deliberately does **not** re-embed `embeddingVec` — durable dismiss/dedup key off row identity + status,
which are untouched; the only cost is that a heavily reworded learning's future *similarity* dedup uses the
original text's vector (acceptable, avoids a Voyage call in the request path). Document this.

**Files**
- `src/app/api/intelligence/learnings/route.ts`
- `src/app/settings/learnings-panel.tsx`

**Interfaces (exact)**
```ts
// PATCH body
{ id: string; title?: string; content?: string }   // at least one of title/content required
// PATCH 200 → { success: true, learning: { id, kind, title, content, createdAt, source } }
```

### Steps

1. **Failing test (route wiring via tsc + a pure schema guard).** Route handlers are DB-touching; verify by
   `npm run typecheck` plus a decision-logic test for the "at least one field" refinement. Add
   `src/app/api/intelligence/learnings/__tests__/patch-body.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { patchBodySchema } from '../route'

test('patchBodySchema: rejects a body with neither title nor content', () => {
  assert.equal(patchBodySchema.safeParse({ id: 'x' }).success, false)
})
test('patchBodySchema: accepts title-only, content-only, and both', () => {
  assert.equal(patchBodySchema.safeParse({ id: 'x', title: 'T' }).success, true)
  assert.equal(patchBodySchema.safeParse({ id: 'x', content: 'C' }).success, true)
  assert.equal(patchBodySchema.safeParse({ id: 'x', title: 'T', content: 'C' }).success, true)
})
test('patchBodySchema: rejects an empty id', () => {
  assert.equal(patchBodySchema.safeParse({ id: '', title: 'T' }).success, false)
})
```
   > Next route modules may only export handlers/config, so a bare `export const patchBodySchema` in
   > `route.ts` fails the generated route type check. **Put the schema in a sibling non-route module**
   > `src/app/api/intelligence/learnings/schema.ts` and import it into both `route.ts` and the test
   > (same pattern `template-visibility.ts` uses to stay out of `route.ts`).

2. **Run fails:** `…tsx --test src/app/api/intelligence/learnings/__tests__/patch-body.test.ts`.

3. **Minimal impl:**

   a. NEW `src/app/api/intelligence/learnings/schema.ts`:
```ts
import { z } from 'zod'

export const patchBodySchema = z
  .object({
    id: z.string().min(1),
    title: z.string().trim().min(1).max(200).optional(),
    content: z.string().trim().min(1).max(4000).optional(),
  })
  .refine((b) => b.title !== undefined || b.content !== undefined, { message: 'Nothing to update' })
```

   b. `route.ts` — import the schema + shared resolver, admin-gate DELETE, add PATCH:
```ts
import { patchBodySchema } from './schema'
```
   Prepend to DELETE:
```ts
export const DELETE = withAuthenticatedApi(async (request, auth) => {
  if (auth.dbUser.role !== 'ADMIN') throw new ApiError('Admin access required', 403, 'FORBIDDEN')
  // …unchanged body…
```
   Add PATCH (after DELETE):
```ts
// PATCH — correct a learning's title/content (admin only). Updates the row
// in place where status='open'; never resurrects a dismissed row and never
// re-embeds (durable dismiss/dedup key off row identity + status, both
// untouched).
export const PATCH = withAuthenticatedApi(async (request, auth) => {
  if (auth.dbUser.role !== 'ADMIN') throw new ApiError('Admin access required', 403, 'FORBIDDEN')
  const body = patchBodySchema.parse(await request.json())

  const agentId = await findOrgIntelligenceAgentId(auth.organizationId)
  if (!agentId) throw new ApiError('Learning not found', 404, 'NOT_FOUND')

  const updated = await prisma.agentMemory.updateMany({
    where: { id: body.id, organizationId: auth.organizationId, agentId, status: 'open' },
    data: {
      ...(body.title !== undefined && { title: body.title }),
      ...(body.content !== undefined && { content: body.content }),
    },
  })
  if (updated.count !== 1) throw new ApiError('Learning not found', 404, 'NOT_FOUND')

  const row = await prisma.agentMemory.findFirst({
    where: { id: body.id, organizationId: auth.organizationId, agentId },
    select: { id: true, kind: true, title: true, content: true, sourceRef: true, createdAt: true },
  })
  if (!row) throw new ApiError('Learning not found', 404, 'NOT_FOUND')
  return {
    success: true,
    learning: {
      id: row.id,
      kind: row.kind,
      title: row.title,
      content: row.content,
      createdAt: row.createdAt,
      source: await resolveSourceLabel(auth.organizationId, row.sourceRef),
    },
  }
})
```

   c. `src/app/settings/learnings-panel.tsx` — add inline edit + admin-gated controls. Full replacement:
```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import { Pencil, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useCachedJson } from '@/lib/client/use-cached-json'

type Learning = {
  id: string
  kind: string
  title: string
  content: string
  source: string | null
  createdAt: string
}

function formatDate(value: string): string {
  try {
    return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return value
  }
}

// Rendered on /settings (Workspace tab): the "What Sublime has learned"
// transparency view. Backed by GET/PATCH/DELETE /api/intelligence/learnings.
// Delete is a soft dismiss (durable); edit corrects title/content in place.
// Edit + remove are admin-only (the route mutations are admin-gated).
export function LearningsPanel() {
  const [learnings, setLearnings] = useState<Learning[] | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftContent, setDraftContent] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)

  const { data: profileData } = useCachedJson<{ profile?: { role: string } }>('/api/settings/profile')
  const isAdmin = profileData?.profile?.role === 'ADMIN'

  const load = useCallback(async () => {
    const response = await fetch('/api/intelligence/learnings', { cache: 'no-store' })
    const data = await response.json().catch(() => ({}))
    setLearnings(response.ok && data.success ? data.learnings : [])
  }, [])

  useEffect(() => { void load() }, [load])

  const dismiss = async (id: string) => {
    setDeletingId(id)
    try {
      const response = await fetch(`/api/intelligence/learnings?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) { toast.error(data.error || 'Could not remove learning'); return }
      setLearnings((prev) => (prev ?? []).filter((learning) => learning.id !== id))
      toast.success('Learning removed')
    } finally {
      setDeletingId(null)
    }
  }

  const startEdit = (learning: Learning) => {
    setEditingId(learning.id)
    setDraftTitle(learning.title)
    setDraftContent(learning.content)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setDraftTitle('')
    setDraftContent('')
  }

  const saveEdit = async (id: string) => {
    if (!draftTitle.trim() || !draftContent.trim()) { toast.error('Title and content are required'); return }
    setSavingId(id)
    try {
      const response = await fetch('/api/intelligence/learnings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, title: draftTitle.trim(), content: draftContent.trim() }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) { toast.error(data.error || 'Could not save learning'); return }
      setLearnings((prev) => (prev ?? []).map((l) => (l.id === id ? data.learning : l)))
      toast.success('Learning updated')
      cancelEdit()
    } finally {
      setSavingId(null)
    }
  }

  return (
    <Card className="mt-6 max-w-2xl">
      <CardHeader><CardTitle>What Sublime has learned</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Facts and suggestions distilled from your connected tools. Correct anything that&apos;s off, or remove
          what shouldn&apos;t be remembered — a removed learning won&apos;t resurface.
        </p>
        {learnings === null && (
          <div className="space-y-2">
            <Skeleton className="h-16 rounded-md" />
            <Skeleton className="h-16 rounded-md" />
          </div>
        )}
        {learnings !== null && learnings.length === 0 && (
          <EmptyState
            icon={Sparkles}
            title="Nothing learned yet"
            description="As your team uses connected tools, Sublime distills read-only usage patterns here."
          />
        )}
        {learnings !== null && learnings.length > 0 && (
          <ul className="space-y-2">
            {learnings.map((learning) => (
              <li key={learning.id} className="flex items-start justify-between gap-3 rounded-md border p-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={learning.kind === 'suggestion' ? 'secondary' : 'outline'} className="text-xs capitalize">
                      {learning.kind}
                    </Badge>
                    {learning.source && <span className="text-xs text-muted-foreground">{learning.source}</span>}
                    <span className="text-xs text-muted-foreground">· {formatDate(learning.createdAt)}</span>
                  </div>
                  {editingId === learning.id ? (
                    <div className="space-y-2 pt-1">
                      <Input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} placeholder="Title" className="h-8 text-sm" />
                      <textarea
                        value={draftContent}
                        onChange={(e) => setDraftContent(e.target.value)}
                        placeholder="Content"
                        rows={3}
                        className="w-full rounded-md border bg-background p-2 text-xs"
                      />
                      <div className="flex items-center gap-2">
                        <Button size="sm" className="h-7 text-xs" disabled={savingId === learning.id} onClick={() => saveEdit(learning.id)}>Save</Button>
                        <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={savingId === learning.id} onClick={cancelEdit}>Cancel</Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm font-medium">{learning.title}</p>
                      <p className="line-clamp-2 text-xs text-muted-foreground">{learning.content}</p>
                    </>
                  )}
                </div>
                {editingId !== learning.id && isAdmin && (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      onClick={() => startEdit(learning)}
                      aria-label="Edit learning"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                      disabled={deletingId === learning.id}
                      onClick={() => dismiss(learning.id)}
                      aria-label="Remove learning"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
```
   > If `@/components/ui/input` isn't already the shared control here, confirm the import path; the panel
   > previously imported none. `useCachedJson` and `Input` both already exist in the codebase.

4. **Run passes:** the schema test.

5. **Verify:** `npm run typecheck`. Manually confirm: non-admin sees learnings but no edit/remove controls;
   a non-admin PATCH/DELETE returns 403; editing a learning updates it in place; the durable dismiss still
   hides a removed learning permanently.

6. **Commit:** `feat(intelligence): edit learnings + admin-gate learnings mutations`

---

## Task 4 — Gap 1: wire the Rescan action into the three Learning UIs

**Problem (grounded).** `POST /api/intelligence/rescan` is fully built (owner-checked via
`assertOwnedConnection`, `maxDuration=300`, runs `scanConnection` inline) but has **zero client callers**.

**Rescan request shape (confirmed from the route):**
```ts
{ plane: 'klavis' | 'nango' | 'mcp', connectionRef: string, connectionName: string }
// klavis: connectionRef = mCPAgent.id   (the card's `connection.id`)
// mcp:    connectionRef = mcpConnection.id (`conn.id`)
// nango:  connectionRef = delivery capability (`integration.capability`, e.g. 'slack')
// 200 → { success: true, result: { scanned: true, processes: N } | { skipped: string } }
```

**Design call — admin gate on rescan.** A manual rescan triggers an LLM distillation pass (cost) and mutates
org learnings. Its siblings (the Learning toggle write, Klavis connect/disconnect) are admin-gated, so add the
same gate to the route and only render the control for admins. (Flagged as a reviewer decision — the route was
previously only owner-checked; this is a defense-in-depth tightening consistent with the audit's admin-gating
theme.)

**Files**
- `src/lib/client/use-rescan-connection.ts` (NEW)
- `src/app/api/intelligence/rescan/route.ts` (admin gate)
- `src/components/connections/mcp-servers-panel.tsx`
- `src/components/integrations/mcp-integration-cards.tsx`
- `src/app/integrations/oauth-integrations-grid.tsx`

**Interface (exact)**
```ts
export function useRescanConnection(): {
  rescan: (params: { plane: ScanPlane; connectionRef: string; connectionName: string }) => Promise<boolean>
  rescanningRef: string | null
}
```

### Steps

1. **Failing test (route admin gate — verify by tsc; hook is client I/O).** No new pure logic; the hook is a
   thin fetch wrapper and the route change is one line. Verification is `npm run typecheck` + manual drive.
   (Skip an isolated unit test here — there is no branchless pure decision to extract; the plan's other tasks
   carry the pure-test coverage.)

2. **Impl — route admin gate.** In `src/app/api/intelligence/rescan/route.ts`, prepend to `POST`:
```ts
export const POST = withAuthenticatedApi(async (request, auth) => {
  if (auth.dbUser.role !== 'ADMIN') throw new ApiError('Admin access required', 403, 'FORBIDDEN')
  const { plane, connectionRef, connectionName } = bodySchema.parse(await request.json())
  // …unchanged…
```

3. **Impl — hook** `src/lib/client/use-rescan-connection.ts`:
```ts
'use client'

import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import type { ScanPlane } from '@/lib/intelligence/scan-exclusions'

/**
 * Fire the manual per-connection Rescan (POST /api/intelligence/rescan). The
 * scan runs inline server-side (maxDuration 300) so the caller awaits the
 * distilled result and can surface it. `rescanningRef` is the connectionRef of
 * the in-flight rescan (for per-row spinners). Admin-only server-side.
 */
export function useRescanConnection() {
  const [rescanningRef, setRescanningRef] = useState<string | null>(null)

  const rescan = useCallback(
    async (params: { plane: ScanPlane; connectionRef: string; connectionName: string }): Promise<boolean> => {
      setRescanningRef(params.connectionRef)
      try {
        const response = await fetch('/api/intelligence/rescan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok || !data.success) {
          toast.error(data.error || 'Rescan failed')
          return false
        }
        const result = data.result as { scanned?: boolean; processes?: number; skipped?: string } | undefined
        if (result?.scanned) {
          const n = result.processes ?? 0
          toast.success(`Learned ${n} process${n === 1 ? '' : 'es'} from ${params.connectionName}`)
        } else {
          toast.info(`Nothing new to learn from ${params.connectionName}${result?.skipped ? ` (${result.skipped})` : ''}`)
        }
        return true
      } catch {
        toast.error('Rescan failed')
        return false
      } finally {
        setRescanningRef(null)
      }
    },
    [],
  )

  return { rescan, rescanningRef }
}
```

4. **Impl — MCP servers panel** (`src/components/connections/mcp-servers-panel.tsx`). Import the hook and add a
   Rescan button in the Learning row (only for `conn.provider` connections whose `id` exists — the scan plane
   only samples provider-backed rows; a plain custom MCP server also has an `id` and is plane `'mcp'`, so wire
   it for every connection with an id). Add:
```tsx
import { RefreshCw } from 'lucide-react'
import { useRescanConnection } from '@/lib/client/use-rescan-connection'
```
   In `McpServersPanelInner`: `const { rescan, rescanningRef } = useRescanConnection()`. Replace the Learning
   row (the last `<div className="flex items-center justify-between gap-2 border-t pt-3">`):
```tsx
                <div className="flex items-center justify-between gap-2 border-t pt-3">
                  <span className="text-xs text-muted-foreground">Learning</span>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      disabled={rescanningRef === conn.id}
                      onClick={() => rescan({ plane: 'mcp', connectionRef: conn.id, connectionName: conn.name })}
                    >
                      <RefreshCw className={rescanningRef === conn.id ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
                      Rescan
                    </Button>
                    <Switch
                      checked={isLearningEnabled(connectionSourceRef('mcp', conn.id))}
                      disabled={togglingLearningId === conn.id}
                      onCheckedChange={(enabled) => toggleLearning(conn, enabled)}
                      aria-label={isLearningEnabled(connectionSourceRef('mcp', conn.id)) ? 'Disable learning from this server' : 'Enable learning from this server'}
                    />
                  </div>
                </div>
```

5. **Impl — Klavis cards** (`src/components/integrations/mcp-integration-cards.tsx`). Add:
```tsx
import { RefreshCw } from 'lucide-react'   // add to the existing lucide import
import { useRescanConnection } from '@/lib/client/use-rescan-connection'
```
   In `MCPIntegrationCards`: `const { rescan, rescanningRef } = useRescanConnection()`. Replace the
   `connection.id` Learning block:
```tsx
                {connection.id && (
                  <div className="flex items-center justify-between gap-2 border-t pt-3">
                    <span className="text-xs text-gray-500">Learning</span>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        disabled={rescanningRef === connection.id}
                        onClick={() => rescan({ plane: 'klavis', connectionRef: connection.id!, connectionName: connection.provider })}
                      >
                        <RefreshCw className={rescanningRef === connection.id ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
                        Rescan
                      </Button>
                      <Switch
                        checked={isLearningEnabled(connectionSourceRef('klavis', connection.id))}
                        disabled={togglingLearning === connection.provider}
                        onCheckedChange={(enabled) => toggleLearning(connection, enabled)}
                        aria-label={isLearningEnabled(connectionSourceRef('klavis', connection.id)) ? 'Disable learning from this connection' : 'Enable learning from this connection'}
                      />
                    </div>
                  </div>
                )}
```
   > Note: the Strata catalogue view (`StrataCatalogue`) short-circuits before these per-provider cards and
   > has no per-connection `id`, so Rescan is intentionally absent there — Strata tools are account-level, not
   > a single scannable connection.

6. **Impl — Nango grid** (`src/app/integrations/oauth-integrations-grid.tsx`). Add:
```tsx
import { CheckCircle2, RefreshCw } from 'lucide-react'   // RefreshCw already imported for refreshAll; reuse
import { useRescanConnection } from '@/lib/client/use-rescan-connection'
```
   `const { rescan, rescanningRef } = useRescanConnection()`. In the connected+capability Learning block, add a
   Rescan button gated on `isAdmin` (the grid already computes `isAdmin`):
```tsx
                {connection?.connected && integration.capability && (
                  <div className="flex items-center justify-between gap-2 border-t pt-3">
                    <span className="text-xs text-muted-foreground">Learning</span>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        disabled={!isAdmin || rescanningRef === integration.capability}
                        onClick={() => rescan({ plane: 'nango', connectionRef: integration.capability!, connectionName: integration.name })}
                      >
                        <RefreshCw className={rescanningRef === integration.capability ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
                        Rescan
                      </Button>
                      <Switch
                        checked={isLearningEnabled(connectionSourceRef('nango', integration.capability))}
                        disabled={togglingLearningId === integration.id || !isAdmin}
                        onCheckedChange={(enabled) => toggleLearning(integration, enabled)}
                        aria-label={
                          isLearningEnabled(connectionSourceRef('nango', integration.capability))
                            ? 'Disable learning from this connection'
                            : 'Enable learning from this connection'
                        }
                      />
                    </div>
                  </div>
                )}
```

7. **Run passes / Verify:** `npm run typecheck`. Manual drive: as admin, click Rescan on each surface → toast
   reports processes learned or a skip reason; as non-admin, rescan returns 403 (and the control is hidden/disabled
   after Task 5).

8. **Commit:** `feat(intelligence): wire manual Rescan into the connection Learning UIs`

---

## Task 5 — Gap 6a: client-disable the non-admin Learning toggle (Klavis + MCP surfaces)

**Problem (grounded).** The Nango grid already does `disabled={!isAdmin}` on its Learning switch (it fetches
role via `GET /api/settings/profile`). The Klavis cards (`mcp-integration-cards.tsx`) and MCP-servers panel
(`mcp-servers-panel.tsx`) do **not** gate on role, even though the underlying write
(`PATCH /api/organizations`) is admin-only — so a non-admin sees an enabled toggle that always fails.

**Design call.** Mirror the Nango grid exactly: resolve `isAdmin` from `GET /api/settings/profile` via
`useCachedJson` (not `useAuth`) so all three surfaces derive admin identically. Disable the Learning switch
(and the Rescan button from Task 4) for non-admins.

**Files**
- `src/components/integrations/mcp-integration-cards.tsx`
- `src/components/connections/mcp-servers-panel.tsx`

### Steps

1. **Verify approach:** no pure logic — `npm run typecheck` + manual drive is the verification.

2. **Impl — Klavis cards.** `useCachedJson` is already imported. In `MCPIntegrationCards`:
```tsx
  const { data: profileData } = useCachedJson<{ profile?: { role: string } }>('/api/settings/profile')
  const isAdmin = profileData?.profile?.role === 'ADMIN'
```
   Update the Learning `Switch` and Rescan `Button` disabled props:
```tsx
                      <Button … disabled={!isAdmin || rescanningRef === connection.id} … />
                      <Switch … disabled={!isAdmin || togglingLearning === connection.provider} … />
```

3. **Impl — MCP servers panel.** Add the import + role resolution:
```tsx
import { useCachedJson } from '@/lib/client/use-cached-json'
```
```tsx
  const { data: profileData } = useCachedJson<{ profile?: { role: string } }>('/api/settings/profile')
  const isAdmin = profileData?.profile?.role === 'ADMIN'
```
   Update the Learning `Switch` and Rescan `Button`:
```tsx
                    <Button … disabled={!isAdmin || rescanningRef === conn.id} … />
                    <Switch … disabled={!isAdmin || togglingLearningId === conn.id} … />
```

4. **Verify:** `npm run typecheck`. Manual: a non-admin sees the Learning toggle + Rescan disabled on all three
   surfaces.

5. **Commit:** `fix(intelligence): disable non-admin Learning controls on Klavis/MCP surfaces`

---

## Task 6 — Gap 2: auto re-scan OAuth Klavis connections on `pending_auth → active`

**Problem (grounded).** OAuth-based Klavis providers are created `pending_auth` (`isActive:false`), so the
post-create scan in `POST /api/mcp/connections` (`route.ts` L75-94, gated on `status!=='error' && created`)
runs before auth — `loadScanGroup` finds no tools → `scanConnection` returns `{ skipped:'no-tools' }` — and
nothing re-scans after the user completes OAuth. So OAuth Klavis connections **never** produce learnings.

**Seam (the key design call).** The only place a Klavis connection's live status is refreshed is
`getConnectionStatuses` in `src/lib/mcp/server-provisioning.ts` (L160-226): per connection it reads the
persisted `metadata.status` (the *previous* status), then hits Klavis live, recomputes `status` +
`tools`, and `saveConnection`s the new status. That is exactly the `pending_auth → active` edge. Mirror the
Nango pattern precisely:

- Add a **pure** `shouldScanKlavisConnection(previous, nowActive, hasTools)` to `connection-scan.ts` (sibling of
  `shouldScanNangoConnection`).
- Capture `previousStatus` *before* the live fetch overwrites `status`, and call the pure fn in the map. Surface
  newly-active connections to the caller via an optional `onNewlyActive` callback (keeps the lib decoupled from
  `after()`, exactly as the Nango status route fires scans in the route, not the lib).
- `GET /api/mcp/connections` collects the callback's hits and fires `after(() => scanConnection(... plane:'klavis' ...))`.

**Why no double-scan:** a non-OAuth provider is persisted `active` at create time, so on the first
`getConnectionStatuses` its `previousStatus==='active'` → `shouldScanKlavisConnection` returns false (it was
already scanned in POST on `created`). Only a genuine `pending_auth/error → active` (with tools) fires. A
concurrent-GET race could double-fire, but learnings dedup by `sourceRef`, so at worst `timesUsed` bumps.
The 30s pending-cache bounds the post-OAuth latency before the next live refresh detects the flip.

**Files**
- `src/lib/intelligence/connection-scan.ts` (pure fn)
- `src/lib/mcp/server-provisioning.ts` (`getConnectionStatuses` seam)
- `src/app/api/mcp/connections/route.ts` (fire `after()` scans on GET)
- `src/lib/intelligence/__tests__/connection-scan.test.ts` (append)

**Interfaces (exact)**
```ts
// connection-scan.ts
export const KLAVIS_ACTIVE_STATUS = 'active'
export function shouldScanKlavisConnection(previous: { status: string } | undefined, nowActive: boolean, hasTools: boolean): boolean

// server-provisioning.ts
export async function getConnectionStatuses(
  organizationId: string,
  userId: string,
  onNewlyActive?: (info: { connectionRef: string; connectionName: string }) => void,
): Promise<ConnectionStatusInfo[]>
```

### Steps

1. **Failing test** — append to `src/lib/intelligence/__tests__/connection-scan.test.ts`:
```ts
import { shouldScanKlavisConnection } from '../connection-scan'   // add to the existing import line

test('shouldScanKlavisConnection: no prior status, now active with tools -> true', () => {
  assert.equal(shouldScanKlavisConnection(undefined, true, true), true)
})
test('shouldScanKlavisConnection: prior pending_auth, now active with tools -> true', () => {
  assert.equal(shouldScanKlavisConnection({ status: 'pending_auth' }, true, true), true)
})
test('shouldScanKlavisConnection: prior error, now active with tools -> true', () => {
  assert.equal(shouldScanKlavisConnection({ status: 'error' }, true, true), true)
})
test('shouldScanKlavisConnection: already active, still active -> false', () => {
  assert.equal(shouldScanKlavisConnection({ status: 'active' }, true, true), false)
})
test('shouldScanKlavisConnection: active but no tools -> false', () => {
  assert.equal(shouldScanKlavisConnection({ status: 'pending_auth' }, true, false), false)
})
test('shouldScanKlavisConnection: not active -> false regardless of history/tools', () => {
  assert.equal(shouldScanKlavisConnection(undefined, false, true), false)
  assert.equal(shouldScanKlavisConnection({ status: 'pending_auth' }, false, true), false)
})
```

2. **Run fails:** `…tsx --test src/lib/intelligence/__tests__/connection-scan.test.ts`.

3. **Minimal impl — pure fn** in `src/lib/intelligence/connection-scan.ts` (place next to
   `shouldScanNangoConnection`):
```ts
/** A Klavis connection is "active" (usable) for scan-triggering purposes. */
export const KLAVIS_ACTIVE_STATUS = 'active'

/**
 * Pure: decide whether a Klavis connection should trigger a usage scan on this
 * status refresh, keyed off the STATUS TRANSITION into active (mirrors
 * shouldScanNangoConnection). OAuth providers are created pending_auth and only
 * gain tools after the user authorizes, so scan the first time we observe them
 * active WITH tools. A connection already active on the prior refresh (its
 * post-create scan already ran, or a previous transition already fired) never
 * re-triggers; an inactive or tool-less connection never triggers.
 */
export function shouldScanKlavisConnection(previous: { status: string } | undefined, nowActive: boolean, hasTools: boolean): boolean {
  if (!nowActive || !hasTools) return false
  if (!previous) return true
  return previous.status !== KLAVIS_ACTIVE_STATUS
}
```

4. **Run passes:** the connection-scan test file.

5. **Impl — seam** in `src/lib/mcp/server-provisioning.ts`:

   a. Add imports at the top:
```ts
import { purgeConnectionLearnings, shouldScanKlavisConnection } from '@/lib/intelligence/connection-scan'
import { fromKlavisAgentType } from '@/lib/connectors/registry'
```
   (extend the existing `purgeConnectionLearnings` import).

   b. Change the signature + capture `previousStatus` + call the pure fn in the map. Update
   `getConnectionStatuses`:
```ts
export async function getConnectionStatuses(
  organizationId: string,
  userId: string,
  onNewlyActive?: (info: { connectionRef: string; connectionName: string }) => void,
): Promise<ConnectionStatusInfo[]> {
  const cacheKey = mcpStatusKey(organizationId, userId)
  const cached = await cacheGet<ConnectionStatusInfo[]>(cacheKey)
  if (cached) return cached
```
   Inside the `connections.map(async (connection) => …)` body, replace the `let status = …` line with a
   captured previous + mutable current, and add the transition check after the live block:
```ts
      const metadata = (connection.metadata as Record<string, any> | null) || {}
      const previousStatus = (metadata.status || (connection.isActive ? 'active' : 'pending_auth')) as ConnectionStatus
      let status = previousStatus
      let oauthUrl = metadata.oauthUrl as string | undefined
      let toolCount: number | undefined
      let tools: McpToolInfo[] | undefined = Array.isArray(metadata.tools) ? metadata.tools : undefined

      if (klavis && metadata.instanceId) {
        try {
          const server = await klavis.getServerStatus(metadata.instanceId)
          status = connectionStatus(server)
          oauthUrl = server.oauthUrl
          if (status === 'active' && connection.mcpServerUrl) {
            const fetched = (await klavis.getServerTools(connection.mcpServerUrl)) as McpToolInfo[]
            tools = fetched.map((tool) => ({ name: tool.name, description: tool.description }))
            toolCount = tools.length
          }
          await saveConnection(provider, userId, organizationId, {
            ...server,
            serverUrl: server.serverUrl ?? connection.mcpServerUrl,
          }, tools)
        } catch {
          status = 'error'
        }
      }

      if (tools && toolCount === undefined) toolCount = tools.length
      // Fire a one-time usage scan when a connection first becomes active WITH
      // tools (e.g. an OAuth provider the user just authorized) — the
      // post-create scan ran while it was still pending_auth (no tools). The
      // caller runs the actual scan via after() so it survives the response.
      if (onNewlyActive && shouldScanKlavisConnection({ status: previousStatus }, status === 'active', (tools?.length ?? 0) > 0)) {
        onNewlyActive({ connectionRef: connection.id, connectionName: fromKlavisAgentType(connection.agentType).label })
      }
      return { provider, status, oauthUrl, toolCount, tools, id: connection.id }
```

6. **Impl — route** `src/app/api/mcp/connections/route.ts` GET. Add `after` import and fire scans:
```ts
import { after } from 'next/server'   // already imported at top
```
```ts
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const organizationId = auth.organizationId
  const userId = auth.dbUser.id
  const newlyActive: { connectionRef: string; connectionName: string }[] = []
  const statuses = await getConnectionStatuses(organizationId, userId, (info) => newlyActive.push(info))
  const byProvider = new Map(statuses.map((status) => [status.provider, status]))
  const connections = PROVIDERS.map((provider) => {
    const status = byProvider.get(provider)
    const capability = PROVIDER_CAPABILITIES[provider]
    return {
      provider,
      id: status?.id,
      status: status?.status || 'not_connected',
      oauthUrl: status?.oauthUrl,
      toolCount: status?.toolCount,
      capabilities: capability,
      tools: status?.tools?.length ? status.tools : capability.tools,
    }
  })

  // Fire-and-forget usage scans for connections that just became active-with-
  // tools (e.g. OAuth Klavis providers the user just authorized). `after`
  // (Next 15) keeps them running past the response on serverless; scanConnection
  // dedups by sourceRef so a concurrent double-fire is harmless.
  if (newlyActive.length > 0) {
    after(() =>
      Promise.all(
        newlyActive.map((info) =>
          scanConnection({ organizationId, userId, plane: 'klavis', connectionRef: info.connectionRef, connectionName: info.connectionName }),
        ),
      ).catch(() => undefined),
    )
  }

  return { success: true, connections }
})
```
   (`scanConnection` is already imported in this route; `after` is already imported.)

7. **Verify:** `npm run typecheck` + the connection-scan test. Manual/staging: connect an OAuth Klavis
   provider → complete OAuth → reload the integrations page after the pending cache expires (≤30s) → a
   `intelligence.scan` notification appears and learnings show up under `/settings`.

8. **Commit:** `feat(intelligence): auto re-scan OAuth Klavis connections on activation`

---

## Task 7 — Gap 5: per-org template pagination (never lose your own template)

**Problem (grounded).** `GET /api/agent-templates` fetches the **500 most-recently-updated templates
globally** (`systemPrisma.agentTemplate.findMany({ where:{isActive:true}, orderBy:{updatedAt:'desc'}, take:500 })`),
then `selectVisibleTemplates` filters cross-org auto-generated rows in memory. At scale, an org's own older
auto-generated template can fall outside the global 500 window and vanish from that org's own catalogue.

**Design call.** Fetch the caller's **own** templates in full (org-scoped, `prisma`), and merge with a
**community window** (`systemPrisma`, `organizationId: { not: caller }`, `take:500`). The org can never lose
its own row to the recency cutoff, and the community query excludes the caller's org so it can't duplicate or
crowd out own rows. Harden `selectVisibleTemplates` with an id-dedup (defensive; keeps mine-first order).

**Files**
- `src/app/api/agent-templates/route.ts`
- `src/lib/intelligence/template-visibility.ts`
- `src/lib/intelligence/__tests__/template-visibility.test.ts` (append)

**Interface (exact)**
```ts
export function selectVisibleTemplates<T extends { id: string; mine: boolean; autoGenerated: boolean }>(
  rows: T[],
  extraCommunity?: T[],
): T[]
```

### Steps

1. **Failing test** — append to `src/lib/intelligence/__tests__/template-visibility.test.ts`:
```ts
test('selectVisibleTemplates: keeps an org-own row even when the community window omits it', () => {
  // Simulates the fix: the org's own (older, auto-generated) template arrives
  // in `rows` via the full own-set query, not the truncated community window.
  const own = { id: 'mine-old', mine: true, autoGenerated: true }
  const community = [
    { id: 'c1', mine: false, autoGenerated: false },
    { id: 'c2', mine: false, autoGenerated: false },
  ]
  const out = selectVisibleTemplates([own, ...community])
  assert.deepEqual(out.map((t) => t.id), ['mine-old', 'c1', 'c2'])
})

test('selectVisibleTemplates: dedupes by id, keeping the first (mine-first) occurrence', () => {
  const rows = [
    { id: 'dup', mine: true, autoGenerated: false },
    { id: 'dup', mine: false, autoGenerated: false },
    { id: 'other', mine: false, autoGenerated: false },
  ]
  const out = selectVisibleTemplates(rows)
  assert.deepEqual(out.map((t) => t.id), ['dup', 'other'])
})
```

2. **Run fails:** `…tsx --test src/lib/intelligence/__tests__/template-visibility.test.ts`.

3. **Minimal impl — `template-visibility.ts`** (add `id` to the constraint + dedup):
```ts
export function selectVisibleTemplates<T extends { id: string; mine: boolean; autoGenerated: boolean }>(rows: T[], extraCommunity: T[] = []): T[] {
  const visible = rows.filter((t) => !t.autoGenerated || t.mine)
  const mine = visible.filter((t) => t.mine)
  const community = [...extraCommunity, ...visible.filter((t) => !t.mine)]
  const ordered = [...mine, ...community]
  // Defensive id-dedup (own + community are disjoint by org filter, but a
  // built-in or future overlap must not double-list). Keep first occurrence,
  // so a caller's own copy always wins over a community duplicate.
  const seen = new Set<string>()
  const deduped: T[] = []
  for (const t of ordered) {
    if (seen.has(t.id)) continue
    seen.add(t.id)
    deduped.push(t)
  }
  return deduped
}
```

4. **Run passes:** the template-visibility test file (existing tests still pass — they already pass `id`? If
   the existing fixtures lack `id`, add `id: '<name>'` to each — mechanical).

5. **Impl — route** `src/app/api/agent-templates/route.ts` GET. Add constants + split queries:
```ts
// The caller's own templates are fetched in full (org-scoped) so a global
// recency cutoff can never drop an org's own older auto-generated template.
const OWN_TEMPLATE_CAP = 1000
// Recency window over everyone else's templates (the shared community library).
const COMMUNITY_TEMPLATE_WINDOW = 500

export const GET = withAuthenticatedApi(async (request, auth) => {
  const [ownRows, communityRows] = await Promise.all([
    // Org-scoped (prisma/RLS): the caller's entire catalogue, never truncated
    // by the community window.
    prisma.agentTemplate.findMany({
      where: { isActive: true, organizationId: auth.organizationId },
      orderBy: { updatedAt: 'desc' },
      take: OWN_TEMPLATE_CAP,
    }),
    // Cross-org read by design (systemPrisma) — same exemption as /api/skills
    // GET. Excludes the caller's own org so it can't duplicate ownRows or crowd
    // the window. Auto-generated rows from other orgs are dropped by
    // selectVisibleTemplates (they never leak cross-org).
    systemPrisma.agentTemplate.findMany({
      where: { isActive: true, organizationId: { not: auth.organizationId } },
      orderBy: { updatedAt: 'desc' },
      take: COMMUNITY_TEMPLATE_WINDOW,
    }),
  ])
  const serialized = [...ownRows, ...communityRows].map((t) => serializeTemplate(t, auth.organizationId))
  const builtIns = builtInTemplates.map((t) => ({ ...t, id: String(t.id ?? ''), custom: false, mine: false, autoGenerated: false }))
  const templates = selectVisibleTemplates(serialized, builtIns)
  const limit = Number(request.nextUrl.searchParams.get('limit'))
  return { success: true, templates: limit > 0 ? templates.slice(0, limit) : templates }
})
```
   (`prisma` and `systemPrisma` are both already imported.)

6. **Verify:** `npm run typecheck` + the template-visibility tests. The cross-org query filters
   `organizationId: { not: caller }`, preserving no-cross-tenant-leak (auto-generated other-org rows are still
   additionally dropped by `selectVisibleTemplates`).

7. **Commit:** `fix(templates): fetch an org's own templates in full, community as a window`

---

## Task 8 — Gap 6c: remove the orphaned `insight:mem:<id>` graph node

**Problem (grounded).** In `suggest-workflows.ts`, when a just-saved suggestion's draft-flow generation fails
(the `!validation.ok` branch ~L393 and the `catch` branch ~L420), the code deletes the `AgentMemory` row
(`prisma.agentMemory.delete(...)`) but **not** the graph node `saveAgentMemory` indexed for it
(`insight:mem:<id>`, written by `indexAgentMemory`). That node is orphaned and can resurface in graph
retrieval. Remove it best-effort.

**Design call.** Add `nodeIds.insightMem` and `removeAgentMemoryFromGraph` to the indexer (mirroring
`removeExecutionFromGraph`), have `indexAgentMemory` use the shared id helper (so index/remove can't drift),
and call the remover after both deletes. The remover self-gates on `graphRagPersistent()` (deleteNodes is only
meaningful for the persistent store — same gate as every sibling `remove*` fn); the call site is inside the
already-backgrounded synthesis, so it is inherently best-effort and `.catch`-guarded.

**Files**
- `src/lib/rag/indexer.ts`
- `src/lib/intelligence/suggest-workflows.ts`
- `src/lib/rag/__tests__/indexer.test.ts` (append — pure id helper)

**Interface (exact)**
```ts
export const nodeIds: { …; insightMem: (id: string) => string }
export async function removeAgentMemoryFromGraph(organizationId: string, memoryId: string): Promise<void>
```

### Steps

1. **Failing test** — append to `src/lib/rag/__tests__/indexer.test.ts`:
```ts
import { nodeIds } from '../indexer'   // add near the top imports

test('nodeIds.insightMem builds the stable insight:mem:<id> key', () => {
  assert.equal(nodeIds.insightMem('abc'), 'insight:mem:abc')
})
```

2. **Run fails:** `…tsx --test src/lib/rag/__tests__/indexer.test.ts`.

3. **Minimal impl — `indexer.ts`:**

   a. Add to the `nodeIds` map:
```ts
export const nodeIds = {
  account: (id: string) => `account:${id}`,
  opportunity: (id: string) => `opp:${id}`,
  stakeholder: (id: string) => `stakeholder:${id}`,
  signal: (id: string) => `signal:${id}`,
  run: (id: string) => `run:${id}`,
  agent: (id: string) => `agent:${id}`,
  insightMem: (id: string) => `insight:mem:${id}`,
}
```

   b. Use it in `indexAgentMemory` (replace the literal):
```ts
    const nodeId = nid.insightMem(params.memoryId)
```

   c. Add the remover (next to `removeExecutionFromGraph`):
```ts
/**
 * Remove an agent-memory insight node when its AgentMemory row is deleted
 * (e.g. suggest-workflows discarding a suggestion whose draft flow failed to
 * generate), so the orphaned node can't resurface in retrieval. Id must match
 * indexAgentMemory's scheme (`insight:mem:<id>`). Best-effort; only meaningful
 * for the persistent (Neo4j) store.
 */
export async function removeAgentMemoryFromGraph(organizationId: string, memoryId: string): Promise<void> {
  if (!graphRagPersistent()) return
  try {
    await getGraphRagStore().deleteNodes(organizationId, [nid.insightMem(memoryId)])
  } catch (error) {
    warn('removeAgentMemoryFromGraph', error)
  }
}
```

4. **Run passes:** the indexer test file.

5. **Impl — `suggest-workflows.ts`:**

   a. Add the import:
```ts
import { removeAgentMemoryFromGraph } from '@/lib/rag/indexer'
```

   b. After each `prisma.agentMemory.delete({ where: { id: saved.id, organizationId } }).catch(() => undefined)`
   (both the `!validation.ok` branch and the `catch` branch), add:
```ts
            await prisma.agentMemory.delete({ where: { id: saved.id, organizationId } }).catch(() => undefined)
            void removeAgentMemoryFromGraph(organizationId, saved.id).catch(() => undefined)
```
   (Apply to both delete sites.)

6. **Verify:** `npm run typecheck` + the indexer test. `removeAgentMemoryFromGraph` no-ops cleanly when RAG is
   not persistent, matching every sibling `remove*` fn.

7. **Commit:** `fix(intelligence): remove orphaned graph node when discarding a suggestion memory`

---

## Cross-cutting verification (run before declaring done)

```bash
npm run typecheck
npm test          # all pure node:test suites; DB-gated files self-skip without TEST_DATABASE_URL
npm run lint
```

Focused pure suites added/extended by this plan:
```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
  src/lib/memory/__tests__/agent-memory.test.ts \
  src/lib/intelligence/__tests__/connection-scan.test.ts \
  src/lib/intelligence/__tests__/template-visibility.test.ts \
  src/lib/rag/__tests__/indexer.test.ts \
  src/app/api/intelligence/learnings/__tests__/patch-body.test.ts
```

DB-touching routes (learnings PATCH/DELETE, rescan gate, mcp/connections GET scan, agent-templates queries) are
verified by `tsc` + the pure decision tests above; drive them manually or via a DB-gated route smoke test
(`setTestAuthContext` + `TEST_DATABASE_URL`, per `src/app/api/__tests__/route-smoke.test.ts`) if a live DB is
available.

## Notes / places the real code makes a gap harder or different than expected

1. **Klavis re-scan seam is a GET with side effects.** There is no mutation endpoint that observes the
   `pending_auth → active` flip — it happens inside `getConnectionStatuses`, called from the *GET* cards route.
   Firing a scan from a GET is unusual but is the **exact** established pattern the Nango status GET route uses
   (`after(() => scanConnection(...))`), so this is consistent, not novel. Post-OAuth latency is bounded by the
   30s pending-status cache; a concurrent-GET double-fire is harmless (learnings dedup by `sourceRef`).
2. **`resolveSourceLabel` had to be extracted** — it lived privately in the learnings route and is DB-async,
   but `renderAgentMemories` is pure/sync on the hot path. Resolution therefore happens in `execute-agent.ts`
   on the *budgeted* hit set (deduped, best-effort), not inside the renderer, and not inside `retrieveAgentMemory`
   (keeps retrieval's concern narrow).
3. **Learnings PATCH deliberately does not re-embed.** Durable dismiss/dedup key off row identity + `status`
   (untouched); re-embedding would add a Voyage call to the request path for marginal future-similarity benefit.
   Documented tradeoff.
4. **Admin-gating decision (confirmed against real siblings).** The Learning toggle already writes through
   `PATCH /api/organizations`, which is admin-gated (route L49); `mcp/connections` POST/DELETE are admin-gated.
   So: admin-gate learnings **DELETE + new PATCH** and the **rescan POST**; keep learnings **GET** open. The
   rescan-route admin gate is a *new* tightening (it was previously only owner-checked) — flagged for the
   reviewer, but it is the consistent choice.
5. **Suggestion dedup needs the fix at two layers.** Scoping only the pure `decideMemoryDedup` is insufficient:
   if the SQL nearest-neighbor isn't also scoped by `question`, the "nearest" row can be a different-namespace
   suggestion that's closer than the true same-namespace duplicate, so the real duplicate is missed. The
   `IS NOT DISTINCT FROM` predicate handles the `question=null` (new-workflow) case correctly.
6. **`selectVisibleTemplates` generic gains an `id` constraint.** Existing callers/fixtures that lack `id` must
   add it (`builtInTemplates` is empty so its map just needs `id: String(t.id ?? '')`; test fixtures need an
   `id` field). The real fix is the route's own-full + community-window query split; the pure test proves the
   merge preserves an org's own row and dedupes.
7. **Graph-node gate wording.** The task says "gated on `ragEnabled`", but every sibling `remove*` graph fn
   gates on `graphRagPersistent()` (deletes only matter for the persistent store; the in-memory store is
   per-request ephemeral). `removeAgentMemoryFromGraph` follows the sibling convention — `graphRagPersistent()`
   is the correct, consistent gate and subsumes the intent.
8. **Strata view has no Rescan.** The Klavis cards route through `StrataCatalogue` when a Strata connection
   exists; those tools are account-level with no single scannable connection id, so Rescan is correctly absent
   there (only the legacy per-provider cards, which carry a `connection.id`, get it).
