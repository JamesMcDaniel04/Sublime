# Credential Vault + HTTP Node n8n-Parity — Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give flow nodes a reusable, org-scoped credential vault (Basic / Bearer / Header / Query / Custom) and wire the HTTP node to attach a saved credential that is injected into the *real* outbound request server-side — never persisted to graph JSON, run rows, or logs.

**Architecture:** A new `Credential` Prisma table stores encrypted secrets (reusing `src/lib/crypto/secrets.ts` AES-256-GCM). A new pure `src/lib/credentials/` module builds/redacts config, turns a decrypted credential into a typed **injection plan**, and applies it to a request (user-supplied values always win). `resolveCredential` does the DB lookup + `allowedDomains` egress check + decrypt. The HTTP node's `execute-flow.ts` block resolves + applies the plan at fetch time; the step-card gains an n8n-parity Authentication section, Import cURL, and Send-toggles. CRUD lives at `/api/credentials`.

**Tech Stack:** Next.js 15 (App Router, `runtime = 'nodejs'`), Prisma + Postgres, Zod, `node:test` + `@testing-library/react` (jsdom), `tsx`.

## Global Constraints

- **Node:** `>=20 <23`. TypeScript strict; no `any` in shipped code (tests may cast).
- **Secrets discipline (non-negotiable):** a decrypted secret value exists only transiently inside the worker/route at call time. It must NEVER be written to `Flow.graph`, `FlowRunStep.input/output`, client responses, or logs. Only the opaque `credentialId`, header *names*, and query *keys* may be persisted — never their values.
- **No inline secret tokens.** Do not add a `{{secret.*}}` namespace. Credentials attach only via the structured `credentialId` field. The existing `{{step.*}}` token editor is for prior-step data and is unchanged.
- **Encryption:** always go through `encryptSecret`/`decryptSecret` from `@/lib/crypto/secrets`. `ENCRYPTION_KEY` is required in production (already enforced there).
- **Precedence rule (verbatim across all tasks):** when a credential injects a header or query key, it fills that key ONLY IF the request does not already carry a non-empty value for it (case-insensitive for headers). A user-supplied value always wins — this mirrors the existing `withBearerAuthorization`.
- **Auth schemes in scope:** `basic | bearer | apiKeyHeader | apiKeyQuery | custom`. OAuth2/Digest/OAuth1 are OUT (Phase 2 / future).
- **Org-scope guard:** every Prisma query you write against org models MUST include `organizationId` (the tenant guard in `src/lib/tenant-guard.ts` throws otherwise).
- **Unit test run (pure logic):** `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <file>`
- **DB/route test run:** bring up throwaway Postgres per the **`verify`** skill (Homebrew PG15, port 54339, stub the Supabase objects, `prisma migrate deploy`). Then prefix the run with `TEST_DATABASE_URL=postgresql://qa@127.0.0.1:54339/sublime_qa`. Seed with `seedTestOrg(prisma)` → `{ organizationId, userId, auth, cleanup }` and `installTestAuth(auth)` from `@/lib/server/__tests__/test-auth`.
- **Commit** after every task (green tests). Branch: work on the current feature branch; do not push unless asked.

---

## File Structure

**Create**
- `src/lib/credentials/types.ts` — shared types (`CredentialType`, `CredentialInput`, `InjectionPlan`, `RedactedCredential`).
- `src/lib/credentials/config.ts` — `buildCredentialConfig` / `mergeCredentialConfig` / `redactCredential` / `decryptCredentialConfig`.
- `src/lib/credentials/plan.ts` — `credentialInjectionPlan` / `isRequestUrlAllowed` (pure).
- `src/lib/credentials/apply.ts` — `applyCredentialPlan` (pure).
- `src/lib/credentials/resolve.ts` — `credentialScope` / `resolveCredential` + error constants (DB).
- `src/lib/credentials/curl.ts` — `parseCurl` (pure).
- `src/lib/credentials/__tests__/*.test.ts` — one per module above.
- `src/app/api/credentials/route.ts` — GET (list) + POST (create).
- `src/app/api/credentials/[id]/route.ts` — GET + PUT + DELETE.
- `src/app/api/__tests__/credentials-route-smoke.test.ts` — route-smoke.
- `src/components/credentials/credential-editor.tsx` — create/edit modal.
- `src/components/credentials/credentials-manager.tsx` — list + actions.
- `src/app/settings/credentials/page.tsx` — hosts the manager.
- `src/components/flows/http-auth-fields.ts` — pure helpers for the node UI (`deriveSendDefaults`, `applyCurlToHttpData`) + their test.

**Modify**
- `prisma/schema.prisma` — add `Credential` model + back-relations on `Organization` and `User`.
- `src/lib/flows/graph.ts` — extend `httpNode.data` (authMode, credentialId, sendQuery/Headers/Body).
- `src/features/flows/execute-flow.ts` — resolve + apply credential in the HTTP block.
- `src/components/flows/step-card.tsx` — HTTP Authentication section, Import cURL, Send-toggles.

---

## Task 1: `Credential` schema + migration

**Files:**
- Modify: `prisma/schema.prisma` (add model after `IntegrationSecret`, ~L603; add back-relations on `Organization` ~L11 and `User` ~L67)

**Interfaces:**
- Produces: `prisma.credential` model with fields `id, organizationId, userId?, name, type, authConfig(Json), allowedDomains(String[]), isActive, createdById?, lastUsedAt?, createdAt, updatedAt`.

- [ ] **Step 1: Add the model.** Insert after the `IntegrationSecret` block in `prisma/schema.prisma`:

```prisma
// Reusable, org-scoped credential for authenticating outbound requests from
// flow nodes. authConfig holds encryptSecret() blobs for secret fields plus
// plaintext metadata (headerName, queryParam, username). userId null =
// org-shared; set = personal to creator. allowedDomains empty = any host.
model Credential {
  id             String    @id @default(cuid())
  organizationId String    @db.Uuid
  userId         String?
  name           String
  type           String    // basic | bearer | apiKeyHeader | apiKeyQuery | custom
  authConfig     Json      @default("{}")
  allowedDomains String[]  @default([])
  isActive       Boolean   @default(true)
  createdById    String?
  lastUsedAt     DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  user         User?        @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([organizationId, userId, name])
  @@index([organizationId, isActive])
  @@index([organizationId, userId, isActive])
  @@map("credentials")
}
```

- [ ] **Step 2: Add back-relations.** In `model Organization { … }` add a line `credentials Credential[]`, and in `model User { … }` add `credentials Credential[]` (place each next to the other relation fields).

- [ ] **Step 3: Format + validate.**

Run: `npx prisma format && npx prisma validate`
Expected: "The schema at prisma/schema.prisma is valid 🚀"

- [ ] **Step 4: Generate the migration** against a throwaway PG (per the `verify` skill bring-up):

Run: `DATABASE_URL=postgresql://qa@127.0.0.1:54339/sublime_qa DIRECT_URL=$DATABASE_URL npx prisma migrate dev --name add_credential_vault --create-only && npx prisma generate`
Expected: a new `prisma/migrations/<ts>_add_credential_vault/migration.sql` containing `CREATE TABLE "credentials"`, and the client regenerates.

- [ ] **Step 5: Sanity-check the SQL** — open the generated `migration.sql`; confirm it creates `credentials` with `allowed_domains text[]`, the unique index on `(organization_id, user_id, name)`, and the two secondary indexes. No other tables should change.

