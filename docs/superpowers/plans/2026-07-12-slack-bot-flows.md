# Slack-Bot Flows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flows can power Slack bots: an @mention, DM, channel message, or slash command triggers a published flow; the flow's output replies into the originating channel/thread; a thread carries a multi-turn conversation.

**Architecture:** A per-org `SlackWorkspaceConnection` binding (encrypted bot token + signing secret) exposes one signed public ingress URL per binding (`POST /api/slack/events/[bindingId]`) that mirrors the existing webhook trigger's `systemPrisma` posture. Pure logic lives in `src/lib/slack/*` (verify/payload/format/route-event/reply/session/manifest — all unit-testable without DB); the ingress route only does raw-body HMAC verification, dedup, echo-guard, fast-ack, and hands off to `after()`. A new `slack` trigger type joins `FLOW_TRIGGER_TYPES`; matched flows dispatch through the existing `dispatchFlowExecution` with the normalized Slack payload as input and a `trigger.slack` origin persisted on the run. A post-run hook in `runFlowExecution` replies to the origin; `SlackThreadSession` + the shipped `continueExecutionId` seed mode give threads multi-turn memory.

**Tech Stack:** Next.js 15.5 App Router (route handlers, `after()`), TypeScript strict, Prisma/Postgres, node:test via tsx (`TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <file>`), existing helpers: `encryptSecret`/`decryptSecret` (`src/lib/crypto/secrets.ts`), `rateLimit` (`src/lib/ratelimit.ts`), `cacheGet`/`cacheSet` (`src/lib/cache.ts`), `dispatchFlowExecution` (`src/features/flows/execute-flow.ts`).

## Global Constraints

Every task's requirements implicitly include these. Verbatim hard rules:

- **Route export hygiene:** `route.ts` files export ONLY HTTP handlers + config (`runtime`, `maxDuration`). All pure logic goes in `src/lib/slack/*`. (Next 15.5 hard rule.)
- **Raw-body HMAC before parse:** the Slack signature is computed over the exact request bytes (`await request.text()`); never JSON-parse-then-re-serialize before verifying.
- **Timing-safe compare:** signature comparison uses `crypto.timingSafeEqual` (length-mismatch returns false, never throws).
- **5-min timestamp window:** reject when `|now − x-slack-request-timestamp| > 300s`.
- **Ack <3s:** the ingress handler responds 200 immediately; routing + dispatch runs in `after()` (queue mode rides `dispatchFlowExecution`'s existing EXECUTION_MODE=queue path). Slash commands ack with `{"response_type":"ephemeral","text":"Working on it…"}`.
- **Org-scoped everything:** connection CRUD via `withAuthenticatedApi` (`auth.organizationId`); the ingress selects the binding by URL id only and never trusts payload org/team claims; all downstream queries are scoped to `binding.organizationId`.
- **Secrets encrypted + redacted:** bot token and signing secret stored via `encryptSecret` (the mcp-connections `authConfig` shape), never logged, never returned by any API response (redacted to `hasBotToken`/`hasSigningSecret`).
- **Published graph only:** slack-triggered runs always dispatch with `usePublished: true`, exactly like the webhook trigger.
- **Echo guard:** events authored by the binding's own `botUserId`, or carrying any `bot_id`, are dropped (v1: no bot-message opt-in) — prevents auto-reply loops. Dedup by `event_id`/`trigger_id` (10-min cache) prevents retry double-runs. Per-binding rate limit.
- **Existing flows byte-identical:** `'slack'` is purely additive. `manual|schedule|webhook|signal` behavior, existing trigger JSON, and existing run flows must not change. No edits to existing test expectations.

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` (+ migration) | `SlackWorkspaceConnection`, `SlackThreadSession` |
| `src/lib/slack/connections.ts` | secret JSON encode/decode, redacting serializer, `slackAuthTest`, ingress URL |
| `src/app/api/slack/connections/route.ts` | POST/GET/DELETE binding CRUD |
| `src/lib/slack/verify.ts` | HMAC compute + verify (pure) |
| `src/lib/slack/payload.ts` | event kinds, `SlackTriggerInput`, event/command normalization (pure, client-safe) |
| `src/lib/slack/format.ts` | output → mrkdwn + truncation (pure) |
| `src/app/api/slack/events/[bindingId]/route.ts` | signed ingress: verify, challenge, dedup, echo guard, fast-ack |
| `src/lib/slack/dispatch.ts` | `routeSlackEvent`: session precedence → matching → `dispatchFlowExecution` |
| `src/lib/slack/route-event.ts` | trigger-config parsing + `matchSlackFlows` (pure) |
| `src/lib/flows/trigger.ts`, `src/lib/flows/validate.ts` | `'slack'` trigger type + validation rules |
| `src/components/flows/step-card.tsx` | TriggerBody Slack panel |
| `src/lib/flows/copilot-grounding.ts` | copilot grounding line |
| `src/lib/slack/post.ts` | `chat.postMessage` / response_url posting |
| `src/lib/slack/reply.ts` | origin parsing, reply-text decision, suppression (pure) |
| `src/lib/slack/deliver.ts` | `deliverSlackRunReply` (loads binding, suppresses, posts, session upkeep) |
| `src/features/flows/execute-flow.ts` | post-run reply hook, `slackContinueExecutionId` seed |
| `src/lib/slack/session.ts` | session routing decision (pure) + session DB helpers |
| `src/lib/slack/manifest.ts` | `buildSlackManifest` (pure) |
| `src/app/api/slack/connections/[id]/manifest/route.ts` | manifest GET |
| `src/components/integrations/slack-bot-card.tsx` + `src/app/integrations/page.tsx` | setup UI |

**Pinned ambiguities (decisions this plan commits to):**

1. **"First agent step" (multi-turn seed):** the first SAVED-agent (`agentId` set) `runAgent` adapter invocation in this run's execution order, when `node.thread` is unset and the invocation is not itself a resume. Mechanism: a `slackSeedRemaining` boolean closed over by `runFlowExecution`, consumed once (Task 7). Inline-prompt agent steps (no `agentId`) early-return before the seed point and never consume it. With parallel branches "first" is race-ordered — documented limitation.
2. **Job field name:** `slackContinueExecutionId` on `FlowExecutionJob`.
3. **Suppression rule (Task 6):** the hook stays silent for `succeeded` when a SUCCEEDED tool step in this run routes to a slack plane (`parseFlowToolConnectionId` plane `native` + ref `slack`, or plane `nango` with `slack` in the ref) AND its persisted step input JSON contains the origin channel id. Unresolvable/templated args → the hook still posts (a duplicate reply beats silence). Questions/failures always post.
4. **Bot messages (v1):** ALL `bot_id`-authored events are dropped; the spec's "unless the flow opts into bot messages" opt-in is out of scope (no config field for it).
5. **Manifest scopes:** the spec lists `message.channels` as a *scope*; that is an event name. The manifest uses the real scope set `app_mentions:read, channels:history, chat:write, commands, im:history, im:read` and event subscriptions `app_mention, message.channels, message.im`.
6. **DELETE = hard delete** of the binding row plus its thread sessions (the ingress then 404s). `status` still supports `revoked` for future soft-revoke, but the DELETE endpoint removes the row.
7. **Slash-command replies:** `response_url` is used when present; a post failure (e.g. past its 30-min validity) falls back to `chat.postMessage` to the channel.
8. **Session close on unpublish:** lazy — when the ingress finds an open session whose flow is no longer ACTIVE+published, it closes the session and falls through to normal matching. Plus a 7-day `updatedAt` sweep in the cron dispatch tick.

---

### Task 1: Schema + secrets plumbing + `POST/GET/DELETE /api/slack/connections`

**Files:**
- Modify: `prisma/schema.prisma` (two new models + two back-relations on `Organization`)
- Create: `prisma/migrations/<timestamp>_slack_bot_flows/migration.sql` (generated by `prisma migrate dev`)
- Create: `src/lib/slack/connections.ts`
- Create: `src/app/api/slack/connections/route.ts`
- Test: `src/lib/slack/__tests__/connections.test.ts` (pure helpers, no DB)
- Test: `src/app/api/slack/__tests__/connections-route.test.ts` (DB-gated)

**Interfaces:**
- Consumes: `encryptSecret`/`decryptSecret` from `@/lib/crypto/secrets`; `withAuthenticatedApi`, `ApiError` from `@/lib/server/api-handler`; `prisma` from `@/lib/prisma`.
- Produces (later tasks import these exact names from `@/lib/slack/connections`):
  - `encryptSecretJson(plaintext: string): { value: string }`
  - `decryptSecretJson(payload: unknown): string` (throws on malformed)
  - `slackIngressUrl(bindingId: string): string`
  - `slackAuthTest(botToken: string, fetchImpl?: typeof fetch): Promise<{ teamId: string; teamName: string | null; botUserId: string }>`
  - `serializeSlackConnection(row): { id, teamId, teamName, botUserId, status, hasBotToken, hasSigningSecret, ingressUrl, createdAt, updatedAt }`
  - Prisma models `SlackWorkspaceConnection`, `SlackThreadSession` (client accessors `prisma.slackWorkspaceConnection`, `prisma.slackThreadSession`).

- [ ] **Step 1: Add both models to `prisma/schema.prisma`**

Append after the `FlowRunStep` model (keep file conventions: `@db.Uuid` org id, `@@map`, cascade relation):

```prisma
/// Per-org Slack bot binding: one row per (org, Slack workspace). botToken and
/// signingSecret hold {"value": "<encryptSecret payload>"} — never plaintext.
model SlackWorkspaceConnection {
  id             String   @id @default(cuid())
  organizationId String   @db.Uuid
  teamId         String // Slack workspace id (T…), captured from auth.test
  teamName       String?
  botUserId      String // U… — the bot's own user id, for echo-guarding
  botToken       Json // encrypted at rest (secrets.ts shape)
  signingSecret  Json // encrypted at rest
  status         String   @default("active") // active | error | revoked
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@unique([organizationId, teamId])
  @@map("slack_workspace_connections")
}

/// One Slack thread ↔ one flow conversation. Keyed by the reply thread; tracks
/// the latest run and the latest agent execution (the multi-turn seed).
model SlackThreadSession {
  id               String   @id @default(cuid())
  organizationId   String   @db.Uuid
  bindingId        String
  channel          String
  threadTs         String // the thread root ts
  flowId           String
  flowRunId        String // latest run in this thread
  agentExecutionId String? // latest agent execution (conversation seed)
  status           String   @default("open") // open | closed
  updatedAt        DateTime @updatedAt
  createdAt        DateTime @default(now())

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@unique([bindingId, channel, threadTs])
  @@index([flowRunId])
  @@map("slack_thread_sessions")
}
```

Inside `model Organization` (with the other back-relation arrays), add:

```prisma
  slackWorkspaceConnections SlackWorkspaceConnection[]
  slackThreadSessions       SlackThreadSession[]
```

- [ ] **Step 2: Generate the migration**

Run: `npx prisma migrate dev --name slack_bot_flows`
Expected: a new `prisma/migrations/<timestamp>_slack_bot_flows/migration.sql` with `CREATE TABLE "slack_workspace_connections"` and `CREATE TABLE "slack_thread_sessions"` (UUID FK to `organizations` ON DELETE CASCADE, unique indexes on `(organizationId, teamId)` and `(bindingId, channel, threadTs)`), and `prisma generate` succeeds.

- [ ] **Step 3: Write the failing pure-helper test**

Create `src/lib/slack/__tests__/connections.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encryptSecretJson, decryptSecretJson, slackIngressUrl, slackAuthTest, serializeSlackConnection } from '@/lib/slack/connections'

test('encryptSecretJson round-trips through decryptSecretJson', () => {
  const blob = encryptSecretJson('xoxb-secret-token')
  assert.equal(typeof blob.value, 'string')
  assert.notEqual(blob.value, 'xoxb-secret-token') // never stored raw (b64: at minimum)
  assert.equal(decryptSecretJson(blob), 'xoxb-secret-token')
})

test('decryptSecretJson throws on malformed payloads', () => {
  assert.throws(() => decryptSecretJson(null))
  assert.throws(() => decryptSecretJson({ nope: true }))
  assert.throws(() => decryptSecretJson('raw-string'))
})

test('slackIngressUrl embeds the binding id under /api/slack/events', () => {
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
  assert.equal(slackIngressUrl('bind_123'), 'https://app.example.com/api/slack/events/bind_123')
})

test('slackAuthTest verifies the token and captures team + bot user', async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({ ok: true, team_id: 'T0AAA111', team: 'Acme', user_id: 'U0BOT9999', bot_id: 'B0BOT9999' }))
  }) as typeof fetch
  const result = await slackAuthTest('xoxb-abc', fetchImpl)
  assert.deepEqual(result, { teamId: 'T0AAA111', teamName: 'Acme', botUserId: 'U0BOT9999' })
  assert.equal(calls[0].url, 'https://slack.com/api/auth.test')
  assert.match(String((calls[0].init.headers as Record<string, string>).Authorization), /Bearer xoxb-abc/)
})

test('slackAuthTest rejects a bad token (Slack returns HTTP 200 + ok:false)', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }))) as typeof fetch
  await assert.rejects(() => slackAuthTest('xoxb-bad', fetchImpl), /invalid_auth/)
})

test('serializeSlackConnection redacts secrets', () => {
  const now = new Date()
  const out = serializeSlackConnection({
    id: 'bind_1', organizationId: 'org', teamId: 'T0AAA111', teamName: 'Acme', botUserId: 'U0BOT9999',
    botToken: encryptSecretJson('xoxb-abc'), signingSecret: encryptSecretJson('sig'),
    status: 'active', createdAt: now, updatedAt: now,
  })
  assert.equal(out.hasBotToken, true)
  assert.equal(out.hasSigningSecret, true)
  assert.ok(!JSON.stringify(out).includes('xoxb'))
  assert.ok(out.ingressUrl.endsWith('/api/slack/events/bind_1'))
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/slack/__tests__/connections.test.ts`
Expected: FAIL — `Cannot find module '@/lib/slack/connections'`.

- [ ] **Step 5: Implement `src/lib/slack/connections.ts`**

```ts
/**
 * SlackWorkspaceConnection helpers: encrypted-at-rest secret storage (mirrors
 * the mcp-connections authConfig shape via secrets.ts), redacting serializer,
 * ingress URL, and the Slack auth.test verification call.
 */
import { encryptSecret, decryptSecret } from '@/lib/crypto/secrets'

const SLACK_AUTH_TEST_URL = 'https://slack.com/api/auth.test'

/** Storage shape for botToken / signingSecret Json columns. */
export function encryptSecretJson(plaintext: string): { value: string } {
  return { value: encryptSecret(plaintext) }
}

export function decryptSecretJson(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as { value?: unknown }).value !== 'string') {
    throw new Error('Malformed encrypted Slack secret payload')
  }
  return decryptSecret((payload as { value: string }).value)
}

export function slackIngressUrl(bindingId: string): string {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || ''
  return `${baseUrl}/api/slack/events/${bindingId}`
}

