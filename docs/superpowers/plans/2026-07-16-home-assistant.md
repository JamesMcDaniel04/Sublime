# Home Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Home tab with a workspace-level AI assistant at `/dashboard` (converts assignments into agents via clarifying-question chat, creates/executes agents, oversees the workspace) and move Agent HQ to a new **Agents** tab at `/agents`.

**Architecture:** Structured single-call assistant mirroring the per-agent chat pattern: one `generateStructured` call per message returning `{ reply, agentDraft, action }`. Agent creation reuses the exact normalization + connector-sync logic of `/api/agents/draft`, extracted into a shared helper. New Prisma models persist workspace-level chat sessions. Agent HQ (`src/app/dashboard/`) moves wholesale to `src/app/agents/`; the new `/dashboard` page redirects legacy `?agent=|run=|view=` deep links to `/agents`.

**Tech Stack:** Next.js 15 App Router, Prisma, `generateStructured` (`src/lib/llm/model-runner`), zod, node:test.

**Spec:** `docs/superpowers/specs/2026-07-16-home-assistant-design.md`

## Global Constraints

- Chat message max 4,000 chars; attachment text capped at 24,000 chars; uploads max 10 MB.
- Rate limits: chat 30/min per user, extract 20/min per user (existing `rateLimit` helper).
- Every assistant call checks `checkMonthlyTokenBudget(auth.organizationId)` and records ~chars/4 usage via `recordTokenUsage`.
- House copy style: concise markdown, sentence case, no emoji in assistant output.
- All new API routes use `withAuthenticatedApi` + `ApiError` (never bare `Response`), and every DB read is scoped by `organizationId` (+ `userId` where per-rep).
- Tests use `node:test` (`import { test } from 'node:test'`; `assert` from `node:assert/strict`). DB-backed tests are gated behind `process.env.TEST_DATABASE_URL` exactly like `src/app/api/__tests__/route-smoke.test.ts`.
- Run tests with `npm test`, types with `npm run typecheck`, lint with `npm run lint`.
- Commit after every task with a `feat:`/`refactor:`/`test:` message ending in the Claude co-author trailer.

---

### Task 1: Prisma models for assistant chat

**Files:**
- Modify: `prisma/schema.prisma` (append after `model AgentChatSession` block, ~line 240)

**Interfaces:**
- Produces: `prisma.assistantChatSession`, `prisma.assistantChatMessage` Prisma clients used by Tasks 4–5. Session fields: `id, organizationId, userId, title?, createdAt, updatedAt`. Message fields: `id, organizationId, userId, sessionId, role, content, metadata?, createdAt`.

- [ ] **Step 1: Add the models to `prisma/schema.prisma`**

Insert directly after the closing brace of `model AgentChatSession` (~line 240):

```prisma
// Workspace-level Home assistant chat (not agent-scoped). Sessions are per
// user; messages carry metadata for attachments, created agents, and runs.
model AssistantChatSession {
  id             String   @id @default(cuid())
  organizationId String   @db.Uuid
  userId         String
  // Auto-derived from the first user message.
  title          String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  messages AssistantChatMessage[]

  @@index([organizationId, userId, updatedAt])
  @@map("assistant_chat_sessions")
}

model AssistantChatMessage {
  id             String   @id @default(cuid())
  organizationId String   @db.Uuid
  userId         String
  sessionId      String
  role           String
  content        String   @db.Text
  // attachment { filename, text, truncated? } | createdAgent { id, title,
  // icon, description } | executedRun { executionId, agentId, status } |
  // action { type, agentId }
  metadata       Json?
  createdAt      DateTime @default(now())

  session AssistantChatSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@index([sessionId, createdAt])
  @@map("assistant_chat_messages")
}
```

Note: like the existing `AgentChatSession`, these carry `organizationId` as a plain scoping column (no `Organization` relation) — follow that precedent.

- [ ] **Step 2: Create the migration and regenerate the client**

Run: `npx prisma migrate dev --name assistant_chat`
Expected: a new folder `prisma/migrations/<timestamp>_assistant_chat/` containing `migration.sql` with two `CREATE TABLE` statements, and `prisma generate` succeeding.