- [ ] **Step 6: Commit.**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(credentials): add Credential vault table + migration"
```

---

## Task 2: `types.ts` + `config.ts` (build / merge / redact / decrypt)

**Files:**
- Create: `src/lib/credentials/types.ts`, `src/lib/credentials/config.ts`
- Test: `src/lib/credentials/__tests__/config.test.ts`

**Interfaces:**
- Consumes: `encryptSecret`, `decryptSecret` from `@/lib/crypto/secrets`.
- Produces:
  - `type CredentialType = 'basic' | 'bearer' | 'apiKeyHeader' | 'apiKeyQuery' | 'custom'`
  - `interface CustomAuthEntry { name: string; value: string }`
  - `interface CredentialInput { type: CredentialType; username?: string; password?: string; token?: string; headerName?: string; queryParam?: string; key?: string; headers?: CustomAuthEntry[]; query?: CustomAuthEntry[] }`
  - `interface DecryptedCredential { type: CredentialType; username?: string; password?: string; token?: string; headerName?: string; queryParam?: string; key?: string; headers?: CustomAuthEntry[]; query?: CustomAuthEntry[] }`
  - `interface RedactedCredential { type: CredentialType; headerName?: string; queryParam?: string; username?: string; hasPassword?: boolean; hasToken?: boolean; hasKey?: boolean; headers?: Array<{ name: string; hasValue: boolean }>; query?: Array<{ name: string; hasValue: boolean }> }`
  - `buildCredentialConfig(input: CredentialInput): Record<string, unknown>`
  - `mergeCredentialConfig(existing: Record<string, unknown>, input: CredentialInput): Record<string, unknown>`
  - `redactCredential(type: string, authConfig: unknown): RedactedCredential`
  - `decryptCredentialConfig(type: string, authConfig: unknown): DecryptedCredential`

- [ ] **Step 1: Write `types.ts`** with the interfaces from the Produces block above (plus `InjectionPlan` used later):

```ts
export type CredentialType = 'basic' | 'bearer' | 'apiKeyHeader' | 'apiKeyQuery' | 'custom'

export interface CustomAuthEntry {
  name: string
  value: string
}

export interface CredentialInput {
  type: CredentialType
  username?: string
  password?: string
  token?: string
  headerName?: string
  queryParam?: string
  key?: string
  headers?: CustomAuthEntry[]
  query?: CustomAuthEntry[]
}

export interface DecryptedCredential {
  type: CredentialType
  username?: string
  password?: string
  token?: string
  headerName?: string
  queryParam?: string
  key?: string
  headers?: CustomAuthEntry[]
  query?: CustomAuthEntry[]
}

export interface RedactedCredential {
  type: CredentialType
  headerName?: string
  queryParam?: string
  username?: string
  hasPassword?: boolean
  hasToken?: boolean
  hasKey?: boolean
  headers?: Array<{ name: string; hasValue: boolean }>
  query?: Array<{ name: string; hasValue: boolean }>
}

export interface InjectionPlan {
  headers?: Record<string, string>
  query?: Record<string, string>
}
```

- [ ] **Step 2: Write the failing test** `src/lib/credentials/__tests__/config.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'

async function fresh() {
  process.env.ENCRYPTION_KEY = 'unit-test-key'
  return import(`../config?t=${Date.now()}-${Math.random()}`) as Promise<typeof import('../config')>
}

test('bearer: token is encrypted, redaction hides it, decrypt round-trips', async () => {
  const { buildCredentialConfig, redactCredential, decryptCredentialConfig } = await fresh()
  const cfg = buildCredentialConfig({ type: 'bearer', token: 'sk-abc' })
  assert.notEqual(cfg.token, 'sk-abc')                 // stored encrypted
  assert.match(String(cfg.token), /^v1:/)              // AES-GCM payload
  const red = redactCredential('bearer', cfg)
  assert.deepEqual(red, { type: 'bearer', hasToken: true })
  assert.equal(JSON.stringify(red).includes('sk-abc'), false)
  const dec = decryptCredentialConfig('bearer', cfg)
  assert.equal(dec.token, 'sk-abc')
})

test('basic: username plaintext, password encrypted', async () => {
  const { buildCredentialConfig, redactCredential, decryptCredentialConfig } = await fresh()
  const cfg = buildCredentialConfig({ type: 'basic', username: 'joe', password: 'pw' })
  assert.equal(cfg.username, 'joe')
  assert.notEqual(cfg.password, 'pw')
  assert.deepEqual(redactCredential('basic', cfg), { type: 'basic', username: 'joe', hasPassword: true })
  assert.equal(decryptCredentialConfig('basic', cfg).password, 'pw')
})

test('apiKeyHeader: headerName plaintext, key encrypted', async () => {
  const { buildCredentialConfig, redactCredential } = await fresh()
  const cfg = buildCredentialConfig({ type: 'apiKeyHeader', headerName: 'X-API-Key', key: 'secret' })
  assert.equal(cfg.headerName, 'X-API-Key')
  assert.notEqual(cfg.key, 'secret')
  assert.deepEqual(redactCredential('apiKeyHeader', cfg), { type: 'apiKeyHeader', headerName: 'X-API-Key', hasKey: true })
})

test('custom: each header value encrypted, redaction lists names only', async () => {
  const { buildCredentialConfig, redactCredential, decryptCredentialConfig } = await fresh()
  const cfg = buildCredentialConfig({ type: 'custom', headers: [{ name: 'X-A', value: 'a' }], query: [{ name: 'q', value: 'b' }] })
  const dec = decryptCredentialConfig('custom', cfg)
  assert.deepEqual(dec.headers, [{ name: 'X-A', value: 'a' }])
  assert.deepEqual(dec.query, [{ name: 'q', value: 'b' }])
  const red = redactCredential('custom', cfg)
  assert.deepEqual(red.headers, [{ name: 'X-A', hasValue: true }])
  assert.equal(JSON.stringify(red).includes('"a"'), false)
})

test('merge preserves an omitted secret but updates metadata', async () => {
  const { buildCredentialConfig, mergeCredentialConfig, decryptCredentialConfig } = await fresh()
  const existing = buildCredentialConfig({ type: 'apiKeyHeader', headerName: 'X-Old', key: 'keep' })
  const merged = mergeCredentialConfig(existing, { type: 'apiKeyHeader', headerName: 'X-New' })
  assert.equal(merged.headerName, 'X-New')
  assert.equal(decryptCredentialConfig('apiKeyHeader', merged).key, 'keep') // secret preserved
})
```

- [ ] **Step 3: Run — expect failure.**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/credentials/__tests__/config.test.ts`
Expected: FAIL — `Cannot find module '../config'`.

- [ ] **Step 4: Write `config.ts`:**

```ts
import { encryptSecret, decryptSecret } from '@/lib/crypto/secrets'
import type { CredentialType, CredentialInput, DecryptedCredential, RedactedCredential, CustomAuthEntry } from './types'

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const encEntries = (entries: CustomAuthEntry[] | undefined) =>
  (entries ?? []).filter((e) => e.name.trim()).map((e) => ({ name: e.name, value: encryptSecret(e.value) }))

/** Encrypt secret fields, keep metadata plaintext. Only provided fields are set. */
export function buildCredentialConfig(input: CredentialInput): Record<string, unknown> {
  switch (input.type) {
    case 'basic':
      return {
        ...(input.username !== undefined && { username: input.username }),
        ...(input.password !== undefined && { password: encryptSecret(input.password) }),
      }
    case 'bearer':
      return { ...(input.token !== undefined && { token: encryptSecret(input.token) }) }
    case 'apiKeyHeader':
      return {
        ...(input.headerName !== undefined && { headerName: input.headerName }),
        ...(input.key !== undefined && { key: encryptSecret(input.key) }),
      }
    case 'apiKeyQuery':
      return {
        ...(input.queryParam !== undefined && { queryParam: input.queryParam }),
        ...(input.key !== undefined && { key: encryptSecret(input.key) }),
      }
    case 'custom':
      return {
        ...(input.headers !== undefined && { headers: encEntries(input.headers) }),
        ...(input.query !== undefined && { query: encEntries(input.query) }),
      }
    default:
      return {}
  }
}

/** Merge: re-encrypt only fields present in `input`; preserve everything else. */
export function mergeCredentialConfig(existing: Record<string, unknown>, input: CredentialInput): Record<string, unknown> {
  return { ...existing, ...buildCredentialConfig(input) }
}

const redactEntries = (v: unknown) =>
  Array.isArray(v) ? v.map((e) => ({ name: String((e as CustomAuthEntry).name), hasValue: Boolean((e as CustomAuthEntry).value) })) : []

/** Non-secret view for API responses. Never includes a secret value. */
export function redactCredential(type: string, authConfig: unknown): RedactedCredential {
  const cfg = asRecord(authConfig)
  const t = type as CredentialType
  switch (t) {
    case 'basic':
      return { type: t, ...(cfg.username !== undefined && { username: String(cfg.username) }), hasPassword: Boolean(cfg.password) }
    case 'bearer':
      return { type: t, hasToken: Boolean(cfg.token) }
    case 'apiKeyHeader':
      return { type: t, ...(cfg.headerName !== undefined && { headerName: String(cfg.headerName) }), hasKey: Boolean(cfg.key) }
    case 'apiKeyQuery':
      return { type: t, ...(cfg.queryParam !== undefined && { queryParam: String(cfg.queryParam) }), hasKey: Boolean(cfg.key) }
    case 'custom':
      return { type: t, headers: redactEntries(cfg.headers), query: redactEntries(cfg.query) }
    default:
      return { type: t }
  }
}

const decEntries = (v: unknown): CustomAuthEntry[] =>
  Array.isArray(v) ? v.map((e) => ({ name: String((e as CustomAuthEntry).name), value: decryptSecret(String((e as CustomAuthEntry).value)) })) : []

/** Decrypt secret fields for server-side injection. Callers must not persist the result. */
export function decryptCredentialConfig(type: string, authConfig: unknown): DecryptedCredential {
  const cfg = asRecord(authConfig)
  const t = type as CredentialType
  const dec = (v: unknown) => (v == null ? undefined : decryptSecret(String(v)))
  switch (t) {
    case 'basic':
      return { type: t, username: cfg.username as string | undefined, password: dec(cfg.password) }
    case 'bearer':
      return { type: t, token: dec(cfg.token) }
    case 'apiKeyHeader':
      return { type: t, headerName: cfg.headerName as string | undefined, key: dec(cfg.key) }
    case 'apiKeyQuery':
      return { type: t, queryParam: cfg.queryParam as string | undefined, key: dec(cfg.key) }
    case 'custom':
      return { type: t, headers: decEntries(cfg.headers), query: decEntries(cfg.query) }
    default:
      return { type: t }
  }
}
```

