# Security Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the twelve gaps found in the 2026-08-13 audit of the 20-item security checklist, converting each from convention into an enforced, CI-guarded invariant.

**Architecture:** Six independent workstreams, each producing working, testable software on its own and committed separately. Every new control follows the codebase's established "gated, clean no-op when unconfigured" pattern (as RAG and the rate limiter already do) so nothing breaks a developer machine that lacks production secrets. Every structural claim gets a CI test in the style of `src/app/api/__tests__/route-permissions.test.ts` — the house pattern for turning a comment into an invariant that cannot drift.

**Tech Stack:** Next.js 15 App Router, Prisma 7 (client at `src/generated/prisma`), Postgres/Supabase, Zod 3, `node:test` runner, GitHub Actions.

**Spec:** This plan implements the audit findings recorded in the conversation of 2026-08-13. The scorecard and per-item evidence are reproduced in `docs/security-posture.md` (created by Task 6.6) so the spec travels with the plan.

## Global Constraints

- **Never break a keyless dev machine.** Every new control must no-op cleanly when its env var is unset. Precedent: `src/lib/ratelimit.ts`, RAG in `.env.example`.
- **Never weaken an existing control.** The CSP, tenant guard, and `withAuthenticatedApi` contract are load-bearing; extend, never relax.
- **Migrations must be idempotent and role-defensive.** `anon` / `authenticated` / `service_role` do not exist on a plain Postgres (CI, local). Guard every reference with a `pg_roles` lookup, matching `scripts/bootstrap-supabase-migration-test.sql`.
- **Encrypted data at rest must stay readable.** Any change to `src/lib/crypto/secrets.ts` keeps the `v1:` read path working forever. New writes may use a new version prefix; existing rows are migrated only by the explicit rotation script.
- **Prisma model access stays org-scoped.** New queries obey `src/lib/tenant-guard.ts`; system-wide paths use `systemPrisma` with a justification comment.
- **No new runtime dependencies** unless a workstream names one explicitly. The audit found 0 vulnerabilities; keep the surface small.
- **Third-party GitHub Actions are pinned by commit SHA**, never by floating tag — adding a supply-chain scanner must not itself be a supply-chain hole.

---

## Workstream 1 — Database grant lockdown (audit gap #4, severity: critical)

**Why:** `src/lib/tenant-guard.ts` says in its own docstring that it "is a guardrail, not a security boundary", and the run-events migration asserts "Prisma-owned tables are not exposed to the authenticated role" — an assumption that is load-bearing and never tested. Supabase's stock `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated` applies to tables created by `postgres`, which is the role `prisma migrate deploy` connects as. If those defaults are live, every Prisma-created table is readable through PostgREST with the publishable anon key.

**Scope decision:** The fix is `REVOKE` + default-privileges revoke, which cannot affect the owner-role connection Prisma uses and is therefore safe to deploy blind. Enabling RLS on all ~60 models is explicitly **out of scope** — RLS is bypassed by the table owner, so it is only meaningful once the app connects as a non-owner role, which is a separate migration project. Task 1.4 records that follow-up.

### Task 1.1: Teach the CI bootstrap about `anon`

**Files:**
- Modify: `scripts/bootstrap-supabase-migration-test.sql`

**Interfaces:**
- Produces: an `anon` role and Supabase-shaped default privileges on a plain Postgres, so Task 1.3's test reproduces the production hazard instead of passing vacuously.

- [ ] **Step 1: Add the `anon` role and Supabase's stock default privileges**

In the existing `DO $roles$` block, add alongside the `authenticated` and `service_role` branches:

```sql
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
```

Then, after the block, reproduce the hazard this workstream exists to close:

```sql
-- Reproduce Supabase's stock default privileges so the grant-lockdown test
-- proves the revoke actually does something. Without this the test passes
-- vacuously on a plain Postgres, which is exactly the blind spot that let the
-- "Prisma-owned tables are not exposed" assumption go untested for a year.
GRANT USAGE ON SCHEMA public TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
```

- [ ] **Step 2: Verify it applies cleanly**

Run: `psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/bootstrap-supabase-migration-test.sql`
Expected: no error, exit 0. Re-run it a second time — it must still exit 0 (idempotent).

### Task 1.2: The lockdown migration

**Files:**
- Create: `prisma/migrations/20260813210000_lock_public_schema_grants/migration.sql`

**Interfaces:**
- Produces: no table readable by `anon` or `authenticated` in schema `public`, now or for any future table.

- [ ] **Step 1: Write the migration**