If no local database is reachable, do NOT hand-write the migration SQL — stop and ask the user how they apply migrations in this environment (the repo's deploy path runs `scripts/vercel-migrate.mjs`).

- [ ] **Step 3: Verify typecheck picks up the new client types**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add prisma
git commit -m "feat: add assistant chat session/message models

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Shared agent-draft creation helper

Extract the draft→agent normalization + creation from `POST /api/agents/draft` so the Home assistant (Task 5) creates agents with identical semantics (icon guard, schedule normalization, connector sync) and the two routes cannot drift.

**Files:**
- Create: `src/features/agents/create-from-draft.ts`
- Create: `src/features/agents/__tests__/create-from-draft.test.ts`
- Modify: `src/app/api/agents/draft/route.ts`

**Interfaces:**
- Consumes: `syncAgentConnectors(agentId, organizationId, userId, integrations)` from `@/lib/connectors/agent-connectors`; `DEFAULT_AGENT_MODEL` from `@/lib/llm/model-runner`; `prisma` from `@/lib/prisma`.
- Produces (used by Task 5):
  - `type AgentDraft = { title: string; icon: string; description: string; instructions: string; integrations: string[]; schedule: { type: string; time: string; cron: string; timezone: string; isActive: boolean } }`
  - `normalizeDraft(draft: AgentDraft): NormalizedDraft` (pure)
  - `createAgentFromDraft(draft: AgentDraft, ctx: { organizationId: string; userId: string }): Promise<{ agent: AgentTask; draft: NormalizedDraft }>`

- [ ] **Step 1: Write the failing unit test**

Create `src/features/agents/__tests__/create-from-draft.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDraft, type AgentDraft } from '../create-from-draft'

const base: AgentDraft = {
  title: 'Weekly Report Agent',
  icon: '📄',
  description: 'Summarizes the week.',
  instructions: 'You summarize the week.',
  integrations: ['slack'],
  schedule: { type: 'weekly', time: '09:00', cron: '', timezone: 'UTC', isActive: true },
}

test('keeps a valid emoji icon', () => {
  assert.equal(normalizeDraft(base).icon, '📄')
})

test('replaces a word icon with the default mark', () => {
  assert.equal(normalizeDraft({ ...base, icon: 'test' }).icon, '🤖')
})

test('replaces an empty icon with the default mark', () => {
  assert.equal(normalizeDraft({ ...base, icon: '  ' }).icon, '🤖')
})

test('manual schedules are never active', () => {
  const normalized = normalizeDraft({
    ...base,
    schedule: { type: 'manual', time: '', cron: '', timezone: '', isActive: true },
  })
  assert.equal(normalized.schedule.isActive, false)
  assert.equal(normalized.schedule.timezone, 'UTC')
  assert.equal('time' in normalized.schedule, false)
})

test('omits empty time/cron and keeps set ones', () => {
  const normalized = normalizeDraft(base)
  assert.equal(normalized.schedule.time, '09:00')
  assert.equal('cron' in normalized.schedule, false)
})

test('stamps model, visibility, and folder defaults', () => {
  const normalized = normalizeDraft(base)
  assert.equal(typeof normalized.model, 'string')
  assert.equal(normalized.visibility, 'private')
  assert.equal(normalized.folder, null)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/agents/__tests__/create-from-draft.test.ts`
Expected: FAIL — cannot find module `../create-from-draft`.

- [ ] **Step 3: Write the helper**

Create `src/features/agents/create-from-draft.ts`:

```ts
import type { AgentTask } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { syncAgentConnectors } from '@/lib/connectors/agent-connectors'
import { DEFAULT_AGENT_MODEL } from '@/lib/llm/model-runner'

/**
 * Draft→agent creation shared by POST /api/agents/draft and the Home
 * assistant. One home for the icon guard, schedule normalization, and
 * connector sync so the two entry points cannot drift.
 */

export type AgentDraft = {
  title: string
  icon: string
  description: string
  instructions: string
  integrations: string[]
  schedule: { type: string; time: string; cron: string; timezone: string; isActive: boolean }
}

export type NormalizedDraft = Omit<AgentDraft, 'schedule'> & {
  schedule: { type: string; timezone: string; isActive: boolean; time?: string; cron?: string }
  model: string
  visibility: 'private'
  folder: null
}

export function normalizeDraft(draft: AgentDraft): NormalizedDraft {
  const schedule = {
    type: draft.schedule.type,
    timezone: draft.schedule.timezone || 'UTC',
    isActive: draft.schedule.isActive && draft.schedule.type !== 'manual',
    ...(draft.schedule.time ? { time: draft.schedule.time } : {}),
    ...(draft.schedule.cron ? { cron: draft.schedule.cron } : {}),
  }
  // The model sometimes returns a word (e.g. "test") instead of an emoji for
  // `icon`; that then shows as broken text. Accept it only if it looks like an
  // emoji (no ASCII letters/digits, short), else fall back to a default mark.
  const rawIcon = draft.icon?.trim() || ''
  const icon = rawIcon && !/[A-Za-z0-9]/.test(rawIcon) && [...rawIcon].length <= 4 ? rawIcon : '🤖'
  return { ...draft, icon, schedule, model: DEFAULT_AGENT_MODEL, visibility: 'private', folder: null }
}

export async function createAgentFromDraft(
  draft: AgentDraft,
  ctx: { organizationId: string; userId: string },
): Promise<{ agent: AgentTask; draft: NormalizedDraft }> {
  const normalized = normalizeDraft(draft)
  const agent = await prisma.agentTask.create({
    data: {
      agentType: 'CUSTOM',
      description: normalized.description || normalized.title,
      objective: normalized.instructions,
      schedule: normalized.schedule,
      status: 'ACTIVE',
      visibility: 'private',
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      metadata: {
        title: normalized.title,
        description: normalized.description,
        model: normalized.model,
        integrations: normalized.integrations,
        icon: normalized.icon,
      },
    },
  })
  // Typed connector bindings — without this, the agent's first run falls back
  // to metadata-string matching.
  await syncAgentConnectors(agent.id, ctx.organizationId, ctx.userId, normalized.integrations)
  return { agent, draft: normalized }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/agents/__tests__/create-from-draft.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Refactor `POST /api/agents/draft` onto the helper**

In `src/app/api/agents/draft/route.ts`:

Replace the imports of `prisma`, `syncAgentConnectors`, and the whole post-parse body (schedule normalization, icon guard, `enrichedDraft`, `prisma.agentTask.create`, `syncAgentConnectors` call) so the route becomes:

```ts
import { z } from 'zod'
import { BUILTIN_CONNECTORS } from '@/lib/connectors/registry'
import { generateStructured } from '@/lib/llm/model-runner'
import { qwenConfigured } from '@/lib/llm/qwen'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { checkMonthlyTokenBudget, recordTokenUsage } from '@/lib/usage/budget'
import { createAgentFromDraft, normalizeDraft, type AgentDraft } from '@/features/agents/create-from-draft'
```

Keep `PROVIDERS` and `DRAFT_SCHEMA` exactly as they are. Delete the local `type Draft` and use `AgentDraft`. The handler body after `recordTokenUsage` becomes:

```ts
  const draft = JSON.parse(text) as AgentDraft

  if (!create) {
    return { success: true, draft: normalizeDraft(draft) }
  }

  const { agent, draft: enrichedDraft } = await createAgentFromDraft(draft, {
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
  })
  return { success: true, draft: enrichedDraft, agentId: agent.id }
```

- [ ] **Step 6: Verify types and full test suite**

Run: `npm run typecheck && npm test`
Expected: typecheck PASS; test run PASS (new tests included, no regressions).

- [ ] **Step 7: Commit**

```bash
git add src/features/agents/create-from-draft.ts src/features/agents/__tests__/create-from-draft.test.ts src/app/api/agents/draft/route.ts
git commit -m "refactor: extract shared agent-draft creation helper

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Workspace context builder

**Files:**
- Create: `src/features/assistant/workspace-context.ts`
- Create: `src/features/assistant/__tests__/workspace-context.test.ts`

**Interfaces:**
- Consumes: `agentReadScope`, `executionVisibilityScope`, `flowReadScope` from `@/lib/server/visibility`; `readAgentMetadata` from `@/lib/agents/metadata`; `getIntegrationStatus(userId, organizationId)` from `@/features/integrations/status`.
- Produces (used by Task 5): `buildWorkspaceContext(auth: { organizationId: string; dbUser: { id: string } }): Promise<WorkspaceContext>` where

```ts
type WorkspaceContext = {
  agents: Array<{ id: string; title: string; description: string; status: string; schedule: unknown; integrations: string[]; lastExecutedAt: string | null }>
  recentRuns: Array<{ id: string; agentTitle: string; status: string; startedAt: string; headline: string | null; error: string | null }>
  connections: {
    oauth: Record<string, { connected: boolean }>
    nango: Array<{ provider: string; status: string; error: string | null }>
    mcp: Array<{ name: string; provider: string | null; verified: boolean }>
  }
  flows: Array<{ id: string; name: string; status: string }>
}
```

- [ ] **Step 1: Write the failing test**

Create `src/features/assistant/__tests__/workspace-context.test.ts` (DB-gated, mirroring the route-smoke setup):

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    await prisma.agentTask.create({
      data: {
        description: 'Context agent',
        objective: 'o',
        status: 'ACTIVE',
        agentType: 'CUSTOM',
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        metadata: { title: 'Context Agent', integrations: ['slack'] },
      },
    })
    await prisma.flow.create({
      data: { name: 'Context flow', organizationId: seeded.organizationId, userId: seeded.userId },
    })
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  test('includes this org agents and flows', async () => {
    const { buildWorkspaceContext } = await import('../workspace-context')
    const context = await buildWorkspaceContext({
      organizationId: seeded.organizationId,
      dbUser: { id: seeded.userId },
    })
    assert.ok(context.agents.some((agent: any) => agent.title === 'Context Agent'))
    assert.ok(context.flows.some((flow: any) => flow.name === 'Context flow'))
    assert.ok('oauth' in context.connections)
  })

  test('excludes other-org data', async () => {
    const { buildWorkspaceContext } = await import('../workspace-context')
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    const other = await seedTestOrg(prisma)
    try {
      const context = await buildWorkspaceContext({
        organizationId: other.organizationId,
        dbUser: { id: other.userId },
      })
      assert.equal(context.agents.length, 0)
      assert.equal(context.flows.length, 0)
    } finally {
      await other.cleanup()
    }
  })
} else {
  test.skip('workspace-context tests need TEST_DATABASE_URL', () => {})
}
```

Note: check `src/lib/server/__tests__/test-auth.ts` for the exact `seedTestOrg` return shape (`organizationId`, `userId`, `auth`, `cleanup`) before running; adjust property names if they differ.

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/assistant/__tests__/workspace-context.test.ts`
Expected: FAIL (module not found) when `TEST_DATABASE_URL` is set; SKIP otherwise. If no test database is configured locally, note that and rely on typecheck + Step 4's suite run in CI.

- [ ] **Step 3: Write the builder**

Create `src/features/assistant/workspace-context.ts`:

```ts
import { prisma } from '@/lib/prisma'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { agentReadScope, executionVisibilityScope, flowReadScope } from '@/lib/server/visibility'
import { getIntegrationStatus } from '@/features/integrations/status'

/**
 * Server-side context assembly for the Home assistant: a compact, bounded
 * snapshot of everything going on in the workspace (agents, recent runs,
 * connections, flows) that the model grounds its answers in. Long values are
 * clipped so one big run output cannot blow the prompt budget.
 */

function clip(value: unknown, max = 300): string | null {
  if (value == null) return null
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (!text) return null
  return text.length > max ? `${text.slice(0, max)}… [truncated]` : text
}

export type WorkspaceContext = {
  agents: Array<{
    id: string
    title: string
    description: string
    status: string
    schedule: unknown
    integrations: string[]
    lastExecutedAt: string | null
  }>
  recentRuns: Array<{
    id: string
    agentTitle: string
    status: string
    startedAt: string
    headline: string | null
    error: string | null
  }>
  connections: {
    oauth: Record<string, { connected: boolean }>
    nango: Array<{ provider: string; status: string; error: string | null }>
    mcp: Array<{ name: string; provider: string | null; verified: boolean }>
  }
  flows: Array<{ id: string; name: string; status: string }>
}

export async function buildWorkspaceContext(auth: {
  organizationId: string
  dbUser: { id: string }
}): Promise<WorkspaceContext> {
  const { organizationId } = auth
  const userId = auth.dbUser.id

  const [agents, runs, flows, nango, mcp, oauth] = await Promise.all([
    prisma.agentTask.findMany({
      where: { organizationId, status: { not: 'DELETED' }, ...agentReadScope(userId) },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    }),
    prisma.agentExecution.findMany({
      where: { organizationId, ...executionVisibilityScope(userId) },
      orderBy: { startedAt: 'desc' },
      take: 20,
      select: { id: true, status: true, startedAt: true, error: true, metadata: true },
    }),
    prisma.flow.findMany({
      where: { organizationId, ...flowReadScope(userId) },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: { id: true, name: true, status: true },
    }),
    prisma.nangoConnection.findMany({
      where: { organizationId },
      select: { providerConfigKey: true, status: true, lastError: true },
    }),
    prisma.mcpConnection.findMany({
      where: { organizationId, isActive: true, OR: [{ userId: null }, { userId }] },
      select: { name: true, provider: true, lastVerifiedAt: true },
    }),
    getIntegrationStatus(userId, organizationId),
  ])

  return {
    agents: agents.map((agent) => {
      const metadata = readAgentMetadata(agent)
      return {
        id: agent.id,
        title: metadata.title || agent.description,
        description: clip(metadata.description || agent.description) || '',
        status: agent.status,
        schedule: agent.schedule,
        integrations: metadata.integrations || [],
        lastExecutedAt: agent.lastExecutedAt ? agent.lastExecutedAt.toISOString() : null,
      }
    }),
    recentRuns: runs.map((run) => {
      const metadata =
        run.metadata && typeof run.metadata === 'object' && !Array.isArray(run.metadata)
          ? (run.metadata as Record<string, unknown>)
          : {}
      return {
        id: run.id,
        agentTitle: typeof metadata.title === 'string' ? metadata.title : 'Agent',
        status: run.status,
        startedAt: run.startedAt.toISOString(),
        headline: typeof metadata.headline === 'string' ? metadata.headline : null,
        error: clip(run.error),
      }
    }),
    connections: {
      oauth: Object.fromEntries(
        Object.entries(oauth as Record<string, { connected: boolean }>).map(([provider, value]) => [
          provider,
          { connected: Boolean(value?.connected) },
        ]),
      ),
      nango: nango.map((row) => ({
        provider: row.providerConfigKey,
        status: row.status,
        error: clip(row.lastError, 160),
      })),
      mcp: mcp.map((row) => ({ name: row.name, provider: row.provider, verified: Boolean(row.lastVerifiedAt) })),
    },
    flows: flows.map((flow) => ({ id: flow.id, name: flow.name, status: flow.status })),
  }
}
```

Check the exact signature of `readAgentMetadata` in `src/lib/agents/metadata.ts` — if it takes the metadata JSON rather than the whole `AgentTask`, adapt the call (`readAgentMetadata(agent.metadata)`).

- [ ] **Step 4: Verify**

Run: `npm run typecheck && TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/assistant/__tests__/workspace-context.test.ts`
Expected: typecheck PASS; tests PASS (or SKIP without `TEST_DATABASE_URL`).

- [ ] **Step 5: Commit**

```bash
git add src/features/assistant
git commit -m "feat: add workspace context builder for the Home assistant

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `POST /api/assistant/extract` — file → text

**Files:**
- Create: `src/app/api/assistant/extract/route.ts`
- Create: `src/app/api/assistant/__tests__/extract.test.ts`

**Interfaces:**
- Consumes: `extractText(buffer, mimeType, filename)`, `isSupported(mimeType, filename)` from `@/lib/knowledge/extract`.
- Produces (used by the UI in Task 7): `POST multipart(file) → { success: true, filename: string, text: string, truncated: boolean }`. Errors: 400 no file, 413 too large, 415 unsupported, 422 empty/unreadable, 429 rate-limited.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/assistant/__tests__/extract.test.ts`:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let seeded: any

  before(async () => {
    const { prisma } = await import('@/lib/prisma')
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  const postFile = async (name: string, type: string, content: string | Buffer) => {
    const { POST } = await import('../extract/route')
    const form = new FormData()
    form.set('file', new File([content], name, { type }))
    return POST(new NextRequest(new URL('http://test/api/assistant/extract'), { method: 'POST', body: form }))
  }

  test('extracts text from a markdown file', async () => {
    const res = await postFile('assignment.md', 'text/markdown', '# Assignment\nSummarize weekly sales.')
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.filename, 'assignment.md')
    assert.match(data.text, /Summarize weekly sales/)
    assert.equal(data.truncated, false)
  })

  test('rejects unsupported types with 415', async () => {
    const res = await postFile('photo.png', 'image/png', Buffer.from([0x89, 0x50]))
    assert.equal(res.status, 415)
  })

  test('truncates long text and flags it', async () => {
    const res = await postFile('big.txt', 'text/plain', 'a'.repeat(30_000))
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.text.length, 24_000)
    assert.equal(data.truncated, true)
  })

  test('rejects a missing file with 400', async () => {
    const { POST } = await import('../extract/route')
    const form = new FormData()
    const res = await POST(new NextRequest(new URL('http://test/api/assistant/extract'), { method: 'POST', body: form }))
    assert.equal(res.status, 400)
  })
} else {
  test.skip('extract tests need TEST_DATABASE_URL', () => {})
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/assistant/__tests__/extract.test.ts`
Expected: FAIL (cannot find `../extract/route`) with `TEST_DATABASE_URL` set; SKIP otherwise.

- [ ] **Step 3: Write the route**

Create `src/app/api/assistant/extract/route.ts`:

```ts
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { extractText, isSupported } from '@/lib/knowledge/extract'
import { rateLimit } from '@/lib/ratelimit'

export const runtime = 'nodejs'

// Max upload size (pre-extraction) — matches the knowledge upload route.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 // 10 MB
// Extracted text cap: enough for a long assignment brief without letting one
// document dominate the assistant's prompt budget.
const MAX_TEXT_CHARS = 24_000

/**
 * Turns an uploaded assignment file into plain text for the Home assistant.
 * Nothing is persisted here — the client sends the text back with its next
 * chat message, where it is stored as message metadata.
 */
export const POST = withAuthenticatedApi(async (request, auth) => {
  const limited = await rateLimit(`assistant-extract:${auth.dbUser.id}`, { limit: 20, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Rate limit exceeded', 429, 'RATE_LIMITED')

  const form = await request.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) throw new ApiError('Attach a file in the "file" field.')
  if (file.size > MAX_UPLOAD_BYTES) throw new ApiError('File is too large (max 10 MB).', 413, 'TOO_LARGE')

  const filename = file.name || 'upload'
  const mimeType = file.type || 'application/octet-stream'
  if (!isSupported(mimeType, filename)) {
    throw new ApiError('This file type is not supported — use text, markdown, PDF, or DOCX.', 415, 'UNSUPPORTED_TYPE')
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  let text: string
  try {
    text = await extractText(buffer, mimeType, filename)
  } catch (error) {
    throw new ApiError('Could not read this file — it may be corrupted.', 422, 'EXTRACTION_FAILED', error)
  }
  if (!text) throw new ApiError('No text found in this file.', 422, 'EMPTY_FILE')

  const truncated = text.length > MAX_TEXT_CHARS
  return { success: true, filename, text: truncated ? text.slice(0, MAX_TEXT_CHARS) : text, truncated }
})
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/assistant/__tests__/extract.test.ts`
Expected: PASS — 4 tests (with `TEST_DATABASE_URL`). Also run `npm run typecheck` — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/assistant
git commit -m "feat: add assistant file-extract endpoint

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Assistant chat API (`/api/assistant/chat`)

**Files:**
- Create: `src/app/api/assistant/chat/shared.ts`
- Create: `src/app/api/assistant/chat/route.ts`
- Create: `src/app/api/assistant/chat/sessions/route.ts`
- Create: `src/app/api/assistant/__tests__/chat.test.ts`
- Modify: `src/app/api/__tests__/route-smoke.test.ts` (register the two new GET routes — the completeness self-check will fail the suite otherwise)

**Interfaces:**
- Consumes: `buildWorkspaceContext` (Task 3), `createAgentFromDraft`/`AgentDraft` (Task 2), `generateStructured`/`qwenConfigured`, `agentReadScope`, `checkMonthlyTokenBudget`/`recordTokenUsage`, `rateLimit`, Prisma clients from Task 1.
- Produces (used by the UI in Task 7):
  - `GET /api/assistant/chat?sessionId=` → `{ success, sessionId: string | null, messages: SerializedMessage[] }`
  - `GET /api/assistant/chat/sessions` → `{ success, sessions: Array<{ id, title, updatedAt, messageCount }> }`
  - `POST /api/assistant/chat` body `{ message, sessionId?, attachment?: { filename, text, truncated? } }` → `{ success, sessionId, messages: [user, assistant] }`
  - `PATCH /api/assistant/chat` body `{ messageId, executedRun: { executionId, agentId, status } }` → `{ success, message }`
  - `SerializedMessage = { id, role, content, createdAt, attachment: { filename, truncated? } | null, createdAgent: { id, title, icon, description } | null, executedRun: { executionId, agentId, status } | null, action: { type: 'execute', agentId } | null }`

- [ ] **Step 1: Write the shared helpers**

Create `src/app/api/assistant/chat/shared.ts`:

```ts
import type { AssistantChatMessage } from '@prisma/client'

/** A conversation title derived from the first user message. */
export function deriveTitle(message: string): string {
  const text = message.trim().replace(/\s+/g, ' ')
  if (!text) return 'New chat'
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

export function serializeMessage(message: AssistantChatMessage) {
  const metadata =
    message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
      ? (message.metadata as Record<string, unknown>)
      : {}
  const attachment =
    metadata.attachment && typeof metadata.attachment === 'object'
      ? (metadata.attachment as { filename?: string; truncated?: boolean })
      : null
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    // The stored attachment carries the full extracted text (for follow-up
    // turns); the wire shape only needs the chip.
    attachment: attachment ? { filename: attachment.filename ?? 'attachment', truncated: Boolean(attachment.truncated) } : null,
    createdAgent: metadata.createdAgent ?? null,
    executedRun: metadata.executedRun ?? null,
    action: metadata.action ?? null,
  }
}
```

- [ ] **Step 2: Write the sessions route**

Create `src/app/api/assistant/chat/sessions/route.ts`:

```ts
import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

/** Lists the current user's Home assistant conversations, newest first. */
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const sessions = await prisma.assistantChatSession.findMany({
    where: { organizationId: auth.organizationId, userId: auth.dbUser.id },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    include: { _count: { select: { messages: true } } },
  })
  return {
    success: true,
    sessions: sessions
      .filter((session) => session._count.messages > 0)
      .map((session) => ({
        id: session.id,
        title: session.title || 'New chat',
        updatedAt: session.updatedAt.toISOString(),
        messageCount: session._count.messages,
      })),
  }
})
```

- [ ] **Step 3: Write the chat route**

Create `src/app/api/assistant/chat/route.ts`:

```ts
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { generateStructured } from '@/lib/llm/model-runner'
import { qwenConfigured } from '@/lib/llm/qwen'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentReadScope } from '@/lib/server/visibility'
import { rateLimit } from '@/lib/ratelimit'
import { checkMonthlyTokenBudget, recordTokenUsage } from '@/lib/usage/budget'
import { BUILTIN_CONNECTORS } from '@/lib/connectors/registry'
import { createAgentFromDraft, type AgentDraft } from '@/features/agents/create-from-draft'
import { buildWorkspaceContext } from '@/features/assistant/workspace-context'
import { deriveTitle, serializeMessage } from './shared'