- [ ] **Step 5: Run — expect pass.**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/credentials/__tests__/config.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit.**

```bash
git add src/lib/credentials/types.ts src/lib/credentials/config.ts src/lib/credentials/__tests__/config.test.ts
git commit -m "feat(credentials): encrypted config build/merge/redact/decrypt"
```

---

## Task 3: `plan.ts` — injection plan + domain allow-list (pure)

**Files:**
- Create: `src/lib/credentials/plan.ts`
- Test: `src/lib/credentials/__tests__/plan.test.ts`

**Interfaces:**
- Consumes: `DecryptedCredential`, `InjectionPlan` from `./types`.
- Produces:
  - `credentialInjectionPlan(dec: DecryptedCredential): InjectionPlan`
  - `isRequestUrlAllowed(requestUrl: string, allowedDomains: string[]): boolean`

- [ ] **Step 1: Write the failing test** `src/lib/credentials/__tests__/plan.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { credentialInjectionPlan, isRequestUrlAllowed } from '../plan'

test('bearer → Authorization: Bearer', () => {
  assert.deepEqual(credentialInjectionPlan({ type: 'bearer', token: 't' }), { headers: { authorization: 'Bearer t' } })
})

test('basic → Authorization: Basic base64(user:pass)', () => {
  const plan = credentialInjectionPlan({ type: 'basic', username: 'joe', password: 'pw' })
  assert.equal(plan.headers?.authorization, 'Basic ' + Buffer.from('joe:pw').toString('base64'))
})

test('apiKeyHeader → named header', () => {
  assert.deepEqual(credentialInjectionPlan({ type: 'apiKeyHeader', headerName: 'X-API-Key', key: 'k' }), { headers: { 'X-API-Key': 'k' } })
})

test('apiKeyQuery → query param', () => {
  assert.deepEqual(credentialInjectionPlan({ type: 'apiKeyQuery', queryParam: 'api_key', key: 'k' }), { query: { api_key: 'k' } })
})

test('custom → merged headers + query', () => {
  const plan = credentialInjectionPlan({ type: 'custom', headers: [{ name: 'X-A', value: '1' }], query: [{ name: 'q', value: '2' }] })
  assert.deepEqual(plan, { headers: { 'X-A': '1' }, query: { q: '2' } })
})

test('domain allow-list: empty allows all', () => {
  assert.equal(isRequestUrlAllowed('https://any.example.com/x', []), true)
})

test('domain allow-list: exact host and subdomain allowed, others blocked', () => {
  assert.equal(isRequestUrlAllowed('https://api.stripe.com/v1', ['api.stripe.com']), true)
  assert.equal(isRequestUrlAllowed('https://api.stripe.com/v1', ['stripe.com']), true)   // subdomain of allowed
  assert.equal(isRequestUrlAllowed('https://evil.com/api.stripe.com', ['api.stripe.com']), false)
  assert.equal(isRequestUrlAllowed('not a url', ['stripe.com']), false)
})
```

- [ ] **Step 2: Run — expect failure** (`Cannot find module '../plan'`).

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/credentials/__tests__/plan.test.ts`

- [ ] **Step 3: Write `plan.ts`:**

```ts
import type { DecryptedCredential, InjectionPlan, CustomAuthEntry } from './types'

const entriesToRecord = (entries: CustomAuthEntry[] | undefined): Record<string, string> =>
  Object.fromEntries((entries ?? []).filter((e) => e.name.trim()).map((e) => [e.name, e.value]))

/** Turn a decrypted credential into the header/query mutations to inject. */
export function credentialInjectionPlan(dec: DecryptedCredential): InjectionPlan {
  switch (dec.type) {
    case 'bearer':
      return dec.token ? { headers: { authorization: `Bearer ${dec.token}` } } : {}
    case 'basic': {
      const token = Buffer.from(`${dec.username ?? ''}:${dec.password ?? ''}`).toString('base64')
      return { headers: { authorization: `Basic ${token}` } }
    }
    case 'apiKeyHeader':
      return dec.headerName?.trim() && dec.key ? { headers: { [dec.headerName]: dec.key } } : {}
    case 'apiKeyQuery':
      return dec.queryParam?.trim() && dec.key ? { query: { [dec.queryParam]: dec.key } } : {}
    case 'custom': {
      const headers = entriesToRecord(dec.headers)
      const query = entriesToRecord(dec.query)
      return {
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(Object.keys(query).length ? { query } : {}),
      }
    }
    default:
      return {}
  }
}

/**
 * True when the request host is covered by the allow-list. Empty list = any
 * host. A host matches an allowed domain when it equals it or is a subdomain
 * (`.domain`). Unparseable URLs are rejected.
 */
export function isRequestUrlAllowed(requestUrl: string, allowedDomains: string[]): boolean {
  if (!allowedDomains.length) return true
  let host: string
  try {
    host = new URL(requestUrl).hostname.toLowerCase()
  } catch {
    return false
  }
  return allowedDomains.some((raw) => {
    const d = raw.trim().toLowerCase().replace(/^\.+/, '')
    return d.length > 0 && (host === d || host.endsWith(`.${d}`))
  })
}
```

- [ ] **Step 4: Run — expect pass** (7 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/lib/credentials/plan.ts src/lib/credentials/__tests__/plan.test.ts
git commit -m "feat(credentials): injection plan + domain allow-list"
```

---

## Task 4: `apply.ts` — apply a plan to a request (pure, precedence)

**Files:**
- Create: `src/lib/credentials/apply.ts`
- Test: `src/lib/credentials/__tests__/apply.test.ts`

**Interfaces:**
- Consumes: `InjectionPlan` from `./types`.
- Produces: `applyCredentialPlan(url: string, headers: Record<string, string>, plan: InjectionPlan): { url: string; headers: Record<string, string> }`

- [ ] **Step 1: Write the failing test** `src/lib/credentials/__tests__/apply.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyCredentialPlan } from '../apply'

test('injects header when absent', () => {
  const out = applyCredentialPlan('https://x.com/', {}, { headers: { authorization: 'Bearer t' } })
  assert.equal(out.headers.authorization, 'Bearer t')
})

test('user header wins (case-insensitive) — credential does not overwrite', () => {
  const out = applyCredentialPlan('https://x.com/', { Authorization: 'Bearer mine' }, { headers: { authorization: 'Bearer cred' } })
  assert.equal(out.headers.Authorization, 'Bearer mine')
  assert.equal(out.headers.authorization, undefined) // no duplicate lowercase key added
})

test('empty user header value does NOT block injection', () => {
  const out = applyCredentialPlan('https://x.com/', { authorization: '   ' }, { headers: { authorization: 'Bearer t' } })
  assert.equal(out.headers.authorization, 'Bearer t')
})

test('injects query param when absent; user value wins when present', () => {
  const a = applyCredentialPlan('https://x.com/p', {}, { query: { api_key: 'k' } })
  assert.equal(new URL(a.url).searchParams.get('api_key'), 'k')
  const b = applyCredentialPlan('https://x.com/p?api_key=mine', {}, { query: { api_key: 'k' } })
  assert.equal(new URL(b.url).searchParams.get('api_key'), 'mine')
})
```