/**
 * Verify a bot token against Slack and capture the workspace identity.
 * Slack returns HTTP 200 even on failure — inspect body.ok. `user_id` on a
 * bot-token auth.test IS the bot's own user id (the echo-guard identity).
 */
export async function slackAuthTest(
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ teamId: string; teamName: string | null; botUserId: string }> {
  const response = await fetchImpl(SLACK_AUTH_TEST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json; charset=utf-8' },
    signal: AbortSignal.timeout(15_000),
  })
  const body = (await response.json()) as Record<string, unknown>
  if (body.ok !== true) throw new Error(`Slack auth.test failed: ${body.error ?? 'unknown'}`)
  const teamId = typeof body.team_id === 'string' ? body.team_id : ''
  const botUserId = typeof body.user_id === 'string' ? body.user_id : ''
  if (!teamId || !botUserId) throw new Error('Slack auth.test failed: missing team_id/user_id')
  return { teamId, teamName: typeof body.team === 'string' ? body.team : null, botUserId }
}

/** Redacted API view — secrets are NEVER included. */
export function serializeSlackConnection(row: {
  id: string
  teamId: string
  teamName: string | null
  botUserId: string
  botToken: unknown
  signingSecret: unknown
  status: string
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: row.id,
    teamId: row.teamId,
    teamName: row.teamName,
    botUserId: row.botUserId,
    status: row.status,
    hasBotToken: Boolean((row.botToken as { value?: unknown } | null)?.value),
    hasSigningSecret: Boolean((row.signingSecret as { value?: unknown } | null)?.value),
    ingressUrl: slackIngressUrl(row.id),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/slack/__tests__/connections.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 7: Write the failing DB-gated route test**

Create `src/app/api/slack/__tests__/connections-route.test.ts` (mirrors `src/app/api/__tests__/route-smoke.test.ts`'s gating + `test-auth` seam):

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'

  let prisma: any
  let seeded: any
  const realFetch = global.fetch

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    // Stub Slack auth.test — no live network in tests.
    global.fetch = (async (url: any, init?: any) => {
      if (String(url) === 'https://slack.com/api/auth.test') {
        return new Response(JSON.stringify({ ok: true, team_id: 'T0AAA111', team: 'Acme', user_id: 'U0BOT9999' }))
      }
      return realFetch(url, init)
    }) as typeof fetch
  })

  after(async () => {
    global.fetch = realFetch
    if (seeded) {
      await prisma.slackWorkspaceConnection.deleteMany({ where: { organizationId: seeded.organizationId } })
      await seeded.cleanup()
    }
  })

  const jsonReq = (method: string, body?: unknown, query = '') =>
    new NextRequest(new URL(`http://test/api/slack/connections${query}`), {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

  test('POST verifies via auth.test, encrypts, upserts, and returns a redacted binding', async () => {
    const { POST } = await import('@/app/api/slack/connections/route')
    const res = await POST(jsonReq('POST', { botToken: 'xoxb-live-token', signingSecret: 'sig-secret-1' }))
    assert.equal(res.status, 200)
    const data = await res.json()
    assert.equal(data.success, true)
    assert.equal(data.connection.teamId, 'T0AAA111')
    assert.equal(data.connection.botUserId, 'U0BOT9999')
    assert.equal(data.connection.hasBotToken, true)
    assert.ok(data.connection.ingressUrl.includes('/api/slack/events/'))
    assert.ok(!JSON.stringify(data).includes('xoxb-live-token'))
    assert.ok(!JSON.stringify(data).includes('sig-secret-1'))
    // Encrypted at rest, and posting again upserts the same (org, team) row.
    const row = await prisma.slackWorkspaceConnection.findFirst({ where: { organizationId: seeded.organizationId, teamId: 'T0AAA111' } })
    assert.ok(!JSON.stringify(row.botToken).includes('xoxb-live-token'))
    const res2 = await POST(jsonReq('POST', { botToken: 'xoxb-rotated', signingSecret: 'sig-secret-2' }))
    assert.equal((await res2.json()).connection.id, data.connection.id)
  })

  test('GET lists redacted bindings; DELETE removes the row', async () => {
    const { GET, DELETE } = await import('@/app/api/slack/connections/route')
    const list = await (await GET(jsonReq('GET'))).json()
    assert.equal(list.connections.length, 1)
    const id = list.connections[0].id
    const del = await DELETE(jsonReq('DELETE', undefined, `?id=${id}`))
    assert.equal((await del.json()).success, true)
    assert.equal(await prisma.slackWorkspaceConnection.count({ where: { organizationId: seeded.organizationId } }), 0)
  })
} else {
  test('slack connections route (skipped — TEST_DATABASE_URL not set)', () => {})
}
```

- [ ] **Step 8: Run to verify it fails**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/slack/__tests__/connections-route.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/slack/connections/route'` (or skip-pass when no test DB; in that case rely on Step 6 + typecheck and note it).

- [ ] **Step 9: Implement `src/app/api/slack/connections/route.ts`**

```ts
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { encryptSecretJson, serializeSlackConnection, slackAuthTest } from '@/lib/slack/connections'

const createSchema = z.object({
  botToken: z.string().min(1),
  signingSecret: z.string().min(1),
})

// ── GET — list org bindings (redacted) ────────────────────────────────────
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const connections = await prisma.slackWorkspaceConnection.findMany({
    where: { organizationId: auth.organizationId },
    orderBy: { createdAt: 'desc' },
  })
  return { success: true, connections: connections.map(serializeSlackConnection) }
})

// ── POST — create/refresh a binding ───────────────────────────────────────
export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = createSchema.parse(await request.json())
  // Verify the token against Slack and capture the workspace identity —
  // a bad token never reaches the database.
  let identity: Awaited<ReturnType<typeof slackAuthTest>>
  try {
    identity = await slackAuthTest(data.botToken)
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : 'Slack token verification failed', 400, 'SLACK_AUTH_FAILED')
  }
  const secrets = {
    teamName: identity.teamName,
    botUserId: identity.botUserId,
    botToken: encryptSecretJson(data.botToken) as unknown as Prisma.InputJsonValue,
    signingSecret: encryptSecretJson(data.signingSecret) as unknown as Prisma.InputJsonValue,
    status: 'active',
  }
  const connection = await prisma.slackWorkspaceConnection.upsert({
    where: { organizationId_teamId: { organizationId: auth.organizationId, teamId: identity.teamId } },
    create: { organizationId: auth.organizationId, teamId: identity.teamId, ...secrets },
    update: secrets,
  })
  return { success: true, connection: serializeSlackConnection(connection) }
})

// ── DELETE — remove a binding (and its thread sessions) ──────────────────
export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const url = new URL(request.url)
  const id = url.searchParams.get('id') || z.object({ id: z.string().min(1) }).parse(await request.json()).id
  const existing = await prisma.slackWorkspaceConnection.findFirst({ where: { id, organizationId: auth.organizationId } })
  if (!existing) throw new ApiError('Slack connection not found', 404, 'NOT_FOUND')
  await prisma.slackThreadSession.deleteMany({ where: { organizationId: auth.organizationId, bindingId: existing.id } })
  await prisma.slackWorkspaceConnection.delete({ where: { id: existing.id } })
  return { success: true }
})
```

- [ ] **Step 10: Run both tests + typecheck**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/slack/__tests__/connections.test.ts src/app/api/slack/__tests__/connections-route.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 11: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/slack/connections.ts src/lib/slack/__tests__/connections.test.ts src/app/api/slack/connections/route.ts src/app/api/slack/__tests__/connections-route.test.ts
git commit -m "feat(slack): SlackWorkspaceConnection + SlackThreadSession schema and binding CRUD"
```

---

### Task 2: Pure slack lib — `verify.ts`, `payload.ts`, `format.ts`

**Files:**
- Create: `src/lib/slack/verify.ts`
- Create: `src/lib/slack/payload.ts`
- Create: `src/lib/slack/format.ts`
- Test: `src/lib/slack/__tests__/verify.test.ts`
- Test: `src/lib/slack/__tests__/payload.test.ts`
- Test: `src/lib/slack/__tests__/format.test.ts`

**Interfaces (produced — later tasks import these exact names):**
- `verify.ts`: `SLACK_SIGNATURE_WINDOW_SECONDS = 300`; `computeSlackSignature(signingSecret: string, timestamp: string, rawBody: string): string` (returns `v0=<hex>`); `verifySlackSignature(args: { rawBody: string; timestamp: string | null; signature: string | null; signingSecret: string; nowMs?: number }): boolean`.
- `payload.ts` (client-safe — no node imports; the builder UI imports it):
  - `SLACK_EVENT_KINDS = ['app_mention', 'message.im', 'message.channels', 'slash_command'] as const`; `type SlackEventKind`.
  - `type SlackTriggerInput = { kind: SlackEventKind; text: string; user: string; channel: string; channelName?: string; ts: string; thread_ts?: string; team: string; command?: string; response_url?: string; permalink?: string }`
  - `type NormalizedSlackEvent = { input: SlackTriggerInput; dedupId: string; authorBotId?: string }`
  - `normalizeSlackEventPayload(envelope: unknown): NormalizedSlackEvent | null`
  - `normalizeSlackCommandPayload(params: Record<string, string>): NormalizedSlackEvent | null`
- `format.ts`: `SLACK_REPLY_MAX_CHARS = 4000`; `formatSlackReply(output: unknown, opts?: { runUrl?: string }): string`.

- [ ] **Step 1: Write the failing verify test (real HMAC vector computed in-test)**

Create `src/lib/slack/__tests__/verify.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import { computeSlackSignature, verifySlackSignature, SLACK_SIGNATURE_WINDOW_SECONDS } from '@/lib/slack/verify'

// Known vector, computed here from first principles so the helper can never
// drift from Slack's spec: v0=HMAC_SHA256(secret, "v0:{timestamp}:{rawBody}").
const SECRET = '8f742231b10e8888abcd99yyyzzz85a5'
const TIMESTAMP = '1752300000'
const RAW_BODY = 'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&command=%2Fweather&text=94070'
const EXPECTED =
  'v0=' + crypto.createHmac('sha256', SECRET).update(`v0:${TIMESTAMP}:${RAW_BODY}`, 'utf8').digest('hex')

test('computeSlackSignature matches the hand-computed HMAC vector', () => {
  assert.equal(computeSlackSignature(SECRET, TIMESTAMP, RAW_BODY), EXPECTED)
})

test('verifySlackSignature accepts a valid signature inside the window', () => {
  const ok = verifySlackSignature({
    rawBody: RAW_BODY, timestamp: TIMESTAMP, signature: EXPECTED,
    signingSecret: SECRET, nowMs: Number(TIMESTAMP) * 1000 + 60_000,
  })
  assert.equal(ok, true)
})

test('rejects a stale timestamp (> 300s skew, both directions)', () => {
  const base = { rawBody: RAW_BODY, timestamp: TIMESTAMP, signature: EXPECTED, signingSecret: SECRET }
  assert.equal(verifySlackSignature({ ...base, nowMs: (Number(TIMESTAMP) + SLACK_SIGNATURE_WINDOW_SECONDS + 1) * 1000 }), false)
  assert.equal(verifySlackSignature({ ...base, nowMs: (Number(TIMESTAMP) - SLACK_SIGNATURE_WINDOW_SECONDS - 1) * 1000 }), false)
})

test('rejects a tampered body, wrong secret, missing/garbled headers', () => {
  const nowMs = Number(TIMESTAMP) * 1000
  assert.equal(verifySlackSignature({ rawBody: RAW_BODY + 'x', timestamp: TIMESTAMP, signature: EXPECTED, signingSecret: SECRET, nowMs }), false)
  assert.equal(verifySlackSignature({ rawBody: RAW_BODY, timestamp: TIMESTAMP, signature: EXPECTED, signingSecret: 'wrong', nowMs }), false)
  assert.equal(verifySlackSignature({ rawBody: RAW_BODY, timestamp: null, signature: EXPECTED, signingSecret: SECRET, nowMs }), false)
  assert.equal(verifySlackSignature({ rawBody: RAW_BODY, timestamp: TIMESTAMP, signature: null, signingSecret: SECRET, nowMs }), false)
  assert.equal(verifySlackSignature({ rawBody: RAW_BODY, timestamp: 'not-a-number', signature: EXPECTED, signingSecret: SECRET, nowMs }), false)
  // Length mismatch must return false, not throw (timingSafeEqual throws on length mismatch).
  assert.equal(verifySlackSignature({ rawBody: RAW_BODY, timestamp: TIMESTAMP, signature: 'v0=short', signingSecret: SECRET, nowMs }), false)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/slack/__tests__/verify.test.ts`
Expected: FAIL — `Cannot find module '@/lib/slack/verify'`.

- [ ] **Step 3: Implement `src/lib/slack/verify.ts`**

```ts
/**
 * Slack request-signature verification (pure — unit-tested with known vectors).
 * v0=HMAC_SHA256(signingSecret, "v0:{timestamp}:{rawBody}") over the EXACT raw
 * request bytes, timing-safe compare, ±300s timestamp window.
 */
import crypto from 'crypto'

export const SLACK_SIGNATURE_WINDOW_SECONDS = 300

export function computeSlackSignature(signingSecret: string, timestamp: string, rawBody: string): string {
  return 'v0=' + crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`, 'utf8').digest('hex')
}

export function verifySlackSignature(args: {
  rawBody: string
  timestamp: string | null
  signature: string | null
  signingSecret: string
  nowMs?: number
}): boolean {
  const { rawBody, timestamp, signature, signingSecret } = args
  if (!timestamp || !signature) return false
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  const nowSeconds = Math.floor((args.nowMs ?? Date.now()) / 1000)
  if (Math.abs(nowSeconds - ts) > SLACK_SIGNATURE_WINDOW_SECONDS) return false
  const expected = Buffer.from(computeSlackSignature(signingSecret, timestamp, rawBody), 'utf8')
  const provided = Buffer.from(signature, 'utf8')
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided)
}
```

- [ ] **Step 4: Run verify tests — PASS**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/slack/__tests__/verify.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing payload test (real event/command shapes)**

Create `src/lib/slack/__tests__/payload.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSlackEventPayload, normalizeSlackCommandPayload, SLACK_EVENT_KINDS } from '@/lib/slack/payload'

const envelope = (event: Record<string, unknown>) => ({
  token: 'ignored',
  team_id: 'T0AAA111',
  api_app_id: 'A0AAA111',
  event,
  type: 'event_callback',
  event_id: 'Ev0AAA0001',
  event_time: 1752300000,
})

test('SLACK_EVENT_KINDS is the approved four', () => {
  assert.deepEqual([...SLACK_EVENT_KINDS], ['app_mention', 'message.im', 'message.channels', 'slash_command'])
})

test('normalizes an app_mention event_callback', () => {
  const result = normalizeSlackEventPayload(envelope({
    type: 'app_mention', user: 'U0USER111', text: '<@U0BOT9999> summarize today',
    ts: '1752300000.000100', channel: 'C0CHAN111', thread_ts: '1752299000.000100', event_ts: '1752300000.000100',
  }))
  assert.ok(result)
  assert.equal(result.input.kind, 'app_mention')
  assert.equal(result.input.text, '<@U0BOT9999> summarize today')
  assert.equal(result.input.user, 'U0USER111')
  assert.equal(result.input.channel, 'C0CHAN111')
  assert.equal(result.input.ts, '1752300000.000100')
  assert.equal(result.input.thread_ts, '1752299000.000100')
  assert.equal(result.input.team, 'T0AAA111')
  assert.equal(result.dedupId, 'Ev0AAA0001')
  assert.equal(result.authorBotId, undefined)
})

test('normalizes a DM (message + channel_type im) and a channel message', () => {
  const dm = normalizeSlackEventPayload(envelope({
    type: 'message', channel_type: 'im', user: 'U0USER111', text: 'hello bot',
    ts: '1752300001.000200', channel: 'D0DM11111',
  }))
  assert.equal(dm?.input.kind, 'message.im')
  const chan = normalizeSlackEventPayload(envelope({
    type: 'message', channel_type: 'channel', user: 'U0USER111', text: 'deploy please',
    ts: '1752300002.000300', channel: 'C0CHAN111',
  }))
  assert.equal(chan?.input.kind, 'message.channels')
  assert.equal(chan?.input.thread_ts, undefined)
})

test('surfaces bot_id for the echo guard; drops subtyped/unsupported events', () => {
  const bot = normalizeSlackEventPayload(envelope({
    type: 'message', channel_type: 'channel', bot_id: 'B0BOT9999', text: 'I am a bot',
    ts: '1752300003.000400', channel: 'C0CHAN111',
  }))
  assert.equal(bot?.authorBotId, 'B0BOT9999')
  // message_changed / channel_join etc. are edits and noise, not new input
  assert.equal(normalizeSlackEventPayload(envelope({ type: 'message', subtype: 'message_changed', channel_type: 'channel', ts: '1', channel: 'C1' })), null)
  assert.equal(normalizeSlackEventPayload(envelope({ type: 'reaction_added', user: 'U1' })), null)
  assert.equal(normalizeSlackEventPayload(envelope({ type: 'message', channel_type: 'mpim', user: 'U1', text: 'x', ts: '1', channel: 'G1' })), null)
  assert.equal(normalizeSlackEventPayload({ type: 'url_verification', challenge: 'x' }), null)
  assert.equal(normalizeSlackEventPayload(null), null)
})

test('normalizes a slash-command form payload', () => {
  const result = normalizeSlackCommandPayload({
    token: 'ignored', team_id: 'T0AAA111', channel_id: 'C0CHAN111', channel_name: 'general',
    user_id: 'U0USER111', command: '/deploy', text: 'prod eu-west',
    response_url: 'https://hooks.slack.com/commands/T0AAA111/123/abc',
    trigger_id: '13345224609.738474920.8088930838d88f008e0', api_app_id: 'A0AAA111',
  })
  assert.ok(result)
  assert.equal(result.input.kind, 'slash_command')
  assert.equal(result.input.command, '/deploy')
  assert.equal(result.input.text, 'prod eu-west')
  assert.equal(result.input.channel, 'C0CHAN111')
  assert.equal(result.input.channelName, 'general')
  assert.equal(result.input.response_url, 'https://hooks.slack.com/commands/T0AAA111/123/abc')
  assert.equal(result.input.ts, '')
  assert.equal(result.dedupId, '13345224609.738474920.8088930838d88f008e0')
  assert.equal(normalizeSlackCommandPayload({ team_id: 'T1' }), null) // no command → not a slash payload
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/slack/__tests__/payload.test.ts`
Expected: FAIL — `Cannot find module '@/lib/slack/payload'`.

- [ ] **Step 7: Implement `src/lib/slack/payload.ts`**

```ts
/**
 * Slack payload normalization (pure, CLIENT-SAFE — no node imports; the
 * builder UI imports SLACK_EVENT_KINDS). Both event callbacks and slash
 * commands map to one SlackTriggerInput, exposed to the flow as
 * {{trigger.input.text}}, {{trigger.input.channel}}, etc.
 */
export const SLACK_EVENT_KINDS = ['app_mention', 'message.im', 'message.channels', 'slash_command'] as const
export type SlackEventKind = (typeof SLACK_EVENT_KINDS)[number]

export type SlackTriggerInput = {
  kind: SlackEventKind
  text: string
  user: string
  channel: string
  channelName?: string
  ts: string
  thread_ts?: string
  team: string
  command?: string
  response_url?: string
  permalink?: string
}

export type NormalizedSlackEvent = {
  input: SlackTriggerInput
  /** event_id (events) / trigger_id (commands) — the 10-minute dedup key. */
  dedupId: string
  /** Present when a bot authored the message — the echo guard drops these. */
  authorBotId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

export function normalizeSlackEventPayload(envelope: unknown): NormalizedSlackEvent | null {
  if (!isRecord(envelope) || envelope.type !== 'event_callback' || !isRecord(envelope.event)) return null
  const event = envelope.event
  // Subtyped messages (message_changed, message_deleted, channel_join, …) are
  // edits/noise, never fresh input. Bot messages arrive subtype-less with
  // bot_id set — normalized through so the route's echo guard owns the drop.
  if (typeof event.subtype === 'string') return null
  let kind: SlackEventKind | null = null
  if (event.type === 'app_mention') kind = 'app_mention'
  else if (event.type === 'message' && event.channel_type === 'im') kind = 'message.im'
  else if (event.type === 'message' && event.channel_type === 'channel') kind = 'message.channels'
  if (!kind) return null // v1: no mpim/group support
  const dedupId = str(envelope.event_id)
  if (!dedupId) return null
  return {
    input: {
      kind,
      text: str(event.text),
      user: str(event.user),
      channel: str(event.channel),
      ts: str(event.ts),
      ...(str(event.thread_ts) ? { thread_ts: str(event.thread_ts) } : {}),
      team: str(envelope.team_id),
    },
    dedupId,
    ...(str(event.bot_id) ? { authorBotId: str(event.bot_id) } : {}),
  }
}

export function normalizeSlackCommandPayload(params: Record<string, string>): NormalizedSlackEvent | null {
  if (!params.command || !params.trigger_id) return null
  return {
    input: {
      kind: 'slash_command',
      text: params.text ?? '',
      user: params.user_id ?? '',
      channel: params.channel_id ?? '',
      ...(params.channel_name ? { channelName: params.channel_name } : {}),
      ts: '', // slash commands carry no message ts — replies use response_url
      team: params.team_id ?? '',
      command: params.command,
      ...(params.response_url ? { response_url: params.response_url } : {}),
    },
    dedupId: params.trigger_id,
  }
}
```

- [ ] **Step 8: Run payload tests — PASS**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/slack/__tests__/payload.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 9: Write the failing format test**

Create `src/lib/slack/__tests__/format.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatSlackReply, SLACK_REPLY_MAX_CHARS } from '@/lib/slack/format'

test('strings pass through untouched', () => {
  assert.equal(formatSlackReply('Deployed *v1.2* to prod'), 'Deployed *v1.2* to prod')
})

test('objects/arrays become fenced JSON', () => {
  assert.equal(formatSlackReply({ ok: true, count: 2 }), '```json\n' + JSON.stringify({ ok: true, count: 2 }, null, 2) + '\n```')
  assert.ok(formatSlackReply([1, 2, 3]).startsWith('```json\n'))
})

test('null/undefined/empty degrade to a placeholder', () => {
  assert.equal(formatSlackReply(null), '_(no output)_')
  assert.equal(formatSlackReply(undefined), '_(no output)_')
  assert.equal(formatSlackReply(''), '_(no output)_')
})

test('long output truncates to 4k chars with a run-link suffix', () => {
  const long = 'x'.repeat(SLACK_REPLY_MAX_CHARS + 500)
  const out = formatSlackReply(long, { runUrl: 'https://app.test/flows/f1/activity' })
  assert.ok(out.length <= SLACK_REPLY_MAX_CHARS)
  assert.ok(out.endsWith('_…truncated — full output: https://app.test/flows/f1/activity_'))
  const noLink = formatSlackReply(long)
  assert.ok(noLink.length <= SLACK_REPLY_MAX_CHARS)
  assert.ok(noLink.endsWith('_…truncated_'))
})
```

- [ ] **Step 10: Run to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/slack/__tests__/format.test.ts`
Expected: FAIL — `Cannot find module '@/lib/slack/format'`.

- [ ] **Step 11: Implement `src/lib/slack/format.ts`**

```ts
/** Flow output → Slack mrkdwn (pure). Strings pass through; objects/arrays
 * become fenced JSON; 4k-char truncation with a run-link suffix. */
export const SLACK_REPLY_MAX_CHARS = 4000

export function formatSlackReply(output: unknown, opts: { runUrl?: string } = {}): string {
  let text: string
  if (output === null || output === undefined || output === '') text = '_(no output)_'
  else if (typeof output === 'string') text = output
  else if (typeof output === 'object') {
    try {
      text = '```json\n' + JSON.stringify(output, null, 2) + '\n```'
    } catch {
      text = String(output)
    }
  } else text = String(output)

  if (text.length <= SLACK_REPLY_MAX_CHARS) return text
  const suffix = opts.runUrl ? `\n_…truncated — full output: ${opts.runUrl}_` : '\n_…truncated_'
  return text.slice(0, SLACK_REPLY_MAX_CHARS - suffix.length) + suffix
}
```

- [ ] **Step 12: Run all three lib tests + typecheck**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/slack/__tests__/verify.test.ts src/lib/slack/__tests__/payload.test.ts src/lib/slack/__tests__/format.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add src/lib/slack/verify.ts src/lib/slack/payload.ts src/lib/slack/format.ts src/lib/slack/__tests__/verify.test.ts src/lib/slack/__tests__/payload.test.ts src/lib/slack/__tests__/format.test.ts
git commit -m "feat(slack): pure verify/payload/format helpers with HMAC vectors"
```

---

### Task 3: Signed ingress route `POST /api/slack/events/[bindingId]`

**Files:**
- Create: `src/app/api/slack/events/[bindingId]/route.ts`
- Create: `src/lib/slack/dispatch.ts` (routing stub — Task 5 fills it in)
- Test: `src/app/api/slack/__tests__/events-route.test.ts` (DB-gated)

**Interfaces:**
- Consumes: `verifySlackSignature` (Task 2), `normalizeSlackEventPayload`/`normalizeSlackCommandPayload` (Task 2), `decryptSecretJson` (Task 1), `rateLimit` from `@/lib/ratelimit`, `cacheGet`/`cacheSet` from `@/lib/cache`, `systemPrisma` from `@/lib/prisma`, `after` from `next/server`.
- Produces: `routeSlackEvent(args: { bindingId: string; organizationId: string; botUserId: string; normalized: NormalizedSlackEvent }): Promise<void>` in `src/lib/slack/dispatch.ts` — Task 5 replaces the stub body, the signature is FINAL here.

- [ ] **Step 1: Create the routing stub `src/lib/slack/dispatch.ts`**

```ts
import { apiLogger } from '@/lib/logger'
import type { NormalizedSlackEvent } from '@/lib/slack/payload'

export type SlackRouteArgs = {
  bindingId: string
  organizationId: string
  botUserId: string
  normalized: NormalizedSlackEvent
}

/**
 * Route a verified, deduped, non-bot Slack event to matching flows.
 * Runs inside after() — the HTTP ack has already gone out.
 * Task 5 implements matching + dispatch; this stub only logs.
 */
export async function routeSlackEvent(args: SlackRouteArgs): Promise<void> {
  apiLogger.info('slack event received (routing not yet implemented)', {
    bindingId: args.bindingId,
    kind: args.normalized.input.kind,
  })
}
```

- [ ] **Step 2: Write the failing route test**

Create `src/app/api/slack/__tests__/events-route.test.ts`:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  const SIGNING_SECRET = 'test-signing-secret-1234'
  let prisma: any
  let seeded: any
  let bindingId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    const { encryptSecretJson } = await import('@/lib/slack/connections')
    seeded = await seedTestOrg(prisma)
    const binding = await prisma.slackWorkspaceConnection.create({
      data: {
        organizationId: seeded.organizationId, teamId: 'T0AAA111', teamName: 'Acme',
        botUserId: 'U0BOT9999',
        botToken: encryptSecretJson('xoxb-test'), signingSecret: encryptSecretJson(SIGNING_SECRET),
      },
    })
    bindingId = binding.id
  })

  after(async () => {
    if (seeded) {
      await prisma.slackWorkspaceConnection.deleteMany({ where: { organizationId: seeded.organizationId } })
      await seeded.cleanup()
    }
  })

  const signed = (rawBody: string, contentType: string, overrides: Record<string, string> = {}) => {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = 'v0=' + crypto.createHmac('sha256', SIGNING_SECRET).update(`v0:${timestamp}:${rawBody}`, 'utf8').digest('hex')
    return new NextRequest(new URL(`http://test/api/slack/events/${bindingId}`), {
      method: 'POST',
      headers: {
        'content-type': contentType,
        'x-slack-request-timestamp': overrides.timestamp ?? timestamp,
        'x-slack-signature': overrides.signature ?? signature,
      },
      body: rawBody,
    })
  }

  const mentionEnvelope = (eventId: string) => JSON.stringify({
    token: 'ignored', team_id: 'T0AAA111', api_app_id: 'A0AAA111', type: 'event_callback',
    event_id: eventId, event_time: 1752300000,
    event: { type: 'app_mention', user: 'U0USER111', text: '<@U0BOT9999> hello', ts: '1752300000.000100', channel: 'C0CHAN111' },
  })

  test('url_verification echoes the challenge (after signature verification)', async () => {
    const { POST } = await import('@/app/api/slack/events/[bindingId]/route')
    const raw = JSON.stringify({ type: 'url_verification', token: 'ignored', challenge: 'ch4LL3nge' })
    const res = await POST(signed(raw, 'application/json'))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { challenge: 'ch4LL3nge' })
  })

  test('bad signature → 401; unknown binding → 404', async () => {
    const { POST } = await import('@/app/api/slack/events/[bindingId]/route')
    const raw = mentionEnvelope('Ev0BAD0001')
    const bad = await POST(signed(raw, 'application/json', { signature: 'v0=' + 'ab'.repeat(32) }))
    assert.equal(bad.status, 401)
    const req404 = new NextRequest(new URL('http://test/api/slack/events/nonexistent'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: raw,
    })
    assert.equal((await POST(req404)).status, 404)
  })

  test('valid event acks 200 fast; duplicate event_id is dropped (ok:duplicate)', async () => {
    const { POST } = await import('@/app/api/slack/events/[bindingId]/route')
    const raw = mentionEnvelope('Ev0DEDUP01')
    const first = await POST(signed(raw, 'application/json'))
    assert.equal(first.status, 200)
    assert.deepEqual(await first.json(), { ok: true })
    const second = await POST(signed(raw, 'application/json'))
    assert.deepEqual(await second.json(), { ok: true, duplicate: true })
  })

  test('echo guard: events from the binding bot user or any bot_id are dropped', async () => {
    const { POST } = await import('@/app/api/slack/events/[bindingId]/route')
    const own = JSON.stringify({
      token: 'x', team_id: 'T0AAA111', type: 'event_callback', event_id: 'Ev0ECHO001', event_time: 1,
      event: { type: 'message', channel_type: 'channel', user: 'U0BOT9999', text: 'my own reply', ts: '2.0', channel: 'C0CHAN111' },
    })
    const res = await POST(signed(own, 'application/json'))
    assert.deepEqual(await res.json(), { ok: true, dropped: 'echo' })
  })

  test('slash command acks with the ephemeral working message', async () => {
    const { POST } = await import('@/app/api/slack/events/[bindingId]/route')
    const raw = new URLSearchParams({
      token: 'x', team_id: 'T0AAA111', channel_id: 'C0CHAN111', channel_name: 'general',
      user_id: 'U0USER111', command: '/deploy', text: 'prod',
      response_url: 'https://hooks.slack.com/commands/T0AAA111/123/abc', trigger_id: '111.222.333',
    }).toString()
    const res = await POST(signed(raw, 'application/x-www-form-urlencoded'))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { response_type: 'ephemeral', text: 'Working on it…' })
  })
} else {
  test('slack events route (skipped — TEST_DATABASE_URL not set)', () => {})
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/slack/__tests__/events-route.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/slack/events/[bindingId]/route'`.

- [ ] **Step 4: Implement `src/app/api/slack/events/[bindingId]/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { rateLimit } from '@/lib/ratelimit'
import { cacheGet, cacheSet } from '@/lib/cache'
import { decryptSecretJson } from '@/lib/slack/connections'
import { verifySlackSignature } from '@/lib/slack/verify'
import { normalizeSlackEventPayload, normalizeSlackCommandPayload } from '@/lib/slack/payload'
import { routeSlackEvent } from '@/lib/slack/dispatch'

export const runtime = 'nodejs'
export const maxDuration = 300

const DEDUP_TTL_MS = 10 * 60_000

// Slack ingress — one URL per binding (deterministic tenant lookup, what the
// manifest embeds). Public, session-less: mirrors the webhook trigger's
// systemPrisma posture, authenticated by Slack's request signature instead of
// a per-flow secret. Ack fast (<3s); routing + dispatch runs in after().
export async function POST(request: NextRequest) {
  try {
    const bindingId = request.nextUrl.pathname.split('/').at(-1)
    // Public endpoint — throttle per binding to blunt floods (mirrors flow-trigger).
    const limited = await rateLimit(`slack-events:${bindingId ?? 'unknown'}`, { limit: 120, windowMs: 60_000 })
    if (!limited.ok) return NextResponse.json({ ok: false, error: 'Rate limit exceeded' }, { status: 429 })
    if (!bindingId) return NextResponse.json({ ok: false }, { status: 404 })

    // Raw body FIRST — the signature is computed over the exact bytes.
    const rawBody = await request.text()

    // systemPrisma: session-less ingress; the binding row (URL id) is the sole
    // tenant selector — payload team/org claims are never trusted.
    const binding = await systemPrisma.slackWorkspaceConnection.findFirst({ where: { id: bindingId, status: 'active' } })
    if (!binding) return NextResponse.json({ ok: false }, { status: 404 })

    // Slack signs EVERY request, including url_verification.
    const verified = verifySlackSignature({
      rawBody,
      timestamp: request.headers.get('x-slack-request-timestamp'),
      signature: request.headers.get('x-slack-signature'),
      signingSecret: decryptSecretJson(binding.signingSecret),
    })
    if (!verified) return NextResponse.json({ ok: false, error: 'Invalid signature' }, { status: 401 })

    const contentType = (request.headers.get('content-type') || '').toLowerCase()
    const isForm = contentType.includes('application/x-www-form-urlencoded')
    let parsed: unknown = null
    if (!isForm) {
      try {
        parsed = JSON.parse(rawBody)
      } catch {
        return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
      }
      const maybe = parsed as { type?: unknown; challenge?: unknown }
      if (maybe.type === 'url_verification' && typeof maybe.challenge === 'string') {
        return NextResponse.json({ challenge: maybe.challenge })
      }
    }

    const normalized = isForm
      ? normalizeSlackCommandPayload(Object.fromEntries(new URLSearchParams(rawBody)))
      : normalizeSlackEventPayload(parsed)
    // Unsupported event types still ack 200 — a non-2xx would make Slack retry.
    if (!normalized) return NextResponse.json({ ok: true, ignored: true })

    // Dedup: Slack retries on slow acks — drop event_ids/trigger_ids seen in
    // the last 10 minutes.
    const dedupKey = `slack-event:${binding.id}:${normalized.dedupId}`
    if (await cacheGet<number>(dedupKey)) return NextResponse.json({ ok: true, duplicate: true })
    await cacheSet(dedupKey, 1, DEDUP_TTL_MS)

    // Echo guard: never react to our own (or any bot's) messages — reply loops.
    if (normalized.authorBotId || normalized.input.user === binding.botUserId) {
      return NextResponse.json({ ok: true, dropped: 'echo' })
    }

    const routeArgs = {
      bindingId: binding.id,
      organizationId: binding.organizationId,
      botUserId: binding.botUserId,
      normalized,
    }
    // Ack fast: routing + dispatch continues past the response via after().
    after(() =>
      routeSlackEvent(routeArgs).catch((error) =>
        apiLogger.error('slack event routing failed', { bindingId: binding.id, error: error instanceof Error ? error.message : String(error) }),
      ),
    )
    if (normalized.input.kind === 'slash_command') {
      return NextResponse.json({ response_type: 'ephemeral', text: 'Working on it…' })
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    apiLogger.error('slack ingress failed', { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ ok: false, error: 'Internal server error' }, { status: 500 })
  }
}
```

- [ ] **Step 5: Run the route test — PASS**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/slack/__tests__/events-route.test.ts && npx tsc --noEmit`
Expected: PASS (5 tests), no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/slack/events src/lib/slack/dispatch.ts src/app/api/slack/__tests__/events-route.test.ts
git commit -m "feat(slack): signed ingress route — challenge, HMAC, dedup, echo guard, fast-ack"
```

---

### Task 4: `slack` trigger type — trigger.ts, validate.ts, TriggerBody panel, copilot grounding

**Files:**
- Modify: `src/lib/flows/trigger.ts:3` (`FLOW_TRIGGER_TYPES`)
- Modify: `src/lib/flows/validate.ts:167-216` (`validateTriggerConfig`)
- Modify: `src/components/flows/step-card.tsx` (TriggerData type ~line 81, TRIGGER_SUBTYPE_ICON ~line 104, TriggerBody ~line 953)
- Modify: `src/lib/flows/copilot-grounding.ts:47` (append one rule line)
- Test: `src/lib/flows/__tests__/slack-trigger.test.ts`

**Interfaces:**
- Consumes: `SLACK_EVENT_KINDS`, `SlackEventKind` from `@/lib/slack/payload` (client-safe).
- Produces: `'slack'` is a valid `FlowTriggerType`; trigger config shape stored on the trigger node (and synced to `Flow.trigger` by the existing save/publish path — no changes needed there since `normalizeFlowTrigger` spreads unknown keys): `{ type: 'slack', events: SlackEventKind[], command?: string, channels?: string[], keyword?: string, threadMemory?: boolean }`. Validation codes: `MISSING_SLACK_EVENTS`, `INVALID_SLACK_EVENT`, `MISSING_SLACK_COMMAND`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/flows/__tests__/slack-trigger.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FLOW_TRIGGER_TYPES, normalizeFlowTrigger } from '@/lib/flows/trigger'
import { validateFlowGraph } from '@/lib/flows/validate'
import type { FlowGraph } from '@/lib/flows/graph'