```sql
-- Revoke PostgREST's reach into Prisma-owned tables.
--
-- Supabase ships `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON
-- TABLES TO anon, authenticated`, scoped to the granting role. `prisma migrate
-- deploy` connects as that same role, so every table this repo has ever
-- created may carry a grant to `anon` — readable over PostgREST at
-- /rest/v1/<table> with the publishable key, with no RLS to stop it.
--
-- Isolation in this app is enforced at the application layer (see
-- src/lib/tenant-guard.ts), which PostgREST bypasses entirely. Revoking the
-- grants removes the bypass. This cannot affect the application: Prisma
-- connects as the table OWNER, and ownership is not mediated by these grants.
--
-- Deliberately NOT revoked:
--   - FUNCTIONS. public.can_access_run_events / can_access_flow_jam are granted
--     to `authenticated` on purpose (private Realtime channel authorization);
--     a blanket function revoke would silently break run-event delivery and
--     flow-jam collaboration.
--   - Schema USAGE. Those same helper functions live in `public` and need it.
DO $lockdown$
DECLARE
  target_role text;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
      RAISE NOTICE 'role % absent (plain Postgres) — nothing to revoke', target_role;
      CONTINUE;
    END IF;

    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', target_role);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', target_role);

    -- Future tables: default privileges are per-granting-role, so revoke for
    -- the role running this migration AND for `postgres` when it exists and
    -- differs (a migration run by a different owner must not leave the
    -- postgres-role defaults armed for the next table).
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', target_role);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', target_role);

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres')
       AND current_user <> 'postgres' THEN
      BEGIN
        EXECUTE format(
          'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM %I', target_role);
        EXECUTE format(
          'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', target_role);
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE WARNING 'cannot alter postgres-role default privileges for %; run as postgres to complete', target_role;
      END;
    END IF;
  END LOOP;
END
$lockdown$;
```

- [ ] **Step 2: Apply it and confirm no drift**

Run: `npx prisma migrate deploy && npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code`
Expected: migration applies; diff exits 0 (this migration changes no schema objects, so `schema.prisma` needs no edit).

- [ ] **Step 3: Commit**

```bash
git add scripts/bootstrap-supabase-migration-test.sql prisma/migrations/20260813210000_lock_public_schema_grants/
git commit -m "fix(security): revoke anon/authenticated grants on Prisma-owned tables"
```

### Task 1.3: The CI drift guard

**Files:**
- Create: `src/lib/__tests__/public-schema-grants.pg.test.ts`

**Interfaces:**
- Consumes: the roles and default privileges from Task 1.1, the revoke from Task 1.2.
- Produces: a failing CI run the moment a future migration re-exposes a table.

- [ ] **Step 1: Write the failing test**

Follow the `TEST_DATABASE_URL`-gated shape of `src/lib/__tests__/realtime-rls.pg.test.ts` (skip entirely when unset, so `npm test` stays green on a dev machine).

```ts
/**
 * No table in schema `public` may be readable by `anon` or `authenticated`.
 *
 * Isolation is enforced in the application layer (src/lib/tenant-guard.ts),
 * which PostgREST does not run. A grant to either role therefore exposes every
 * tenant's rows at /rest/v1/<table> with the publishable key. The bootstrap
 * script arms Supabase's stock default privileges, so this test fails without
 * the lockdown migration rather than passing vacuously.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  before(async () => { ({ prisma } = await import('@/lib/prisma')) })
  after(async () => { await prisma?.$disconnect?.() })

  test('no public table grants SELECT to anon or authenticated', async () => {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT c.relname::text AS table_name,
             has_table_privilege('anon', c.oid, 'SELECT') AS anon_read,
             has_table_privilege('authenticated', c.oid, 'SELECT') AS auth_read
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
    `)
    const exposed = rows
      .filter((r: any) => r.anon_read || r.auth_read)
      .map((r: any) => `${r.table_name}(${r.anon_read ? 'anon' : ''}${r.auth_read ? ' authenticated' : ''})`)
    assert.deepEqual(exposed, [], `Table(s) readable over PostgREST: ${exposed.join(', ')}`)
  })

  test('a newly created table inherits no grant', async () => {
    // Proves the ALTER DEFAULT PRIVILEGES revoke took, not just the one-time
    // REVOKE — the difference between fixing today's tables and fixing the
    // next migration's too.
    await prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS grant_drift_probe (id int)')
    try {
      const rows = await prisma.$queryRawUnsafe(`
        SELECT has_table_privilege('anon', 'public.grant_drift_probe', 'SELECT') AS anon_read,
               has_table_privilege('authenticated', 'public.grant_drift_probe', 'SELECT') AS auth_read
      `)
      assert.equal(rows[0].anon_read, false, 'new table inherited an anon grant')
      assert.equal(rows[0].auth_read, false, 'new table inherited an authenticated grant')
    } finally {
      await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS grant_drift_probe')
    }
  })

  test('realtime channel helpers remain executable by authenticated', async () => {
    // The revoke deliberately spares FUNCTIONS; this is the regression guard.
    const rows = await prisma.$queryRawUnsafe(`
      SELECT has_function_privilege('authenticated', 'public.can_access_run_events(text)', 'EXECUTE') AS ok
    `)
    assert.equal(rows[0].ok, true, 'run-events channel authorization lost its grant')
  })
}
```

- [ ] **Step 2: Run against a database WITHOUT the migration to prove it fails**

Run: on a scratch database, apply the bootstrap script only, then
`TEST_DATABASE_URL=... npx tsx --test src/lib/__tests__/public-schema-grants.pg.test.ts`
Expected: FAIL listing every table as anon-readable. This is the audit finding, reproduced.

- [ ] **Step 3: Apply the migration and re-run**

Expected: PASS, all three tests.

- [ ] **Step 4: Commit**

```bash
git add src/lib/__tests__/public-schema-grants.pg.test.ts
git commit -m "test(security): guard against PostgREST grant drift on public tables"
```

### Task 1.4: Operator verification runbook

**Files:**
- Create: `docs/runbooks/verify-postgrest-exposure.md`

- [ ] **Step 1: Write the runbook**

It must contain, verbatim and copy-pasteable: the `has_table_privilege` audit query; the live check `curl "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/users?select=id&limit=1" -H "apikey: $ANON_KEY"` with the expected `401`/`permission denied` response; and a "Follow-up: connect as a non-owner role and enable RLS" section stating why RLS was out of scope here (owner bypass) and what it would take.

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/verify-postgrest-exposure.md
git commit -m "docs: runbook for verifying PostgREST table exposure"
```