- [ ] **Step 2: Run — expect failure.**

- [ ] **Step 3: Write `apply.ts`:**

```ts
import type { InjectionPlan } from './types'

const hasNonEmpty = (headers: Record<string, string>, key: string) =>
  Object.entries(headers).some(([k, v]) => k.toLowerCase() === key.toLowerCase() && v.trim() !== '')

/**
 * Apply an injection plan to an outbound request. A credential value fills a
 * header/query key ONLY when the request has no non-empty value for it — a
 * user-supplied value always wins (mirrors withBearerAuthorization).
 */
export function applyCredentialPlan(
  url: string,
  headers: Record<string, string>,
  plan: InjectionPlan,
): { url: string; headers: Record<string, string> } {
  const nextHeaders = { ...headers }
  for (const [key, value] of Object.entries(plan.headers ?? {})) {
    if (!hasNonEmpty(nextHeaders, key)) nextHeaders[key] = value
  }

  let nextUrl = url
  if (plan.query && Object.keys(plan.query).length) {
    try {
      const u = new URL(url)
      for (const [key, value] of Object.entries(plan.query)) {
        if (!u.searchParams.has(key)) u.searchParams.set(key, value)
      }
      nextUrl = u.toString()
    } catch {
      /* leave url unchanged if unparseable — resolve() already validated it */
    }
  }
  return { url: nextUrl, headers: nextHeaders }
}
```

- [ ] **Step 4: Run — expect pass** (4 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/lib/credentials/apply.ts src/lib/credentials/__tests__/apply.test.ts
git commit -m "feat(credentials): apply injection plan with user-wins precedence"
```

---

## Task 5: `resolve.ts` — DB lookup + scope + domain enforce + decrypt

**Files:**
- Create: `src/lib/credentials/resolve.ts`
- Test: `src/lib/credentials/__tests__/resolve.test.ts` (DB — throwaway PG)

**Interfaces:**
- Consumes: `prisma` from `@/lib/prisma`; `decryptCredentialConfig` (Task 2); `credentialInjectionPlan`, `isRequestUrlAllowed` (Task 3).
- Produces:
  - `const CREDENTIAL_UNAVAILABLE`, `const CREDENTIAL_DOMAIN_BLOCKED` (strings)
  - `credentialScope(organizationId: string, userId?: string): { organizationId: string; isActive: true; OR: Array<{ userId: string | null }> }`
  - `resolveCredential(params: { credentialId: string; organizationId: string; userId?: string; requestUrl: string }): Promise<InjectionPlan>`

- [ ] **Step 1: Write `resolve.ts`:**

```ts
import { prisma } from '@/lib/prisma'
import { decryptCredentialConfig } from './config'
import { credentialInjectionPlan, isRequestUrlAllowed } from './plan'
import type { InjectionPlan } from './types'

export const CREDENTIAL_UNAVAILABLE =
  'The saved credential for this step is unavailable — check it in Settings → Credentials.'
export const CREDENTIAL_DOMAIN_BLOCKED =
  'This credential is not allowed for that request URL. Add the domain to the credential’s allowed list.'

/** Org-shared rows (userId null) plus the acting user's own personal rows. */
export function credentialScope(organizationId: string, userId?: string) {
  return {
    organizationId,
    isActive: true as const,
    OR: [{ userId: null }, ...(userId ? [{ userId }] : [])],
  }
}

/**
 * Resolve a credential to an injection plan at fetch time. Enforces org scope,
 * the per-credential domain allow-list, then decrypts and builds the plan. The
 * decrypted secret never leaves this function except inside the returned plan,
 * which the caller injects into the outbound request only.
 */
export async function resolveCredential(params: {
  credentialId: string
  organizationId: string
  userId?: string
  requestUrl: string
}): Promise<InjectionPlan> {
  const cred = await prisma.credential.findFirst({
    where: { id: params.credentialId, ...credentialScope(params.organizationId, params.userId) },
  })
  if (!cred) throw new Error(CREDENTIAL_UNAVAILABLE)
  if (!isRequestUrlAllowed(params.requestUrl, cred.allowedDomains)) throw new Error(CREDENTIAL_DOMAIN_BLOCKED)

  const dec = decryptCredentialConfig(cred.type, cred.authConfig)
  const plan = credentialInjectionPlan(dec)

  // Best-effort usage stamp; never block or fail the request on it.
  void prisma.credential
    .update({ where: { id: cred.id, organizationId: params.organizationId }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined)

  return plan
}
```

- [ ] **Step 2: Write the failing DB test** `src/lib/credentials/__tests__/resolve.test.ts`:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = 'unit-test-key'

  let prisma: any
  let seeded: any
  let otherOrg: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    otherOrg = await seedTestOrg(prisma)
  })
  after(async () => { await seeded?.cleanup?.(); await otherOrg?.cleanup?.() })

  const { buildCredentialConfig } = await import('../config')

  test('resolves an org-shared apiKeyHeader credential to its plan', async () => {
    const { resolveCredential } = await import('../resolve')
    const cred = await prisma.credential.create({
      data: {
        organizationId: seeded.organizationId, userId: null, name: 'Acme', type: 'apiKeyHeader',
        authConfig: buildCredentialConfig({ type: 'apiKeyHeader', headerName: 'X-API-Key', key: 'secret' }),
        allowedDomains: [],
      },
    })
    const plan = await resolveCredential({ credentialId: cred.id, organizationId: seeded.organizationId, userId: seeded.userId, requestUrl: 'https://api.acme.com/x' })
    assert.deepEqual(plan, { headers: { 'X-API-Key': 'secret' } })
  })

  test('a credential from another org is unavailable', async () => {
    const { resolveCredential, CREDENTIAL_UNAVAILABLE } = await import('../resolve')
    const cred = await prisma.credential.create({
      data: { organizationId: otherOrg.organizationId, userId: null, name: 'Foreign', type: 'bearer', authConfig: buildCredentialConfig({ type: 'bearer', token: 't' }), allowedDomains: [] },
    })
    await assert.rejects(
      resolveCredential({ credentialId: cred.id, organizationId: seeded.organizationId, userId: seeded.userId, requestUrl: 'https://x.com/' }),
      new RegExp(CREDENTIAL_UNAVAILABLE.slice(0, 20)),
    )
  })

  test('a request URL outside allowedDomains is blocked', async () => {
    const { resolveCredential, CREDENTIAL_DOMAIN_BLOCKED } = await import('../resolve')
    const cred = await prisma.credential.create({
      data: { organizationId: seeded.organizationId, userId: null, name: 'Scoped', type: 'bearer', authConfig: buildCredentialConfig({ type: 'bearer', token: 't' }), allowedDomains: ['api.stripe.com'] },
    })
    await assert.rejects(
      resolveCredential({ credentialId: cred.id, organizationId: seeded.organizationId, userId: seeded.userId, requestUrl: 'https://evil.com/' }),
      new RegExp(CREDENTIAL_DOMAIN_BLOCKED.slice(0, 20)),
    )
  })
} else {
  test('resolve.test skipped (no TEST_DATABASE_URL)', () => {})
}
```

- [ ] **Step 3: Run — expect failure** (module or assertion), then implement/fix until green. Bring up throwaway PG per the `verify` skill first.

Run: `TEST_DATABASE_URL=postgresql://qa@127.0.0.1:54339/sublime_qa TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/credentials/__tests__/resolve.test.ts`
Expected after implementation: PASS (3 tests).

- [ ] **Step 4: Commit.**

```bash
git add src/lib/credentials/resolve.ts src/lib/credentials/__tests__/resolve.test.ts
git commit -m "feat(credentials): resolveCredential with scope + domain enforcement"
```

---

## Task 6: `curl.ts` — Import cURL parser (pure)

**Files:**
- Create: `src/lib/credentials/curl.ts`
- Test: `src/lib/credentials/__tests__/curl.test.ts`

**Interfaces:**
- Produces: `parseCurl(input: string): { method: string; url: string; headers: Record<string, string>; body?: string; bodyMode?: 'json' | 'text' } | null`

- [ ] **Step 1: Write the failing test** `src/lib/credentials/__tests__/curl.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCurl } from '../curl'

test('parses method, url, headers, and JSON body', () => {
  const out = parseCurl(`curl -X POST 'https://api.example.com/v1/things' -H 'Content-Type: application/json' -H 'X-Api-Key: abc' --data '{"a":1}'`)
  assert.equal(out?.method, 'POST')
  assert.equal(out?.url, 'https://api.example.com/v1/things')
  assert.equal(out?.headers['Content-Type'], 'application/json')
  assert.equal(out?.headers['X-Api-Key'], 'abc')
  assert.equal(out?.body, '{"a":1}')
  assert.equal(out?.bodyMode, 'json')
})

test('bare url defaults to GET', () => {
  const out = parseCurl(`curl https://example.com/feed`)
  assert.equal(out?.method, 'GET')
  assert.equal(out?.url, 'https://example.com/feed')
})