const graphWith = (trigger: Record<string, unknown>): FlowGraph =>
  ({
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger } },
      { id: 'a1', type: 'agent', position: { x: 0, y: 0 }, data: { agentId: '', prompt: 'Reply helpfully', input: '{{trigger.input.text}}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'a1' }],
  }) as unknown as FlowGraph

test('slack is a known trigger type and normalizes intact', () => {
  assert.ok((FLOW_TRIGGER_TYPES as readonly string[]).includes('slack'))
  const trigger = normalizeFlowTrigger({ type: 'slack', events: ['app_mention'], threadMemory: true })
  assert.equal(trigger.type, 'slack')
  assert.deepEqual(trigger.events, ['app_mention'])
  assert.equal(trigger.threadMemory, true)
})

test('slack trigger requires at least one valid event kind', () => {
  const none = validateFlowGraph(graphWith({ type: 'slack' }))
  assert.ok(none.errors.some((e) => e.code === 'MISSING_SLACK_EVENTS'))
  const empty = validateFlowGraph(graphWith({ type: 'slack', events: [] }))
  assert.ok(empty.errors.some((e) => e.code === 'MISSING_SLACK_EVENTS'))
  const bogus = validateFlowGraph(graphWith({ type: 'slack', events: ['app_mention', 'reaction_added'] }))
  assert.ok(bogus.errors.some((e) => e.code === 'INVALID_SLACK_EVENT'))
})