---

## Workstream 2 — Bot protection (audit gap #12, severity: high; also mitigates #11)

**Why:** Zero captcha primitives exist. Signup, login, and password reset go browser → Supabase directly, so the app's rate limiter never sees them; Turnstile is the only control that can sit in front of that path, which is why this workstream also closes the login rate-limiting gap. `/api/contact` has only a 5/min IP limit derived from spoofable headers.

**Choice:** Cloudflare Turnstile — free, natively supported by Supabase Auth (`options.captchaToken`), no per-user tracking. Configured entirely by env var; unset means every code path no-ops, so dev machines and CI are unaffected.

### Task 2.1: Server-side token verification

**Files:**
- Create: `src/lib/security/turnstile.ts`
- Test: `src/lib/security/__tests__/turnstile.test.ts`

**Interfaces:**
- Produces: `turnstileConfigured(): boolean`, `assertHumanToken(token: string | undefined, remoteIp?: string): Promise<void>` (throws `TurnstileError` on failure, resolves silently when unconfigured).

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertHumanToken, TurnstileError } from '../turnstile'

test('no-ops when unconfigured', async () => {
  delete process.env.TURNSTILE_SECRET_KEY
  await assertHumanToken(undefined) // must not throw
})

test('rejects a missing token when configured', async () => {
  process.env.TURNSTILE_SECRET_KEY = 'secret'
  await assert.rejects(() => assertHumanToken(undefined), TurnstileError)
})

test('rejects when Cloudflare says the token is bad', async () => {
  process.env.TURNSTILE_SECRET_KEY = 'secret'
  const fetchImpl = async () => new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }))
  await assert.rejects(() => assertHumanToken('bad', undefined, fetchImpl as any), TurnstileError)
})

test('accepts a token Cloudflare validates', async () => {
  process.env.TURNSTILE_SECRET_KEY = 'secret'
  const fetchImpl = async () => new Response(JSON.stringify({ success: true }))
  await assertHumanToken('good', '1.2.3.4', fetchImpl as any)
})