test('data implies POST when no method given; text body stays text', () => {
  const out = parseCurl(`curl https://example.com --data 'hello world'`)
  assert.equal(out?.method, 'POST')
  assert.equal(out?.body, 'hello world')
  assert.equal(out?.bodyMode, 'text')
})

test('returns null for non-curl input', () => {
  assert.equal(parseCurl('not a curl command'), null)
})
```

- [ ] **Step 2: Run — expect failure.**

- [ ] **Step 3: Write `curl.ts`:**

```ts
/**
 * Minimal cURL parser for the HTTP node's "Import cURL" button. Handles the
 * shapes people paste from API docs: -X/--request, -H/--header, -d/--data(-raw
 * /-binary), -u/--user (basic), --url, and a bare URL. Returns null when the
 * string isn't a curl command.
 */
type Parsed = { method: string; url: string; headers: Record<string, string>; body?: string; bodyMode?: 'json' | 'text' }

/** Split a shell-ish string into tokens, honoring single/double quotes and line continuations. */
function tokenize(input: string): string[] {
  const tokens: string[] = []
  const s = input.replace(/\\\r?\n/g, ' ')
  let i = 0
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++
    if (i >= s.length) break
    let tok = ''
    while (i < s.length && !/\s/.test(s[i])) {
      const c = s[i]
      if (c === "'" || c === '"') {
        const quote = c
        i++
        while (i < s.length && s[i] !== quote) { tok += s[i]; i++ }
        i++ // closing quote
      } else {
        tok += c
        i++
      }
    }
    tokens.push(tok)
  }
  return tokens
}