export const runtime = 'nodejs'
export const maxDuration = 120

/**
 * Workspace-level Home assistant chat. GET returns a conversation, POST
 * answers with server-assembled workspace context and may CREATE an agent
 * (from an aligned assignment) or flag an execute action the client fires
 * against the existing /api/agents/[id]/execute endpoint. PATCH records the
 * resulting run on the message so the transcript renders it after reload.
 */

const PROVIDERS = [...new Map(BUILTIN_CONNECTORS.map((c) => [c.key.toLowerCase(), c.key])).values()]

const SYSTEM_PROMPT = [
  'You are the Sublime home assistant for a team workspace. You oversee the workspace: its agents, their recent runs, connected integrations, and flows.',
  'Ground every statement in the provided context. If the context does not contain the answer, say so plainly.',
  'When the user shares an assignment (as text or an attached file) and wants it handled, turn it into an agent. First check the delivery requirements: output format, cadence or schedule, destinations or integrations, and scope. If any of these are genuinely ambiguous, ask ONE batch of short clarifying questions in the reply and set agentDraft to null. Once requirements are clear — or the assignment already answers them — set agentDraft to the complete configuration. Never ask clarifying questions and emit agentDraft in the same turn.',
  `Available integrations: ${PROVIDERS.join(', ')}. Include only the ones the task needs; an agent with no integrations is fine.`,
  'agentDraft.instructions must be complete operating instructions in second person: the goal, the steps, which tools to use, and what the final output must contain. If minor details remain open, instruct the agent to ask the user via its ask_user tool at run time.',
  'When you emit agentDraft the agent is created immediately and shown to the user with a Run button — never claim you cannot create agents, and never emit agentDraft merely as an example.',
  'Set a schedule only when the user describes a recurring cadence; otherwise use type "manual" with isActive false.',
  'Set action to { "type": "execute", "agentId": "<id from the context agents list>" } ONLY when the user explicitly asks to run an agent. Otherwise action is null. Never invent agent ids.',
  'Write concise markdown in sentence case. No emoji.',
].join('\n')

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reply: { type: 'string', description: 'The answer shown to the user, in concise markdown. Sentence case, no emoji.' },
    agentDraft: {
      type: ['object', 'null'],
      additionalProperties: false,
      description: 'A complete agent configuration once assignment requirements are aligned; null otherwise.',
      properties: {
        title: { type: 'string', description: 'Short agent name, e.g. "Weekly Report Agent".' },
        icon: { type: 'string', description: 'A single emoji that represents the agent.' },
        description: { type: 'string', description: 'One sentence describing what the agent does.' },
        instructions: { type: 'string', description: 'Complete operating instructions in second person.' },
        integrations: { type: 'array', items: { type: 'string', enum: [...PROVIDERS] } },
        schedule: {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { type: 'string', enum: ['manual', 'hourly', 'daily', 'weekly', 'cron'] },
            time: { type: 'string', description: '24h HH:MM start time; empty string when not applicable.' },
            cron: { type: 'string', description: 'Cron expression; empty string unless type is "cron".' },
            timezone: { type: 'string', description: 'IANA timezone, default UTC.' },
            isActive: { type: 'boolean' },
          },
          required: ['type', 'time', 'cron', 'timezone', 'isActive'],
        },
      },
      required: ['title', 'icon', 'description', 'instructions', 'integrations', 'schedule'],
    },
    action: {
      type: ['object', 'null'],
      additionalProperties: false,
      description: 'An action for the client to perform, or null.',
      properties: {
        type: { type: 'string', enum: ['execute'] },
        agentId: { type: 'string', description: 'Id of an agent from the context agents list.' },
      },
      required: ['type', 'agentId'],
    },
  },
  required: ['reply', 'agentDraft', 'action'],
} as const

const draftSchema = z.object({
  title: z.string().min(1),
  icon: z.string().default(''),
  description: z.string().default(''),
  instructions: z.string().min(1),
  integrations: z.array(z.string()).default([]),
  schedule: z.object({
    type: z.enum(['manual', 'hourly', 'daily', 'weekly', 'cron']),
    time: z.string().default(''),
    cron: z.string().default(''),
    timezone: z.string().default('UTC'),
    isActive: z.boolean().default(false),
  }),
})

const actionSchema = z.object({ type: z.literal('execute'), agentId: z.string().min(1) })

