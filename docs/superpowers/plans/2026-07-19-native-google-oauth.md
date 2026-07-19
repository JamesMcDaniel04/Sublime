# Native Google OAuth (Gmail First) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gmail connections run on our own verified Google OAuth client (auth-code + refresh flow), at parity with the Nango path (send tool + intelligence scan), while Nango keeps serving all non-Google providers.

**Architecture:** A pure OAuth module (`src/lib/google/oauth.ts`) + encrypted token store (`GoogleOAuthConnection` mirrored into `NangoConnection` with `provider: 'google-native'`) + a `NangoProxy`-compatible fetch proxy (`src/lib/google/proxy.ts`). Adapters, the integrations grid, status, and scan planes read the mirrored rows unchanged; the only dispatch change is a `proxyForConnection()` selector at the two `spec.run(...)` call sites and skipping Nango deployed-actions for native connections.

**Tech Stack:** Next.js route handlers (`withAuthenticatedApi`), Prisma, AES-GCM secrets (`src/lib/crypto/secrets.ts`), node:test via `npm test`, route-smoke protocol from `.claude/skills/verify`.

## Global Constraints

- Env (read at CALL time, never module load — same rule as `getNangoClient`): `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`.
- Scopes for `google-mail`: `https://www.googleapis.com/auth/gmail.send`, `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/userinfo.email`.
- State: HMAC-SHA256 over `{ organizationId, userId, service, exp }` keyed from `ENCRYPTION_KEY`; 10-minute expiry.
- Timeouts: 10s token/userinfo endpoints, 20s proxy calls (mirror `withTimeout` in delivery.ts).
- Callback never renders a bare 500 — all failures 302 to `/integrations?error=<code>`.
- Mirror rows: `NangoConnection` with `provider: 'google-native'`, `connectionId` = GoogleOAuthConnection id, `providerConfigKey` = service.
- Queries through the guarded prisma client must include `organizationId` (tenant guard throws otherwise).
- `npm test` green before every commit; guard test (`no-legacy-brand-colors`) stays green (no UI colors added).

---

### Task 1: OAuth module (`src/lib/google/oauth.ts`)

**Files:**
- Create: `src/lib/google/oauth.ts`
- Test: `src/lib/google/__tests__/oauth.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 3–5):
  - `googleOAuthConfigured(): boolean`
  - `GOOGLE_SERVICE_SCOPES: Record<'google-mail', string[]>`
  - `type GoogleOAuthService = keyof typeof GOOGLE_SERVICE_SCOPES`
  - `signState(payload: { organizationId: string; userId: string; service: GoogleOAuthService }): string`
  - `verifyState(raw: string): { organizationId: string; userId: string; service: GoogleOAuthService } | null`
  - `buildAuthUrl(input: { service: GoogleOAuthService; state: string }): string`
  - `exchangeCode(code: string): Promise<{ accessToken: string; refreshToken: string | null; expiresIn: number; scope: string }>`
  - `refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }>`
  - `fetchAccountEmail(accessToken: string): Promise<string>`
  - `revokeToken(token: string): Promise<void>` (best-effort; swallows upstream errors)

- [ ] **Step 1: Write the failing tests**

Create `src/lib/google/__tests__/oauth.test.ts`:

```ts
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  GOOGLE_SERVICE_SCOPES,
  buildAuthUrl,
  googleOAuthConfigured,
  signState,
  verifyState,
} from '../oauth'

beforeEach(() => {
  process.env.ENCRYPTION_KEY = 'test-encryption-key'
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id.apps.googleusercontent.com'
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret'
  process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://app.example.com/api/google/oauth/callback'
})

test('configured only when all three env vars are set', () => {
  assert.equal(googleOAuthConfigured(), true)
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET
  assert.equal(googleOAuthConfigured(), false)
})

test('gmail scope set covers send, readonly, and userinfo.email', () => {
  const scopes = GOOGLE_SERVICE_SCOPES['google-mail']
  assert.ok(scopes.includes('https://www.googleapis.com/auth/gmail.send'))
  assert.ok(scopes.includes('https://www.googleapis.com/auth/gmail.readonly'))
  assert.ok(scopes.includes('https://www.googleapis.com/auth/userinfo.email'))
})

test('state round-trips and rejects tampering', () => {
  const state = signState({ organizationId: 'org-1', userId: 'user-1', service: 'google-mail' })
  const verified = verifyState(state)
  assert.deepEqual(
    { organizationId: verified?.organizationId, userId: verified?.userId, service: verified?.service },
    { organizationId: 'org-1', userId: 'user-1', service: 'google-mail' },
  )
  assert.equal(verifyState(state.slice(0, -2) + 'xx'), null)
  assert.equal(verifyState('garbage'), null)
})

test('auth url carries offline access, consent prompt, scopes, and state', () => {
  const url = new URL(buildAuthUrl({ service: 'google-mail', state: 'abc123' }))
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(url.searchParams.get('access_type'), 'offline')
  assert.equal(url.searchParams.get('prompt'), 'consent')
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('client_id'), 'client-id.apps.googleusercontent.com')
  assert.equal(url.searchParams.get('redirect_uri'), 'https://app.example.com/api/google/oauth/callback')
  assert.equal(url.searchParams.get('state'), 'abc123')
  assert.ok(url.searchParams.get('scope')?.includes('gmail.send'))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/google/__tests__/oauth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/google/oauth.ts`:

```ts
/**
 * Native Google OAuth — replaces Nango for Google providers (Google blocks
 * Nango's flow). Auth-code + refresh against OUR verified OAuth client.
 * Env is read at call time so builds succeed without configuration.
 */
import crypto from 'crypto'

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo'
const STATE_TTL_MS = 10 * 60 * 1000
const TOKEN_TIMEOUT_MS = 10_000

export const GOOGLE_SERVICE_SCOPES = {
  'google-mail': [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/userinfo.email',
  ],
} as const

export type GoogleOAuthService = keyof typeof GOOGLE_SERVICE_SCOPES

export function googleOAuthConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID
      && process.env.GOOGLE_OAUTH_CLIENT_SECRET
      && process.env.GOOGLE_OAUTH_REDIRECT_URI,
  )
}