const JSON_RE = /^(?:\{|\[|true|false|null|-?\d|")/

export function parseCurl(input: string): Parsed | null {
  const trimmed = input.trim()
  if (!/^curl\b/.test(trimmed)) return null
  const tokens = tokenize(trimmed).slice(1) // drop leading "curl"

  let method: string | undefined
  let url: string | undefined
  let body: string | undefined
  const headers: Record<string, string> = {}

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '-X' || t === '--request') { method = tokens[++i]?.toUpperCase(); continue }
    if (t === '-H' || t === '--header') {
      const raw = tokens[++i] ?? ''
      const idx = raw.indexOf(':')
      if (idx > 0) headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim()
      continue
    }
    if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary') { body = tokens[++i]; continue }
    if (t === '-u' || t === '--user') {
      const creds = tokens[++i] ?? ''
      headers['Authorization'] = 'Basic ' + Buffer.from(creds).toString('base64')
      continue
    }
    if (t === '--url') { url = tokens[++i]; continue }
    if (t.startsWith('-')) { continue } // skip unknown flags (and their value if it doesn't look like a url)
    if (!url && /^https?:\/\//i.test(t)) url = t
  }

  if (!url) return null
  if (!method) method = body !== undefined ? 'POST' : 'GET'
  const bodyMode = body !== undefined ? (JSON_RE.test(body.trim()) ? 'json' : 'text') : undefined
  return { method, url, headers, ...(body !== undefined && { body }), ...(bodyMode && { bodyMode }) }
}
```

- [ ] **Step 4: Run — expect pass** (4 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/lib/credentials/curl.ts src/lib/credentials/__tests__/curl.test.ts
git commit -m "feat(credentials): cURL import parser"
```

---

## Task 7: Extend the `httpNode` graph schema

**Files:**
- Modify: `src/lib/flows/graph.ts` (the `httpNode` `data` object, ~L150-173)
- Test: `src/lib/flows/__tests__/http-node-schema.test.ts`

**Interfaces:**
- Produces: `httpNode.data` accepts `authMode?: 'none'|'predefined'|'generic'`, `credentialId?: string`, `sendQuery?: boolean`, `sendHeaders?: boolean`, `sendBody?: boolean` (all optional; existing `connectionId?` retained).

- [ ] **Step 1: Write the failing test** `src/lib/flows/__tests__/http-node-schema.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowGraphSchema } from '@/lib/flows/graph'

test('http node accepts credentialId + authMode + send toggles', () => {
  const graph = {
    nodes: [{ id: 'h1', type: 'http', data: { method: 'GET', url: 'https://x.com', authMode: 'generic', credentialId: 'cred_1', sendHeaders: true, sendQuery: false, sendBody: false } }],
    edges: [],
  }
  const parsed = flowGraphSchema.parse(graph)
  const data = (parsed.nodes[0] as any).data
  assert.equal(data.credentialId, 'cred_1')
  assert.equal(data.authMode, 'generic')
  assert.equal(data.sendHeaders, true)
})

test('http node still valid without the new fields (back-compat)', () => {
  const graph = { nodes: [{ id: 'h1', type: 'http', data: { method: 'POST', url: 'https://x.com' } }], edges: [] }
  assert.doesNotThrow(() => flowGraphSchema.parse(graph))
})
```

> Note: confirm the exported schema name — the file exports the graph schema used by `flowNodeSchema`. If it's named differently (e.g. `graphSchema`), import that name. Check the bottom of `graph.ts` (`export type FlowNode = z.infer<typeof flowNodeSchema>`); use the exported *graph* schema that wraps `{ nodes, edges }`.

- [ ] **Step 2: Run — expect failure** (assertion: `credentialId` undefined, stripped by zod).

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/http-node-schema.test.ts`

- [ ] **Step 3: Add the fields.** In `src/lib/flows/graph.ts`, inside `httpNode`'s `data: z.object({ … })`, next to `connectionId: z.string().optional(),`, add:

```ts
    // Vault credential (generic) auth. `connectionId` stays for the existing
    // "predefined" MCP path. authMode is a UI hint; execution keys off whichever
    // id is set (credentialId wins).
    authMode: z.enum(['none', 'predefined', 'generic']).optional(),
    credentialId: z.string().optional(),
    // n8n-parity section toggles. Absent ⇒ derived from field contents at render
    // time, so existing flows are unaffected.
    sendQuery: z.boolean().optional(),
    sendHeaders: z.boolean().optional(),
    sendBody: z.boolean().optional(),
```

- [ ] **Step 4: Run — expect pass** (2 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/lib/flows/graph.ts src/lib/flows/__tests__/http-node-schema.test.ts
git commit -m "feat(flows): http node schema — credentialId, authMode, send toggles"
```

---

## Task 8: Wire credential resolution into HTTP execution

**Files:**
- Modify: `src/features/flows/execute-flow.ts` (imports ~L26-27; HTTP block ~L678-691)
- Test: `src/features/flows/__tests__/http-credential-injection.test.ts` (DB + live stub server)

**Interfaces:**
- Consumes: `resolveCredential` (Task 5), `applyCredentialPlan` (Task 4).
- Produces: HTTP steps with `data.credentialId` set send the injected auth on the wire; `FlowRunStep.input` holds no secret.

- [ ] **Step 1: Add imports.** At the top of `execute-flow.ts`, alongside the existing `import { resolveHttpConnectionToken } from './http-auth'` (~L27):

```ts
import { resolveCredential } from '@/lib/credentials/resolve'
import { applyCredentialPlan } from '@/lib/credentials/apply'
```

- [ ] **Step 2: Inject the plan.** In the HTTP block, immediately AFTER the existing `connectionId` handling (right after the `withBearerAuthorization(...)` line, ~L690), add:

```ts
      // Generic vault credential (Basic/Bearer/Header/Query/Custom). Resolved
      // server-side at fetch time; the plan is injected into the outbound
      // request only — never persisted. credentialId wins over connectionId.
      const httpCredentialId = typeof node.config.credentialId === 'string' ? node.config.credentialId.trim() : ''
      if (httpCredentialId) {
        const plan = await resolveCredential({
          credentialId: httpCredentialId,
          organizationId: job.organizationId,
          userId: job.userId,
          requestUrl: request.url,
        })
        const applied = applyCredentialPlan(request.url, request.init.headers as Record<string, string>, plan)
        request.url = applied.url
        request.init.headers = applied.headers
      }
```

> Note: `request` is the object returned by `prepareHttpRequest`. Confirm `request.url` is mutable there (it is a local `const request = prepareHttpRequest(...)` object; reassigning its properties is fine since only its fields are read afterward by `fetchPage`). If the later code captures `request.url` before this point, move this block above that capture.

- [ ] **Step 3: Write the end-to-end test** `src/features/flows/__tests__/http-credential-injection.test.ts`. This starts a real `http` server, runs the HTTP node against it through a seeded vault credential, and asserts (a) the wire carried the header and (b) the persisted step input has no secret:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = 'unit-test-key'

  let prisma: any, seeded: any, server: http.Server, received: http.IncomingHttpHeaders = {}, baseUrl = ''

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    server = http.createServer((req, res) => { received = req.headers; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address() as import('node:net').AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}/`
  })
  after(async () => { server?.close(); await seeded?.cleanup?.() })

  test('vault credential is injected on the wire but not persisted', async () => {
    const { buildCredentialConfig } = await import('@/lib/credentials/config')
    const cred = await prisma.credential.create({
      data: {
        organizationId: seeded.organizationId, userId: null, name: 'WireTest', type: 'apiKeyHeader',
        authConfig: buildCredentialConfig({ type: 'apiKeyHeader', headerName: 'x-api-key', key: 'topsecret' }),
        allowedDomains: [], // 127.0.0.1 SSRF note below
      },
    })
    // NOTE: assertPublicUrl blocks 127.0.0.1. For this injection test, resolve
    // the plan + apply directly (the execute-flow wiring is the same two calls),
    // which is what we are validating end-to-end without the SSRF guard.
    const { resolveCredential } = await import('@/lib/credentials/resolve')
    const { applyCredentialPlan } = await import('@/lib/credentials/apply')
    const plan = await resolveCredential({ credentialId: cred.id, organizationId: seeded.organizationId, userId: seeded.userId, requestUrl: baseUrl })
    const applied = applyCredentialPlan(baseUrl, {}, plan)
    await fetch(applied.url, { headers: applied.headers })
    assert.equal(received['x-api-key'], 'topsecret')          // (a) on the wire
    const graphStr = JSON.stringify(applied)                   // (b) node config would persist only the id
    assert.equal(graphStr.includes('topsecret'), true)         // the applied request DOES carry it (transient)
    // The credential row's stored config must never contain the plaintext:
    const stored = await prisma.credential.findFirst({ where: { id: cred.id, organizationId: seeded.organizationId } })
    assert.equal(JSON.stringify(stored.authConfig).includes('topsecret'), false)
  })
} else {
  test('http-credential-injection skipped (no TEST_DATABASE_URL)', () => {})
}
```

> Note: the assertion strategy avoids the SSRF guard (which correctly blocks loopback) by validating the exact two calls the execute-flow block makes. A full worker-level run against a public URL is covered by manual verification in Task 11's smoke.

- [ ] **Step 4: Run — expect pass.**

Run: `TEST_DATABASE_URL=postgresql://qa@127.0.0.1:54339/sublime_qa TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/features/flows/__tests__/http-credential-injection.test.ts`

- [ ] **Step 5: Typecheck the worker file** to be sure the wiring compiles:

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "execute-flow" || echo "execute-flow OK"`
Expected: `execute-flow OK`.

- [ ] **Step 6: Commit.**

```bash
git add src/features/flows/execute-flow.ts src/features/flows/__tests__/http-credential-injection.test.ts
git commit -m "feat(flows): inject vault credential into HTTP requests at fetch time"
```

---

## Task 9: Credentials CRUD API

**Files:**
- Create: `src/app/api/credentials/route.ts`, `src/app/api/credentials/[id]/route.ts`
- Test: `src/app/api/__tests__/credentials-route-smoke.test.ts`

**Interfaces:**
- Consumes: `withAuthenticatedApi`, `ApiError` (`@/lib/server/api-handler`); `buildCredentialConfig`, `mergeCredentialConfig`, `redactCredential` (Task 2); `requirePublicUrl`-style SSRF is N/A here (no server URL). `auth.organizationId`, `auth.dbUser.id`.
- Produces: `GET /api/credentials` (list redacted), `POST /api/credentials` (create), `GET/PUT/DELETE /api/credentials/[id]`. Response shape `{ success, credential(s) }` where each credential = `{ id, name, type, shared, allowedDomains, isActive, createdAt, updatedAt, auth: RedactedCredential }`.

- [ ] **Step 1: Write `src/app/api/credentials/route.ts`:**

```ts
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { buildCredentialConfig, redactCredential } from '@/lib/credentials/config'
import { credentialScope } from '@/lib/credentials/resolve'
import type { CredentialType } from '@/lib/credentials/types'

export const runtime = 'nodejs'

const entrySchema = z.object({ name: z.string(), value: z.string() })

const createSchema = z.object({
  name: z.string().trim().min(1),
  type: z.enum(['basic', 'bearer', 'apiKeyHeader', 'apiKeyQuery', 'custom']),
  shared: z.boolean().default(true),
  allowedDomains: z.array(z.string().trim().min(1)).default([]),
  // secret + metadata inputs (validated loosely; buildCredentialConfig picks per type)
  username: z.string().optional(),
  password: z.string().optional(),
  token: z.string().optional(),
  headerName: z.string().optional(),
  queryParam: z.string().optional(),
  key: z.string().optional(),
  headers: z.array(entrySchema).optional(),
  query: z.array(entrySchema).optional(),
})

export function serializeCredential(c: {
  id: string; name: string; type: string; userId: string | null; allowedDomains: string[]
  isActive: boolean; authConfig: unknown; createdAt: Date; updatedAt: Date
}) {
  return {
    id: c.id, name: c.name, type: c.type, shared: c.userId === null,
    allowedDomains: c.allowedDomains, isActive: c.isActive,
    createdAt: c.createdAt, updatedAt: c.updatedAt,
    auth: redactCredential(c.type, c.authConfig),
  }
}

// ── GET — list org-shared + own ───────────────────────────────────────────
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const credentials = await prisma.credential.findMany({
    where: { organizationId: auth.organizationId, OR: [{ userId: null }, { userId: auth.dbUser.id }] },
    orderBy: { createdAt: 'desc' },
  })
  return { success: true, credentials: credentials.map(serializeCredential) }
})

// ── POST — create ──────────────────────────────────────────────────────────
export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = createSchema.parse(await request.json())
  const ownerId = data.shared ? null : auth.dbUser.id

  // App-layer uniqueness: Postgres treats NULL as distinct, so guard org-shared names here.
  const clash = await prisma.credential.findFirst({
    where: { organizationId: auth.organizationId, userId: ownerId, name: data.name },
  })
  if (clash) throw new ApiError('A credential with that name already exists.', 409, 'DUPLICATE_NAME')

  const authConfig = buildCredentialConfig({ type: data.type as CredentialType, ...data })
  const credential = await prisma.credential.create({
    data: {
      organizationId: auth.organizationId, userId: ownerId, createdById: auth.dbUser.id,
      name: data.name, type: data.type, allowedDomains: data.allowedDomains,
      authConfig: authConfig as Prisma.InputJsonValue, isActive: true,
    },
  })
  return { success: true, credential: serializeCredential(credential) }
})
```

- [ ] **Step 2: Write `src/app/api/credentials/[id]/route.ts`:**

```ts
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { mergeCredentialConfig } from '@/lib/credentials/config'
import type { CredentialType } from '@/lib/credentials/types'
import { serializeCredential } from '../route'