export const GET = withAuthenticatedApi(async (request, auth) => {
  const requested = new URL(request.url).searchParams.get('sessionId')
  let sessionId = requested
  if (!sessionId) {
    const latest = await prisma.assistantChatSession.findFirst({
      where: { organizationId: auth.organizationId, userId: auth.dbUser.id },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    })
    sessionId = latest?.id ?? null
  }
  if (!sessionId) return { success: true, sessionId: null, messages: [] }
  const rows = await prisma.assistantChatMessage.findMany({
    where: { organizationId: auth.organizationId, userId: auth.dbUser.id, sessionId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 100,
  })
  return { success: true, sessionId, messages: rows.reverse().map(serializeMessage) }
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  if (!process.env.ANTHROPIC_API_KEY && !qwenConfigured()) {
    throw new ApiError('No model provider is configured', 503, 'AI_UNAVAILABLE')
  }
  const { message, sessionId: requestedSessionId, attachment } = z
    .object({
      message: z.string().min(1).max(4000),
      sessionId: z.string().optional(),
      attachment: z
        .object({
          filename: z.string().min(1).max(200),
          text: z.string().min(1).max(24_000),
          truncated: z.boolean().optional(),
        })
        .optional(),
    })
    .parse(await request.json())

  const limited = await rateLimit(`assistant-chat:${auth.dbUser.id}`, { limit: 30, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Rate limit exceeded', 429, 'RATE_LIMITED')
  const budget = await checkMonthlyTokenBudget(auth.organizationId)
  if (budget.over) throw new ApiError('Monthly token budget reached for this workspace.', 429, 'BUDGET_EXCEEDED')

  let session = requestedSessionId
    ? await prisma.assistantChatSession.findFirst({
        where: { id: requestedSessionId, organizationId: auth.organizationId, userId: auth.dbUser.id },
      })
    : null
  if (!session) {
    session = await prisma.assistantChatSession.create({
      data: { organizationId: auth.organizationId, userId: auth.dbUser.id, title: deriveTitle(message) },
    })
  }

  const [context, historyRows] = await Promise.all([
    buildWorkspaceContext(auth),
    prisma.assistantChatMessage.findMany({
      where: { organizationId: auth.organizationId, userId: auth.dbUser.id, sessionId: session.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
    }),
  ])
  const conversation = historyRows.reverse().map((row) => {
    const metadata =
      row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {}
    const stored = metadata.attachment as { filename?: string; text?: string } | undefined
    // Re-inline earlier attachments (clipped) so follow-up turns keep the
    // assignment in view without resending it from the client.
    const suffix = stored?.text ? `\n\n[Attached ${stored.filename}]\n${stored.text.slice(0, 4000)}` : ''
    return { role: row.role, content: `${row.content.slice(0, 2000)}${suffix}` }
  })

  let reply = ''
  let draft: z.infer<typeof draftSchema> | null = null
  let action: z.infer<typeof actionSchema> | null = null
  try {
    const text = await generateStructured({
      schemaName: 'home_assistant_reply',
      schema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      system: SYSTEM_PROMPT,
      user: JSON.stringify({
        context,
        conversation,
        question: message,
        ...(attachment ? { attachment } : {}),
      }),
      // A draft reply includes complete agent instructions inline — a tight
      // cap truncates the JSON and turns a valid answer into a parse failure.
      maxTokens: 8192,
    })
    const parsed = JSON.parse(text || '{}') as { reply?: unknown; agentDraft?: unknown; action?: unknown }
    reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : ''
    draft = draftSchema.nullish().catch(null).parse(parsed.agentDraft ?? null) ?? null
    action = actionSchema.nullish().catch(null).parse(parsed.action ?? null) ?? null
  } catch (error) {
    throw new ApiError('The assistant could not respond. Try again.', 502, 'ASSISTANT_FAILED', error)
  }

  // Auto-apply: an aligned draft becomes a real agent immediately; the reply
  // renders a created-agent card with a Run button. A creation failure keeps
  // the conversation (and the draft's content, via the reply text) intact.
  let createdAgent: { id: string; title: string; icon: string; description: string } | null = null
  if (draft) {
    try {
      const created = await createAgentFromDraft(draft as AgentDraft, {
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
      })
      createdAgent = {
        id: created.agent.id,
        title: created.draft.title,
        icon: created.draft.icon,
        description: created.draft.description,
      }
    } catch {
      reply = `${reply}\n\nI could not save the agent just now — ask me to create it again.`
    }
  }

  // Execute requests: validate the id against this user's visible ACTIVE
  // agents; the client fires the existing execute endpoint (inline runs can
  // take minutes — far too long to hold this response open).
  let validatedAction: { type: 'execute'; agentId: string } | null = null
  if (action) {
    const target = await prisma.agentTask.findFirst({
      where: { id: action.agentId, organizationId: auth.organizationId, status: 'ACTIVE', ...agentReadScope(auth.dbUser.id) },
      select: { id: true },
    })
    if (target) validatedAction = { type: 'execute', agentId: target.id }
    else reply = `${reply}\n\nI could not find that agent in this workspace, so I did not start a run.`
  }

  if (!reply) reply = createdAgent ? 'Here is the agent I set up.' : 'No answer returned.'

  // Rough metering (~chars/4): generateStructured returns no token usage.
  void recordTokenUsage(
    auth.organizationId,
    Math.ceil((JSON.stringify(context).length + message.length + (attachment?.text.length ?? 0) + reply.length) / 4),
  ).catch(() => undefined)

  const userMessage = await prisma.assistantChatMessage.create({
    data: {
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      sessionId: session.id,
      role: 'user',
      content: message,
      ...(attachment ? { metadata: { attachment } as unknown as Prisma.InputJsonValue } : {}),
    },
  })
  const assistantMetadata: Record<string, unknown> = {}
  if (createdAgent) assistantMetadata.createdAgent = createdAgent
  if (validatedAction) assistantMetadata.action = validatedAction
  const assistantMessage = await prisma.assistantChatMessage.create({
    data: {
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      sessionId: session.id,
      role: 'assistant',
      content: reply,
      ...(Object.keys(assistantMetadata).length
        ? { metadata: assistantMetadata as unknown as Prisma.InputJsonValue }
        : {}),
    },
  })

  // Bump the session so it sorts to the top of history. Best-effort.
  await prisma.assistantChatSession
    .update({ where: { id: session.id }, data: { title: session.title ?? deriveTitle(message) } })
    .catch(() => undefined)

  return { success: true, sessionId: session.id, messages: [serializeMessage(userMessage), serializeMessage(assistantMessage)] }
})

// Records the run the client started off an execute action (or a created-agent
// Run click) so the transcript still shows it after a reload.
export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const { messageId, executedRun } = z
    .object({
      messageId: z.string().min(1),
      executedRun: z.object({
        executionId: z.string().min(1),
        agentId: z.string().min(1),
        status: z.string().min(1).max(40),
      }),
    })
    .parse(await request.json())
  const row = await prisma.assistantChatMessage.findFirst({
    where: { id: messageId, organizationId: auth.organizationId, userId: auth.dbUser.id },
  })
  if (!row) throw new ApiError('Message not found', 404, 'NOT_FOUND')
  const metadata =
    row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {}
  const updated = await prisma.assistantChatMessage.update({
    where: { id: row.id },
    data: { metadata: { ...metadata, executedRun } as unknown as Prisma.InputJsonValue },
  })
  return { success: true, message: serializeMessage(updated) }
})
```

- [ ] **Step 4: Write the API tests**

Create `src/app/api/assistant/__tests__/chat.test.ts`:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let sessionId: string
  let messageId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    const session = await prisma.assistantChatSession.create({
      data: { organizationId: seeded.organizationId, userId: seeded.userId, title: 'Seeded chat' },
    })
    sessionId = session.id
    const message = await prisma.assistantChatMessage.create({
      data: {
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        sessionId,
        role: 'assistant',
        content: 'Created the agent.',
        metadata: { createdAgent: { id: 'a1', title: 'T', icon: '🤖', description: '' } },
      },
    })
    messageId = message.id
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  test('GET /api/assistant/chat returns the latest session messages', async () => {
    const { GET } = await import('../chat/route')
    const res = await GET(new NextRequest(new URL('http://test/api/assistant/chat')))
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.sessionId, sessionId)
    assert.equal(data.messages.length, 1)
    assert.equal(data.messages[0].createdAgent.id, 'a1')
  })

  test('GET /api/assistant/chat/sessions lists only sessions with messages', async () => {
    await prisma.assistantChatSession.create({
      data: { organizationId: seeded.organizationId, userId: seeded.userId, title: 'Empty chat' },
    })
    const { GET } = await import('../chat/sessions/route')
    const res = await GET(new NextRequest(new URL('http://test/api/assistant/chat/sessions')))
    const data = await res.json()
    assert.equal(data.sessions.length, 1)
    assert.equal(data.sessions[0].id, sessionId)
  })

  test('PATCH records an executed run on an owned message', async () => {
    const { PATCH } = await import('../chat/route')
    const res = await PATCH(
      new NextRequest(new URL('http://test/api/assistant/chat'), {
        method: 'PATCH',
        body: JSON.stringify({
          messageId,
          executedRun: { executionId: 'e1', agentId: 'a1', status: 'pending' },
        }),
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.message.executedRun.executionId, 'e1')
    assert.equal(data.message.createdAgent.id, 'a1') // merge, not replace
  })

  test('POST 503s when no model provider is configured', async () => {
    // The test env has no ANTHROPIC_API_KEY/Qwen config, so the provider guard
    // must fire before any DB write — a POST here must not create a session.
    const previous = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const { POST } = await import('../chat/route')
      const res = await POST(
        new NextRequest(new URL('http://test/api/assistant/chat'), {
          method: 'POST',
          body: JSON.stringify({ message: 'hello' }),
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      assert.equal(res.status, 503)
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous
    }
  })

  test('PATCH 404s on a message the user does not own', async () => {
    const otherSeed = await (await import('@/lib/server/__tests__/test-auth')).seedTestOrg(prisma)
    try {
      const foreign = await prisma.assistantChatSession.create({
        data: { organizationId: otherSeed.organizationId, userId: otherSeed.userId },
      })
      const foreignMessage = await prisma.assistantChatMessage.create({
        data: {
          organizationId: otherSeed.organizationId,
          userId: otherSeed.userId,
          sessionId: foreign.id,
          role: 'assistant',
          content: 'x',
        },
      })
      const { PATCH } = await import('../chat/route')
      const res = await PATCH(
        new NextRequest(new URL('http://test/api/assistant/chat'), {
          method: 'PATCH',
          body: JSON.stringify({
            messageId: foreignMessage.id,
            executedRun: { executionId: 'e2', agentId: 'a2', status: 'pending' },
          }),
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      assert.equal(res.status, 404)
    } finally {
      await otherSeed.cleanup()
    }
  })
} else {
  test.skip('assistant chat tests need TEST_DATABASE_URL', () => {})
}
```

- [ ] **Step 5: Register the new GET routes in the smoke suite**

In `src/app/api/__tests__/route-smoke.test.ts`, add to the `cases` array (alphabetical placement near the other top-level routes):

```ts
    { name: 'GET /api/assistant/chat', run: async () => (await import('../assistant/chat/route')).GET(req('/api/assistant/chat')) },
    { name: 'GET /api/assistant/chat/sessions', run: async () => (await import('../assistant/chat/sessions/route')).GET(req('/api/assistant/chat/sessions')) },
```

(The suite's completeness self-check enumerates every `withAuthenticatedApi` GET route — omitting these fails the build of the test suite by design.)

- [ ] **Step 6: Run tests and typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS. Without `TEST_DATABASE_URL` locally, the DB-gated files skip; typecheck must still pass.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/assistant src/app/api/__tests__/route-smoke.test.ts
git commit -m "feat: add workspace assistant chat API

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Move Agent HQ from `/dashboard` to `/agents`

Pure mechanical move + link rewrite. No behavior changes inside Agent HQ.

**Files:**
- Rename: `src/app/dashboard/` → `src/app/agents/` (all 6 files)
- Modify: `src/app/agents/page.tsx`, `src/app/agents/agent-config-dialog.tsx`, `src/app/agents/agent-config-form.tsx`
- Modify: `src/components/layout/sidebar.tsx`, `src/components/layout/app-shell.tsx`, `src/components/search/command-palette.tsx`
- Modify: `src/lib/notifications/notification-href.ts`, `src/lib/notifications/service.ts`
- Modify: `src/app/templates/page.tsx`, `src/app/templates/[id]/page.tsx`, `src/app/skills/[id]/page.tsx`
- Modify: `src/components/templates/templates-explorer.tsx`, `src/components/flows/step-card.tsx`
- Modify: `src/app/not-found.tsx`, `src/app/error.tsx`

**Interfaces:**
- Produces: Agent HQ served at `/agents` with identical query-param API (`?agent=`, `?run=`, `?view=templates`, `?tab=skills`). `/dashboard` is left with NO page for one commit (Task 7 adds the new Home page immediately after; do Task 7 in the same PR).

- [ ] **Step 1: Move the directory**

```bash
git mv src/app/dashboard src/app/agents
```

- [ ] **Step 2: Rewrite `/dashboard` self-references inside the moved files**

In `src/app/agents/page.tsx` replace every `'/dashboard` occurrence with `'/agents` — specifically:
- `router.replace(next === 'templates' ? '/dashboard?view=templates' : '/dashboard', { scroll: false })` → `/agents?view=templates` / `/agents`
- the four `router.replace('/dashboard')` calls in the deep-link effects → `router.replace('/agents')`

In `src/app/agents/agent-config-dialog.tsx`: `router.push(\`/dashboard?run=${runId}\`)` → `` router.push(`/agents?run=${runId}`) ``.

In `src/app/agents/agent-config-form.tsx`: `router.push(\`/dashboard?run=${runId}\`)` → `` `/agents?run=${runId}` ``; `<Link href="/dashboard?view=templates&tab=skills">` → `/agents?view=templates&tab=skills`.

Verify: `grep -rn "/dashboard" src/app/agents/` returns nothing.

- [ ] **Step 3: Update the sidebar**

In `src/components/layout/sidebar.tsx`:

```ts
import { Sparkles } from 'lucide-react'   // add to the existing lucide import list

const navigation = [
  { name: 'Home', href: '/dashboard', icon: Sparkles },
  { name: 'Agents', href: '/agents', icon: Brain },
  { name: 'Integrations', href: '/integrations', icon: Plug },
  { name: 'Flows', href: '/flows', icon: Workflow },
]
```

Update the isActive line so Home stays exact-match and Agents matches by prefix:

```ts
const isActive = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href))
```

(unchanged logic works: `/agents` prefix-matches, `/dashboard` stays exact).

Also in `sidebar.tsx`: `runAgent`'s `router.push('/dashboard')` → `router.push('/agents')`; agent row click `` router.push(`/dashboard?agent=${agent.id}`) `` → `` `/agents?agent=${agent.id}` ``; the "+" button `router.push('/dashboard?agent=new')` → `'/agents?agent=new'`; the comment about the templates library path → `/agents?view=templates`.

- [ ] **Step 4: Update app shell, command palette, notifications, and inbound links**

`src/components/layout/app-shell.tsx`:

```ts
const APP_PREFIXES = ['/dashboard', '/agents', '/integrations', '/connections', '/templates', '/flows', '/settings']
const FULLSCREEN_ROUTES = new Set(['/dashboard', '/agents'])
```

`src/components/search/command-palette.tsx` — NAV_ITEMS becomes:

```ts
const NAV_ITEMS: NavResult[] = [
  { label: 'Home', href: '/dashboard', icon: Sparkles },
  { label: 'Agents', href: '/agents', icon: Brain },
  { label: 'Flows', href: '/flows', icon: Workflow },
  { label: 'Integrations', href: '/integrations', icon: Plug },
  { label: 'Templates', href: '/agents?view=templates', icon: FileText },
  { label: 'MCP Servers', href: '/integrations?tab=mcp', icon: Server },
  { label: 'Settings', href: '/settings', icon: Settings },
]
```

(add `Sparkles` to the lucide import) and the result handlers: `` router.push(`/agents?agent=${result.agent.id}`) `` / `` router.push(`/agents?run=${result.run.id}`) ``.

`src/lib/notifications/notification-href.ts`: `` n.executionId ? `/agents?run=${n.executionId}` : '/agents' ``.
`src/lib/notifications/service.ts`: `` url: input.link ?? (input.executionId ? `/agents?run=${input.executionId}` : '/agents') ``.
`src/app/templates/page.tsx`: redirect targets → `/agents?view=templates&tab=skills` / `/agents?view=templates` (update the comment too).
`src/app/templates/[id]/page.tsx`: `` router.push(`/dashboard?agent=${...}`) `` (both occurrences) → `/agents?agent=`; both `href="/dashboard?view=templates"` links → `/agents?view=templates`.
`src/app/skills/[id]/page.tsx`: `router.push('/dashboard?view=templates&tab=skills')` → `/agents?view=templates&tab=skills`; the back-link href likewise; `<Link href="/dashboard">Create an agent first</Link>` → `/agents`.
`src/components/templates/templates-explorer.tsx`: `router.replace(value === 'skills' ? '/dashboard?view=templates&tab=skills' : '/dashboard?view=templates', ...)` → `/agents?...`.
`src/components/flows/step-card.tsx` line ~1573: `href="/dashboard"` → `href="/agents"`.
`src/app/not-found.tsx`: `<Link href="/dashboard">Return to dashboard</Link>` → `<Link href="/agents">Open your agents</Link>`.
`src/app/error.tsx`: `window.location.href = '/dashboard'` → `'/agents'` and the button label `Dashboard` → `Agents`.

Leave untouched (they now mean Home): `src/app/page.tsx` root redirect, `src/app/auth/login/page.tsx`, `src/app/auth/update-password/page.tsx`, `src/lib/auth/redirect.ts`, `src/lib/supabase/middleware.ts`.

- [ ] **Step 5: Sweep for leftovers**

Run: `grep -rn "dashboard?agent=\|dashboard?run=\|dashboard?view=" src/ --include="*.ts" --include="*.tsx"`
Expected: no matches outside comments/tests. Also `npm run typecheck` — PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: move Agent HQ to /agents

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Home assistant UI at `/dashboard`

**Files:**
- Create: `src/app/dashboard/page.tsx`
- Create: `src/app/dashboard/home-assistant.tsx`

**Interfaces:**
- Consumes: Task 5's chat API shapes (`SerializedMessage`, POST/GET/PATCH bodies), Task 4's extract response, existing `POST /api/agents/{id}/execute`, `Markdown` (`@/components/ui/markdown`), `Button` (`@/components/ui/button`), `notifyAgentsChanged` (`@/components/layout/sidebar`), `cn` (`@/lib/utils`), `useAuth` (`@/hooks/use-auth`), `toast` (sonner).

- [ ] **Step 1: Write the page shell with the legacy redirect**

Create `src/app/dashboard/page.tsx`:

```tsx
'use client'

import { Suspense, useEffect, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { HomeAssistant } from './home-assistant'

/**
 * Home — the workspace assistant. This route used to be Agent HQ, so legacy
 * deep links (?agent=, ?run=, ?view=) from old notifications, bookmarks, and
 * emails are forwarded to /agents with their params intact.
 */
function HomePage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const legacy = useMemo(
    () => ['agent', 'run', 'view'].some((key) => searchParams.get(key) !== null),
    [searchParams],
  )

  useEffect(() => {
    if (legacy) router.replace(`/agents?${searchParams.toString()}`)
  }, [legacy, router, searchParams])

  if (legacy) return null
  return <HomeAssistant />
}

export default function DashboardHomePage() {
  return (
    <Suspense fallback={null}>
      <HomePage />
    </Suspense>
  )
}
```

- [ ] **Step 2: Write the assistant component**

Create `src/app/dashboard/home-assistant.tsx`:

```tsx
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  ArrowUp,
  Cable,
  CalendarClock,
  Clock,
  ExternalLink,
  FileText,
  ListChecks,
  Loader2,
  MessageSquare,
  Paperclip,
  Play,
  Plus,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/components/ui/markdown'
import { notifyAgentsChanged } from '@/components/layout/sidebar'
import { useAuth } from '@/hooks/use-auth'
import { cn } from '@/lib/utils'

/**
 * Home — the workspace-level assistant. A Claude/ChatGPT-style chat surface:
 * hero + composer + preset chips before the first message, then a transcript.
 * The assistant answers oversight questions from server-assembled workspace
 * context, converts assignments (text or uploaded files) into agents after
 * aligning on delivery requirements, and can start runs when asked.
 */

type Attachment = { filename: string; text: string; truncated?: boolean }

type CreatedAgent = { id: string; title: string; icon: string; description: string }

type ExecutedRun = { executionId: string; agentId: string; status: string }

type ChatMessage = {
  id: string
  role: string
  content: string
  createdAt: string
  attachment?: { filename: string; truncated?: boolean } | null
  createdAgent?: CreatedAgent | null
  executedRun?: ExecutedRun | null
  action?: { type: 'execute'; agentId: string } | null
}

type SessionSummary = { id: string; title: string; updatedAt: string; messageCount: number }

/** Compact relative time for the history list, e.g. "just now", "2h", "3d". */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w`
  return `${Math.floor(days / 30)}mo`
}

// Preset chips are limited to what the assistant can actually do: convert
// assignments, report on runs, report on connections, and build agents.
const PRESETS: Array<{ label: string; icon: typeof FileText; prompt: string; sendNow: boolean }> = [
  {
    label: 'Turn an assignment into an agent',
    icon: FileText,
    prompt: 'I have an assignment I need handled. Here are the details: ',
    sendNow: false,
  },
  {
    label: 'What did my agents do this week?',
    icon: ListChecks,
    prompt: 'Summarize what my agents did recently — completed runs, failures, and anything waiting on me.',
    sendNow: true,
  },
  {
    label: 'Which connections need attention?',
    icon: Cable,
    prompt: 'Check my connections and integrations — is anything disconnected or erroring?',
    sendNow: true,
  },
  {
    label: 'Build me a daily briefing agent',
    icon: CalendarClock,
    prompt: 'Build me an agent that prepares a short daily briefing of my workspace activity every morning at 9am.',
    sendNow: true,
  },
]

export function HomeAssistant() {
  const { user } = useAuth()
  const router = useRouter()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [loadingSession, setLoadingSession] = useState(false)
  const [attachment, setAttachment] = useState<Attachment | null>(null)
  const [uploading, setUploading] = useState(false)
  const [runningId, setRunningId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const historyRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const loadSessions = useCallback(async () => {
    try {
      const response = await fetch('/api/assistant/chat/sessions', { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      setSessions(Array.isArray(data.sessions) ? data.sessions : [])
    } catch {
      setSessions([])
    }
  }, [])

  // Fresh chat on every visit; history stays reachable from the dropdown.
  useEffect(() => {
    void loadSessions()
  }, [loadSessions])

  // Close the history dropdown on an outside click.
  useEffect(() => {
    if (!historyOpen) return
    const onClick = (event: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(event.target as Node)) setHistoryOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [historyOpen])

  // Keep the newest message in view as the thread grows.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, sending])

  const startNewChat = () => {
    setHistoryOpen(false)
    setSessionId(null)
    setMessages([])
    setInput('')
    setAttachment(null)
  }

  const selectSession = async (id: string) => {
    setHistoryOpen(false)
    if (id === sessionId) return
    setLoadingSession(true)
    setMessages([])
    try {
      const response = await fetch(`/api/assistant/chat?sessionId=${encodeURIComponent(id)}`, { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      setMessages(Array.isArray(data.messages) ? data.messages : [])
      setSessionId(typeof data.sessionId === 'string' ? data.sessionId : id)
    } finally {
      setLoadingSession(false)
    }
  }

  /** Persist a started run on its source message so reloads still show it. */
  const recordRun = (messageId: string, executedRun: ExecutedRun) => {
    setMessages((previous) => previous.map((message) => (message.id === messageId ? { ...message, executedRun } : message)))
    fetch('/api/assistant/chat', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId, executedRun }),
    }).catch(() => undefined)
  }

  const executeAgent = useCallback(async (agentId: string, messageId: string, title?: string) => {
    setRunningId(agentId)
    try {
      const response = await fetch(`/api/agents/${agentId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'Run failed')
        return
      }
      if (data.result?.status === 'waiting_for_input') toast(`${title || 'The agent'} needs your input`)
      else toast.success(`${title || 'Agent'} run started`)
      if (data.executionId) {
        recordRun(messageId, { executionId: data.executionId, agentId, status: data.result?.status || data.status || 'pending' })
      }
      notifyAgentsChanged()
    } catch {
      toast.error('Could not start the run — check your connection and try again.')
    } finally {
      setRunningId(null)
    }
  }, [])

  const send = async (preset?: string) => {
    const content = (preset ?? input).trim()
    if (!content || sending || uploading) return
    setInput('')
    setSending(true)
    const localId = `local-${Date.now()}`
    const sentAttachment = attachment
    setAttachment(null)
    setMessages((previous) => [
      ...previous,
      {
        id: localId,
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
        attachment: sentAttachment ? { filename: sentAttachment.filename, truncated: sentAttachment.truncated } : null,
      },
    ])
    try {
      const response = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: content,
          ...(sessionId ? { sessionId } : {}),
          ...(sentAttachment ? { attachment: sentAttachment } : {}),
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'The assistant is unavailable right now.')
        setMessages((previous) => previous.filter((message) => message.id !== localId))
        setInput(content)
        setAttachment(sentAttachment)
        return
      }
      const returned: ChatMessage[] = Array.isArray(data.messages) ? data.messages : []
      setMessages((previous) => [...previous.filter((message) => message.id !== localId), ...returned])
      if (typeof data.sessionId === 'string') setSessionId(data.sessionId)
      if (returned.some((message) => message.createdAgent)) notifyAgentsChanged()
      // The assistant validated an explicit "run it" request — fire the
      // existing execute endpoint and pin the run onto the message.
      const actionMessage = returned.find((message) => message.action?.type === 'execute')
      if (actionMessage?.action) void executeAgent(actionMessage.action.agentId, actionMessage.id)
      void loadSessions()
    } finally {
      setSending(false)
    }
  }

  const uploadFile = async (file: File) => {
    setUploading(true)
    try {
      const form = new FormData()
      form.set('file', file)
      const response = await fetch('/api/assistant/extract', { method: 'POST', body: form })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'Could not read that file.')
        return
      }
      setAttachment({ filename: data.filename, text: data.text, truncated: data.truncated })
      if (data.truncated) toast('Long file — using the first part of it.')
      textareaRef.current?.focus()
    } catch {
      toast.error('Could not read that file — check your connection and try again.')
    } finally {
      setUploading(false)
    }
  }

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    if (preset.sendNow) {
      void send(preset.prompt)
      return
    }
    setInput(preset.prompt)
    textareaRef.current?.focus()
  }

  const onComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  const empty = messages.length === 0 && !sending && !loadingSession

  const composer = (
    <div className="w-full">
      {attachment && (
        <div className="mb-2 inline-flex items-center gap-2 rounded-full border bg-white px-3 py-1.5 text-sm text-gray-700 shadow-1">
          <FileText className="h-3.5 w-3.5 text-indigo-500" />
          <span className="max-w-[16rem] truncate">{attachment.filename}</span>
          {attachment.truncated && <span className="text-xs text-amber-600">(trimmed)</span>}
          <button
            type="button"
            aria-label="Remove attachment"
            className="rounded-full p-0.5 text-gray-400 transition-colors hover:text-gray-700"
            onClick={() => setAttachment(null)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div className="flex items-end gap-2 rounded-2xl border bg-white p-2 shadow-1 transition-shadow focus-within:ring-2 focus-within:ring-indigo-200">
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept=".txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.xml,.html,.htm,.pdf,.docx,text/*,application/pdf,application/json"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void uploadFile(file)
          }}
        />
        <Button
          size="icon"
          variant="ghost"
          className="h-9 w-9 shrink-0 rounded-full text-gray-500 hover:text-gray-800"
          aria-label="Attach an assignment file"
          title="Attach an assignment file"
          disabled={uploading || sending}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
        </Button>
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          onChange={(event) => {
            setInput(event.target.value)
            event.target.style.height = 'auto'
            event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`
          }}
          onKeyDown={onComposerKeyDown}
          placeholder={attachment ? 'What should be done with this assignment?' : 'Ask about your workspace, or describe an assignment…'}
          disabled={sending}
          className="max-h-40 min-h-[2.25rem] flex-1 resize-none bg-transparent py-1.5 text-sm outline-none placeholder:text-gray-400"
        />
        <Button
          size="icon"
          className="h-9 w-9 shrink-0 rounded-full"
          aria-label="Send message"
          disabled={sending || uploading || !input.trim()}
          onClick={() => void send()}
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  )

  return (
    <div className="flex h-screen min-h-0 flex-col bg-slate-50">
      {/* Header: new chat + history, mirroring the per-agent panel. */}
      <div className="flex shrink-0 items-center justify-between border-b bg-white px-4 py-3">
        <div>
          <p className="eyebrow">Home</p>
        </div>
        <div className="flex items-center gap-1" ref={historyRef}>
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="New chat" title="New chat" onClick={startNewChat} disabled={sending}>
            <Plus className="h-4 w-4" />
          </Button>
          <div className="relative">
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Chat history" title="Chat history" onClick={() => setHistoryOpen((open) => !open)}>
              <Clock className="h-4 w-4" />
            </Button>
            {historyOpen && (
              <div className="absolute right-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-md border bg-white shadow-popover">
                <p className="px-3 pb-1 pt-2 text-xs font-medium text-gray-500">Chat history</p>
                {sessions.length === 0 ? (
                  <p className="px-3 pb-3 pt-1 text-sm text-gray-500">No past chats yet.</p>
                ) : (
                  <ul className="max-h-72 overflow-y-auto pb-1">
                    {sessions.map((session) => (
                      <li key={session.id}>
                        <button
                          type="button"
                          onClick={() => void selectSession(session.id)}
                          className={cn(
                            'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-gray-50',
                            session.id === sessionId && 'bg-indigo-50',
                          )}
                        >
                          <MessageSquare className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                          <span className="min-w-0 flex-1 truncate">{session.title}</span>
                          <span className="shrink-0 text-xs text-gray-400">{relativeTime(session.updatedAt)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {empty ? (
        /* Hero: greeting + composer + presets, vertically centered. */
        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
          <div className="w-full max-w-2xl">
            <h1 className="text-center text-2xl font-semibold text-gray-900">
              Hey {user?.firstName || 'there'} — what should we take on?
            </h1>
            <p className="mt-2 text-center text-sm text-gray-500">
              Ask about anything happening in your workspace, or hand me an assignment and I&apos;ll turn it into an agent.
            </p>
            <div className="mt-6">{composer}</div>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  disabled={sending || uploading}
                  onClick={() => applyPreset(preset)}
                  className="flex items-center gap-1.5 rounded-full border bg-white px-3 py-1.5 text-sm text-gray-600 shadow-1 transition-colors hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700"
                >
                  <preset.icon className="h-3.5 w-3.5" />
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Transcript */}
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-3xl space-y-3 p-4">
              {loadingSession && (
                <div className="flex items-center justify-center p-6 text-gray-500">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              )}
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={cn(
                    'rounded-xl p-3 text-sm',
                    message.role === 'user' ? 'ml-12 bg-indigo-50' : 'mr-12 border bg-white',
                  )}
                >
                  {message.role === 'user' ? (
                    <>
                      {message.attachment && (
                        <span className="mb-1.5 inline-flex items-center gap-1.5 rounded-full border border-indigo-200 bg-white px-2 py-0.5 text-xs text-indigo-700">
                          <FileText className="h-3 w-3" /> {message.attachment.filename}
                        </span>
                      )}
                      <p className="whitespace-pre-wrap">{message.content}</p>
                    </>
                  ) : (
                    <>
                      <Markdown>{message.content}</Markdown>
                      {message.createdAgent && (
                        <div className="mt-3 rounded-lg border bg-gray-50 p-3">
                          <div className="flex items-center gap-2">
                            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white text-lg shadow-1">
                              {message.createdAgent.icon}
                            </span>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-semibold">{message.createdAgent.title}</p>
                              {message.createdAgent.description && (
                                <p className="truncate text-xs text-gray-500">{message.createdAgent.description}</p>
                              )}
                            </div>
                          </div>
                          <div className="mt-3 flex gap-2">
                            <Button
                              size="sm"
                              disabled={runningId === message.createdAgent.id}
                              onClick={() => void executeAgent(message.createdAgent!.id, message.id, message.createdAgent!.title)}
                            >
                              {runningId === message.createdAgent.id ? (
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Play className="mr-1.5 h-3.5 w-3.5" />
                              )}
                              Run
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => router.push(`/agents?agent=${message.createdAgent!.id}`)}>
                              <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> Open in Agents
                            </Button>
                          </div>
                        </div>
                      )}
                      {message.executedRun && (
                        <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
                          <span>Run started ({message.executedRun.status}).</span>
                          <button
                            type="button"
                            className="font-medium underline-offset-2 hover:underline"
                            onClick={() => router.push(`/agents?run=${message.executedRun!.executionId}`)}
                          >
                            View run
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
              {sending && (
                <div className="mr-12 flex items-center gap-2 rounded-xl border bg-white p-3 text-sm text-gray-500">
                  <Loader2 className="h-4 w-4 animate-spin" /> Thinking…
                </div>
              )}
            </div>
          </div>
          {/* Composer pinned to the bottom */}
          <div className="shrink-0 border-t bg-slate-50 p-4">
            <div className="mx-auto max-w-3xl">{composer}</div>
          </div>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Verify types, lint, and render**

Run: `npm run typecheck && npm run lint`
Expected: PASS for both.

Then start the dev server (`npm run dev`), sign in, and verify: `/dashboard` shows the hero with 4 preset chips; sending "Which connections need attention?" returns an answer; attaching a `.md` file shows the chip; `/dashboard?agent=new` redirects to `/agents?agent=new`; the sidebar shows Home + Agents and both highlight correctly.

- [ ] **Step 4: Commit**

```bash
git add src/app/dashboard
git commit -m "feat: add Home workspace assistant at /dashboard

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full check suite**

Run: `npm run check` (typecheck + lint + build) and `npm test`
Expected: all PASS. Fix anything that fails before proceeding — do not skip.

- [ ] **Step 2: End-to-end walkthrough in the dev app**

With `npm run dev` running and signed in:
1. Home hero renders; preset "Turn an assignment into an agent" prefills the composer.
2. Paste an assignment ("Every Friday, compile a summary of open Linear issues and email it to me") — the assistant asks clarifying questions OR creates the agent; after alignment a created-agent card appears with Run + Open in Agents.
3. The new agent appears in the sidebar tree (via `notifyAgentsChanged`).
4. Clicking Run starts a run; the run card links to `/agents?run=<id>`.
5. "What did my agents do this week?" answers from real run data.
6. History dropdown lists the conversation; New chat clears; reopening restores messages including the created-agent card.
7. Old-style link `/dashboard?view=templates` lands on the templates library under `/agents`.
8. A notification URL (`/agents?run=...`) opens the run in Agent HQ.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: home assistant verification fixes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(Skip this commit if Step 1–2 needed no changes.)