function requireEnv(name: 'GOOGLE_OAUTH_CLIENT_ID' | 'GOOGLE_OAUTH_CLIENT_SECRET' | 'GOOGLE_OAUTH_REDIRECT_URI'): string {
  const value = process.env[name]
  if (!value) throw new Error(`Native Google OAuth is not configured. Please set ${name}`)
  return value
}

// ── Signed state (CSRF + context transport through Google) ──────────────────

function stateKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) throw new Error('ENCRYPTION_KEY is required for Google OAuth state signing')
  return crypto.createHash('sha256').update(`google-oauth-state:${raw}`).digest()
}

type StatePayload = { organizationId: string; userId: string; service: GoogleOAuthService }

export function signState(payload: StatePayload): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + STATE_TTL_MS })).toString('base64url')
  const mac = crypto.createHmac('sha256', stateKey()).update(body).digest('base64url')
  return `${body}.${mac}`
}

export function verifyState(raw: string): StatePayload | null {
  const [body, mac] = raw.split('.')
  if (!body || !mac) return null
  const expected = crypto.createHmac('sha256', stateKey()).update(body).digest('base64url')
  const macBuf = Buffer.from(mac)
  const expectedBuf = Buffer.from(expected)
  if (macBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(macBuf, expectedBuf)) return null
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString()) as StatePayload & { exp: number }
    if (typeof parsed.exp !== 'number' || parsed.exp < Date.now()) return null
    if (!(parsed.service in GOOGLE_SERVICE_SCOPES)) return null
    if (!parsed.organizationId || !parsed.userId) return null
    return { organizationId: parsed.organizationId, userId: parsed.userId, service: parsed.service }
  } catch {
    return null
  }
}

// ── Consent URL ─────────────────────────────────────────────────────────────

export function buildAuthUrl(input: { service: GoogleOAuthService; state: string }): string {
  const url = new URL(AUTH_ENDPOINT)
  url.searchParams.set('client_id', requireEnv('GOOGLE_OAUTH_CLIENT_ID'))
  url.searchParams.set('redirect_uri', requireEnv('GOOGLE_OAUTH_REDIRECT_URI'))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('access_type', 'offline')
  // Force the consent screen so Google returns a refresh token on every
  // connect (it omits one on silent re-approval).
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('include_granted_scopes', 'true')
  url.searchParams.set('scope', GOOGLE_SERVICE_SCOPES[input.service].join(' '))
  url.searchParams.set('state', input.state)
  return url.toString()
}

// ── Token endpoints ─────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer)) as Promise<T>
}

async function tokenRequest(params: Record<string, string>, label: string): Promise<Record<string, unknown>> {
  const response = await withTimeout(
    fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    }),
    TOKEN_TIMEOUT_MS,
    label,
  )
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    const detail = typeof data.error === 'string' ? data.error : `status ${response.status}`
    throw new Error(`${label} failed: ${detail}`)
  }
  return data
}

export async function exchangeCode(code: string): Promise<{ accessToken: string; refreshToken: string | null; expiresIn: number; scope: string }> {
  const data = await tokenRequest(
    {
      code,
      client_id: requireEnv('GOOGLE_OAUTH_CLIENT_ID'),
      client_secret: requireEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
      redirect_uri: requireEnv('GOOGLE_OAUTH_REDIRECT_URI'),
      grant_type: 'authorization_code',
    },
    'Google code exchange',
  )
  return {
    accessToken: String(data.access_token ?? ''),
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
    expiresIn: Number(data.expires_in ?? 0),
    scope: String(data.scope ?? ''),
  }
}

export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const data = await tokenRequest(
    {
      refresh_token: refreshToken,
      client_id: requireEnv('GOOGLE_OAUTH_CLIENT_ID'),
      client_secret: requireEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
      grant_type: 'refresh_token',
    },
    'Google token refresh',
  )
  return { accessToken: String(data.access_token ?? ''), expiresIn: Number(data.expires_in ?? 0) }
}