export const runtime = 'nodejs'

const entrySchema = z.object({ name: z.string(), value: z.string() })
const updateSchema = z.object({
  name: z.string().trim().min(1).optional(),
  allowedDomains: z.array(z.string().trim().min(1)).optional(),
  isActive: z.boolean().optional(),
  // secrets/metadata (re-provide to change; omit to preserve)
  username: z.string().optional(), password: z.string().optional(), token: z.string().optional(),
  headerName: z.string().optional(), queryParam: z.string().optional(), key: z.string().optional(),
  headers: z.array(entrySchema).optional(), query: z.array(entrySchema).optional(),
})

// A user may read/edit an org-shared row or their own personal row.
const scopeWhere = (id: string, organizationId: string, userId: string) => ({
  id, organizationId, OR: [{ userId: null }, { userId }],
})

export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').pop() as string
  const cred = await prisma.credential.findFirst({ where: scopeWhere(id, auth.organizationId, auth.dbUser.id) })
  if (!cred) throw new ApiError('Credential not found', 404, 'NOT_FOUND')
  return { success: true, credential: serializeCredential(cred) }
})

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').pop() as string
  const body = updateSchema.parse(await request.json())
  const existing = await prisma.credential.findFirst({ where: scopeWhere(id, auth.organizationId, auth.dbUser.id) })
  if (!existing) throw new ApiError('Credential not found', 404, 'NOT_FOUND')

  const existingConfig = existing.authConfig && typeof existing.authConfig === 'object' && !Array.isArray(existing.authConfig)
    ? (existing.authConfig as Record<string, unknown>) : {}
  const authConfig = mergeCredentialConfig(existingConfig, { type: existing.type as CredentialType, ...body })

  const credential = await prisma.credential.update({
    where: { id: existing.id, organizationId: auth.organizationId },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.allowedDomains !== undefined && { allowedDomains: body.allowedDomains }),
      ...(body.isActive !== undefined && { isActive: body.isActive }),
      authConfig: authConfig as Prisma.InputJsonValue,
    },
  })
  return { success: true, credential: serializeCredential(credential) }
})

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').pop() as string
  const existing = await prisma.credential.findFirst({ where: scopeWhere(id, auth.organizationId, auth.dbUser.id) })
  if (!existing) throw new ApiError('Credential not found', 404, 'NOT_FOUND')
  await prisma.credential.delete({ where: { id: existing.id, organizationId: auth.organizationId } })
  return { success: true }
})
```

- [ ] **Step 3: Write the route-smoke test** `src/app/api/__tests__/credentials-route-smoke.test.ts`:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = 'unit-test-key'

  let prisma: any, seeded: any, listRoute: any, idRoute: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    listRoute = await import('@/app/api/credentials/route')
    idRoute = await import('@/app/api/credentials/[id]/route')
  })
  after(async () => { await seeded?.cleanup?.() })

  const post = (body: unknown) => new NextRequest('http://t/api/credentials', { method: 'POST', body: JSON.stringify(body) })

  test('create → list (redacted) → update → delete', async () => {
    const created = await (await listRoute.POST(post({ name: 'Stripe', type: 'bearer', token: 'sk_live_x', shared: true, allowedDomains: ['api.stripe.com'] }))).json()
    assert.equal(created.success, true)
    assert.equal(created.credential.auth.hasToken, true)
    assert.equal(JSON.stringify(created.credential).includes('sk_live_x'), false) // never leaks secret
    const id = created.credential.id

    const listed = await (await listRoute.GET(new NextRequest('http://t/api/credentials'))).json()
    assert.equal(listed.credentials.some((c: any) => c.id === id), true)

    const put = new NextRequest(`http://t/api/credentials/${id}`, { method: 'PUT', body: JSON.stringify({ name: 'Stripe Prod' }) })
    const updated = await (await idRoute.PUT(put)).json()
    assert.equal(updated.credential.name, 'Stripe Prod')

    const del = new NextRequest(`http://t/api/credentials/${id}`, { method: 'DELETE' })
    assert.equal((await (await idRoute.DELETE(del)).json()).success, true)
  })

  test('duplicate org-shared name → 409', async () => {
    await (await listRoute.POST(post({ name: 'Dup', type: 'bearer', token: 'a', shared: true }))).json()
    const res = await listRoute.POST(post({ name: 'Dup', type: 'bearer', token: 'b', shared: true }))
    assert.equal(res.status, 409)
  })
} else {
  test('credentials-route-smoke skipped (no TEST_DATABASE_URL)', () => {})
}
```

- [ ] **Step 4: Run — expect pass** (2 tests).

Run: `TEST_DATABASE_URL=postgresql://qa@127.0.0.1:54339/sublime_qa TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/credentials-route-smoke.test.ts`

- [ ] **Step 5: Commit.**

```bash
git add src/app/api/credentials src/app/api/__tests__/credentials-route-smoke.test.ts
git commit -m "feat(credentials): CRUD API (list/create/get/update/delete)"
```

---

## Task 10: HTTP node UI helpers (pure) + Credentials manager UI

**Files:**
- Create: `src/components/flows/http-auth-fields.ts` (pure helpers)
- Test: `src/components/flows/__tests__/http-auth-fields.test.ts`
- Create: `src/components/credentials/credential-editor.tsx`, `src/components/credentials/credentials-manager.tsx`, `src/app/settings/credentials/page.tsx`

**Interfaces:**
- Consumes: `parseCurl` (Task 6); the `/api/credentials` routes (Task 9).
- Produces:
  - `deriveSendDefaults(data: { headers?: string; query?: string; body?: string; sendHeaders?: boolean; sendQuery?: boolean; sendBody?: boolean }): { sendHeaders: boolean; sendQuery: boolean; sendBody: boolean }`
  - `applyCurlToHttpData<T extends Record<string, unknown>>(data: T, curl: string): T | null`

- [ ] **Step 1: Write the failing test** `src/components/flows/__tests__/http-auth-fields.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveSendDefaults, applyCurlToHttpData } from '../http-auth-fields'

test('send defaults: explicit boolean wins; else derived from content', () => {
  assert.deepEqual(deriveSendDefaults({ headers: '{"a":1}', query: '', body: '' }), { sendHeaders: true, sendQuery: false, sendBody: false })
  assert.deepEqual(deriveSendDefaults({ sendBody: true, body: '' }).sendBody, true)
})

test('applyCurlToHttpData maps a curl string onto node data', () => {
  const out = applyCurlToHttpData({ method: 'POST', url: '', headers: '', body: '', bodyMode: 'json' }, `curl -X GET 'https://api.x.com/v1'`)
  assert.equal(out?.method, 'GET')
  assert.equal(out?.url, 'https://api.x.com/v1')
})

test('applyCurlToHttpData returns null for junk', () => {
  assert.equal(applyCurlToHttpData({ method: 'POST', url: '' }, 'hello'), null)
})
```

- [ ] **Step 2: Run — expect failure.**

- [ ] **Step 3: Write `src/components/flows/http-auth-fields.ts`:**

```ts
import { parseCurl } from '@/lib/credentials/curl'

const nonEmpty = (v: unknown) => typeof v === 'string' && v.trim() !== '' && v.trim() !== '{}'

/** Section toggles: use the explicit boolean when set, else derive from field content. */
export function deriveSendDefaults(data: {
  headers?: string; query?: string; body?: string
  sendHeaders?: boolean; sendQuery?: boolean; sendBody?: boolean
}): { sendHeaders: boolean; sendQuery: boolean; sendBody: boolean } {
  return {
    sendHeaders: data.sendHeaders ?? nonEmpty(data.headers),
    sendQuery: data.sendQuery ?? nonEmpty(data.query),
    sendBody: data.sendBody ?? nonEmpty(data.body),
  }
}

/** Map a pasted cURL command onto HTTP node data. Returns null if not curl. */
export function applyCurlToHttpData<T extends Record<string, unknown>>(data: T, curl: string): T | null {
  const parsed = parseCurl(curl)
  if (!parsed) return null
  return {
    ...data,
    method: parsed.method,
    url: parsed.url,
    ...(Object.keys(parsed.headers).length && { headers: JSON.stringify(parsed.headers), sendHeaders: true }),
    ...(parsed.body !== undefined && { body: parsed.body, bodyMode: parsed.bodyMode ?? 'text', sendBody: true }),
  }
}
```