test('slash_command requires a command; other kinds do not', () => {
  const missing = validateFlowGraph(graphWith({ type: 'slack', events: ['slash_command'] }))
  assert.ok(missing.errors.some((e) => e.code === 'MISSING_SLACK_COMMAND'))
  const ok = validateFlowGraph(graphWith({ type: 'slack', events: ['slash_command'], command: '/deploy' }))
  assert.ok(!ok.errors.some((e) => e.code.startsWith('MISSING_SLACK') || e.code.startsWith('INVALID_SLACK')))
  const mention = validateFlowGraph(graphWith({ type: 'slack', events: ['app_mention'] }))
  assert.ok(!mention.errors.some((e) => e.code === 'MISSING_SLACK_COMMAND'))
})

test('existing trigger types are untouched (additive change)', () => {
  const webhook = validateFlowGraph(graphWith({ type: 'webhook' }))
  assert.ok(!webhook.errors.some((e) => e.code.includes('SLACK')))
  assert.deepEqual((FLOW_TRIGGER_TYPES as readonly string[]).slice(0, 4), ['manual', 'schedule', 'webhook', 'signal'])
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/slack-trigger.test.ts`
Expected: FAIL — `'slack'` not in `FLOW_TRIGGER_TYPES`, missing error codes.

- [ ] **Step 3: Add `'slack'` to `src/lib/flows/trigger.ts`**

Change line 3 (append to the tuple — additive, keep order):

```ts
export const FLOW_TRIGGER_TYPES = ['manual', 'schedule', 'webhook', 'signal', 'slack'] as const
```

- [ ] **Step 4: Add slack rules to `validateTriggerConfig` in `src/lib/flows/validate.ts`**

Add the import at the top of the file:

```ts
import { SLACK_EVENT_KINDS } from '@/lib/slack/payload'
```

Inside `validateTriggerConfig`, insert BEFORE the `if (type !== 'schedule') return` line (line 200):

```ts
  if (type === 'slack') {
    const events = Array.isArray(trigger.events) ? trigger.events : []
    if (events.length === 0) {
      add(issues, 'error', 'MISSING_SLACK_EVENTS', 'A Slack trigger needs at least one event kind (mention, DM, channel message, or slash command).', 'trigger')
    }
    for (const kind of events) {
      if (typeof kind !== 'string' || !(SLACK_EVENT_KINDS as readonly string[]).includes(kind)) {
        add(issues, 'error', 'INVALID_SLACK_EVENT', `Slack trigger has an unknown event kind "${String(kind)}".`, 'trigger')
      }
    }
    if (events.includes('slash_command') && !String(trigger.command ?? '').trim()) {
      add(issues, 'error', 'MISSING_SLACK_COMMAND', 'A slash-command Slack trigger needs the command (e.g. /deploy).', 'trigger')
    }
    return
  }
```

- [ ] **Step 5: Run the test — PASS**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/slack-trigger.test.ts`
Expected: PASS (4 tests). Also run the existing suites to prove additivity: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/trigger.test.ts src/lib/flows/__tests__/validate.test.ts` → PASS unchanged.

- [ ] **Step 6: Add the Slack panel to TriggerBody in `src/components/flows/step-card.tsx`**

(a) Extend `TriggerData` (line 81) — add `'slack'` to the type union and the slack fields:

```ts
type TriggerData = {
  type?: 'manual' | 'schedule' | 'webhook' | 'signal' | 'slack'
  schedule?: { type?: string; time?: string; cron?: string; timezone?: string; runAt?: string; isActive?: boolean }
  input?: string
  inputFields?: TriggerInputField[]
  signal?: string
  events?: string[]
  command?: string
  channels?: string[]
  keyword?: string
  threadMemory?: boolean
  /** "Only run when…": the run is skipped unless these clauses match the trigger payload. */
  filter?: { match?: 'all' | 'any'; clauses?: ConditionClause[] }
}
```

(b) Add the icon (line 104 map; `MessageSquare` is imported from `lucide-react` — add it to the existing lucide import if absent):

```ts
const TRIGGER_SUBTYPE_ICON: Record<string, typeof Bot> = {
  webhook: Webhook,
  schedule: Clock,
  signal: Radio,
  manual: Zap,
  slack: MessageSquare,
}
```

(c) In TriggerBody's trigger-type `<select>` (line 1073-1085): widen the cast and add the option:

```tsx
            const next = event.target.value as 'manual' | 'schedule' | 'webhook' | 'signal' | 'slack'
```

```tsx
          <option value="slack">When a Slack message arrives</option>
```

(d) Add the panel after the webhook block (after line 1187), plus imports at top of file: `import { SLACK_EVENT_KINDS } from '@/lib/slack/payload'` and `useEffect` (already imported via react). Add state next to the `webhook` state in TriggerBody (line 963):

```tsx
  const [slackBinding, setSlackBinding] = useState<{ id: string; teamName: string | null; status: string; ingressUrl: string } | null>(null)
  useEffect(() => {
    if (type !== 'slack') return
    let cancelled = false
    fetch('/api/slack/connections')
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setSlackBinding(data.connections?.[0] ?? null)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [type])
```

Panel JSX:

```tsx
      {type === 'slack' && (
        <div className="space-y-3">
          <div className="grid gap-2">
            <label className={labelClass}>Respond to</label>
            {([
              ['app_mention', '@mentions of the bot'],
              ['message.im', 'Direct messages'],
              ['message.channels', 'Channel messages'],
              ['slash_command', 'A slash command'],
            ] as const).map(([kind, label]) => (
              <label key={kind} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={(trigger.events ?? []).includes(kind)}
                  onChange={(event) => {
                    const events = new Set(trigger.events ?? [])
                    if (event.target.checked) events.add(kind)
                    else events.delete(kind)
                    setTrigger({ ...trigger, events: Array.from(events) })
                  }}
                />
                {label}
              </label>
            ))}
          </div>
          {(trigger.events ?? []).includes('slash_command') && (
            <div className="grid gap-2">
              <label className={labelClass}>Slash command</label>
              <input className={cn(controlClass, 'font-mono')} value={trigger.command ?? ''} placeholder="/deploy" onChange={(event) => setTrigger({ ...trigger, command: event.target.value || undefined })} />
            </div>
          )}
          <div className="grid gap-2">
            <label className={labelClass}>Only these channels (optional, comma-separated channel IDs)</label>
            <input
              className={cn(controlClass, 'font-mono')}
              value={(trigger.channels ?? []).join(', ')}
              placeholder="C0123ABC, C0456DEF"
              onChange={(event) => {
                const channels = event.target.value.split(',').map((entry) => entry.trim()).filter(Boolean)
                setTrigger({ ...trigger, channels: channels.length ? channels : undefined })
              }}
            />
          </div>
          <div className="grid gap-2">
            <label className={labelClass}>Only when the message contains (optional)</label>
            <input className={controlClass} value={trigger.keyword ?? ''} placeholder="deploy" onChange={(event) => setTrigger({ ...trigger, keyword: event.target.value || undefined })} />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={trigger.threadMemory === true} onChange={(event) => setTrigger({ ...trigger, threadMemory: event.target.checked || undefined })} />
            Remember the conversation within a thread
          </label>
          {slackBinding ? (
            <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5">
              <p className="text-xs text-slate-600">
                Slack bot: <strong>{slackBinding.teamName ?? 'Connected workspace'}</strong> ({slackBinding.status})
              </p>
              {copyBlock('Ingress URL', slackBinding.ingressUrl)}
            </div>
          ) : (
            <p className="text-xs text-amber-700">No Slack bot connected — add one on the Integrations page first.</p>
          )}
          <p className="text-xs text-slate-500">
            The Slack message arrives as <code className="font-mono">{'{{trigger.input.text}}'}</code> (plus channel, user, ts). Runs the <strong>published</strong> version and replies into the originating thread.
          </p>
        </div>
      )}
```

- [ ] **Step 7: Add the copilot grounding line**

In `src/lib/flows/copilot-grounding.ts`, append to the `graphRules` string (after the final line 47 clause, keeping the `' + '` chain):

```ts
  'Slack trigger: trigger data {type:"slack", events:[…], command?, channels?, keyword?, threadMemory?}; events is a non-empty subset of app_mention/message.im/message.channels/slash_command; slash_command requires command (e.g. "/deploy"); the Slack message arrives as {{trigger.input.text}} with {{trigger.input.channel}}, {{trigger.input.user}}, {{trigger.input.ts}}; set threadMemory true for multi-turn thread conversations.'
```

- [ ] **Step 8: Verify build + tests**

Run: `npx tsc --noEmit && TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/slack-trigger.test.ts`
Expected: no type errors; PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/flows/trigger.ts src/lib/flows/validate.ts src/lib/flows/__tests__/slack-trigger.test.ts src/components/flows/step-card.tsx src/lib/flows/copilot-grounding.ts
git commit -m "feat(flows): slack trigger type — validation, builder panel, copilot grounding"
```

---

### Task 5: Routing + dispatch — `route-event.ts` + ingress wiring

**Files:**
- Create: `src/lib/slack/route-event.ts`
- Modify: `src/lib/slack/dispatch.ts` (replace the Task 3 stub body)
- Modify: `src/features/flows/execute-flow.ts:48` (trigger type union only)
- Test: `src/lib/slack/__tests__/route-event.test.ts`

**Interfaces:**
- Consumes: `SlackTriggerInput`, `SlackEventKind`, `SLACK_EVENT_KINDS` (Task 2); `dispatchFlowExecution` from `@/features/flows/execute-flow`; `systemPrisma`, `prisma` from `@/lib/prisma`.
- Produces (Tasks 6/7 depend on these exact names):
  - `type SlackTriggerConfig = { type: 'slack'; events: SlackEventKind[]; command?: string; channels?: string[]; keyword?: string; threadMemory?: boolean }`
  - `slackTriggerConfigOf(trigger: unknown): SlackTriggerConfig | null`
  - `type SlackFlowCandidate = { id: string; trigger: unknown }`
  - `matchSlackFlows(input: SlackTriggerInput, flows: SlackFlowCandidate[]): { id: string; config: SlackTriggerConfig }[]`
  - Run trigger JSON persisted on every slack run: `{ type: 'slack', slack: { bindingId, channel, thread_ts, response_url?, kind } }` where `thread_ts = input.thread_ts ?? input.ts` (empty string → omitted, e.g. slash commands).
  - `FlowExecutionJob['trigger']` type widened to `{ type: 'manual' | 'schedule' | 'webhook' | 'signal' | 'slack'; [key: string]: unknown }`.

- [ ] **Step 1: Write the failing matcher test**

Create `src/lib/slack/__tests__/route-event.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchSlackFlows, slackTriggerConfigOf } from '@/lib/slack/route-event'
import type { SlackTriggerInput } from '@/lib/slack/payload'

const mention: SlackTriggerInput = {
  kind: 'app_mention', text: '<@U0BOT9999> please deploy to prod', user: 'U0USER111',
  channel: 'C0CHAN111', ts: '1752300000.000100', team: 'T0AAA111',
}
const slash: SlackTriggerInput = {
  kind: 'slash_command', text: 'prod', user: 'U0USER111', channel: 'C0CHAN111', ts: '',
  team: 'T0AAA111', command: '/deploy', response_url: 'https://hooks.slack.com/commands/x',
}
const flow = (id: string, trigger: unknown) => ({ id, trigger })

test('slackTriggerConfigOf parses valid configs and rejects others', () => {
  assert.deepEqual(slackTriggerConfigOf({ type: 'slack', events: ['app_mention'], threadMemory: true }), {
    type: 'slack', events: ['app_mention'], threadMemory: true,
  })
  assert.equal(slackTriggerConfigOf({ type: 'webhook' }), null)
  assert.equal(slackTriggerConfigOf({ type: 'slack', events: [] }), null)
  assert.equal(slackTriggerConfigOf({ type: 'slack', events: ['nonsense'] }), null)
  assert.equal(slackTriggerConfigOf(null), null)
})

test('matches on event kind', () => {
  const flows = [
    flow('f1', { type: 'slack', events: ['app_mention'] }),
    flow('f2', { type: 'slack', events: ['message.im'] }),
    flow('f3', { type: 'webhook' }),
  ]
  assert.deepEqual(matchSlackFlows(mention, flows).map((m) => m.id), ['f1'])
})

test('slash commands match on command equality (leading slash and case ignored)', () => {
  const flows = [
    flow('f1', { type: 'slack', events: ['slash_command'], command: 'deploy' }),
    flow('f2', { type: 'slack', events: ['slash_command'], command: '/Deploy' }),
    flow('f3', { type: 'slack', events: ['slash_command'], command: '/status' }),
    flow('f4', { type: 'slack', events: ['app_mention'] }),
  ]
  assert.deepEqual(matchSlackFlows(slash, flows).map((m) => m.id), ['f1', 'f2'])
})

test('channel allowlist and keyword filter', () => {
  const flows = [
    flow('f1', { type: 'slack', events: ['app_mention'], channels: ['C0CHAN111'] }),
    flow('f2', { type: 'slack', events: ['app_mention'], channels: ['C0OTHER'] }),
    flow('f3', { type: 'slack', events: ['app_mention'], keyword: 'DEPLOY' }), // case-insensitive substring
    flow('f4', { type: 'slack', events: ['app_mention'], keyword: 'rollback' }),
  ]
  assert.deepEqual(matchSlackFlows(mention, flows).map((m) => m.id), ['f1', 'f3'])
})

test('multiple matches all dispatch (each gets its own run)', () => {
  const flows = [
    flow('f1', { type: 'slack', events: ['app_mention'] }),
    flow('f2', { type: 'slack', events: ['app_mention', 'message.channels'] }),
  ]
  assert.equal(matchSlackFlows(mention, flows).length, 2)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/slack/__tests__/route-event.test.ts`
Expected: FAIL — `Cannot find module '@/lib/slack/route-event'`.

- [ ] **Step 3: Implement `src/lib/slack/route-event.ts`**

```ts
/** Pure Slack → flow routing: which of the org's slack-triggered flows does a
 * normalized event match? (kind ∈ events; command equality; channel allowlist;
 * keyword substring). Multiple matches all dispatch — each its own run. */
import { SLACK_EVENT_KINDS, type SlackEventKind, type SlackTriggerInput } from '@/lib/slack/payload'

export type SlackTriggerConfig = {
  type: 'slack'
  events: SlackEventKind[]
  command?: string
  channels?: string[]
  keyword?: string
  threadMemory?: boolean
}

export type SlackFlowCandidate = { id: string; trigger: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function slackTriggerConfigOf(trigger: unknown): SlackTriggerConfig | null {
  if (!isRecord(trigger) || trigger.type !== 'slack') return null
  const rawEvents = Array.isArray(trigger.events) ? trigger.events : []
  const events = rawEvents.filter(
    (kind): kind is SlackEventKind => typeof kind === 'string' && (SLACK_EVENT_KINDS as readonly string[]).includes(kind),
  )
  if (!events.length || events.length !== rawEvents.length) return null
  return {
    type: 'slack',
    events,
    ...(typeof trigger.command === 'string' && trigger.command.trim() ? { command: trigger.command.trim() } : {}),
    ...(Array.isArray(trigger.channels) && trigger.channels.length
      ? { channels: trigger.channels.filter((entry): entry is string => typeof entry === 'string') }
      : {}),
    ...(typeof trigger.keyword === 'string' && trigger.keyword.trim() ? { keyword: trigger.keyword.trim() } : {}),
    ...(trigger.threadMemory === true ? { threadMemory: true } : {}),
  }
}

const normalizeCommand = (command: string) => command.trim().toLowerCase().replace(/^\//, '')

export function matchSlackFlows(
  input: SlackTriggerInput,
  flows: SlackFlowCandidate[],
): { id: string; config: SlackTriggerConfig }[] {
  const matches: { id: string; config: SlackTriggerConfig }[] = []
  for (const candidate of flows) {
    const config = slackTriggerConfigOf(candidate.trigger)
    if (!config) continue
    if (!config.events.includes(input.kind)) continue
    if (input.kind === 'slash_command') {
      if (!config.command || !input.command) continue
      if (normalizeCommand(config.command) !== normalizeCommand(input.command)) continue
    }
    if (config.channels?.length && !config.channels.includes(input.channel)) continue
    if (config.keyword && !input.text.toLowerCase().includes(config.keyword.toLowerCase())) continue
    matches.push({ id: candidate.id, config })
  }
  return matches
}
```

- [ ] **Step 4: Run matcher tests — PASS**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/slack/__tests__/route-event.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Widen `FlowExecutionJob.trigger` in `src/features/flows/execute-flow.ts`**

Change line 48 only:

```ts
  trigger?: { type: 'manual' | 'schedule' | 'webhook' | 'signal' | 'slack'; [key: string]: unknown }
```

- [ ] **Step 6: Implement the real `routeSlackEvent` in `src/lib/slack/dispatch.ts`**

Replace the whole file:

```ts
import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { dispatchFlowExecution } from '@/features/flows/execute-flow'
import { matchSlackFlows, type SlackTriggerConfig } from '@/lib/slack/route-event'
import type { NormalizedSlackEvent, SlackTriggerInput } from '@/lib/slack/payload'

export type SlackRouteArgs = {
  bindingId: string
  organizationId: string
  botUserId: string
  normalized: NormalizedSlackEvent
}

/** The origin block persisted at trigger.slack on every slack-triggered run —
 * the Task 6 reply hook reads exactly this shape. */
export function slackRunTrigger(bindingId: string, input: SlackTriggerInput) {
  const threadTs = input.thread_ts ?? (input.ts || undefined)
  return {
    type: 'slack' as const,
    slack: {
      bindingId,
      channel: input.channel,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...(input.response_url ? { response_url: input.response_url } : {}),
      kind: input.kind,
    },
  }
}

/** Owner attribution mirrors the webhook trigger: the flow's owner, or the
 * org's oldest active member. */
async function resolveRunOwner(flow: { userId: string | null; organizationId: string }) {
  return flow.userId
    ? prisma.user.findFirst({ where: { id: flow.userId, organizationId: flow.organizationId, isActive: true } })
    : prisma.user.findFirst({ where: { organizationId: flow.organizationId, isActive: true }, orderBy: { createdAt: 'asc' } })
}

/**
 * Route a verified, deduped, non-bot Slack event to matching flows and
 * dispatch each as its own PUBLISHED run. Runs inside after() — best-effort;
 * per-flow failures are logged, never thrown.
 */
export async function routeSlackEvent(args: SlackRouteArgs): Promise<void> {
  const { bindingId, organizationId, normalized } = args
  const input = normalized.input

  // systemPrisma: session-less ingress continuation — org id came from the
  // binding row, and every query below is scoped to it.
  const flows = await systemPrisma.flow.findMany({
    where: { organizationId, status: 'ACTIVE' },
    select: { id: true, userId: true, organizationId: true, trigger: true, publishedGraph: true },
    take: 200,
  })
  const candidates = flows.filter((flow) => flow.publishedGraph != null)
  const matches = matchSlackFlows(input, candidates)
  if (!matches.length) return

  for (const match of matches) {
    const flow = candidates.find((candidate) => candidate.id === match.id)
    if (!flow) continue
    try {
      const owner = await resolveRunOwner(flow)
      if (!owner) {
        apiLogger.warn('slack dispatch skipped — no active user to attribute the run to', { flowId: flow.id })
        continue
      }
      const result = await dispatchFlowExecution({
        flowId: flow.id,
        organizationId,
        userId: owner.id,
        input,
        usePublished: true,
        trigger: slackRunTrigger(bindingId, input),
      })
      await afterSlackDispatch({ organizationId, bindingId, input, config: match.config, flowId: flow.id, flowRunId: result.flowRunId })
    } catch (error) {
      apiLogger.error('slack flow dispatch failed', { flowId: flow.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** Post-dispatch bookkeeping. Task 7 fills this in with thread-session upkeep;
 * until then it is a no-op so Task 5 ships without the session model in play. */
async function afterSlackDispatch(_args: {
  organizationId: string
  bindingId: string
  input: SlackTriggerInput
  config: SlackTriggerConfig
  flowId: string
  flowRunId: string
}): Promise<void> {}
```

- [ ] **Step 7: Verify everything still passes**

Run: `npx tsc --noEmit && TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/slack/__tests__/route-event.test.ts && TEST_DATABASE_URL=$TEST_DATABASE_URL TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/slack/__tests__/events-route.test.ts`
Expected: PASS (the ingress test still passes — `routeSlackEvent` runs in `after()` and finds no matching flows in the seeded org).

- [ ] **Step 8: Commit**

```bash
git add src/lib/slack/route-event.ts src/lib/slack/__tests__/route-event.test.ts src/lib/slack/dispatch.ts src/features/flows/execute-flow.ts
git commit -m "feat(slack): event routing — matchSlackFlows + dispatch to published runs with trigger.slack origin"
```

---

### Task 6: Reply-to-origin hook in execute-flow

**Files:**
- Create: `src/lib/slack/post.ts`
- Create: `src/lib/slack/reply.ts`
- Create: `src/lib/slack/deliver.ts`
- Modify: `src/features/flows/execute-flow.ts` (hook after the terminal-status write, ~line 731, before the signals block)
- Test: `src/lib/slack/__tests__/reply.test.ts` (pure)
- Test: `src/lib/slack/__tests__/deliver.test.ts` (DB-gated, fetch stubbed)

**Interfaces:**
- Consumes: `formatSlackReply` (Task 2), `decryptSecretJson` (Task 1), the `trigger.slack` origin shape (Task 5), `parseFlowToolConnectionId` from `@/lib/flows/tool-connection-id`, `FlowNode`/`flowGraphSchema` from `@/lib/flows/graph`.
- Produces:
  - `post.ts`: `postSlackMessage(args: { botToken: string; channel: string; threadTs?: string; text: string; fetchImpl?: typeof fetch }): Promise<void>` (throws on `ok:false`); `postSlackResponseUrl(args: { responseUrl: string; text: string; fetchImpl?: typeof fetch }): Promise<void>`.
  - `reply.ts`: `type SlackRunOrigin = { bindingId: string; channel: string; thread_ts?: string; response_url?: string; kind?: string }`; `slackOriginOf(trigger: unknown): SlackRunOrigin | null`; `resolveSlackReplyText(args: { status: 'succeeded' | 'failed' | 'waiting'; output?: unknown; error?: string | null; question?: string; runUrl?: string }): string | null`; `shouldSuppressSuccessReply(args: { steps: { nodeId: string; status: string; input?: unknown }[]; nodesById: Map<string, { type: string; data?: Record<string, unknown> }>; channel: string }): boolean`.
  - `deliver.ts`: `deliverSlackRunReply(args: { organizationId: string; flowId: string; flowRunId: string; status: 'succeeded' | 'failed' | 'waiting'; output: unknown; error?: string | null; question?: string; origin: SlackRunOrigin; fetchImpl?: typeof fetch }): Promise<void>` — Task 7 appends session upkeep inside this function.

- [ ] **Step 1: Write the failing pure reply test**

Create `src/lib/slack/__tests__/reply.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slackOriginOf, resolveSlackReplyText, shouldSuppressSuccessReply } from '@/lib/slack/reply'

test('slackOriginOf reads the trigger.slack block and rejects everything else', () => {
  const origin = slackOriginOf({ type: 'slack', slack: { bindingId: 'b1', channel: 'C1', thread_ts: '1.0', kind: 'app_mention' } })
  assert.deepEqual(origin, { bindingId: 'b1', channel: 'C1', thread_ts: '1.0', kind: 'app_mention' })
  assert.equal(slackOriginOf({ type: 'webhook' }), null)
  assert.equal(slackOriginOf({ type: 'slack' }), null) // missing origin block
  assert.equal(slackOriginOf({ type: 'slack', slack: { bindingId: 'b1' } }), null) // missing channel
  assert.equal(slackOriginOf(null), null)
})

test('resolveSlackReplyText: succeeded → formatted output; failed → notice; waiting → question', () => {
  assert.equal(resolveSlackReplyText({ status: 'succeeded', output: 'All done' }), 'All done')
  assert.match(resolveSlackReplyText({ status: 'failed', error: 'HTTP 500: boom' })!, /failed.*HTTP 500: boom/s)
  assert.match(resolveSlackReplyText({ status: 'failed', error: null })!, /failed/)
  assert.equal(resolveSlackReplyText({ status: 'waiting', question: 'Which environment?' }), 'Which environment?')
  assert.match(resolveSlackReplyText({ status: 'waiting' })!, /waiting for your reply/)
})

const nodesById = new Map<string, { type: string; data?: Record<string, unknown> }>([
  ['t1', { type: 'tool', data: { connectionId: 'native:slack', toolName: 'post_message', args: '{"channel":"C0CHAN111","text":"hi"}' } }],
  ['t2', { type: 'tool', data: { connectionId: 'native:granola', toolName: 'get_meetings', args: '{}' } }],
  ['a1', { type: 'agent', data: {} }],
])

test('suppression: a succeeded slack-plane step to the same channel suppresses', () => {
  const steps = [{ nodeId: 't1', status: 'succeeded', input: { connectionId: 'native:slack', toolName: 'post_message', args: '{"channel":"C0CHAN111","text":"hi"}' } }]
  assert.equal(shouldSuppressSuccessReply({ steps, nodesById, channel: 'C0CHAN111' }), true)
})

test('no suppression: different channel, non-slack plane, failed step, or agent step', () => {
  assert.equal(shouldSuppressSuccessReply({
    steps: [{ nodeId: 't1', status: 'succeeded', input: { args: '{"channel":"C0OTHER","text":"hi"}' } }],
    nodesById, channel: 'C0CHAN111',
  }), false)
  assert.equal(shouldSuppressSuccessReply({
    steps: [{ nodeId: 't2', status: 'succeeded', input: { args: '{"channel":"C0CHAN111"}' } }],
    nodesById, channel: 'C0CHAN111',
  }), false)
  assert.equal(shouldSuppressSuccessReply({
    steps: [{ nodeId: 't1', status: 'failed', input: { args: '{"channel":"C0CHAN111"}' } }],
    nodesById, channel: 'C0CHAN111',
  }), false)
  assert.equal(shouldSuppressSuccessReply({ steps: [{ nodeId: 'a1', status: 'succeeded' }], nodesById, channel: 'C0CHAN111' }), false)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/slack/__tests__/reply.test.ts`
Expected: FAIL — `Cannot find module '@/lib/slack/reply'`.

- [ ] **Step 3: Implement `src/lib/slack/post.ts` and `src/lib/slack/reply.ts`**

`src/lib/slack/post.ts`:

```ts
/** Outbound Slack posting for the reply-to-origin hook. Slack returns HTTP
 * 200 even on failure — body.ok is authoritative (same as SlackToolClient). */
const SLACK_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage'

export async function postSlackMessage(args: {
  botToken: string
  channel: string
  threadTs?: string
  text: string
  fetchImpl?: typeof fetch
}): Promise<void> {
  const fetchImpl = args.fetchImpl ?? fetch
  const response = await fetchImpl(SLACK_POST_MESSAGE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.botToken}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      channel: args.channel,
      text: args.text,
      ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = (await response.json()) as Record<string, unknown>
  if (body.ok !== true) throw new Error(`Slack API error: ${body.error ?? 'unknown'}`)
}

/** Slash-command reply via response_url (valid ~30 min; caller falls back to
 * chat.postMessage on failure). */
export async function postSlackResponseUrl(args: { responseUrl: string; text: string; fetchImpl?: typeof fetch }): Promise<void> {
  const fetchImpl = args.fetchImpl ?? fetch
  const response = await fetchImpl(args.responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ response_type: 'in_channel', text: args.text }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Slack response_url error: HTTP ${response.status}`)
}
```

`src/lib/slack/reply.ts`:

```ts
/** Pure reply-to-origin decisions: origin parsing, reply text per terminal
 * status, and explicit-reply suppression. */
import { formatSlackReply } from '@/lib/slack/format'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'

export type SlackRunOrigin = {
  bindingId: string
  channel: string
  thread_ts?: string
  response_url?: string
  kind?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function slackOriginOf(trigger: unknown): SlackRunOrigin | null {
  if (!isRecord(trigger) || trigger.type !== 'slack' || !isRecord(trigger.slack)) return null
  const slack = trigger.slack
  if (typeof slack.bindingId !== 'string' || !slack.bindingId || typeof slack.channel !== 'string' || !slack.channel) return null
  return {
    bindingId: slack.bindingId,
    channel: slack.channel,
    ...(typeof slack.thread_ts === 'string' && slack.thread_ts ? { thread_ts: slack.thread_ts } : {}),
    ...(typeof slack.response_url === 'string' && slack.response_url ? { response_url: slack.response_url } : {}),
    ...(typeof slack.kind === 'string' ? { kind: slack.kind } : {}),
  }
}

export function resolveSlackReplyText(args: {
  status: 'succeeded' | 'failed' | 'waiting'
  output?: unknown
  error?: string | null
  question?: string
  runUrl?: string
}): string | null {
  if (args.status === 'succeeded') return formatSlackReply(args.output, { runUrl: args.runUrl })
  if (args.status === 'failed') {
    return `:warning: The flow failed${args.error ? `:\n> ${args.error.slice(0, 300)}` : '.'}`
  }
  return args.question?.trim() || 'The flow is waiting for your reply.'
}

/** True when this run already posted to the origin channel via an explicit
 * slack step (native:slack, or a nango plane whose ref names slack) — the
 * explicit reply wins for `succeeded`. Unresolvable/templated args → false
 * (the hook still posts; a duplicate reply beats silence). */
export function shouldSuppressSuccessReply(args: {
  steps: { nodeId: string; status: string; input?: unknown }[]
  nodesById: Map<string, { type: string; data?: Record<string, unknown> }>
  channel: string
}): boolean {
  for (const step of args.steps) {
    if (step.status !== 'succeeded') continue
    const node = args.nodesById.get(step.nodeId)
    if (node?.type !== 'tool') continue
    const connectionId = typeof node.data?.connectionId === 'string' ? node.data.connectionId : ''
    if (!connectionId) continue
    const { plane, ref } = parseFlowToolConnectionId(connectionId)
    const slackPlane = (plane === 'native' && ref === 'slack') || (plane === 'nango' && ref.toLowerCase().includes('slack'))
    if (!slackPlane) continue
    if (JSON.stringify(step.input ?? '').includes(args.channel)) return true
  }
  return false
}
```

- [ ] **Step 4: Run the pure test — PASS**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/slack/__tests__/reply.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Implement `src/lib/slack/deliver.ts`**

```ts
/** Post-run reply-to-origin delivery: called by runFlowExecution after the
 * run's terminal/waiting status is persisted. Best-effort by contract — the
 * caller catches; a Slack outage must never affect the run's outcome. */
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { flowGraphSchema } from '@/lib/flows/graph'
import { decryptSecretJson } from '@/lib/slack/connections'
import { postSlackMessage, postSlackResponseUrl } from '@/lib/slack/post'
import { resolveSlackReplyText, shouldSuppressSuccessReply, type SlackRunOrigin } from '@/lib/slack/reply'

export async function deliverSlackRunReply(args: {
  organizationId: string
  flowId: string
  flowRunId: string
  status: 'succeeded' | 'failed' | 'waiting'
  output: unknown
  error?: string | null
  question?: string
  origin: SlackRunOrigin
  fetchImpl?: typeof fetch
}): Promise<void> {
  const { origin } = args
  // systemPrisma: post-run continuation of a session-less slack run; the
  // binding is still constrained to the run's own organizationId.
  const binding = await systemPrisma.slackWorkspaceConnection.findFirst({
    where: { id: origin.bindingId, organizationId: args.organizationId, status: 'active' },
  })
  if (!binding) return

  // Suppression: if an explicit slack step in this run already posted to the
  // origin channel, stay silent for `succeeded` — questions/failures still post.
  if (args.status === 'succeeded') {
    const run = await systemPrisma.flowRun.findFirst({
      where: { id: args.flowRunId, organizationId: args.organizationId },
      select: { graphSnapshot: true },
    })
    const steps = await systemPrisma.flowRunStep.findMany({
      where: { flowRunId: args.flowRunId },
      select: { nodeId: true, status: true, input: true },
    })
    const parsed = run?.graphSnapshot ? flowGraphSchema.safeParse(run.graphSnapshot) : null
    if (parsed?.success) {
      const nodesById = new Map(parsed.data.nodes.map((node) => [node.id, node as { type: string; data?: Record<string, unknown> }]))
      if (shouldSuppressSuccessReply({ steps, nodesById, channel: origin.channel })) return
    }
  }

  const runUrl = `${process.env.NEXT_PUBLIC_APP_URL || ''}/flows/${args.flowId}/activity`
  const text = resolveSlackReplyText({ status: args.status, output: args.output, error: args.error, question: args.question, runUrl })
  if (!text) return

  const botToken = decryptSecretJson(binding.botToken)
  // Slash commands reply via response_url (30-min validity); anything else —
  // and a failed response_url post — goes to the channel, always in-thread.
  if (origin.response_url && origin.kind === 'slash_command') {
    try {
      await postSlackResponseUrl({ responseUrl: origin.response_url, text, fetchImpl: args.fetchImpl })
      return
    } catch (error) {
      apiLogger.warn('slack response_url reply failed — falling back to chat.postMessage', {
        flowRunId: args.flowRunId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  await postSlackMessage({ botToken, channel: origin.channel, threadTs: origin.thread_ts, text, fetchImpl: args.fetchImpl })
}
```

- [ ] **Step 6: Wire the hook into `src/features/flows/execute-flow.ts`**

Add imports at the top (after the existing `@/lib/flows/*` imports):

```ts
import { slackOriginOf } from '@/lib/slack/reply'
import { deliverSlackRunReply } from '@/lib/slack/deliver'
```

Insert AFTER the `if (status === 'failed') { … sweep … }` block (ends line 731) and BEFORE the `// Fire the flow.completed signal` block (line 733):

```ts
  // Slack reply-to-origin: a run started from Slack reports its outcome back
  // to the originating channel/thread — succeeded output, a failure notice,
  // or the pending question when the run pauses (the multi-turn bridge).
  // run.trigger carries the origin (persisted at dispatch), so resumes reply
  // too. Fire-and-safe: a Slack outage must never affect the run's outcome.
  const slackOrigin = slackOriginOf(run.trigger)
  if (slackOrigin) {
    await deliverSlackRunReply({
      organizationId: job.organizationId,
      flowId: flow.id,
      flowRunId: run.id,
      status,
      output: result.output,
      error: runError,
      question: status === 'waiting' ? result.waiting?.question : undefined,
      origin: slackOrigin,
    }).catch((error) => {
      apiLogger.error?.('slack run reply failed', { flowRunId: run.id, error: error instanceof Error ? error.message : String(error) })
    })
  }
```

Note: `execute-flow.ts` has no `apiLogger` import — add `import { apiLogger } from '@/lib/logger'` alongside the new imports (and use `apiLogger.error(...)` without the optional chain).

- [ ] **Step 7: Write the DB-gated deliver test**

Create `src/lib/slack/__tests__/deliver.test.ts`:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'

  let prisma: any
  let seeded: any
  let bindingId: string

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    const { encryptSecretJson } = await import('@/lib/slack/connections')
    seeded = await seedTestOrg(prisma)
    const binding = await prisma.slackWorkspaceConnection.create({
      data: {
        organizationId: seeded.organizationId, teamId: 'T0AAA111', teamName: 'Acme', botUserId: 'U0BOT9999',
        botToken: encryptSecretJson('xoxb-deliver'), signingSecret: encryptSecretJson('sig'),
      },
    })
    bindingId = binding.id
  })

  after(async () => {
    if (seeded) {
      await prisma.slackWorkspaceConnection.deleteMany({ where: { organizationId: seeded.organizationId } })
      await seeded.cleanup()
    }
  })

  const stubFetch = (posts: { url: string; body: any; auth?: string }[]) =>
    (async (url: any, init: any) => {
      posts.push({ url: String(url), body: JSON.parse(String(init.body)), auth: init.headers?.Authorization })
      return new Response(JSON.stringify({ ok: true }))
    }) as typeof fetch

  test('succeeded run posts formatted output to the origin thread with the decrypted token', async () => {
    const { deliverSlackRunReply } = await import('@/lib/slack/deliver')
    const flow = await prisma.flow.create({ data: { name: 'Deliver flow', organizationId: seeded.organizationId, userId: seeded.userId } })
    const run = await prisma.flowRun.create({
      data: { flowId: flow.id, status: 'succeeded', organizationId: seeded.organizationId, userId: seeded.userId },
    })
    const posts: any[] = []
    await deliverSlackRunReply({
      organizationId: seeded.organizationId, flowId: flow.id, flowRunId: run.id,
      status: 'succeeded', output: 'Deployed v1.2',
      origin: { bindingId, channel: 'C0CHAN111', thread_ts: '1752300000.000100', kind: 'app_mention' },
      fetchImpl: stubFetch(posts),
    })
    assert.equal(posts.length, 1)
    assert.equal(posts[0].url, 'https://slack.com/api/chat.postMessage')
    assert.equal(posts[0].auth, 'Bearer xoxb-deliver')
    assert.deepEqual(posts[0].body, { channel: 'C0CHAN111', text: 'Deployed v1.2', thread_ts: '1752300000.000100' })
  })

  test('slash-command run replies via response_url', async () => {
    const { deliverSlackRunReply } = await import('@/lib/slack/deliver')
    const flow = await prisma.flow.create({ data: { name: 'Slash flow', organizationId: seeded.organizationId, userId: seeded.userId } })
    const run = await prisma.flowRun.create({
      data: { flowId: flow.id, status: 'succeeded', organizationId: seeded.organizationId, userId: seeded.userId },
    })
    const posts: any[] = []
    await deliverSlackRunReply({
      organizationId: seeded.organizationId, flowId: flow.id, flowRunId: run.id,
      status: 'succeeded', output: 'done',
      origin: { bindingId, channel: 'C0CHAN111', response_url: 'https://hooks.slack.com/commands/T/1/a', kind: 'slash_command' },
      fetchImpl: stubFetch(posts),
    })
    assert.equal(posts.length, 1)
    assert.equal(posts[0].url, 'https://hooks.slack.com/commands/T/1/a')
    assert.equal(posts[0].body.response_type, 'in_channel')
  })

  test('unknown binding or wrong org posts nothing', async () => {
    const { deliverSlackRunReply } = await import('@/lib/slack/deliver')
    const posts: any[] = []
    await deliverSlackRunReply({
      organizationId: seeded.organizationId, flowId: 'f', flowRunId: 'r',
      status: 'failed', output: null, error: 'x',
      origin: { bindingId: 'nonexistent', channel: 'C1' },
      fetchImpl: stubFetch(posts),
    })
    assert.equal(posts.length, 0)
  })
} else {
  test('slack deliver (skipped — TEST_DATABASE_URL not set)', () => {})
}
```

- [ ] **Step 8: Run tests + typecheck**

Run: `npx tsc --noEmit && TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/slack/__tests__/reply.test.ts && TEST_DATABASE_URL=$TEST_DATABASE_URL TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/slack/__tests__/deliver.test.ts`
Expected: PASS. Also run the flows suite to prove the hook is inert for non-slack runs: `npm test` → all existing tests pass (non-slack runs have `slackOriginOf(run.trigger) === null`).

- [ ] **Step 9: Commit**

```bash
git add src/lib/slack/post.ts src/lib/slack/reply.ts src/lib/slack/deliver.ts src/lib/slack/__tests__/reply.test.ts src/lib/slack/__tests__/deliver.test.ts src/features/flows/execute-flow.ts
git commit -m "feat(slack): reply-to-origin hook — formatted output, failure notice, pending question, suppression"
```

---

### Task 7: Multi-turn — SlackThreadSession + ingress precedence + continueExecutionId pass-through

**Files:**
- Create: `src/lib/slack/session.ts`
- Modify: `src/lib/slack/dispatch.ts` (session precedence at the top of `routeSlackEvent`; fill in `afterSlackDispatch`)
- Modify: `src/features/flows/execute-flow.ts` (`FlowExecutionJob.slackContinueExecutionId` + the runAgent seed, ~lines 32-51 and 383-388)
- Modify: `src/lib/slack/deliver.ts` (record the run's last agentExecutionId on the session)
- Modify: `src/app/api/cron/dispatch/route.ts` (stale-session sweep, isolated like the flow reaper at lines 94-99)
- Test: `src/lib/slack/__tests__/session.test.ts` (pure routing decision)

**Interfaces:**
- Consumes: `SlackThreadSession` model (Task 1), `dispatchFlowExecution`/`FlowExecutionJob` (Task 5 union), `deliverSlackRunReply` (Task 6), `runAgentExecution`'s existing `continueExecutionId` seed mode (`src/features/agents/execute-agent.ts:470-484` — seeds the transcript from a prior execution and appends the new input).
- Produces (`src/lib/slack/session.ts`):
  - `type SessionRouting = { mode: 'resume'; flowRunId: string; flowId: string } | { mode: 'continue'; flowId: string; continueExecutionId?: string } | { mode: 'fallthrough' }`
  - `resolveSessionRouting(args: { session: { flowId: string; flowRunId: string; agentExecutionId: string | null; status: string } | null; runStatus: string | null; flowActive: boolean }): SessionRouting` (pure)
  - `findOpenSession(args: { organizationId: string; bindingId: string; channel: string; threadTs: string }): Promise<SlackThreadSession | null>`
  - `upsertThreadSession(args: { organizationId: string; bindingId: string; channel: string; threadTs: string; flowId: string; flowRunId: string }): Promise<void>`
  - `recordSessionAgentExecution(args: { organizationId: string; flowRunId: string; agentExecutionId: string | null }): Promise<void>`
  - `closeSession(args: { organizationId: string; id: string }): Promise<void>`
  - `closeStaleSlackSessions(): Promise<number>` (7-day `updatedAt` sweep, all orgs — cron)
- Produces (`execute-flow.ts`): `FlowExecutionJob.slackContinueExecutionId?: string` — applied as `continueExecutionId` to the FIRST saved-agent step reached in execution order when `node.thread` is unset and the invocation is not a resume (pinned decision #1/#2).

- [ ] **Step 1: Write the failing pure session test**

Create `src/lib/slack/__tests__/session.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSessionRouting } from '@/lib/slack/session'

const session = { flowId: 'f1', flowRunId: 'run1', agentExecutionId: 'exec1', status: 'open' }

test('no session, or a closed one → fallthrough to normal matching', () => {
  assert.deepEqual(resolveSessionRouting({ session: null, runStatus: null, flowActive: true }), { mode: 'fallthrough' })
  assert.deepEqual(resolveSessionRouting({ session: { ...session, status: 'closed' }, runStatus: 'waiting', flowActive: true }), { mode: 'fallthrough' })
})

test('unpublished/inactive flow → fallthrough (caller closes the session)', () => {
  assert.deepEqual(resolveSessionRouting({ session, runStatus: 'waiting', flowActive: false }), { mode: 'fallthrough' })
})

test('waiting run → the message is the reply (resume)', () => {
  assert.deepEqual(resolveSessionRouting({ session, runStatus: 'waiting', flowActive: true }), { mode: 'resume', flowRunId: 'run1', flowId: 'f1' })
})

test('settled run → new run continuing the conversation (seed = last agent execution)', () => {
  assert.deepEqual(resolveSessionRouting({ session, runStatus: 'succeeded', flowActive: true }), { mode: 'continue', flowId: 'f1', continueExecutionId: 'exec1' })
  // no agent execution recorded yet → still route to the session's flow, fresh conversation
  assert.deepEqual(
    resolveSessionRouting({ session: { ...session, agentExecutionId: null }, runStatus: 'failed', flowActive: true }),
    { mode: 'continue', flowId: 'f1' },
  )
  // run row vanished → still continue by flow
  assert.deepEqual(resolveSessionRouting({ session, runStatus: null, flowActive: true }), { mode: 'continue', flowId: 'f1', continueExecutionId: 'exec1' })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/slack/__tests__/session.test.ts`
Expected: FAIL — `Cannot find module '@/lib/slack/session'`.

- [ ] **Step 3: Implement `src/lib/slack/session.ts`**

```ts
/** SlackThreadSession: one Slack thread ↔ one flow conversation.
 * resolveSessionRouting is the pure precedence decision the ingress applies
 * BEFORE trigger matching; the DB helpers wrap the session lifecycle. */
import { systemPrisma } from '@/lib/prisma'

export type SessionRouting =
  | { mode: 'resume'; flowRunId: string; flowId: string }
  | { mode: 'continue'; flowId: string; continueExecutionId?: string }
  | { mode: 'fallthrough' }

export function resolveSessionRouting(args: {
  session: { flowId: string; flowRunId: string; agentExecutionId: string | null; status: string } | null
  runStatus: string | null
  flowActive: boolean
}): SessionRouting {
  const { session } = args
  if (!session || session.status !== 'open') return { mode: 'fallthrough' }
  if (!args.flowActive) return { mode: 'fallthrough' }
  if (args.runStatus === 'waiting') return { mode: 'resume', flowRunId: session.flowRunId, flowId: session.flowId }
  return {
    mode: 'continue',
    flowId: session.flowId,
    ...(session.agentExecutionId ? { continueExecutionId: session.agentExecutionId } : {}),
  }
}

// systemPrisma throughout: these run in the session-less ingress/post-run
// continuations; every query is scoped to the caller's organizationId.

export async function findOpenSession(args: { organizationId: string; bindingId: string; channel: string; threadTs: string }) {
  return systemPrisma.slackThreadSession.findFirst({
    where: { organizationId: args.organizationId, bindingId: args.bindingId, channel: args.channel, threadTs: args.threadTs, status: 'open' },
  })
}

export async function upsertThreadSession(args: {
  organizationId: string
  bindingId: string
  channel: string
  threadTs: string
  flowId: string
  flowRunId: string
}): Promise<void> {
  await systemPrisma.slackThreadSession.upsert({
    where: { bindingId_channel_threadTs: { bindingId: args.bindingId, channel: args.channel, threadTs: args.threadTs } },
    create: { ...args, status: 'open' },
    update: { flowId: args.flowId, flowRunId: args.flowRunId, status: 'open' },
  })
}

/** Post-run: remember the run's last agent execution as the thread's
 * conversation seed. No-op when the run has no session or no agent steps. */
export async function recordSessionAgentExecution(args: {
  organizationId: string
  flowRunId: string
  agentExecutionId: string | null
}): Promise<void> {
  if (!args.agentExecutionId) return
  await systemPrisma.slackThreadSession.updateMany({
    where: { organizationId: args.organizationId, flowRunId: args.flowRunId, status: 'open' },
    data: { agentExecutionId: args.agentExecutionId },
  })
}

export async function closeSession(args: { organizationId: string; id: string }): Promise<void> {
  await systemPrisma.slackThreadSession.updateMany({
    where: { organizationId: args.organizationId, id: args.id },
    data: { status: 'closed' },
  })
}

/** Cron sweep: close sessions idle for 7+ days (all orgs — CRON_SECRET-gated caller). */
export async function closeStaleSlackSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const result = await systemPrisma.slackThreadSession.updateMany({
    where: { status: 'open', updatedAt: { lt: cutoff } },
    data: { status: 'closed' },
  })
  return result.count
}
```

- [ ] **Step 4: Run the pure test — PASS**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/slack/__tests__/session.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add `slackContinueExecutionId` to `FlowExecutionJob` and the runAgent seed**

In `src/features/flows/execute-flow.ts`, add to the `FlowExecutionJob` type (after `subflowDepth`, line 50):

```ts
  // Slack multi-turn: a prior AgentExecution id whose transcript seeds the
  // FIRST saved-agent step of this run (execution order), so a thread carries
  // one conversation across runs. Consumed at most once per run.
  slackContinueExecutionId?: string
```

In `runFlowExecution`, immediately before the `const runAgent: RunAgentFn = ...` definition (line 333):

```ts
  // Slack multi-turn seed — consumed by the first saved-agent invocation that
  // is neither loop-threaded nor a resume. Inline-prompt agents early-return
  // before the seed point and never consume it (documented limitation: with
  // parallel branches "first" is race-ordered).
  let slackSeedRemaining = Boolean(job.slackContinueExecutionId)
```

Inside `runAgent`, replace the two lines (383-384):

```ts
      const threadKey = node.thread ? `${node.thread.key}:${node.id}` : undefined
      const continueExecutionId = threadKey && node.thread!.iteration > 0 ? threadExecutions.get(threadKey) : undefined
```

with:

```ts
      const threadKey = node.thread ? `${node.thread.key}:${node.id}` : undefined
      let continueExecutionId = threadKey && node.thread!.iteration > 0 ? threadExecutions.get(threadKey) : undefined
      // Slack multi-turn: seed ONLY the first agent step reached in this run,
      // and never when loop-threading already provides a seed or this
      // invocation resumes a paused execution.
      if (!continueExecutionId && !node.thread && !resumeThis && slackSeedRemaining && job.slackContinueExecutionId) {
        slackSeedRemaining = false
        continueExecutionId = job.slackContinueExecutionId
      }
```

(The `runAgentExecution` call at line 385-389 is unchanged — it already spreads `continueExecutionId` when set. `resumeThis` is declared at line 379, above the insertion point.)

- [ ] **Step 6: Wire precedence + session upkeep into `src/lib/slack/dispatch.ts`**

Add imports:

```ts
import { findOpenSession, resolveSessionRouting, upsertThreadSession, closeSession } from '@/lib/slack/session'
```

At the TOP of `routeSlackEvent` (before the flows query), insert:

```ts
  // Ingress precedence: a non-bot message in a thread with an open session is
  // a continuation of that conversation, not a fresh trigger match.
  if (input.thread_ts) {
    const session = await findOpenSession({ organizationId, bindingId, channel: input.channel, threadTs: input.thread_ts })
    if (session) {
      const [sessionFlow, sessionRun] = await Promise.all([
        systemPrisma.flow.findFirst({
          where: { id: session.flowId, organizationId, status: 'ACTIVE' },
          select: { id: true, userId: true, organizationId: true, publishedGraph: true },
        }),
        systemPrisma.flowRun.findFirst({ where: { id: session.flowRunId, organizationId }, select: { status: true } }),
      ])
      const flowActive = Boolean(sessionFlow && sessionFlow.publishedGraph != null)
      const routing = resolveSessionRouting({ session, runStatus: sessionRun?.status ?? null, flowActive })
      if (!flowActive) {
        // Unpublished/deleted flow: the conversation is over — close and fall
        // through to normal matching.
        await closeSession({ organizationId, id: session.id })
      }
      if (routing.mode === 'resume' && sessionFlow) {
        const owner = await resolveRunOwner(sessionFlow)
        if (owner) {
          // The thread message answers the run's pending question — resume it
          // (the resumeKey machinery targets the paused iteration; the reply
          // hook re-fires on the resumed run's next settle).
          await dispatchFlowExecution({
            flowId: sessionFlow.id,
            organizationId,
            userId: owner.id,
            flowRunId: routing.flowRunId,
            reply: input.text,
            usePublished: true,
          }).catch((error) =>
            apiLogger.error('slack thread resume failed', { flowRunId: routing.flowRunId, error: error instanceof Error ? error.message : String(error) }),
          )
        }
        return
      }
      if (routing.mode === 'continue' && sessionFlow) {
        const owner = await resolveRunOwner(sessionFlow)
        if (owner) {
          const result = await dispatchFlowExecution({
            flowId: sessionFlow.id,
            organizationId,
            userId: owner.id,
            input,
            usePublished: true,
            trigger: slackRunTrigger(bindingId, input),
            ...(routing.continueExecutionId ? { slackContinueExecutionId: routing.continueExecutionId } : {}),
          }).catch((error) => {
            apiLogger.error('slack thread continuation failed', { flowId: sessionFlow.id, error: error instanceof Error ? error.message : String(error) })
            return null
          })
          if (result) {
            await upsertThreadSession({
              organizationId, bindingId, channel: input.channel,
              threadTs: input.thread_ts, flowId: sessionFlow.id, flowRunId: result.flowRunId,
            })
          }
        }
        return
      }
      // fallthrough: continue to normal trigger matching below.
    }
  }
```

Replace the empty `afterSlackDispatch` body with:

```ts
async function afterSlackDispatch(args: {
  organizationId: string
  bindingId: string
  input: SlackTriggerInput
  config: SlackTriggerConfig
  flowId: string
  flowRunId: string
}): Promise<void> {
  if (!args.config.threadMemory) return
  const threadTs = args.input.thread_ts ?? (args.input.ts || undefined)
  if (!threadTs) return // slash commands have no thread to remember
  await upsertThreadSession({
    organizationId: args.organizationId,
    bindingId: args.bindingId,
    channel: args.input.channel,
    threadTs,
    flowId: args.flowId,
    flowRunId: args.flowRunId,
  })
}
```

- [ ] **Step 7: Record the conversation seed in `src/lib/slack/deliver.ts`**

Add the import:

```ts
import { recordSessionAgentExecution } from '@/lib/slack/session'
```

At the START of `deliverSlackRunReply` (before the binding lookup), insert:

```ts
  // Session upkeep: remember the run's LAST agent execution as the thread's
  // conversation seed (no-op when the run has no open session or agent steps).
  const lastAgentStep = await systemPrisma.flowRunStep.findFirst({
    where: { flowRunId: args.flowRunId, agentExecutionId: { not: null } },
    orderBy: { order: 'desc' },
    select: { agentExecutionId: true },
  })
  await recordSessionAgentExecution({
    organizationId: args.organizationId,
    flowRunId: args.flowRunId,
    agentExecutionId: lastAgentStep?.agentExecutionId ?? null,
  }).catch(() => undefined)
```

- [ ] **Step 8: Add the cron sweep to `src/app/api/cron/dispatch/route.ts`**

After the flow-reaper block (lines 94-99, the `try { await reapStuckFlowRuns() } catch …` block), add an equally isolated block:

```ts
    // Slack thread sessions idle 7+ days are dead conversations — close them
    // so a months-later thread message starts fresh instead of resuming.
    // Isolated so a sweep failure never aborts the tick.
    try {
      const { closeStaleSlackSessions } = await import('@/lib/slack/session')
      await closeStaleSlackSessions()
    } catch (error) {
      apiLogger.error('cron/dispatch: slack session sweep failed', { error: capError(error) })
    }
```

(Match the surrounding block's exact error-helper usage — the file already uses `capError` at line 98.)

- [ ] **Step 9: Run everything**

Run: `npx tsc --noEmit && TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/slack/__tests__/session.test.ts && npm test`
Expected: no type errors; session tests PASS; the full suite passes (the seed change is inert when `slackContinueExecutionId` is unset — `slackSeedRemaining` starts false).

- [ ] **Step 10: Commit**

```bash
git add src/lib/slack/session.ts src/lib/slack/__tests__/session.test.ts src/lib/slack/dispatch.ts src/lib/slack/deliver.ts src/features/flows/execute-flow.ts src/app/api/cron/dispatch/route.ts
git commit -m "feat(slack): multi-turn threads — SlackThreadSession, ingress precedence, continueExecutionId seed"
```

---

### Task 8: Manifest endpoint + Integrations-page "Slack bot" card

**Files:**
- Create: `src/lib/slack/manifest.ts`
- Create: `src/app/api/slack/connections/[id]/manifest/route.ts`
- Create: `src/components/integrations/slack-bot-card.tsx`
- Modify: `src/app/integrations/page.tsx` (render the card in the "accounts" tab)
- Test: `src/lib/slack/__tests__/manifest.test.ts`

**Interfaces:**
- Consumes: `slackIngressUrl`, `serializeSlackConnection` (Task 1); `slackTriggerConfigOf` (Task 5); `withAuthenticatedApi`, `ApiError`.
- Produces: `buildSlackManifest(args: { appName: string; ingressUrl: string; commands?: string[] }): Record<string, unknown>` — a ready-to-paste Slack app manifest (JSON) with event subscriptions + slash-command request URLs pre-filled.

- [ ] **Step 1: Write the failing manifest test**

Create `src/lib/slack/__tests__/manifest.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSlackManifest } from '@/lib/slack/manifest'

test('manifest pre-fills scopes, event subscriptions, and the ingress URL', () => {
  const manifest = buildSlackManifest({ appName: 'Sublime Bot', ingressUrl: 'https://app.test/api/slack/events/bind_1' }) as any
  assert.equal(manifest.display_information.name, 'Sublime Bot')
  // Real scope names (the spec's "message.channels" is an event, not a scope).
  assert.deepEqual(manifest.oauth_config.scopes.bot, [
    'app_mentions:read', 'channels:history', 'chat:write', 'commands', 'im:history', 'im:read',
  ])
  assert.equal(manifest.settings.event_subscriptions.request_url, 'https://app.test/api/slack/events/bind_1')
  assert.deepEqual(manifest.settings.event_subscriptions.bot_events, ['app_mention', 'message.channels', 'message.im'])
  assert.equal(manifest.settings.socket_mode_enabled, false)
  assert.equal(manifest.features.slash_commands, undefined) // none configured
})

test('slash commands from the org flows are pre-filled with the ingress URL', () => {
  const manifest = buildSlackManifest({
    appName: 'Sublime Bot', ingressUrl: 'https://app.test/api/slack/events/bind_1', commands: ['/deploy', 'status'],
  }) as any
  assert.deepEqual(manifest.features.slash_commands.map((c: any) => c.command), ['/deploy', '/status'])
  assert.ok(manifest.features.slash_commands.every((c: any) => c.url === 'https://app.test/api/slack/events/bind_1'))
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/slack/__tests__/manifest.test.ts`
Expected: FAIL — `Cannot find module '@/lib/slack/manifest'`.

- [ ] **Step 3: Implement `src/lib/slack/manifest.ts`**

```ts
/** Ready-to-paste Slack app manifest so creating the Slack app is copy-paste.
 * NOTE: the design doc listed "message.channels" among the scopes — that is
 * an EVENT name; the real read scope for channel messages is channels:history. */
export function buildSlackManifest(args: { appName: string; ingressUrl: string; commands?: string[] }): Record<string, unknown> {
  const commands = Array.from(new Set((args.commands ?? []).map((command) => '/' + command.trim().replace(/^\//, '')).filter((command) => command !== '/')))
  return {
    display_information: { name: args.appName, description: 'Runs Sublime flows from Slack' },
    features: {
      bot_user: { display_name: args.appName, always_online: true },
      ...(commands.length
        ? {
            slash_commands: commands.map((command) => ({
              command,
              url: args.ingressUrl,
              description: 'Runs a Sublime flow',
              should_escape: false,
            })),
          }
        : {}),
    },
    oauth_config: {
      scopes: { bot: ['app_mentions:read', 'channels:history', 'chat:write', 'commands', 'im:history', 'im:read'] },
    },
    settings: {
      event_subscriptions: {
        request_url: args.ingressUrl,
        bot_events: ['app_mention', 'message.channels', 'message.im'],
      },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  }
}
```

- [ ] **Step 4: Run the manifest test — PASS**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/slack/__tests__/manifest.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Implement `src/app/api/slack/connections/[id]/manifest/route.ts`**

```ts
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { slackIngressUrl } from '@/lib/slack/connections'
import { buildSlackManifest } from '@/lib/slack/manifest'
import { slackTriggerConfigOf } from '@/lib/slack/route-event'

// GET — a ready-to-paste Slack app manifest for this binding, slash commands
// pre-filled from the org's active slack-triggered flows.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = new URL(request.url).pathname.split('/').at(-2)
  const binding = await prisma.slackWorkspaceConnection.findFirst({
    where: { id: id ?? '', organizationId: auth.organizationId },
  })
  if (!binding) throw new ApiError('Slack connection not found', 404, 'NOT_FOUND')
  const flows = await prisma.flow.findMany({
    where: { organizationId: auth.organizationId, status: 'ACTIVE' },
    select: { trigger: true },
    take: 200,
  })
  const commands = flows
    .map((flow) => slackTriggerConfigOf(flow.trigger)?.command)
    .filter((command): command is string => Boolean(command))
  const manifest = buildSlackManifest({
    appName: binding.teamName ? `Sublime (${binding.teamName})` : 'Sublime Bot',
    ingressUrl: slackIngressUrl(binding.id),
    commands,
  })
  return { success: true, manifest }
})
```

- [ ] **Step 6: Create `src/components/integrations/slack-bot-card.tsx`**

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import { Copy, Download, MessageSquare, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

type SlackConnection = {
  id: string
  teamId: string
  teamName: string | null
  botUserId: string
  status: string
  ingressUrl: string
}

export function SlackBotCard() {
  const [connections, setConnections] = useState<SlackConnection[]>([])
  const [botToken, setBotToken] = useState('')
  const [signingSecret, setSigningSecret] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/slack/connections')
      const data = await res.json()
      if (res.ok) setConnections(data.connections ?? [])
    } catch {
      // listing failure is non-fatal; the card just shows the connect form
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const connect = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/slack/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken, signingSecret }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) {
        toast.error(data.error || 'Slack token verification failed.')
        return
      }
      toast.success(`Connected ${data.connection.teamName ?? data.connection.teamId}.`)
      setBotToken('')
      setSigningSecret('')
      await load()
    } finally {
      setSaving(false)
    }
  }

  const disconnect = async (id: string) => {
    const res = await fetch(`/api/slack/connections?id=${id}`, { method: 'DELETE' })
    if (res.ok) {
      toast.success('Slack bot disconnected.')
      await load()
    } else toast.error('Could not disconnect.')
  }

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success('Ingress URL copied.')
    } catch {
      toast.error('Could not copy the URL.')
    }
  }

  const downloadManifest = async (id: string) => {
    const res = await fetch(`/api/slack/connections/${id}/manifest`)
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.manifest) {
      toast.error('Could not build the manifest.')
      return
    }
    const blob = new Blob([JSON.stringify(data.manifest, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'slack-app-manifest.json'
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5" /> Slack bot
        </CardTitle>
        <CardDescription>
          Let flows respond to @mentions, DMs, channel messages, and slash commands. Paste the bot token and signing secret from your Slack app.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {connections.map((connection) => (
          <div key={connection.id} className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">
                {connection.teamName ?? connection.teamId}{' '}
                <span className="text-xs text-slate-500">({connection.status})</span>
              </p>
              <Button type="button" variant="ghost" size="sm" onClick={() => disconnect(connection.id)} title="Disconnect">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <p className="break-all rounded bg-white px-2 py-1.5 font-mono text-[11px]">{connection.ingressUrl}</p>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => copyUrl(connection.ingressUrl)}>
                <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy ingress URL
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => downloadManifest(connection.id)}>
                <Download className="mr-1.5 h-3.5 w-3.5" /> Download app manifest
              </Button>
            </div>
          </div>
        ))}
        <div className="grid gap-2">
          <input
            className="h-9 rounded-md border border-slate-200 px-3 font-mono text-sm"
            type="password"
            value={botToken}
            placeholder="Bot token (xoxb-…)"
            onChange={(event) => setBotToken(event.target.value)}
          />
          <input
            className="h-9 rounded-md border border-slate-200 px-3 font-mono text-sm"
            type="password"
            value={signingSecret}
            placeholder="Signing secret"
            onChange={(event) => setSigningSecret(event.target.value)}
          />
          <Button type="button" onClick={connect} loading={saving} disabled={!botToken.trim() || !signingSecret.trim()}>
            {connections.length ? 'Connect another workspace' : 'Connect Slack bot'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
```

(Adjust the `Card`/`Button` imports to the exact components the neighboring `mcp-integration-cards.tsx` uses if they differ — match that file's conventions.)

- [ ] **Step 7: Render the card in `src/app/integrations/page.tsx`**

Add the import:

```tsx
import { SlackBotCard } from '@/components/integrations/slack-bot-card'
```

Change the "accounts" tab content:

```tsx
      <TabsContent value="accounts" className="mt-6 space-y-6">
        <SlackBotCard />
        <Suspense fallback={<p className="text-sm text-gray-500">Loading integrations...</p>}>
          <OAuthIntegrationsGrid />
        </Suspense>
      </TabsContent>
```

- [ ] **Step 8: Verify build + full suite**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: no type errors, all tests pass, production build succeeds.

- [ ] **Step 9: Commit**

```bash
git add src/lib/slack/manifest.ts src/lib/slack/__tests__/manifest.test.ts src/app/api/slack/connections/[id]/manifest/route.ts src/components/integrations/slack-bot-card.tsx src/app/integrations/page.tsx
git commit -m "feat(slack): app-manifest endpoint + Integrations-page Slack bot card"
```

---

## Spec coverage map (self-review)

| Spec section | Tasks |
|---|---|
| §1 binding model + setup API + manifest + setup UI | 1, 8 |
| §2 signed ingress (rate limit → raw body → signature → dedup → echo guard → fast-ack → route) + payload normalization | 2, 3 |
| §3 `slack` trigger type + config + `matchSlackFlows` + dispatch posture + builder UI + validation | 4, 5 |
| §4 reply-to-origin (mrkdwn format, response_url, suppression, always thread_ts) | 2 (format), 6 |
| §5 multi-turn (`SlackThreadSession`, ingress precedence, resume vs continue, `slackContinueExecutionId`, session close) | 1 (schema), 7 |
| §6 security constraints | Global Constraints + Tasks 1, 3 |
| §7 testing (pure units, route smoke, DB-gated) | every task |