test('fails CLOSED when Cloudflare is unreachable', async () => {
  // Deliberately the opposite of the rate limiter's fail-open stance: a
  // limiter outage degrades throughput, a captcha outage degrades identity.
  process.env.TURNSTILE_SECRET_KEY = 'secret'
  const fetchImpl = async () => { throw new Error('network') }
  await assert.rejects(() => assertHumanToken('good', undefined, fetchImpl as any), TurnstileError)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern=turnstile` (or `npx tsx --test src/lib/security/__tests__/turnstile.test.ts`)
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Post `secret` + `response` + optional `remoteip` as form-encoded to `https://challenges.cloudflare.com/turnstile/v0/siteverify` with a 5s `AbortSignal.timeout`. Accept a `fetchImpl` parameter defaulting to `fetch` (the codebase's testing seam — see `src/lib/import/fetch-url.ts`). Fail closed on network error, non-OK status, or `success !== true`.

- [ ] **Step 4: Run tests to verify they pass** — Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/security/turnstile.ts src/lib/security/__tests__/turnstile.test.ts
git commit -m "feat(security): add Turnstile token verification helper"
```

### Task 2.2: CSP allowance + env documentation

**Files:**
- Modify: `src/lib/security/csp.ts`
- Modify: `src/lib/security/__tests__/csp.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add a failing CSP test**

Assert `script-src` and `frame-src` both contain `https://challenges.cloudflare.com`. Expected: FAIL.

- [ ] **Step 2: Add the host to `script-src` and `frame-src`** — the widget loads a script and renders in an iframe; omitting either silently breaks the challenge with only a console error.

- [ ] **Step 3: Document the env vars in `.env.example`**

```
# Bot protection — Cloudflare Turnstile (dash.cloudflare.com → Turnstile).
# Unset = every captcha check no-ops, which is the correct local-dev default.
# Set BOTH in production, and enable the matching CAPTCHA provider in the
# Supabase Auth dashboard so signup/login/recovery are covered too.
NEXT_PUBLIC_TURNSTILE_SITE_KEY=
TURNSTILE_SECRET_KEY=
```

- [ ] **Step 4: Run tests, then commit**

```bash
git add src/lib/security/csp.ts src/lib/security/__tests__/csp.test.ts .env.example
git commit -m "feat(security): allow Turnstile in CSP and document its env vars"
```

### Task 2.3: The client widget

**Files:**
- Create: `src/components/auth/turnstile-widget.tsx`

**Interfaces:**
- Produces: `<TurnstileWidget onToken={(token: string | null) => void} />`, which renders nothing at all when `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is unset.

- [ ] **Step 1: Implement** — load the Turnstile script once (guard against React 19 double-mount in dev), render an explicit-mode widget with the nonce-compatible script tag, call `onToken` on success and `onToken(null)` on expiry/error so the form can re-disable submit.

- [ ] **Step 2: Commit**

```bash
git add src/components/auth/turnstile-widget.tsx
git commit -m "feat(security): add Turnstile widget component"
```

### Task 2.4: Wire into the auth pages

**Files:**
- Modify: `src/app/(public)/auth/login/page.tsx`
- Modify: `src/app/(public)/auth/signup/page.tsx`
- Modify: `src/app/(public)/auth/forgot-password/page.tsx`

- [ ] **Step 1: Render the widget and pass the token to Supabase**

Supabase takes it natively: `signInWithPassword({ email, password, options: { captchaToken } })`, `signUp({ ..., options: { captchaToken } })`, `resetPasswordForEmail(email, { captchaToken })`. Note `useSupabase().signIn` currently takes `(email, password)` — thread an optional third `captchaToken` argument through the provider rather than bypassing it, so every caller keeps one code path.

- [ ] **Step 2: Verify by running the app with the site key set** — the widget must appear and sign-in must still succeed. With the key unset, the form must behave exactly as before.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(public)/auth" src/components/providers/supabase-provider.tsx
git commit -m "feat(security): require Turnstile on login, signup and password reset"
```

### Task 2.5: Wire into the public API routes

**Files:**
- Modify: `src/app/api/contact/route.ts`
- Modify: `src/app/api/feedback/route.ts`
- Test: `src/app/api/__tests__/contact-route.test.ts`

- [ ] **Step 1: Add a failing test** — with `TURNSTILE_SECRET_KEY` set and no token in the body, POST `/api/contact` returns 400. Expected: FAIL.

- [ ] **Step 2: Add `captchaToken: z.string().optional()` to each body schema and `await assertHumanToken(...)` before any work.** Map `TurnstileError` to a 400 `CAPTCHA_FAILED`.

- [ ] **Step 3: Run tests, then commit**

```bash
git add src/app/api/contact src/app/api/feedback src/app/api/__tests__/contact-route.test.ts
git commit -m "feat(security): require Turnstile on public contact and feedback routes"
```

---

## Workstream 3 — Auth rate limiting visibility (audit gap #11, severity: high)

**Why:** The app's limiter is good and, as of this audit, confirmed globally backed in production (`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are both set). It simply never sees auth traffic. Turnstile (Workstream 2) is the real mitigation; what remains is that *no one can tell from the repo* whether Supabase's own auth limits are configured, and the checklist item is unverifiable prose.

**Honest scope:** Supabase dashboard settings cannot be enforced from application code. This workstream makes them *checkable* rather than pretending to enforce them.

### Task 3.1: Rate-limit the auth-adjacent app routes

**Files:**
- Modify: `src/app/api/auth/context/route.ts`
- Modify: `src/app/api/bootstrap/route.ts`

- [ ] **Step 1: Add a declarative rate limit to each** via the wrapper's existing config, e.g. `rateLimit: { feature: 'auth-context', perUser: 60 }`. These are the session-bootstrap routes an authenticated attacker could loop.

- [ ] **Step 2: Run the route smoke suite** — Run: `npm test -- --test-name-pattern=route-smoke`. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/auth/context src/app/api/bootstrap
git commit -m "feat(security): rate limit session bootstrap routes"
```

### Task 3.2: A checkable auth-configuration probe

**Files:**
- Create: `scripts/check-auth-hardening.mjs`
- Modify: `package.json` (add `"check:auth": "node scripts/check-auth-hardening.mjs"`)

- [ ] **Step 1: Implement the probe**

Reads `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from the environment and reports, as a pass/fail table: whether password signup is disabled, whether a CAPTCHA provider is enabled, and whether leaked-password protection is on — via `GET {url}/auth/v1/settings` (unauthenticated, returns the project's public auth config) supplemented by the admin API where needed. Exit non-zero on any failure. Print a clear "cannot verify — set SUPABASE_SERVICE_ROLE_KEY" and exit 0 when credentials are absent, so it never blocks a dev machine.

- [ ] **Step 2: Verify** — Run: `npm run check:auth` with no credentials. Expected: prints the cannot-verify notice, exits 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/check-auth-hardening.mjs package.json
git commit -m "feat(security): add a probe for Supabase auth hardening settings"
```

---

## Workstream 4 — Upload hardening (audit gap #16, severity: high)

**Why:** `isSupported()` in `src/lib/knowledge/extract.ts` accepts a file when the MIME type **or** the extension matches — either alone passes, and neither is verified against the bytes. Those bytes then reach `pdf-parse` (last published 2018) and `mammoth` (unzips with no bomb guard) in-process. There is no malware scanning of any kind. Separately, `imageUrl` on `PATCH /api/settings/profile` is validated only as `z.string().url()`, while the equivalent org-logo field is regex-locked to a `data:image/(png|jpeg|webp)` URL.

### Task 4.1: Magic-byte sniffing

**Files:**
- Create: `src/lib/security/file-signature.ts`
- Test: `src/lib/security/__tests__/file-signature.test.ts`

**Interfaces:**
- Produces: `sniffFileKind(buffer: Buffer): 'pdf' | 'zip' | 'text' | 'unknown'`, `assertDeclaredKindMatches(buffer: Buffer, mimeType: string, filename: string): void` (throws `FileSignatureError`).

- [ ] **Step 1: Write the failing test**

```ts
test('detects a PDF by its header, not its name', () => {
  assert.equal(sniffFileKind(Buffer.from('%PDF-1.7\n...')), 'pdf')
})
test('detects a DOCX (zip container) by its header', () => {
  assert.equal(sniffFileKind(Buffer.from([0x50, 0x4b, 0x03, 0x04])), 'zip')
})
test('rejects bytes that contradict a .pdf name', () => {
  // The exact attack the OR-allowlist permitted: any bytes, named .pdf,
  // handed straight to an unmaintained parser.
  assert.throws(
    () => assertDeclaredKindMatches(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'application/pdf', 'evil.pdf'),
    FileSignatureError,
  )
})
test('accepts UTF-8 text for a .md name', () => {
  assertDeclaredKindMatches(Buffer.from('# hello'), 'text/markdown', 'notes.md')
})
test('rejects binary bytes for a .txt name', () => {
  assert.throws(() => assertDeclaredKindMatches(Buffer.from([0x00, 0xff, 0xfe]), 'text/plain', 'notes.txt'), FileSignatureError)
})
```

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL, module not found.

- [ ] **Step 3: Implement** — `%PDF-` prefix for pdf; `PK\x03\x04` for zip; text = decodes as UTF-8 with no NUL bytes in the first 8 KB. `assertDeclaredKindMatches` maps the declared type to an expected kind and throws on mismatch.

- [ ] **Step 4: Run tests to verify they pass** — Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/security/file-signature.ts src/lib/security/__tests__/file-signature.test.ts
git commit -m "feat(security): sniff uploaded file signatures"
```

### Task 4.2: Tighten the allowlist from OR to AND

**Files:**
- Modify: `src/lib/knowledge/extract.ts`
- Modify: `src/lib/knowledge/__tests__/extract.test.ts`

- [ ] **Step 1: Add a failing test** — `extractText` on zip bytes declared `application/pdf` must throw rather than reach `pdf-parse`. Expected: FAIL (it currently reaches the parser).

- [ ] **Step 2: Call `assertDeclaredKindMatches` at the top of `extractText`** and keep `isSupported` as the cheap pre-check. Both upload routes already convert a thrown error into a 415.

- [ ] **Step 3: Run tests, then commit**

```bash
git add src/lib/knowledge/extract.ts src/lib/knowledge/__tests__/extract.test.ts
git commit -m "fix(security): require declared file type to match actual bytes"
```

### Task 4.3: DOCX decompression-bomb guard

**Files:**
- Modify: `src/lib/security/file-signature.ts`
- Modify: `src/lib/security/__tests__/file-signature.test.ts`

**Interfaces:**
- Produces: `assertZipWithinBudget(buffer: Buffer, maxUncompressedBytes: number): void`.

- [ ] **Step 1: Write the failing test** — a synthetic zip central directory declaring 5 GB uncompressed must throw; a normal small one must not.

- [ ] **Step 2: Implement** — parse the End of Central Directory record, walk the central directory entries, sum their declared uncompressed sizes, and throw when the total exceeds the budget. Reading the declared sizes is enough: it costs no decompression and a lying header fails later in `mammoth` anyway.

- [ ] **Step 3: Call it from `extractText` for the DOCX branch** with a 64 MB budget.

- [ ] **Step 4: Run tests, then commit**

```bash
git add src/lib/security/file-signature.ts src/lib/security/__tests__/file-signature.test.ts src/lib/knowledge/extract.ts
git commit -m "feat(security): bound DOCX uncompressed size before parsing"
```

### Task 4.4: Pluggable malware scanning

**Files:**
- Create: `src/lib/security/scan-upload.ts`
- Test: `src/lib/security/__tests__/scan-upload.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `scanUpload(buffer: Buffer, filename: string): Promise<void>` — throws `MalwareDetectedError` on a positive verdict, resolves when `UPLOAD_SCANNER_URL` is unset.

- [ ] **Step 1: Write the failing test** — unset scanner resolves; a scanner returning `{ infected: true }` throws; a scanner that times out throws (fail closed, same reasoning as Turnstile); the EICAR test string is forwarded intact.

- [ ] **Step 2: Implement** — POST the bytes to `UPLOAD_SCANNER_URL` (an ICAP-style HTTP shim, e.g. a ClamAV REST sidecar) with a 10 s timeout and a `fetchImpl` seam. Deliberately transport-agnostic so the deployment can point it at ClamAV, a cloud scanner, or nothing.

- [ ] **Step 3: Document in `.env.example`**

```
# Upload malware scanning — optional HTTP scanner (e.g. a ClamAV REST sidecar).
# Unset = uploads are accepted after signature + size checks with no AV pass.
# Set this in any deployment that accepts files from untrusted users.
UPLOAD_SCANNER_URL=
```

- [ ] **Step 4: Call `scanUpload` from both upload routes** — `src/app/api/assistant/extract/route.ts` and `src/app/api/agents/[id]/knowledge/route.ts`, after the size check and before extraction. Map `MalwareDetectedError` to a 422 `MALWARE_DETECTED`.

- [ ] **Step 5: Run tests, then commit**

```bash
git add src/lib/security/scan-upload.ts src/lib/security/__tests__/scan-upload.test.ts .env.example src/app/api/assistant/extract src/app/api/agents
git commit -m "feat(security): add pluggable malware scanning for uploads"
```

### Task 4.5: Close the avatar schema hole

**Files:**
- Modify: `src/app/api/settings/profile/route.ts`
- Test: `src/app/api/__tests__/mutation-routes-e2e.test.ts`

- [ ] **Step 1: Add a failing test** — `PATCH /api/settings/profile` with `imageUrl: 'https://evil.example/pixel.png'` must be rejected, and so must `imageUrl: 'javascript:alert(1)'` (Zod's `.url()` accepts it, since it is a valid URL). Expected: FAIL, both currently accepted.

- [ ] **Step 2: Replace the validator with the org-logo regex**

```ts
  imageUrl: z
    .string()
    .max(300_000)
    // Same shape as the org logo: an inline data URL the client produced by
    // re-encoding the chosen image. A bare .url() accepts `javascript:` (a
    // valid URL) and any external host, turning an avatar into a tracking
    // pixel that leaks every viewer's IP.
    .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, 'Unsupported image format.')
    .nullable()
    .optional(),
```

- [ ] **Step 3: Run tests, then commit**

```bash
git add src/app/api/settings/profile src/app/api/__tests__/mutation-routes-e2e.test.ts
git commit -m "fix(security): restrict profile avatars to inline image data URLs"
```

---

## Workstream 5 — Supply chain (audit gap #20 and #2, severity: medium)

**Why:** `npm audit --omit=dev` gates CI and currently reports 0 vulnerabilities, but it runs only on push and pull request — a CVE published tomorrow against an unchanged dependency surfaces only at the next commit. There is no Dependabot or Renovate config, dev dependencies sit outside the gate, and there is no secret scanning or SAST. Git history is clean today but nothing keeps it that way.

### Task 5.1: Dependabot

**Files:**
- Create: `.github/dependabot.yml`

- [ ] **Step 1: Write the config** — weekly `npm` updates grouped into one PR for minor/patch (so the queue stays reviewable) with major bumps separate, plus weekly `github-actions` updates so the pinned SHAs in Task 5.3 do not rot.

- [ ] **Step 2: Commit**

```bash
git add .github/dependabot.yml
git commit -m "ci: enable Dependabot for npm and GitHub Actions"
```

### Task 5.2: Nightly vulnerability sweep

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add a `schedule` trigger and an audit job**

Add `schedule: - cron: '17 6 * * *'` to `on:`, and a job that runs the existing blocking `npm run audit:prod` plus a non-blocking full `npm audit` (`continue-on-error: true`) so dev-dependency findings are visible without wedging the pipeline. Guard the job with `if: github.event_name == 'schedule'` where it should not run per-push.

- [ ] **Step 2: Verify the workflow parses** — Run: `npx --yes @action-validator/cli@latest .github/workflows/ci.yml` (or push the branch and read the Actions tab).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: sweep dependencies nightly, not only on push"
```

### Task 5.3: Secret scanning and SAST

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `.gitleaks.toml`

- [ ] **Step 1: Add a `security` job** running gitleaks over full history (`fetch-depth: 0`) and Semgrep with its default ruleset. Pin both actions by commit SHA per the global constraints.

- [ ] **Step 2: Add `.gitleaks.toml`** allowlisting the known test fixtures the audit surfaced — `sk-ant-api03-abcdefghijklmnop1234`, `sk_live_abcdefghijklmnop1234`, `AKIAIOSFODNN7EXAMPLE`, `xoxb-1234567890-abcdefghij` — scoped to `**/__tests__/**` only, so a real secret in application code still fails.

- [ ] **Step 3: Run gitleaks locally to confirm a clean baseline**

Run: `docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:latest detect --source=/repo --config=/repo/.gitleaks.toml`
Expected: no leaks found. If it flags anything beyond the allowlisted fixtures, stop and triage before committing.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml .gitleaks.toml
git commit -m "ci: add gitleaks secret scanning and Semgrep SAST"
```

---

## Workstream 6 — Remaining hardening (audit gaps #9, #14, #18, #5, #15, severity: low–medium)

### Task 6.1: Pin session cookie flags

**Files:**
- Modify: `src/lib/supabase/server.ts`
- Modify: `src/lib/supabase/middleware.ts`
- Test: `src/lib/supabase/__tests__/cookie-options.test.ts` (create)

- [ ] **Step 1: Write the failing test** — assert the shared options object is `{ httpOnly: true, secure: true, sameSite: 'lax', path: '/' }` in production and `secure: false` when `NODE_ENV !== 'production'` (so `http://localhost` still works). Expected: FAIL, no such export.

- [ ] **Step 2: Export `SESSION_COOKIE_OPTIONS` from `src/lib/supabase/config.ts` and pass it as `cookieOptions` to both `createServerClient` calls.** Today the flags are whatever `@supabase/ssr` defaults to — correct, but unasserted and free to change under a minor version bump.

- [ ] **Step 3: Run tests, then commit**

```bash
git add src/lib/supabase
git commit -m "fix(security): pin and test Supabase session cookie flags"
```

### Task 6.2: Request body size cap

**Files:**
- Modify: `src/lib/server/api-handler.ts`
- Test: `src/lib/server/__tests__/api-handler.test.ts`

- [ ] **Step 1: Write the failing test** — a request declaring `content-length: 20000000` returns 413 `TOO_LARGE`; one declaring 1 KB passes through. Expected: FAIL.

- [ ] **Step 2: Add an optional `maxBodyBytes` to `RouteAccess`, defaulting to 1 MB**, checked after auth and before the handler, mirroring the existing `content-length` check in `src/app/api/flows/[id]/trigger/route.ts:41`. Give the two upload routes an explicit larger budget so the 10 MB limit still applies there.

- [ ] **Step 3: Run the full route suite** — Run: `npm test`. Expected: PASS. Any route legitimately exceeding 1 MB gets an explicit budget rather than a raised default.

- [ ] **Step 4: Commit**

```bash
git add src/lib/server
git commit -m "feat(security): cap request body size at the API wrapper"
```

### Task 6.3: CSP violation reporting

**Files:**
- Modify: `src/lib/security/csp.ts`
- Create: `src/app/api/security/csp-report/route.ts`
- Modify: `src/app/api/__tests__/route-permissions.test.ts`

- [ ] **Step 1: Add `report-uri /api/security/csp-report` and a matching `report-to` group** to the policy. Without a reporting sink, every violation is invisible and the policy can only be tightened by guesswork.

- [ ] **Step 2: Create the collector route** — accepts POST, rate-limited by IP, body capped at 16 KB, logs through `apiLogger` at warn level, always returns 204. It is unauthenticated by necessity (browsers send reports without credentials), so add it to `DIFFERENTLY_AUTHENTICATED` in the permissions test with the mechanism `'unauthenticated browser report sink; rate limited, logs only, never reads or writes tenant data'`.

- [ ] **Step 3: Run the permissions test** — Run: `npm test -- --test-name-pattern=route-permissions`. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/security/csp.ts src/app/api/security src/app/api/__tests__/route-permissions.test.ts
git commit -m "feat(security): collect CSP violation reports"
```

### Task 6.4: Strengthen key derivation

**Files:**
- Modify: `src/lib/crypto/secrets.ts`
- Modify: `src/lib/crypto/__tests__/secrets.test.ts`

**Why:** `deriveKey` is a bare `sha256(ENCRYPTION_KEY)`. That is fine for a high-entropy random key and weak for a passphrase, and the `v1:` envelope carries no key identifier, which is what makes rotation all-or-nothing.

- [ ] **Step 1: Write the failing test** — `encryptSecret` produces a `v2:` payload; `decryptSecret` still reads existing `v1:` and `b64:` payloads byte-for-byte; a `v2:` payload written under key A does not decrypt under key B. Expected: FAIL.

- [ ] **Step 2: Add a `v2` format** using `crypto.hkdfSync('sha256', keyMaterial, salt, info, 32)` with a random 16-byte salt stored in the envelope: `v2:<saltB64>:<ivB64>:<tagB64>:<ctB64>`. Keep `v1` on the read path forever — the global constraint. Do **not** re-encrypt existing rows here; that is `src/lib/crypto/rotate.ts`'s job and an operator decision.

- [ ] **Step 3: Run the crypto suite and the credential round-trip tests** — Run: `npm test -- --test-name-pattern='secret|credential'`. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/crypto
git commit -m "feat(security): derive encryption keys with HKDF and a per-secret salt"
```

### Task 6.5: Remove the MFA QR HTML sink

**Files:**
- Modify: `src/app/(app)/settings/tabs/security.tsx`

- [ ] **Step 1: Replace `dangerouslySetInnerHTML={{ __html: enrollment.qr }}` with `<img src={enrollment.qr} alt="" />`** using the `totp.qr_code` data URI Supabase already returns, and drop the now-unused `qr` SVG field from the enrollment state. Low risk today — the string comes from Supabase, not a user — but it is the only such sink in the codebase, and removing it means the rule "we have zero HTML injection points" becomes greppable.

- [ ] **Step 2: Verify MFA enrollment still renders a scannable code** in the running app.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/settings/tabs/security.tsx"
git commit -m "refactor(security): render the MFA QR as an image instead of raw HTML"
```

### Task 6.6: Refresh the security documentation

**Files:**
- Modify: `docs/production-auth-checklist.md`
- Create: `docs/security-posture.md`

- [ ] **Step 1: Fix the stale paragraph** — the checklist's closing paragraph says the CSP "permits inline scripts/styles" and asks for a move to nonces. `src/lib/security/csp.ts` already uses per-request nonces and confines `unsafe-eval` to development. Correct it to state what is actually true and what genuinely remains (`style-src 'unsafe-inline'`, which Next's inline style injection still requires).

- [ ] **Step 2: Add the Turnstile, scanner, and auth-probe items** to the checklist.

- [ ] **Step 3: Write `docs/security-posture.md`** — the 20-item scorecard with, for each item, the control, the file that implements it, and the test that guards it. This is the artifact that makes the next audit a diff instead of a rediscovery.

- [ ] **Step 4: Commit**

```bash
git add docs/production-auth-checklist.md docs/security-posture.md
git commit -m "docs: refresh the security checklist and record the 20-item posture"
```

---

## Final verification

- [ ] **Run the full gate:** `npm run check` (typecheck → lint → audit:prod → build)
- [ ] **Run the tests:** `npm test`
- [ ] **Run the DB-backed tests against a real Postgres** per the `verify` skill, so Workstream 1's guards actually execute rather than skipping.
- [ ] **Confirm every claim with output before reporting completion** (superpowers:verification-before-completion).

## Out of scope, recorded deliberately

- **Full RLS on all ~60 models.** RLS is bypassed by the table owner, and Prisma connects as the owner, so enabling it changes nothing until the app connects as a non-owner role with per-tenant policies. That is a standalone project; Task 1.4 documents the path. The grant revoke closes the exposure that mattered.
- **Proxying Supabase auth through the app** to bring login under the app's rate limiter. Large, risky, and largely redundant once Turnstile is in front of the same forms.
- **Removing `style-src 'unsafe-inline'`.** Next.js injects inline styles during dynamic rendering; removing it needs a styled-nonce audit of every component and belongs in its own change.