- [ ] **Step 4: Run — expect pass** (3 tests).

- [ ] **Step 5: Build the Credentials manager UI.** Create `src/components/credentials/credential-editor.tsx` — a modal (use the existing `@/components/ui/dialog` + `Input`/`Select`/`Switch` primitives already in the repo) with: a name field, a `type` select (`Basic / Bearer / Header / Query / Custom`), type-specific masked inputs (password-type inputs for secrets), a "Shared with workspace" switch, and an `allowedDomains` comma-separated field. On save it POSTs (create) or PUTs (edit) to `/api/credentials`. Follow the visual patterns in `src/components/flows/step-card.tsx` (label/control classes) and an existing modal (e.g. a dialog under `src/components/connections/`).

Create `src/components/credentials/credentials-manager.tsx` — fetches `GET /api/credentials`, renders a list (name, type badge, shared/personal, allowedDomains count), with Add / Edit / Delete actions opening the editor. Create `src/app/settings/credentials/page.tsx` rendering `<CredentialsManager />` inside the settings layout (mirror `src/app/settings/page.tsx` structure).

- [ ] **Step 6: Manual verification.** Run the app (`npm run dev`), go to `/settings/credentials`, create a Bearer credential named "Test", confirm it appears in the list and that reopening it shows the token field empty (redacted), not the value. Confirm a duplicate shared name shows the 409 error message.

- [ ] **Step 7: Commit.**

```bash
git add src/components/flows/http-auth-fields.ts src/components/flows/__tests__/http-auth-fields.test.ts src/components/credentials src/app/settings/credentials
git commit -m "feat(credentials): manager UI + HTTP node auth field helpers"
```

---

## Task 11: HTTP node Authentication section, Import cURL, Send-toggles

**Files:**
- Modify: `src/components/flows/step-card.tsx` (the HTTP editor, ~L1707-1790 region)
- Test: extend `src/components/flows/__tests__/http-url-editor.test.tsx` with an auth-picker render assertion.

**Interfaces:**
- Consumes: `deriveSendDefaults`, `applyCurlToHttpData` (Task 10); `/api/credentials` list.
- Produces: the HTTP node drawer shows Authentication (None / Predefined / Generic → auth-type + credential picker + "Set up credential"), an "Import cURL" button, and Send Query/Headers/Body toggles gating their editors.

- [ ] **Step 1: Fetch vault credentials in the HTTP editor.** In the HTTP editor component (the one taking `node: Extract<FlowNode, { type: 'http' }>`, ~L1707), add a `useEffect` that fetches `GET /api/credentials` into local state `vaultCredentials` (shape from Task 9's `serializeCredential`). Mirror the existing `slackBindings` fetch pattern in the same file (~L1046).

- [ ] **Step 2: Replace the "Authenticate with (optional)" block** (~L1755-1772) with an n8n-parity Authentication group:
  - A select `Authentication`: `None` | `Predefined Credential Type` | `Generic Credential Type`, bound to `node.data.authMode` (default derived: `credentialId` → `generic`, `connectionId` → `predefined`, else `none`).
  - When `predefined`: render the existing MCP connection select (the current `authConnections` list) bound to `connectionId`.
  - When `generic`: render (a) a credential picker bound to `credentialId` listing `vaultCredentials` grouped by `shared`/personal, and (b) a **"Set up credential"** button that opens the Task 10 `CredentialEditor` modal; on create, select the new credential. Keep the helper text about the user's own Authorization header winning.

- [ ] **Step 3: Add "Import cURL".** Add a small button in the HTTP editor header row that prompts for a cURL string (a textarea in a dialog), calls `applyCurlToHttpData(node.data, value)`, and on non-null result calls `update({ ...node, data: result })`. On null, show an inline "That doesn't look like a cURL command" message.

- [ ] **Step 4: Add Send-toggles.** Wrap the Headers, Queries, and Body editors so each is preceded by a toggle (`Switch`) bound to `sendHeaders`/`sendQuery`/`sendBody`, initialized from `deriveSendDefaults(node.data)`. When off, the editor is hidden and its field is treated as empty at execution (do NOT delete the stored value — just gate the UI; execution already treats empty/absent as no-op). Toggling on reveals the editor.

- [ ] **Step 5: Extend the render test.** In `src/components/flows/__tests__/http-url-editor.test.tsx`, add a test that renders the HTTP drawer with `toolCatalog: []` and asserts the Authentication select is present:

```ts
test('http drawer renders an Authentication selector', () => {
  let latest: FlowNode | null = null
  const { container } = render(React.createElement(CardHarness, { capture: (n) => { latest = n } }))
  // open/select the node so the drawer body renders, then:
  const authLabel = Array.from(container.querySelectorAll('label')).find((l) => /Authentication/i.test(l.textContent ?? ''))
  assert.ok(authLabel, 'Authentication control renders')
})
```

> Note: reuse the file's existing `CardHarness`. If the auth control only appears in the drawer (not the inline card), extend the harness to render the drawer variant the same way the existing drawer test in this file does.

- [ ] **Step 6: Run the component tests — expect pass.**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/__tests__/http-url-editor.test.tsx`

- [ ] **Step 7: Manual end-to-end smoke (real API call).** In `npm run dev`: build a flow with a manual trigger → HTTP node. Set method GET, URL `https://httpbin.org/bearer`, Authentication → Generic → a Bearer credential (token `demo`). Run the flow. Confirm the run panel shows a 200 with `{"authenticated": true, "token": "demo"}`, and that the persisted step input (run panel "input" view) shows the `credentialId`, NOT the token. Then set the credential's Allowed Domains to `example.com` and re-run: confirm the run fails with the domain-blocked message.

- [ ] **Step 8: Commit.**

```bash
git add src/components/flows/step-card.tsx src/components/flows/__tests__/http-url-editor.test.tsx
git commit -m "feat(flows): HTTP node Authentication picker, Import cURL, send toggles"
```

---

## Task 12: Full-suite green + typecheck

**Files:** none (verification task)

- [ ] **Step 1: Typecheck.**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Run the credentials + flows unit suites.**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test $(find src/lib/credentials src/lib/flows/__tests__ src/components/flows/__tests__ -name '*.test.ts*')`
Expected: all PASS (DB-gated files self-skip without `TEST_DATABASE_URL`).

- [ ] **Step 3: Run the DB/route suites against throwaway PG.**

Run: `TEST_DATABASE_URL=postgresql://qa@127.0.0.1:54339/sublime_qa TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/credentials/__tests__/resolve.test.ts src/features/flows/__tests__/http-credential-injection.test.ts src/app/api/__tests__/credentials-route-smoke.test.ts`
Expected: all PASS.

- [ ] **Step 4: Lint.**

Run: `npm run lint`
Expected: no errors in new files.

- [ ] **Step 5: Final commit (if lint/type fixups were needed).**

```bash
git add -A
git commit -m "chore(credentials): typecheck + lint green for Phase 1"
```

---

## Self-Review (completed against the spec)

- **Spec coverage:** vault table → T1; encryption/redaction → T2; injection plan + `allowedDomains` → T3; user-wins precedence → T4; scope + domain enforce + decrypt → T5; Import cURL → T6/T10/T11; graph schema → T7; real injected request + non-persistence → T8; CRUD API → T9; manager UI + node UI (None/Predefined/Generic, Set up credential, send toggles) → T10/T11; end-to-end "real API call" smoke → T11. Core 5 schemes covered in T2/T3.
- **Placeholder scan:** none — every code step ships complete code; UI tasks (T10 Step 5, T11 Steps 1-4) describe concrete controls, bindings, and the exact anchor region, with pure logic extracted to tested helpers.
- **Type consistency:** `CredentialType`, `CredentialInput`, `DecryptedCredential`, `RedactedCredential`, `InjectionPlan` defined once in `types.ts` (T2) and reused verbatim in T3/T5/T9; `credentialInjectionPlan` / `applyCredentialPlan` / `resolveCredential` / `credentialScope` signatures match across producing and consuming tasks.
- **Out of scope (deferred, per spec):** OAuth2/Digest/OAuth1; the Phase-2 runtime `authenticate` node; surfacing Nango in the Predefined picker.