export async function fetchAccountEmail(accessToken: string): Promise<string> {
  const response = await withTimeout(
    fetch(USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${accessToken}` } }),
    TOKEN_TIMEOUT_MS,
    'Google userinfo',
  )
  if (!response.ok) throw new Error(`Google userinfo failed: status ${response.status}`)
  const data = (await response.json()) as { email?: string }
  if (!data.email) throw new Error('Google userinfo returned no email')
  return data.email
}

/** Best-effort revocation — a failed revoke must not block disconnect. */
export async function revokeToken(token: string): Promise<void> {
  try {
    await withTimeout(
      fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, { method: 'POST' }),
      TOKEN_TIMEOUT_MS,
      'Google token revoke',
    )
  } catch {
    // Ignored: the row is deleted regardless; Google GC's the grant.
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/google/__tests__/oauth.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/google/oauth.ts src/lib/google/__tests__/oauth.test.ts
git commit -m "feat: native Google OAuth module (consent url, signed state, token calls)"
```

---

### Task 2: Token store — Prisma model, migration, mirror helpers

**Files:**
- Modify: `prisma/schema.prisma` (new model after `NangoConnection`, plus `googleOAuthConnections GoogleOAuthConnection[]` on `Organization`)
- Create: `prisma/migrations/<generated>/migration.sql` (via `prisma migrate dev` on throwaway PG)
- Create: `src/lib/google/store.ts`
- Test: `src/lib/google/__tests__/store.test.ts` (encrypt round-trip; DB paths covered by Task 3 route-smoke)

**Interfaces:**
- Consumes: `encryptSecret(plaintext: string): string`, `decryptSecret(payload: string): string` from `@/lib/crypto/secrets`.
- Produces (consumed by Tasks 3–4):
  - `upsertGoogleConnection(input: { organizationId: string; userId: string; service: GoogleOAuthService; accountEmail: string; scopes: string[]; refreshToken: string }): Promise<{ id: string }>` — creates/updates the `GoogleOAuthConnection` AND its `NangoConnection` mirror row in one transaction.
  - `getGoogleConnection(id: string): Promise<{ id: string; organizationId: string; service: string; refreshToken: string; status: string } | null>` (decrypts).
  - `markGoogleConnectionError(id: string, message: string): Promise<void>` — sets status `error` + lastError on BOTH rows.
  - `deleteGoogleConnection(input: { organizationId: string; id: string }): Promise<{ refreshToken: string | null; service: string } | null>` — deletes both rows, returns the decrypted token for revocation.

- [ ] **Step 1: Add the Prisma model**

In `prisma/schema.prisma`, after `model NangoConnection`:

```prisma
// Native Google OAuth connections (Google blocks Nango's flow). The encrypted
// refresh token lives HERE; a NangoConnection row with provider
// 'google-native' mirrors each record so every existing read path (grid,
// status, tool plane, scan plane) works unchanged.
model GoogleOAuthConnection {
  id              String   @id @default(cuid())
  organizationId  String   @db.Uuid
  userId          String
  service         String // e.g. 'google-mail'
  accountEmail    String
  scopes          String[] @default([])
  refreshTokenEnc String   @db.Text
  status          String   @default("connected")
  lastError       String?  @db.Text
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@unique([organizationId, userId, service, accountEmail])
  @@index([organizationId, service])
  @@map("google_oauth_connections")
}
```

Add to `model Organization`'s relation list: `googleOAuthConnections GoogleOAuthConnection[]`.

- [ ] **Step 2: Generate the migration on throwaway Postgres**

Follow `.claude/skills/verify` (initdb on port 54339, stub `auth`/`realtime` schemas, `prisma migrate deploy` for existing migrations), then:

```bash
DATABASE_URL=postgresql://qa@127.0.0.1:54339/sublime_qa DIRECT_URL=$DATABASE_URL npx prisma migrate dev --name native_google_oauth_connections
```

Expected: new folder under `prisma/migrations/` containing `CREATE TABLE "google_oauth_connections" ...`; `npx prisma generate` succeeds.

- [ ] **Step 3: Write the failing store test**

Create `src/lib/google/__tests__/store.test.ts`:

```ts
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { encryptSecret, decryptSecret } from '@/lib/crypto/secrets'

beforeEach(() => {
  process.env.ENCRYPTION_KEY = 'test-encryption-key'
})

test('refresh tokens survive the encrypt/decrypt round trip used by the store', () => {
  const token = '1//0refresh-token-payload'
  assert.equal(decryptSecret(encryptSecret(token)), token)
})

test('store module exposes the four connection operations', async () => {
  const store = await import('../store')
  assert.equal(typeof store.upsertGoogleConnection, 'function')
  assert.equal(typeof store.getGoogleConnection, 'function')
  assert.equal(typeof store.markGoogleConnectionError, 'function')
  assert.equal(typeof store.deleteGoogleConnection, 'function')
})
```

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/google/__tests__/store.test.ts`
Expected: FAIL — `../store` not found.

- [ ] **Step 4: Implement the store**

Create `src/lib/google/store.ts`:

```ts
/**
 * Persistence for native Google OAuth connections. The refresh token is
 * AES-GCM encrypted at rest; every record keeps a NangoConnection mirror row
 * (provider 'google-native') so existing read paths stay unchanged.
 */
import { prisma } from '@/lib/prisma'
import { decryptSecret, encryptSecret } from '@/lib/crypto/secrets'
import type { GoogleOAuthService } from './oauth'

export const GOOGLE_NATIVE_PROVIDER = 'google-native'

export async function upsertGoogleConnection(input: {
  organizationId: string
  userId: string
  service: GoogleOAuthService
  accountEmail: string
  scopes: string[]
  refreshToken: string
}): Promise<{ id: string }> {
  const refreshTokenEnc = encryptSecret(input.refreshToken)
  return prisma.$transaction(async (tx) => {
    const record = await tx.googleOAuthConnection.upsert({
      where: {
        organizationId_userId_service_accountEmail: {
          organizationId: input.organizationId,
          userId: input.userId,
          service: input.service,
          accountEmail: input.accountEmail,
        },
      },
      create: {
        organizationId: input.organizationId,
        userId: input.userId,
        service: input.service,
        accountEmail: input.accountEmail,
        scopes: input.scopes,
        refreshTokenEnc,
      },
      update: { scopes: input.scopes, refreshTokenEnc, status: 'connected', lastError: null },
    })
    await tx.nangoConnection.upsert({
      where: { organizationId_connectionId: { organizationId: input.organizationId, connectionId: record.id } },
      create: {
        organizationId: input.organizationId,
        userId: input.userId,
        connectionId: record.id,
        providerConfigKey: input.service,
        provider: GOOGLE_NATIVE_PROVIDER,
        status: 'connected',
        metadata: { accountEmail: input.accountEmail },
      },
      update: { status: 'connected', lastError: null, metadata: { accountEmail: input.accountEmail } },
    })
    return { id: record.id }
  })
}

export async function getGoogleConnection(id: string) {
  const record = await prisma.googleOAuthConnection.findUnique({ where: { id } })
  if (!record) return null
  return {
    id: record.id,
    organizationId: record.organizationId,
    service: record.service,
    refreshToken: decryptSecret(record.refreshTokenEnc),
    status: record.status,
  }
}

export async function markGoogleConnectionError(id: string, message: string): Promise<void> {
  const record = await prisma.googleOAuthConnection.findUnique({ where: { id }, select: { organizationId: true } })
  if (!record) return
  await prisma.$transaction([
    prisma.googleOAuthConnection.update({ where: { id }, data: { status: 'error', lastError: message } }),
    prisma.nangoConnection.updateMany({
      where: { organizationId: record.organizationId, connectionId: id, provider: GOOGLE_NATIVE_PROVIDER },
      data: { status: 'error', lastError: message },
    }),
  ])
}

export async function deleteGoogleConnection(input: { organizationId: string; id: string }) {
  const record = await prisma.googleOAuthConnection.findFirst({
    where: { id: input.id, organizationId: input.organizationId },
  })
  if (!record) return null
  await prisma.$transaction([
    prisma.nangoConnection.deleteMany({
      where: { organizationId: input.organizationId, connectionId: record.id, provider: GOOGLE_NATIVE_PROVIDER },
    }),
    prisma.googleOAuthConnection.delete({ where: { id: record.id } }),
  ])
  let refreshToken: string | null = null
  try {
    refreshToken = decryptSecret(record.refreshTokenEnc)
  } catch {
    // Undecryptable token (rotated key) — deletion already happened; revoke is skipped.
  }
  return { refreshToken, service: record.service }
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/google/__tests__/store.test.ts && npm run typecheck`
Expected: PASS / clean (prisma generate must have run for the new model).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/google/store.ts src/lib/google/__tests__/store.test.ts
git commit -m "feat: GoogleOAuthConnection model with encrypted tokens and Nango mirror rows"
```

---

### Task 3: OAuth routes (start / callback / disconnect) + route-smoke tests

**Files:**
- Create: `src/app/api/google/oauth/start/route.ts`
- Create: `src/app/api/google/oauth/callback/route.ts`
- Create: `src/app/api/google/oauth/connections/[id]/route.ts`
- Test: `src/app/api/__tests__/google-oauth-routes.test.ts`

**Interfaces:**
- Consumes: Task 1 (`signState`, `verifyState`, `buildAuthUrl`, `exchangeCode`, `fetchAccountEmail`, `revokeToken`, `googleOAuthConfigured`, `GOOGLE_SERVICE_SCOPES`), Task 2 (`upsertGoogleConnection`, `deleteGoogleConnection`), `withAuthenticatedApi` + `ApiError` from `@/lib/server/api-handler`, `scanConnection`/`shouldScanNangoConnection`/`purgeConnectionLearnings` from `@/lib/intelligence/connection-scan` (mirror the disconnect purge in `/api/nango/status`), `after` from `next/server`.
- Produces: routes exactly as specified below; Task 6's UI calls `/api/google/oauth/start?service=google-mail` (full navigation) and `DELETE /api/google/oauth/connections/<id>`.

- [ ] **Step 1: Write failing route-smoke tests**

Create `src/app/api/__tests__/google-oauth-routes.test.ts` following the seeding pattern in `src/app/api/__tests__/route-smoke.test.ts` (`seedTestOrg`, `installTestAuth` from `@/lib/server/__tests__/test-auth`; skip when `TEST_DATABASE_URL` unset):

```ts
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const DB = process.env.TEST_DATABASE_URL
const ENABLED = Boolean(DB)

before(() => {
  process.env.ENCRYPTION_KEY = 'test-encryption-key'
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'client-id.apps.googleusercontent.com'
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'client-secret'
  process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://127.0.0.1:3000/api/google/oauth/callback'
})

test('start route 302s to Google with a signed state', { skip: !ENABLED }, async () => {
  const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
  const seeded = await seedTestOrg()
  installTestAuth(seeded)
  const { GET } = await import('@/app/api/google/oauth/start/route')
  const response = await GET(new NextRequest('http://127.0.0.1/api/google/oauth/start?service=google-mail'))
  assert.ok(response.status >= 300 && response.status < 400, `expected redirect, got ${response.status}`)
  const location = new URL(response.headers.get('location') ?? '')
  assert.equal(location.hostname, 'accounts.google.com')
  const { verifyState } = await import('@/lib/google/oauth')
  const state = verifyState(location.searchParams.get('state') ?? '')
  assert.equal(state?.organizationId, seeded.organizationId)
})

test('callback with forged state redirects to integrations error', { skip: !ENABLED }, async () => {
  const { GET } = await import('@/app/api/google/oauth/callback/route')
  const response = await GET(new NextRequest('http://127.0.0.1/api/google/oauth/callback?code=x&state=forged'))
  const location = response.headers.get('location') ?? ''
  assert.ok(location.includes('/integrations?error=invalid_state'), location)
})

test('disconnect deletes both rows', { skip: !ENABLED }, async () => {
  const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
  const seeded = await seedTestOrg()
  installTestAuth(seeded)
  const { upsertGoogleConnection } = await import('@/lib/google/store')
  const { id } = await upsertGoogleConnection({
    organizationId: seeded.organizationId,
    userId: seeded.userId,
    service: 'google-mail',
    accountEmail: 'a@b.co',
    scopes: ['https://www.googleapis.com/auth/gmail.send'],
    refreshToken: 'rt-1',
  })
  const { DELETE } = await import('@/app/api/google/oauth/connections/[id]/route')
  const response = await DELETE(
    new NextRequest(`http://127.0.0.1/api/google/oauth/connections/${id}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id }) },
  )
  assert.equal(response.status, 200)
  const { prisma } = await import('@/lib/prisma')
  assert.equal(await prisma.googleOAuthConnection.findUnique({ where: { id } }), null)
  assert.equal(
    (await prisma.nangoConnection.findMany({ where: { organizationId: seeded.organizationId, connectionId: id } })).length,
    0,
  )
})
```

NOTE: match the exact `params` typing (`Promise` vs plain object) and `seedTestOrg`/`installTestAuth` signatures to what `route-smoke.test.ts` actually does — copy its conventions verbatim at implementation time.

- [ ] **Step 2: Run to verify failure**

Run (throwaway PG up per `.claude/skills/verify`):
`TEST_DATABASE_URL=postgresql://qa@127.0.0.1:54339/sublime_qa TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/google-oauth-routes.test.ts`
Expected: FAIL — route modules not found.

- [ ] **Step 3: Implement the three routes**

`src/app/api/google/oauth/start/route.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { GOOGLE_SERVICE_SCOPES, buildAuthUrl, googleOAuthConfigured, signState, type GoogleOAuthService } from '@/lib/google/oauth'

export const runtime = 'nodejs'

export const GET = withAuthenticatedApi(async (request: NextRequest, auth) => {
  if (!googleOAuthConfigured()) throw new ApiError('Native Google OAuth is not configured.', 501, 'GOOGLE_OAUTH_UNCONFIGURED')
  const service = request.nextUrl.searchParams.get('service') ?? 'google-mail'
  if (!(service in GOOGLE_SERVICE_SCOPES)) throw new ApiError(`Unknown Google service: ${service}`, 400, 'GOOGLE_SERVICE_UNKNOWN')
  const state = signState({ organizationId: auth.organizationId, userId: auth.userId, service: service as GoogleOAuthService })
  return NextResponse.redirect(buildAuthUrl({ service: service as GoogleOAuthService, state }))
})
```

(Adjust `auth.organizationId` / `auth.userId` property names to the real `AuthContext` shape — check `requireAuthContext`'s return type at implementation time.)

`src/app/api/google/oauth/callback/route.ts`:

```ts
import { NextResponse, after, type NextRequest } from 'next/server'
import { exchangeCode, fetchAccountEmail, verifyState, GOOGLE_SERVICE_SCOPES } from '@/lib/google/oauth'
import { upsertGoogleConnection } from '@/lib/google/store'
import { scanConnection, shouldScanNangoConnection } from '@/lib/intelligence/connection-scan'
import { apiLogger } from '@/lib/logger'

export const runtime = 'nodejs'

/** Google redirects the browser here; auth context rides in the signed state. */
export async function GET(request: NextRequest): Promise<Response> {
  const redirect = (suffix: string) => NextResponse.redirect(new URL(`/integrations${suffix}`, request.nextUrl.origin))
  const params = request.nextUrl.searchParams
  if (params.get('error')) return redirect(`?error=${encodeURIComponent(params.get('error') ?? 'denied')}`)

  const state = verifyState(params.get('state') ?? '')
  if (!state) return redirect('?error=invalid_state')
  const code = params.get('code')
  if (!code) return redirect('?error=missing_code')

  try {
    const tokens = await exchangeCode(code)
    if (!tokens.refreshToken) return redirect('?error=no_refresh_token')
    const accountEmail = await fetchAccountEmail(tokens.accessToken)
    const { id } = await upsertGoogleConnection({
      organizationId: state.organizationId,
      userId: state.userId,
      service: state.service,
      accountEmail,
      scopes: tokens.scope ? tokens.scope.split(' ') : [...GOOGLE_SERVICE_SCOPES[state.service]],
      refreshToken: tokens.refreshToken,
    })
    // Same post-connect usage scan Nango connections get (fire-and-forget).
    after(async () => {
      try {
        if (await shouldScanNangoConnection(state.organizationId, id)) {
          await scanConnection({ organizationId: state.organizationId, userId: state.userId, plane: 'nango', connectionRef: id })
        }
      } catch (error) {
        apiLogger.warn('google-oauth: post-connect scan failed', { error: error instanceof Error ? error.message : String(error) })
      }
    })
    return redirect('?connected=gmail')
  } catch (error) {
    apiLogger.error('google-oauth: callback failed', { error: error instanceof Error ? error.message : String(error) })
    return redirect('?error=exchange_failed')
  }
}
```

(Verify `shouldScanNangoConnection` / `scanConnection` argument shapes against `/api/nango/status`'s usage at implementation time; mirror that call exactly.)

`src/app/api/google/oauth/connections/[id]/route.ts`:

```ts
import { type NextRequest } from 'next/server'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { revokeToken } from '@/lib/google/oauth'
import { deleteGoogleConnection } from '@/lib/google/store'
import { capabilityForProviderConfigKey } from '@/lib/nango/delivery'
import { purgeConnectionLearnings } from '@/lib/intelligence/connection-scan'

export const runtime = 'nodejs'

export const DELETE = withAuthenticatedApi(async (request: NextRequest, auth) => {
  const id = request.nextUrl.pathname.split('/').pop() ?? ''
  const deleted = await deleteGoogleConnection({ organizationId: auth.organizationId, id })
  if (!deleted) throw new ApiError('Connection not found.', 404, 'GOOGLE_CONNECTION_NOT_FOUND')
  if (deleted.refreshToken) await revokeToken(deleted.refreshToken)
  // Purge learnings the same way the Nango disconnect path does (mirror the
  // exact purge call used in /api/nango/connections/[integrationId]).
  const capability = capabilityForProviderConfigKey(deleted.service)
  if (capability) await purgeConnectionLearnings(auth.organizationId, [capability])
  return { success: true }
})
```

(Mirror the actual purge invocation from the Nango disconnect route — argument shapes verified at implementation time; `capabilitiesToPurgeOnDisconnect` may be needed if other connections still cover the capability.)

- [ ] **Step 4: Run route-smoke tests**

Same command as Step 2. Expected: PASS (3 tests).

- [ ] **Step 5: Full suite + commit**

```bash
npm test && npm run typecheck
git add src/app/api/google src/app/api/__tests__/google-oauth-routes.test.ts
git commit -m "feat: native Google OAuth start/callback/disconnect routes"
```

---

### Task 4: Native proxy (`src/lib/google/proxy.ts`)

**Files:**
- Create: `src/lib/google/proxy.ts`
- Test: `src/lib/google/__tests__/proxy.test.ts`

**Interfaces:**
- Consumes: `refreshAccessToken` (Task 1), `getGoogleConnection`, `markGoogleConnectionError` (Task 2), `NangoProxyArgs`/`NangoProxy` types from `@/lib/nango/delivery`.
- Produces (consumed by Task 5):
  - `googleProxy(connectionId: string): NangoProxy`
  - `clearGoogleTokenCache(): void` (test seam)
  - `isGoogleNativeProvider(provider: string | null | undefined): boolean` — true for `'google-native'`.

- [ ] **Step 1: Write failing tests**

Create `src/lib/google/__tests__/proxy.test.ts` — inject fetch/token deps via the exported test seam:

```ts
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { __testHooks, clearGoogleTokenCache, googleProxy, isGoogleNativeProvider } from '../proxy'

beforeEach(() => {
  clearGoogleTokenCache()
  __testHooks.reset()
})

test('provider discriminator', () => {
  assert.equal(isGoogleNativeProvider('google-native'), true)
  assert.equal(isGoogleNativeProvider('google'), false)
  assert.equal(isGoogleNativeProvider(null), false)
})

test('maps gmail endpoints to gmail.googleapis.com and sends bearer', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  __testHooks.set({
    loadConnection: async () => ({ id: 'c1', organizationId: 'o1', service: 'google-mail', refreshToken: 'rt', status: 'connected' }),
    refresh: async () => ({ accessToken: 'at-1', expiresIn: 3600 }),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })
  const proxy = googleProxy('c1')
  const result = await proxy({ method: 'POST', endpoint: '/gmail/v1/users/me/messages/send', connectionId: 'c1', providerConfigKey: 'google-mail', data: { raw: 'x' } })
  assert.deepEqual(result.data, { ok: true })
  assert.equal(calls[0].url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send')
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer at-1')
})

test('retries exactly once on 401 with a forced refresh', async () => {
  let refreshes = 0
  let attempts = 0
  __testHooks.set({
    loadConnection: async () => ({ id: 'c1', organizationId: 'o1', service: 'google-mail', refreshToken: 'rt', status: 'connected' }),
    refresh: async () => ({ accessToken: `at-${++refreshes}`, expiresIn: 3600 }),
    fetchImpl: async () => {
      attempts += 1
      return attempts === 1
        ? new Response('unauthorized', { status: 401 })
        : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })
  const proxy = googleProxy('c1')
  const result = await proxy({ method: 'GET', endpoint: '/gmail/v1/users/me/profile', connectionId: 'c1', providerConfigKey: 'google-mail' })
  assert.deepEqual(result.data, { ok: true })
  assert.equal(attempts, 2)
  assert.equal(refreshes, 2)
})

test('reuses a cached access token across calls', async () => {
  let refreshes = 0
  __testHooks.set({
    loadConnection: async () => ({ id: 'c1', organizationId: 'o1', service: 'google-mail', refreshToken: 'rt', status: 'connected' }),
    refresh: async () => ({ accessToken: `at-${++refreshes}`, expiresIn: 3600 }),
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  })
  const proxy = googleProxy('c1')
  await proxy({ method: 'GET', endpoint: '/gmail/v1/users/me/profile', connectionId: 'c1', providerConfigKey: 'google-mail' })
  await proxy({ method: 'GET', endpoint: '/gmail/v1/users/me/profile', connectionId: 'c1', providerConfigKey: 'google-mail' })
  assert.equal(refreshes, 1)
})
```

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/google/__tests__/proxy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement the proxy**

Create `src/lib/google/proxy.ts`:

```ts
/**
 * NangoProxy-compatible executor for native Google connections. Delivery
 * adapters keep their exact call shape; only the transport differs: a bearer
 * token minted from the stored refresh token, cached in-memory per connection.
 */
import type { NangoProxy, NangoProxyArgs } from '@/lib/nango/delivery'
import { refreshAccessToken } from './oauth'
import { getGoogleConnection, markGoogleConnectionError, GOOGLE_NATIVE_PROVIDER } from './store'

const PROXY_TIMEOUT_MS = 20_000
const EXPIRY_SLACK_MS = 60_000

type CachedToken = { accessToken: string; expiresAt: number }
const tokenCache = new Map<string, CachedToken>()

type Hooks = {
  loadConnection: typeof getGoogleConnection
  refresh: typeof refreshAccessToken
  fetchImpl: typeof fetch
}
const defaultHooks: Hooks = { loadConnection: getGoogleConnection, refresh: refreshAccessToken, fetchImpl: fetch }
let hooks: Hooks = { ...defaultHooks }

/** Test seam: swap the DB/token/fetch dependencies without module mocking. */
export const __testHooks = {
  set(next: Partial<Hooks>) {
    hooks = { ...hooks, ...next }
  },
  reset() {
    hooks = { ...defaultHooks }
  },
}

export function clearGoogleTokenCache(): void {
  tokenCache.clear()
}

export function isGoogleNativeProvider(provider: string | null | undefined): boolean {
  return provider === GOOGLE_NATIVE_PROVIDER
}

function baseUrlFor(endpoint: string): string {
  return endpoint.startsWith('/gmail/') ? 'https://gmail.googleapis.com' : 'https://www.googleapis.com'
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer)) as Promise<T>
}

async function accessTokenFor(connectionId: string, force: boolean): Promise<string> {
  const cached = tokenCache.get(connectionId)
  if (!force && cached && cached.expiresAt > Date.now() + EXPIRY_SLACK_MS) return cached.accessToken
  const connection = await hooks.loadConnection(connectionId)
  if (!connection) throw new Error(`Google connection ${connectionId} not found`)
  try {
    const { accessToken, expiresIn } = await hooks.refresh(connection.refreshToken)
    tokenCache.set(connectionId, { accessToken, expiresAt: Date.now() + expiresIn * 1000 })
    return accessToken
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await markGoogleConnectionError(connectionId, message).catch(() => undefined)
    throw new Error(`Google token refresh failed for connection ${connectionId}: ${message}`)
  }
}

async function execute(args: NangoProxyArgs, accessToken: string): Promise<Response> {
  const url = new URL(baseUrlFor(args.endpoint) + args.endpoint)
  for (const [key, value] of Object.entries(args.params ?? {})) url.searchParams.set(key, String(value))
  return withTimeout(
    hooks.fetchImpl(url.toString(), {
      method: args.method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(args.data !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(args.data !== undefined ? { body: JSON.stringify(args.data) } : {}),
    }),
    PROXY_TIMEOUT_MS,
    `Google proxy ${args.method} ${args.endpoint}`,
  )
}

export function googleProxy(connectionId: string): NangoProxy {
  return async (args) => {
    let response = await execute(args, await accessTokenFor(connectionId, false))
    if (response.status === 401) {
      // One forced-refresh retry: covers revoked cache entries, not revoked grants.
      response = await execute(args, await accessTokenFor(connectionId, true))
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`Google API ${args.method} ${args.endpoint} failed (${response.status}): ${body.slice(0, 300)}`)
    }
    const data = response.headers.get('content-type')?.includes('application/json')
      ? await response.json()
      : await response.text()
    return { data }
  }
}
```

- [ ] **Step 3: Run tests**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/google/__tests__/proxy.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
git add src/lib/google/proxy.ts src/lib/google/__tests__/proxy.test.ts
git commit -m "feat: NangoProxy-compatible native Google proxy with token cache"
```

---

### Task 5: Dispatch — plane gating, provider marker, proxy selection, status flag

**Files:**
- Modify: `src/lib/nango/delivery.ts` (add `provider` to `DeliveryConnection` + `resolveDeliveryConnection` select)
- Modify: `src/features/agents/tool-planes.ts:298-360` (`loadNangoPlaneGroups` gate + native branch) and the flow-tool site near `:539`
- Modify: `src/app/api/nango/status/route.ts` (`nativeGoogle` flag; skip `google-native` in Nango-cloud reconciliation)
- Modify: `src/app/api/nango/integrations/route.ts` (inject native Gmail tile when configured)
- Test: `src/lib/google/__tests__/dispatch.test.ts`

**Interfaces:**
- Consumes: `googleProxy`, `isGoogleNativeProvider` (Task 4), `googleOAuthConfigured` (Task 1).
- Produces: `proxyForConnection(connection: DeliveryConnection): NangoProxy | undefined` exported from `src/lib/google/proxy.ts` — returns `googleProxy(connection.connectionId)` when `isGoogleNativeProvider(connection.provider)`, else `undefined` (callers fall back to the Nango default proxy).

- [ ] **Step 1: Write failing dispatch test**

Create `src/lib/google/__tests__/dispatch.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { proxyForConnection } from '../proxy'

test('native connections get the google proxy, others fall through', () => {
  assert.equal(typeof proxyForConnection({ connectionId: 'c1', providerConfigKey: 'google-mail', scope: 'user', provider: 'google-native' }), 'function')
  assert.equal(proxyForConnection({ connectionId: 'c2', providerConfigKey: 'google-mail', scope: 'user', provider: null }), undefined)
  assert.equal(proxyForConnection({ connectionId: 'c3', providerConfigKey: 'slack', scope: 'org', provider: 'slack' }), undefined)
})
```

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/google/__tests__/dispatch.test.ts`
Expected: FAIL — `proxyForConnection` not exported.

- [ ] **Step 2: Add the provider marker + selector**

In `src/lib/nango/delivery.ts`: add `provider: string | null` to the `DeliveryConnection` type and include `provider: chosen.provider ?? null` in `resolveDeliveryConnection`'s return (add `provider: true` to its prisma `select`).

In `src/lib/google/proxy.ts` append:

```ts
import type { DeliveryConnection } from '@/lib/nango/delivery'

/** Adapter call sites: native connections route through googleProxy; a
 *  undefined return means "use the caller's default (Nango) proxy". */
export function proxyForConnection(connection: DeliveryConnection): NangoProxy | undefined {
  return isGoogleNativeProvider(connection.provider) ? googleProxy(connection.connectionId) : undefined
}
```

- [ ] **Step 3: Wire the two `spec.run` sites and the plane gate**

In `src/features/agents/tool-planes.ts`:

1. Gate: `if (!nangoConfigured()) return []` becomes

```ts
if (!nangoConfigured() && !googleOAuthConfigured()) return []
```

(import `googleOAuthConfigured` from `@/lib/google/oauth`).

2. Deployed actions are a Nango-environment feature — skip them for native connections:

```ts
const actionTools = isGoogleNativeProvider(connection.provider)
  ? []
  : await listActionTools(connection.providerConfigKey, capability)
```

3. Static-spec execute site: `spec.run(connection, args)` becomes

```ts
spec.run(connection, args, proxyForConnection(connection))
```

…but `spec.run`'s third parameter defaults to `defaultProxy()` only when `undefined` is passed — verify the `DeliveryToolSpec.run` signature treats an explicit `undefined` as "use default" (it does: default parameters apply to `undefined`). Apply the same change at the flow-tool site near line 539.

4. `listActionTools` also short-circuits when Nango is unconfigured: guard its call with `nangoConfigured()` if it isn't already (native-only deployments must not call the Nango API).

- [ ] **Step 4: Status + integrations routes**

In `src/app/api/nango/status/route.ts`:
- Add `nativeGoogle: googleOAuthConfigured()` to the GET response payload.
- Mark mirrored `google-native` rows in the per-provider map: add `native: true` on entries whose row has `provider === 'google-native'` (type: extend `ConnectionStatus` with `native?: boolean`).
- Any block that reconciles against the Nango cloud API (listing/deleting Nango connections) must filter `provider !== 'google-native'` first — locate each `getNangoClient()` usage in the route and exclude native rows from its inputs.
- The route's early-exit when Nango is unconfigured must still return mirrored native rows: guard only the Nango-cloud calls, not the DB reads.

In `src/app/api/nango/integrations/route.ts`: when `googleOAuthConfigured()` and the Nango-sourced list lacks a Gmail entry (or Nango is unconfigured entirely), append:

```ts
{ id: 'google-mail', name: 'Gmail', provider: 'google-mail', native: true }
```

matching the route's existing item shape (verify exact fields at implementation time; keep `id: 'google-mail'` so status keying by providerConfigKey lines up).

- [ ] **Step 5: Run tests + typecheck + full suite**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/google/__tests__/dispatch.test.ts && npm test && npm run typecheck`
Expected: all pass — existing tool-plane/delivery tests must stay green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/nango/delivery.ts src/features/agents/tool-planes.ts src/app/api/nango/status/route.ts src/app/api/nango/integrations/route.ts src/lib/google/proxy.ts src/lib/google/__tests__/dispatch.test.ts
git commit -m "feat: route native Google connections through googleProxy at the tool planes"
```

---

### Task 6: UI (grid connect/disconnect) + full verification

**Files:**
- Modify: `src/app/integrations/oauth-integrations-grid.tsx:108-165` (connect/disconnect branches)
- Test: manual + existing suite (grid has no unit tests today; behavior is a navigation)

**Interfaces:**
- Consumes: `/api/google/oauth/start?service=google-mail` (Task 3), `DELETE /api/google/oauth/connections/<connectionId>` (Task 3), `nativeGoogle` + per-entry `native`/`connectionIds` from status (Task 5).

- [ ] **Step 1: Branch connect()**

In `connect(integration)`, before the Nango session-token flow:

```ts
// Native Google OAuth: full-page redirect to our own consent flow — Google
// blocks Nango's, and a popup would lose the httpOnly session on return.
if (integration.id === 'google-mail' && statusData?.nativeGoogle) {
  window.location.href = '/api/google/oauth/start?service=google-mail'
  return
}
```

(Use the actual status-state variable name in the file; `statusData` per the earlier hook: `const { data: statusData ... } = ...`.)

- [ ] **Step 2: Branch disconnect()**

In `disconnect(integration)`, when the status entry for the integration has `native: true`, call the native route for each connection id:

```ts
const entry = statusData?.connections?.[integration.id]
if (entry?.native && entry.connectionIds?.length) {
  for (const connectionId of entry.connectionIds) {
    const response = await fetch(`/api/google/oauth/connections/${encodeURIComponent(connectionId)}`, { method: 'DELETE' })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data.error || 'Unable to disconnect account')
    }
  }
  await refreshStatus()
  return
}
```

(Match the file's real status-payload accessors; keep the existing confirm() guard and busy handling around it.)

- [ ] **Step 3: Connected-state toast on return**

The callback lands on `/integrations?connected=gmail` or `?error=<code>`. In the grid (or `src/app/integrations/page.tsx` if it owns searchParams), on mount: read the params, `toast.success('Gmail connected')` / `toast.error(...)`, then `router.replace('/integrations')` to strip them. Follow the existing `useSearchParams` usage in `page.tsx`.

- [ ] **Step 4: Full verification**

Run:

```bash
npm test && npm run lint && npm run typecheck
NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder-anon-key SKIP_MIGRATE=1 npx next build
```

Expected: suite green (including new oauth/store/proxy/dispatch/route tests), lint/typecheck clean, build succeeds.

Route-smoke rerun against throwaway PG:
`TEST_DATABASE_URL=postgresql://qa@127.0.0.1:54339/sublime_qa TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/google-oauth-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/integrations
git commit -m "feat: native Google OAuth connect/disconnect in integrations grid"
```
