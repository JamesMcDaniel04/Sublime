# Customer Lifecycle Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate the whole customer lifecycle — welcome/onboarding/trial/dunning/win-back emails and in-app feedback capture — so the founder only handles complaints.

**Architecture:** A state-swept email engine: lifecycle emails are derived from DB state by the existing `/api/cron/dispatch` daily window (same pattern as the weekly goal digest), with every send claim-logged in a new `EmailSend` table whose unique `dedupeKey` gives exactly-once semantics. Event-driven emails (welcome, dunning) fire from their events through the same log. Feedback is persisted to `FeedbackSubmission` then forwarded to the founder inbox.

**Tech Stack:** Next.js App Router, Prisma/Postgres, Resend REST API (raw fetch, no SDK), `node:test` + tsx, Stripe webhooks.

**Spec:** `docs/superpowers/specs/2026-08-01-customer-lifecycle-automation-design.md`

## Global Constraints

- Env vars are read **at call time**, never at module load (build must succeed without them) — see header comment in `src/lib/integrations/email.ts`.
- All Resend fetches use `AbortSignal.timeout(30_000)`.
- DB-backed tests are gated on `TEST_DATABASE_URL` exactly like `src/lib/billing/__tests__/sync-subscription-e2e.test.ts` (whole file inside `if (TEST_DB) { … }`). Start the throwaway Postgres per the `verify` skill; run migrations against it before trusting failures.
- Run a single test file with: `TEST_DATABASE_URL=<url> TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <file>`
- Cron sweeps: bounded fan-out, per-org/per-user try/catch isolation, fire-and-forget via `afterResponse` (from `@/lib/server/after-response`), never extend the tick — copy the idioms visible at `src/app/api/cron/dispatch/route.ts:520-591`.
- Marketing emails (drip, win-back, digest) respect `User.marketingEmailsOptOut` and carry an unsubscribe link; transactional emails (welcome, trial-ending, dunning, feedback forward, contact) always send.
- Default from address / inbox: `EMAIL_FROM` (default `Sublime <onboarding@resend.dev>`), new `CONTACT_INBOX` (default `hello@trysublime.io`).
- Commit after every task; never `git add -A` (unrelated uncommitted work exists on this branch) — always add explicit paths.

---

### Task 1: Schema — `EmailSend`, `FeedbackSubmission`, `User.marketingEmailsOptOut`

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260801150000_lifecycle_email_feedback/migration.sql`
- Test: `src/lib/email/__tests__/email-send-model.test.ts`

**Interfaces:**
- Produces: Prisma models `EmailSend` (unique `dedupeKey`, `status: EmailSendStatus = PENDING|SENT|FAILED`, `attempts`), `FeedbackSubmission` (`category: FeedbackCategory = COMPLAINT|IDEA|QUESTION|OTHER`), and `User.marketingEmailsOptOut: boolean` — used by every later task.

- [ ] **Step 1: Add models to `prisma/schema.prisma`**

Append to the `Organization` model's relation list (after `goalWorkRules GoalWorkRule[]`):

```prisma
  emailSends                EmailSend[]
  feedbackSubmissions       FeedbackSubmission[]
```

Add to the `User` model after `metadata Json?`:

```prisma
  // Suppresses marketing email (onboarding drip, win-back, goal digest).
  // Transactional email (trial-ending, dunning, welcome) always sends.
  marketingEmailsOptOut Boolean @default(false)
```

Add new models + enums at the end of the models section (near `FeedbackCategory`, follow file conventions):

```prisma
// One row per product email attempt. The unique dedupeKey is the exactly-once
// mechanism: sweeps and webhook retries insert-claim before sending, and a
// duplicate key means "already handled — skip silently".
model EmailSend {
  id             String          @id @default(cuid())
  organizationId String          @db.Uuid
  userId         String?
  // Sequence identifier, e.g. 'welcome', 'drip-day2', 'trial-3d', 'dunning'.
  emailKey       String
  // Once-ness scope, e.g. 'trial-3d:org_<id>' or 'dunning:inv_<id>'.
  dedupeKey      String          @unique
  to             String
  subject        String
  status         EmailSendStatus @default(PENDING)
  attempts       Int             @default(1)
  error          String?
  createdAt      DateTime        @default(now()) @db.Timestamptz(6)
  sentAt         DateTime?       @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId])
  @@map("email_sends")
}

enum EmailSendStatus {
  PENDING
  SENT
  FAILED
}

// In-app feedback. Persisted FIRST (the record of truth), then forwarded to
// CONTACT_INBOX — a forward failure never loses the submission.
model FeedbackSubmission {
  id             String           @id @default(cuid())
  organizationId String           @db.Uuid
  userId         String
  category       FeedbackCategory
  message        String           @db.Text
  // In-app route the user was on when submitting.
  path           String?
  createdAt      DateTime         @default(now()) @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId])
  @@map("feedback_submissions")
}

enum FeedbackCategory {
  COMPLAINT
  IDEA
  QUESTION
  OTHER
}
```

- [ ] **Step 2: Write the migration SQL**

Create `prisma/migrations/20260801150000_lifecycle_email_feedback/migration.sql`:

```sql
-- Lifecycle email send log + in-app feedback + marketing opt-out.

CREATE TYPE "EmailSendStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');
CREATE TYPE "FeedbackCategory" AS ENUM ('COMPLAINT', 'IDEA', 'QUESTION', 'OTHER');

ALTER TABLE "users" ADD COLUMN "marketingEmailsOptOut" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "email_sends" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" TEXT,
    "emailKey" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "EmailSendStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMPTZ(6),
    CONSTRAINT "email_sends_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "email_sends_dedupeKey_key" ON "email_sends"("dedupeKey");
CREATE INDEX "email_sends_organizationId_idx" ON "email_sends"("organizationId");
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "feedback_submissions" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "category" "FeedbackCategory" NOT NULL,
    "message" TEXT NOT NULL,
    "path" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "feedback_submissions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "feedback_submissions_organizationId_idx" ON "feedback_submissions"("organizationId");
ALTER TABLE "feedback_submissions" ADD CONSTRAINT "feedback_submissions_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Regenerate the client and validate**

Run: `npx prisma generate && npx prisma validate`
Expected: both succeed.

- [ ] **Step 4: Write a DB-backed model smoke test**

`src/lib/email/__tests__/email-send-model.test.ts`:

```ts
/** Schema smoke: EmailSend dedupeKey uniqueness — the mechanism every
 *  lifecycle sequence relies on. Gated on TEST_DATABASE_URL (see `verify`). */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  const orgIds: string[] = []

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
  })
  after(async () => {
    for (const id of orgIds) await prisma.organization.delete({ where: { id } }).catch(() => {})
  })

  test('duplicate dedupeKey inserts are rejected (P2002)', async () => {
    const org = await prisma.organization.create({
      data: { name: 'EmailSend', slug: `emailsend-${crypto.randomUUID()}` },
    })
    orgIds.push(org.id)
    const row = {
      organizationId: org.id, emailKey: 'welcome',
      dedupeKey: `welcome:${org.id}`, to: 'a@b.co', subject: 'hi',
    }
    await prisma.emailSend.create({ data: row })
    await assert.rejects(
      prisma.emailSend.create({ data: row }),
      (error: any) => error.code === 'P2002',
    )
  })
}
```

- [ ] **Step 5: Deploy migration to the test DB and run the test**

Run: `TEST_DATABASE_URL=<url> DATABASE_URL=<url> DIRECT_URL=<url> npx prisma migrate deploy`
Then: `TEST_DATABASE_URL=<url> TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/email/__tests__/email-send-model.test.ts`
Expected: PASS (deleting the org must cascade-delete the send row — the `after` hook relies on it).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260801150000_lifecycle_email_feedback/migration.sql src/lib/email/__tests__/email-send-model.test.ts
git commit -m "feat(email): EmailSend log, FeedbackSubmission, marketing opt-out schema"
```

---

### Task 2: Email core — `sendRawEmail`, shared layout, contact-route unification

**Files:**
- Create: `src/lib/email/send.ts`, `src/lib/email/layout.ts`
- Modify: `src/app/api/contact/route.ts` (drop inline Resend fetch, env-driven inbox), `src/lib/env.ts` (document `CONTACT_INBOX`)
- Test: `src/lib/email/__tests__/layout.test.ts`, existing `src/app/api/__tests__/contact-route.test.ts` must stay green

**Interfaces:**
- Consumes: nothing new (wraps the same Resend REST call as `src/lib/integrations/email.ts`).
- Produces: `sendRawEmail(input: { to: string; subject: string; html?: string; text?: string; replyTo?: string }): Promise<void>` (throws on failure); `contactInbox(): string`; `wrapEmailHtml(input: { heading: string; bodyHtml: string; cta?: { label: string; url: string }; unsubscribeUrl?: string | null }): string`; `escapeHtml(value: string): string`.

- [ ] **Step 1: Write the failing layout test**

`src/lib/email/__tests__/layout.test.ts` (pure — no DB gate):

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wrapEmailHtml, escapeHtml } from '../layout'

test('wraps heading and body, escapes the heading', () => {
  const html = wrapEmailHtml({ heading: 'Hi <you>', bodyHtml: '<p>Welcome</p>' })
  assert.ok(html.includes('Hi &lt;you&gt;'))
  assert.ok(html.includes('<p>Welcome</p>'))
  assert.ok(html.toLowerCase().includes('sublime'))
})

test('renders CTA button and unsubscribe footer only when provided', () => {
  const plain = wrapEmailHtml({ heading: 'H', bodyHtml: '<p>b</p>' })
  assert.ok(!plain.includes('Unsubscribe'))
  const full = wrapEmailHtml({
    heading: 'H', bodyHtml: '<p>b</p>',
    cta: { label: 'Open Sublime', url: 'https://app.example/goals' },
    unsubscribeUrl: 'https://app.example/api/email/unsubscribe?uid=u&sig=s',
  })
  assert.ok(full.includes('Open Sublime'))
  assert.ok(full.includes('https://app.example/goals'))
  assert.ok(full.includes('Unsubscribe'))
})

test('escapeHtml escapes the five specials', () => {
  assert.equal(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/email/__tests__/layout.test.ts`
Expected: FAIL — cannot find module `../layout`.

- [ ] **Step 3: Implement `src/lib/email/layout.ts`**

Hand-built HTML, same philosophy as `formatGoalDigest` (`src/lib/goals/digest.ts:20-48`) — no react-email/mjml:

```ts
/** Shared HTML shell for all product email. Inline styles only — mail
 *  clients ignore stylesheets. Callers escape their own bodyHtml content;
 *  heading/label/url inputs are escaped here. */

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function wrapEmailHtml(input: {
  heading: string
  bodyHtml: string
  cta?: { label: string; url: string }
  unsubscribeUrl?: string | null
}): string {
  const cta = input.cta
    ? `<p style="margin:24px 0"><a href="${escapeHtml(input.cta.url)}" style="background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${escapeHtml(input.cta.label)}</a></p>`
    : ''
  const unsubscribe = input.unsubscribeUrl
    ? `<p style="margin-top:32px;font-size:12px;color:#888"><a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#888">Unsubscribe</a> from emails like this.</p>`
    : ''
  return [
    '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#222">',
    `<h1 style="font-size:20px">${escapeHtml(input.heading)}</h1>`,
    input.bodyHtml,
    cta,
    unsubscribe,
    '<p style="margin-top:32px;font-size:12px;color:#888">— The Sublime team</p>',
    '</div>',
  ].join('')
}
```

- [ ] **Step 4: Run the layout test**

Expected: PASS.

- [ ] **Step 5: Implement `src/lib/email/send.ts`**

```ts
/** Product-email transport. One Resend call site for first-party email —
 *  the agent tool in src/lib/integrations/email.ts stays separate on purpose
 *  (different contract: agent-authored content, JSON result surface).
 *  Env is read at call time so builds succeed unconfigured. */
import { emailConfigured } from '@/lib/integrations/email'

const RESEND_API_URL = 'https://api.resend.com/emails'

export { emailConfigured }

export function contactInbox(): string {
  return process.env.CONTACT_INBOX || 'hello@trysublime.io'
}

export async function sendRawEmail(input: {
  to: string
  subject: string
  html?: string
  text?: string
  replyTo?: string
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) throw new Error('Resend API key is not configured')
  const from = process.env.EMAIL_FROM || 'Sublime <onboarding@resend.dev>'
  const payload: Record<string, unknown> = { from, to: [input.to], subject: input.subject }
  if (input.html) {
    payload.html = input.html
    payload.text =
      input.text ?? input.html.replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim()
  } else {
    payload.text = input.text ?? ''
  }
  if (input.replyTo) payload.reply_to = input.replyTo
  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Email API error ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`)
  }
}
```

- [ ] **Step 6: Point the contact route at the shared transport**

In `src/app/api/contact/route.ts`:
- Replace `const CONTACT_INBOX = 'hello@trysublime.io'` and the `RESEND_API_URL` constant with `import { contactInbox, sendRawEmail } from '@/lib/email/send'`; use `const inbox = contactInbox()` inside the handler wherever `CONTACT_INBOX` appeared (including the three user-facing error strings).
- Replace the inline `fetch(RESEND_API_URL, …)` block (lines 91-111) with:

```ts
  try {
    await sendRawEmail({
      to: inbox,
      replyTo: email,
      subject: `[${support === 'dedicated' ? 'Dedicated' : support === 'priority' ? 'Priority' : 'Contact'}] ${REASON_LABELS[reason]} — ${name}`,
      text,
    })
  } catch (error) {
    apiLogger.error('contact form: Resend send failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json(
      { success: false, error: `We could not send your message — please email us directly at ${inbox}.` },
      { status: 502 },
    )
  }
  return NextResponse.json({ success: true })
```

Keep the early `RESEND_API_KEY` 503 check as is (it produces the friendlier 503 before any work).

- [ ] **Step 7: Document `CONTACT_INBOX` in `src/lib/env.ts`**

Add next to the `RESEND_API_KEY` entry (~line 83), following the existing declaration format, a recommended var: `CONTACT_INBOX` — "inbox for contact-form and in-app feedback forwards (default hello@trysublime.io)".

- [ ] **Step 8: Run the existing contact-route test**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/contact-route.test.ts`
Expected: PASS (it stubs fetch/env; if it asserted on the old constant, update assertions to the same literal default).

- [ ] **Step 9: Commit**

```bash
git add src/lib/email/send.ts src/lib/email/layout.ts src/lib/email/__tests__/layout.test.ts src/app/api/contact/route.ts src/lib/env.ts
git commit -m "feat(email): shared transport + layout; contact route uses env-driven inbox"
```

---

### Task 3: Claim-before-send — `sendLoggedEmail`

**Files:**
- Create: `src/lib/email/logged.ts`
- Test: `src/lib/email/__tests__/logged.test.ts`

**Interfaces:**
- Consumes: `sendRawEmail` (Task 2), `EmailSend` model (Task 1).
- Produces: `sendLoggedEmail(input: { organizationId: string; userId?: string | null; emailKey: string; dedupeKey: string; to: string; subject: string; html: string; replyTo?: string }): Promise<'sent' | 'duplicate' | 'failed' | 'unconfigured'>`. Retry semantics: a `FAILED` claim with `attempts < 3` can be re-claimed by a later sweep; `SENT`/`PENDING` cannot.

- [ ] **Step 1: Write the failing DB-backed test**

`src/lib/email/__tests__/logged.test.ts` — same `TEST_DATABASE_URL` gate shape as Task 1. Stub the transport by setting env and intercepting `globalThis.fetch`:

```ts
/** Claim-before-send semantics: exactly-once per dedupeKey, FAILED rows
 *  re-claimable (bounded), send failure never burns the claim silently. */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.RESEND_API_KEY = 'test-key'

  let prisma: any
  let logged: typeof import('../logged')
  const orgIds: string[] = []
  const realFetch = globalThis.fetch
  let fetchOk = true
  let fetchCalls = 0

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    logged = await import('../logged')
    globalThis.fetch = (async () => {
      fetchCalls += 1
      return fetchOk
        ? new Response('{}', { status: 200 })
        : new Response('boom', { status: 500 })
    }) as typeof fetch
  })
  after(async () => {
    globalThis.fetch = realFetch
    for (const id of orgIds) await prisma.organization.delete({ where: { id } }).catch(() => {})
  })
  beforeEach(() => { fetchOk = true; fetchCalls = 0 })

  async function seedOrg() {
    const org = await prisma.organization.create({
      data: { name: 'Logged', slug: `logged-${crypto.randomUUID()}` },
    })
    orgIds.push(org.id)
    return org
  }
  const input = (org: any, over: Record<string, unknown> = {}) => ({
    organizationId: org.id, emailKey: 'trial-3d', dedupeKey: `trial-3d:${org.id}`,
    to: 'admin@example.com', subject: 'Trial ending', html: '<p>hi</p>', ...over,
  })

  test('first call sends and records SENT; second call is a duplicate no-op', async () => {
    const org = await seedOrg()
    assert.equal(await logged.sendLoggedEmail(input(org)), 'sent')
    const row = await prisma.emailSend.findUnique({ where: { dedupeKey: `trial-3d:${org.id}` } })
    assert.equal(row.status, 'SENT')
    assert.ok(row.sentAt)
    assert.equal(await logged.sendLoggedEmail(input(org)), 'duplicate')
    assert.equal(fetchCalls, 1)
  })

  test('transport failure marks FAILED with the error, then a later call re-claims', async () => {
    const org = await seedOrg()
    fetchOk = false
    assert.equal(await logged.sendLoggedEmail(input(org)), 'failed')
    let row = await prisma.emailSend.findUnique({ where: { dedupeKey: `trial-3d:${org.id}` } })
    assert.equal(row.status, 'FAILED')
    assert.match(row.error, /500/)
    fetchOk = true
    assert.equal(await logged.sendLoggedEmail(input(org)), 'sent')
    row = await prisma.emailSend.findUnique({ where: { dedupeKey: `trial-3d:${org.id}` } })
    assert.equal(row.status, 'SENT')
    assert.equal(row.attempts, 2)
  })

  test('a FAILED claim at 3 attempts is not re-claimed', async () => {
    const org = await seedOrg()
    fetchOk = false
    for (let i = 0; i < 3; i += 1) assert.equal(await logged.sendLoggedEmail(input(org)), 'failed')
    assert.equal(await logged.sendLoggedEmail(input(org)), 'duplicate')
    assert.equal(fetchCalls, 3)
  })

  test('unconfigured environment is reported without touching the log', async () => {
    const org = await seedOrg()
    const saved = process.env.RESEND_API_KEY
    delete process.env.RESEND_API_KEY
    try {
      assert.equal(await logged.sendLoggedEmail(input(org)), 'unconfigured')
      assert.equal(await prisma.emailSend.count({ where: { organizationId: org.id } }), 0)
    } finally {
      process.env.RESEND_API_KEY = saved
    }
  })
}
```

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL=<url> TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/email/__tests__/logged.test.ts`
Expected: FAIL — cannot find module `../logged`.

- [ ] **Step 3: Implement `src/lib/email/logged.ts`**

```ts
/** Exactly-once product email: insert the claim BEFORE sending, keyed on the
 *  unique dedupeKey. Inverse of the old digest ordering, where the weekly
 *  claim burned before the send and an outage silently skipped the user. */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { emailConfigured, sendRawEmail } from '@/lib/email/send'

const MAX_ATTEMPTS = 3

export type LoggedEmailResult = 'sent' | 'duplicate' | 'failed' | 'unconfigured'

export async function sendLoggedEmail(input: {
  organizationId: string
  userId?: string | null
  emailKey: string
  dedupeKey: string
  to: string
  subject: string
  html: string
  replyTo?: string
}): Promise<LoggedEmailResult> {
  if (!emailConfigured()) return 'unconfigured'

  // Claim. A P2002 means a row exists: re-claim it only if it FAILED with
  // attempts to spare — otherwise it is handled (SENT, in-flight, or spent).
  let claimId: string
  try {
    const claim = await prisma.emailSend.create({
      data: {
        organizationId: input.organizationId, userId: input.userId ?? null,
        emailKey: input.emailKey, dedupeKey: input.dedupeKey,
        to: input.to, subject: input.subject,
      },
      select: { id: true },
    })
    claimId = claim.id
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error
    const retaken = await prisma.emailSend.updateMany({
      where: { dedupeKey: input.dedupeKey, status: 'FAILED', attempts: { lt: MAX_ATTEMPTS } },
      data: { status: 'PENDING', attempts: { increment: 1 } },
    })
    if (retaken.count === 0) return 'duplicate'
    const row = await prisma.emailSend.findUnique({
      where: { dedupeKey: input.dedupeKey }, select: { id: true },
    })
    if (!row) return 'duplicate'
    claimId = row.id
  }

  try {
    await sendRawEmail({ to: input.to, subject: input.subject, html: input.html, replyTo: input.replyTo })
    await prisma.emailSend.update({
      where: { id: claimId },
      data: { status: 'SENT', sentAt: new Date(), error: null },
    })
    return 'sent'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    apiLogger.warn('email: logged send failed', { emailKey: input.emailKey, dedupeKey: input.dedupeKey, error: message })
    await prisma.emailSend.update({
      where: { id: claimId },
      data: { status: 'FAILED', error: message.slice(0, 500) },
    }).catch(() => {})
    return 'failed'
  }
}
```

- [ ] **Step 4: Run the test**

Expected: PASS (all four tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/email/logged.ts src/lib/email/__tests__/logged.test.ts
git commit -m "feat(email): claim-before-send logged email with bounded FAILED re-claims"
```

---

### Task 4: Unsubscribe — signed link + route

**Files:**
- Create: `src/lib/email/unsubscribe.ts`, `src/app/api/email/unsubscribe/route.ts`
- Modify: `src/lib/env.ts` (document `EMAIL_LINK_SECRET`)
- Test: `src/lib/email/__tests__/unsubscribe.test.ts`, `src/app/api/__tests__/unsubscribe-route-e2e.test.ts`

**Interfaces:**
- Consumes: `User.marketingEmailsOptOut` (Task 1).
- Produces: `unsubscribeUrl(userId: string): string | null` (null when secret or `NEXT_PUBLIC_APP_URL` is missing — callers then SKIP the marketing send, fail-closed); `verifyUnsubscribeToken(userId: string, sig: string): boolean`. Route: `GET /api/email/unsubscribe?uid=<userId>&sig=<hmac>` — no login required.

- [ ] **Step 1: Write the failing helper test**

`src/lib/email/__tests__/unsubscribe.test.ts` (pure):

```ts
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

beforeEach(() => {
  process.env.EMAIL_LINK_SECRET = 'test-secret'
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example'
})

test('round-trips a valid signature and rejects tampering', async () => {
  const { unsubscribeUrl, verifyUnsubscribeToken } = await import('../unsubscribe')
  const url = unsubscribeUrl('user_1')
  assert.ok(url && url.startsWith('https://app.example/api/email/unsubscribe?uid=user_1&sig='))
  const sig = new URL(url!).searchParams.get('sig')!
  assert.equal(verifyUnsubscribeToken('user_1', sig), true)
  assert.equal(verifyUnsubscribeToken('user_2', sig), false)
  assert.equal(verifyUnsubscribeToken('user_1', 'bogus'), false)
})

test('returns null without a secret or app url (fail-closed)', async () => {
  const { unsubscribeUrl } = await import('../unsubscribe')
  delete process.env.EMAIL_LINK_SECRET
  delete process.env.CRON_SECRET
  assert.equal(unsubscribeUrl('user_1'), null)
  process.env.EMAIL_LINK_SECRET = 'test-secret'
  delete process.env.NEXT_PUBLIC_APP_URL
  assert.equal(unsubscribeUrl('user_1'), null)
})
```

- [ ] **Step 2: Run to verify failure** — cannot find module `../unsubscribe`.

- [ ] **Step 3: Implement `src/lib/email/unsubscribe.ts`**

```ts
/** Signed one-click unsubscribe for marketing email (CAN-SPAM). HMAC over the
 *  user id — no expiry: an unsubscribe link should work forever. Secret falls
 *  back to CRON_SECRET so one fewer env var is required in prod; with neither
 *  set, callers must SKIP marketing sends entirely (fail-closed compliance). */
import crypto from 'node:crypto'

function secret(): string | null {
  return process.env.EMAIL_LINK_SECRET || process.env.CRON_SECRET || null
}

function sign(userId: string, key: string): string {
  return crypto.createHmac('sha256', key).update(`email-unsubscribe:${userId}`).digest('base64url')
}

export function unsubscribeUrl(userId: string): string | null {
  const key = secret()
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!key || !appUrl) return null
  const base = appUrl.replace(/\/$/, '')
  return `${base}/api/email/unsubscribe?uid=${encodeURIComponent(userId)}&sig=${sign(userId, key)}`
}

export function verifyUnsubscribeToken(userId: string, sig: string): boolean {
  const key = secret()
  if (!key || !userId || !sig) return false
  const expected = sign(userId, key)
  const a = Buffer.from(expected)
  const b = Buffer.from(sig)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
```

- [ ] **Step 4: Run helper test** — PASS.

- [ ] **Step 5: Write the failing route test**

`src/app/api/__tests__/unsubscribe-route-e2e.test.ts` — DB-gated like Task 1; seed an org + user, build a URL with `unsubscribeUrl(user.id)`, call the route handler directly (`const { GET } = await import('@/app/api/email/unsubscribe/route')`; `await GET(new NextRequest(url))` — mirror however `contact-route.test.ts` constructs requests). Assertions:
- Valid link → 200, response body contains "unsubscribed", and the user row now has `marketingEmailsOptOut: true`.
- Tampered `sig` → 400 and the flag stays `false`.
- Unknown `uid` with a validly-signed sig for that uid → still 200 (idempotent, no user-existence oracle beyond the flag write's no-op).

- [ ] **Step 6: Run to verify failure** — route module missing.

- [ ] **Step 7: Implement `src/app/api/email/unsubscribe/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { verifyUnsubscribeToken } from '@/lib/email/unsubscribe'

export const dynamic = 'force-dynamic'

// Public by design: unsubscribe must work from any mail client with no
// session. The HMAC is the authorization; a bad signature changes nothing.
export async function GET(request: NextRequest) {
  const uid = request.nextUrl.searchParams.get('uid') || ''
  const sig = request.nextUrl.searchParams.get('sig') || ''
  const page = (title: string, body: string, status: number) =>
    new NextResponse(
      `<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;max-width:480px;margin:80px auto;padding:0 16px"><h1 style="font-size:20px">${title}</h1><p>${body}</p></body>`,
      { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    )
  if (!verifyUnsubscribeToken(uid, sig)) {
    return page('Invalid link', 'This unsubscribe link is not valid. You can manage email in Settings instead.', 400)
  }
  await prisma.user.updateMany({ where: { id: uid }, data: { marketingEmailsOptOut: true } })
  return page('You are unsubscribed', 'You will no longer receive marketing email from Sublime. Transactional email (billing, security) still sends.', 200)
}
```

- [ ] **Step 8: Run the route test** — PASS.

- [ ] **Step 9: Document `EMAIL_LINK_SECRET` in `src/lib/env.ts`** next to `CRON_SECRET`/`RESEND_API_KEY`, noting the `CRON_SECRET` fallback and that marketing email is skipped when neither is set.

- [ ] **Step 10: Commit**

```bash
git add src/lib/email/unsubscribe.ts src/app/api/email/unsubscribe/route.ts src/lib/email/__tests__/unsubscribe.test.ts src/app/api/__tests__/unsubscribe-route-e2e.test.ts src/lib/env.ts
git commit -m "feat(email): signed one-click unsubscribe route and marketing opt-out"
```

---

### Task 5: Activity signal — throttled `lastSeenAt` touch

**Files:**
- Modify: `src/lib/server/auth.ts` (inside `requireAuthContext`, after the auth context resolves successfully)
- Test: `src/lib/server/__tests__/last-seen.test.ts` (create `__tests__` dir if absent)

**Interfaces:**
- Consumes: `User.lastSeenAt` (exists in schema at `prisma/schema.prisma:95`, currently never written).
- Produces: `touchLastSeen(userId: string, now?: Date): void` (exported for tests; fire-and-forget, at most one write per 24h per user). Task 7's win-back sweep reads `lastSeenAt`.

- [ ] **Step 1: Write the failing DB-backed test**

`src/lib/server/__tests__/last-seen.test.ts` — DB-gated. Seed org + user with `lastSeenAt: null`; call `touchLastSeen(user.id, now)`; poll (the write is fire-and-forget — `await new Promise(r => setTimeout(r, 50))` then read) and assert `lastSeenAt` ≈ now. Then call again with `now + 1h` and assert the timestamp did NOT move (throttled). Then call with `now + 25h` and assert it DID move.

- [ ] **Step 2: Run to verify failure** — `touchLastSeen` not exported.

- [ ] **Step 3: Implement in `src/lib/server/auth.ts`**

```ts
const LAST_SEEN_THROTTLE_MS = 24 * 60 * 60 * 1000

/** Best-effort presence stamp powering the win-back sweep. updateMany with
 *  the staleness predicate makes the throttle atomic — concurrent requests
 *  race to one UPDATE and the losers match zero rows. Never awaited on the
 *  request path and never allowed to fail it. */
export function touchLastSeen(userId: string, now = new Date()): void {
  void prisma.user.updateMany({
    where: {
      id: userId,
      OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: new Date(now.getTime() - LAST_SEEN_THROTTLE_MS) } }],
    },
    data: { lastSeenAt: now },
  }).catch(() => {})
}
```

Call `touchLastSeen(context.dbUser.id)` in `requireAuthContext` immediately before its successful return (read the function first; place the call after the billing gate so locked-out orgs still count as "seen" is NOT wanted — actually place it BEFORE the billing 402 so a locked-out user visiting the plan picker still registers activity; that prevents win-back emails to people actively looking at the paywall).

- [ ] **Step 4: Run the test** — PASS.

- [ ] **Step 5: Run the wider auth-dependent suites to catch regressions**

Run: `TEST_DATABASE_URL=<url> TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/rbac-e2e.test.ts src/app/api/__tests__/route-permissions.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/auth.ts src/lib/server/__tests__/last-seen.test.ts
git commit -m "feat(auth): throttled lastSeenAt presence stamp"
```

---

### Task 6: Lifecycle templates (pure)

**Files:**
- Create: `src/lib/lifecycle/templates.ts`
- Test: `src/lib/lifecycle/__tests__/templates.test.ts`

**Interfaces:**
- Consumes: `wrapEmailHtml`, `escapeHtml` (Task 2).
- Produces (all pure, all return `{ subject: string; html: string }`):
  - `welcomeEmail(input: { name: string | null; appUrl: string | null }): { subject; html }`
  - `dripDay2Email(input: { appUrl: string | null; unsubscribeUrl: string | null })`
  - `dripDay5Email(input: { appUrl: string | null; unsubscribeUrl: string | null })`
  - `trialEndingEmail(input: { daysLeft: 3 | 1; trialEndsAt: Date; appUrl: string | null })`
  - `dunningEmail(input: { appUrl: string | null })`
  - `winbackInactiveEmail(input: { appUrl: string | null; unsubscribeUrl: string | null })`
  - `winbackCancelledEmail(input: { appUrl: string | null; unsubscribeUrl: string | null })`

- [ ] **Step 1: Write the failing test**

`src/lib/lifecycle/__tests__/templates.test.ts` (pure): for each template assert (a) a non-empty subject, (b) html contains its distinctive copy (`welcome` → "Welcome to Sublime"; `trialEndingEmail({daysLeft: 3, …})` → "3 days"; `dunningEmail` → "payment"), (c) CTA renders when `appUrl` is set and is absent when null, (d) marketing templates include "Unsubscribe" when `unsubscribeUrl` is provided and omit it when null, (e) `welcomeEmail` escapes a hostile name (`name: '<img src=x>'` must not appear unescaped).

- [ ] **Step 2: Run to verify failure** — module missing.

- [ ] **Step 3: Implement `src/lib/lifecycle/templates.ts`**

Each template composes `wrapEmailHtml`. Representative implementations (write all seven; copy tone: short, plain, one CTA):

```ts
import { wrapEmailHtml, escapeHtml } from '@/lib/email/layout'

const goalsCta = (appUrl: string | null, label: string) =>
  appUrl ? { label, url: `${appUrl.replace(/\/$/, '')}/goals` } : undefined
const billingCta = (appUrl: string | null, label: string) =>
  appUrl ? { label, url: `${appUrl.replace(/\/$/, '')}/settings?tab=billing` } : undefined

export function welcomeEmail(input: { name: string | null; appUrl: string | null }) {
  const first = input.name?.trim().split(/\s+/)[0]
  return {
    subject: 'Welcome to Sublime',
    html: wrapEmailHtml({
      heading: first ? `Welcome, ${first}` : 'Welcome to Sublime',
      bodyHtml:
        '<p>Sublime keeps your goals moving with agents that do real work. The fastest way to see it: set one goal and let the platform plan the work toward it.</p>' +
        '<p>Reply to this email any time — a human reads every message.</p>',
      cta: goalsCta(input.appUrl, 'Set your first goal'),
    }),
  }
}

export function trialEndingEmail(input: { daysLeft: 3 | 1; trialEndsAt: Date; appUrl: string | null }) {
  const when = input.trialEndsAt.toISOString().slice(0, 10)
  return {
    subject: input.daysLeft === 1 ? 'Your Sublime trial ends tomorrow' : `Your Sublime trial ends in ${input.daysLeft} days`,
    html: wrapEmailHtml({
      heading: `Your trial ends in ${input.daysLeft} ${input.daysLeft === 1 ? 'day' : 'days'}`,
      bodyHtml: `<p>Your free trial ends on ${escapeHtml(when)}. After that your card on file is charged and everything keeps running — nothing to do if you want to continue. To change plan or payment details, use billing settings.</p>`,
      cta: billingCta(input.appUrl, 'Review billing'),
    }),
  }
}

export function dunningEmail(input: { appUrl: string | null }) {
  return {
    subject: 'Action needed: your Sublime payment failed',
    html: wrapEmailHtml({
      heading: 'Your payment did not go through',
      bodyHtml:
        '<p>We could not collect your latest payment. We will retry automatically, but to avoid any interruption to your agents and flows, please update your payment method.</p>',
      cta: billingCta(input.appUrl, 'Fix payment method'),
    }),
  }
}
```

`dripDay2Email` (subject "Set your first goal in Sublime", body nudging goal creation, `unsubscribeUrl` passed through), `dripDay5Email` (subject "Connect a tool and let agents work", CTA to `/settings?tab=integrations` — verify that tab id by grepping `settings/tabs/` and use the actual integrations route the app uses), `winbackInactiveEmail` (subject "Anything we can help with?"), `winbackCancelledEmail` (subject "We'd love to have you back") — same shape.

- [ ] **Step 4: Run the test** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/lifecycle/templates.ts src/lib/lifecycle/__tests__/templates.test.ts
git commit -m "feat(lifecycle): pure email templates for all sequences"
```

---

### Task 7: Lifecycle sweep + cron wiring

**Files:**
- Create: `src/lib/lifecycle/emails.ts`
- Modify: `src/app/api/cron/dispatch/route.ts` (add one sweep block next to the digest block at ~line 569)
- Test: `src/lib/lifecycle/__tests__/sweep-e2e.test.ts`

**Interfaces:**
- Consumes: `sendLoggedEmail` (Task 3), templates (Task 6), `unsubscribeUrl` (Task 4), `User.lastSeenAt` (Task 5), `mapWithConcurrency` + `globalSweepsAllowed` + `afterResponse` (existing dispatch helpers — import paths visible at the top of `src/app/api/cron/dispatch/route.ts`).
- Produces: `shouldRunLifecycleSweep(now: Date): boolean` (daily, 15:00–15:15 UTC); `runLifecycleSweep(now?: Date): Promise<{ sent: number; skipped: number; failed: number }>`.

**Sweep rules (all queries bounded with `take: 500`, org-created-within-90-days guard on drip so shipping this feature does not blast old workspaces; every send goes through `sendLoggedEmail` so re-runs are no-ops):**

| emailKey | Audience query | Recipient | dedupeKey |
|---|---|---|---|
| `drip-day2` | orgs `createdAt <= now-2d AND createdAt >= now-90d` AND `goals: { none: {} }` | each ADMIN user, `marketingEmailsOptOut: false` | `drip-day2:${user.id}` |
| `drip-day5` | orgs `createdAt <= now-5d AND createdAt >= now-90d` AND `integrations: { none: {} }` AND `nangoConnections: { none: {} }` | same | `drip-day5:${user.id}` |
| `trial-3d` | orgs `trialEndsAt != null AND trialEndsAt > now AND trialEndsAt <= now+3d AND firstPaidAt: null` | each ADMIN user (transactional — no opt-out filter) | `trial-3d:${org.id}:${user.id}` |
| `trial-1d` | same with `now+1d` | same | `trial-1d:${org.id}:${user.id}` |
| `winback-inactive` | orgs `firstPaidAt != null AND plan != 'TRIAL'` AND `users: { some: { lastSeenAt: { lt: now-14d } }, none: { lastSeenAt: { gte: now-14d } } }` | each ADMIN, opt-out filtered | `winback-inactive:${org.id}:${user.id}` (once ever) |
| `winback-cancelled` | orgs `plan: 'TRIAL' AND firstPaidAt != null AND stripeSubscriptionId: null AND updatedAt <= now-7d` | each ADMIN, opt-out filtered | `winback-cancelled:${org.id}:${user.id}` (once ever) |

Note the trial rows use per-user keys uniformly: `trial-3d:${org.id}:${user.id}`.
Marketing sends where `unsubscribeUrl(user.id)` returns `null` are **skipped** with one `apiLogger.warn` per sweep (fail-closed, per spec).
`winback-cancelled`'s `updatedAt` heuristic is deliberate: there is no `canceledAt` column, sends are once-ever, so timing precision does not matter — say so in a code comment.

- [ ] **Step 1: Write the failing DB-backed test**

`src/lib/lifecycle/__tests__/sweep-e2e.test.ts` — DB-gated; stub `globalThis.fetch` as in Task 3; set `RESEND_API_KEY`, `EMAIL_LINK_SECRET`, `NEXT_PUBLIC_APP_URL`. Seed helper creates an org (+ ADMIN user with email) with overridable `createdAt` (Prisma allows explicit `createdAt` on create). Tests, each with a fixed `now = new Date('2026-08-01T15:05:00Z')`:

1. `shouldRunLifecycleSweep` true only in the 15:00–15:15 UTC window.
2. Org aged 3 days with zero goals → one `drip-day2` SENT row for the admin; org aged 1 day → nothing; org aged 3 days **with** a goal → nothing; running the sweep twice → still exactly one row.
3. Admin with `marketingEmailsOptOut: true` → no drip row.
4. Org with `trialEndsAt = now+2d`, `firstPaidAt: null` → `trial-3d` sent; same org next day (`now+1d` run, trialEndsAt now within 1d) → `trial-1d` sent, `trial-3d` not duplicated.
5. Paid org whose only user has `lastSeenAt = now-20d` → `winback-inactive` sent once; second run → duplicate.
6. Org `plan: 'TRIAL', firstPaidAt: now-30d, stripeSubscriptionId: null, updatedAt` older than 7d (set via raw `UPDATE organizations SET "updatedAt" = …` since Prisma auto-bumps it) → `winback-cancelled` sent.
7. With `EMAIL_LINK_SECRET`/`CRON_SECRET` both unset → drip/winback skipped (0 rows), trial rows still send.

- [ ] **Step 2: Run to verify failure** — module missing.

- [ ] **Step 3: Implement `src/lib/lifecycle/emails.ts`**

Skeleton (fill every sequence following it; per-org try/catch; count results):

```ts
import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { sendLoggedEmail } from '@/lib/email/logged'
import { unsubscribeUrl } from '@/lib/email/unsubscribe'
import * as templates from '@/lib/lifecycle/templates'

const DAY_MS = 24 * 60 * 60 * 1000
const SWEEP_TAKE = 500

export function shouldRunLifecycleSweep(now: Date): boolean {
  return now.getUTCHours() === 15 && now.getUTCMinutes() < 15
}

type Tally = { sent: number; skipped: number; failed: number }

export async function runLifecycleSweep(now = new Date()): Promise<Tally> {
  const tally: Tally = { sent: 0, skipped: 0, failed: 0 }
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || null
  // systemPrisma: cross-tenant sweep, CRON_SECRET-gated at the route (same
  // contract as the goal digest).
  await dripSweep(tally, now, appUrl)
  await trialSweep(tally, now, appUrl)
  await winbackSweep(tally, now, appUrl)
  return tally
}

function record(tally: Tally, result: string): void {
  if (result === 'sent') tally.sent += 1
  else if (result === 'failed') tally.failed += 1
  else tally.skipped += 1
}

async function adminsOf(organizationId: string, marketingOnly: boolean) {
  return systemPrisma.user.findMany({
    where: {
      organizationId, role: 'ADMIN', isActive: true, email: { not: null },
      ...(marketingOnly ? { marketingEmailsOptOut: false } : {}),
    },
    select: { id: true, email: true, name: true },
    take: 20,
  })
}
```

Then one function per sweep. Drip example (repeat the shape for the others per the rules table):

```ts
async function dripSweep(tally: Tally, now: Date, appUrl: string | null): Promise<void> {
  const steps = [
    { key: 'drip-day2' as const, minAgeDays: 2, where: { goals: { none: {} } }, template: templates.dripDay2Email },
    { key: 'drip-day5' as const, minAgeDays: 5, where: { integrations: { none: {} }, nangoConnections: { none: {} } }, template: templates.dripDay5Email },
  ]
  for (const step of steps) {
    try {
      const orgs = await systemPrisma.organization.findMany({
        where: {
          createdAt: { lte: new Date(now.getTime() - step.minAgeDays * DAY_MS), gte: new Date(now.getTime() - 90 * DAY_MS) },
          ...step.where,
        },
        select: { id: true },
        take: SWEEP_TAKE,
      })
      for (const org of orgs) {
        try {
          for (const admin of await adminsOf(org.id, true)) {
            const unsub = unsubscribeUrl(admin.id)
            if (!unsub) { tally.skipped += 1; continue } // fail-closed: no unsubscribe link, no marketing email
            const content = step.template({ appUrl, unsubscribeUrl: unsub })
            record(tally, await sendLoggedEmail({
              organizationId: org.id, userId: admin.id, emailKey: step.key,
              dedupeKey: `${step.key}:${admin.id}`, to: admin.email!,
              subject: content.subject, html: content.html,
            }))
          }
        } catch (error) {
          apiLogger.warn('lifecycle: org sweep failed', { organizationId: org.id, step: step.key, error: error instanceof Error ? error.message : String(error) })
        }
      }
    } catch (error) {
      apiLogger.warn('lifecycle: step scan failed', { step: step.key, error: error instanceof Error ? error.message : String(error) })
    }
  }
}
```

`trialSweep`: query orgs per the table (3d then 1d), recipients `adminsOf(org.id, false)`, template `trialEndingEmail({ daysLeft, trialEndsAt: org.trialEndsAt!, appUrl })`, keys `trial-3d:${org.id}:${admin.id}` / `trial-1d:${org.id}:${admin.id}`.
`winbackSweep`: per the table, marketing-filtered, unsubscribe-gated like drip, templates `winbackInactiveEmail`/`winbackCancelledEmail`, once-ever keys.

- [ ] **Step 4: Run the sweep test** — PASS.

- [ ] **Step 5: Wire into cron dispatch**

In `src/app/api/cron/dispatch/route.ts`, add after the digest block (ends line 569), same shape:

```ts
    // Daily lifecycle email sweep (drip, trial-ending, win-back). Every send
    // claim-logs into email_sends first, so a retried tick cannot double-send.
    {
      const lifecycle = await import('@/lib/lifecycle/emails')
      if (globalSweepsAllowed() && lifecycle.shouldRunLifecycleSweep(now)) {
        afterResponse(() => lifecycle.runLifecycleSweep(now))
      }
    }
```

- [ ] **Step 6: Type-check and run dispatch-adjacent tests**

Run: `npx tsc --noEmit` (scoped check: `npx tsc --noEmit -p tsconfig.json`)
Expected: clean. There is no dispatch route test to run; the sweep itself is covered by Step 4.

- [ ] **Step 7: Commit**

```bash
git add src/lib/lifecycle/emails.ts src/lib/lifecycle/__tests__/sweep-e2e.test.ts src/app/api/cron/dispatch/route.ts
git commit -m "feat(lifecycle): daily state-swept drip, trial-ending, and win-back emails"
```

---

### Task 8: Welcome email on new-workspace provisioning

**Files:**
- Modify: `src/lib/supabase/auth-utils.ts` (`provisionUser`, transaction at ~lines 105-137)
- Test: `src/lib/supabase/__tests__/welcome-email-e2e.test.ts` (follow the directory's existing test location convention — grep for `auth-utils` tests first and co-locate)

**Interfaces:**
- Consumes: `sendLoggedEmail` (Task 3), `welcomeEmail` template (Task 6), `afterResponse` (`@/lib/server/after-response`).
- Produces: no new exports — behavior only: exactly one welcome email per freshly-created organization; never for invite-joins, identity links, or re-provisions.

- [ ] **Step 1: Write the failing DB-backed test**

DB-gated; stub `globalThis.fetch`; set `RESEND_API_KEY`. Build the minimal Supabase `User`-shaped object `provisionUser` consumes (`{ id: crypto.randomUUID(), email, user_metadata: { full_name: 'Ada L' }, app_metadata: {} }` — read the function's usage first and match). Tests:
1. Fresh signup (no invitation) → after `provisionUser` resolves, poll up to 500ms for an `EmailSend` row `emailKey: 'welcome', dedupeKey: 'welcome:<orgId>'` with status SENT.
2. Signup matching a pending `OrganizationInvitation` → no welcome row (they joined an existing workspace).
3. Calling `provisionUser` again for the same user → still exactly one row.

- [ ] **Step 2: Run to verify failure** — no `EmailSend` row appears.

- [ ] **Step 3: Implement**

In `provisionUser`, the transaction currently returns `member`. Change the callback to also flag creation, then fire after the transaction commits (never inside it — an email must not send for a rolled-back org):

```ts
      // …inside the tx callback, replace `return member` with:
      return { member, freshOrgId: invitation ? null : organization.id }
```

Adjust the surrounding code (the `try` returns, the catch-path winner re-read) so `provisionUser`'s public return type is unchanged (`member`). After a successful commit with `freshOrgId`:

```ts
    if (result.freshOrgId && result.member.email) {
      const { afterResponse } = await import('@/lib/server/after-response')
      afterResponse(async () => {
        const [{ sendLoggedEmail }, { welcomeEmail }] = await Promise.all([
          import('@/lib/email/logged'),
          import('@/lib/lifecycle/templates'),
        ])
        const content = welcomeEmail({ name: result.member.name, appUrl: process.env.NEXT_PUBLIC_APP_URL || null })
        await sendLoggedEmail({
          organizationId: result.freshOrgId!, userId: result.member.id, emailKey: 'welcome',
          dedupeKey: `welcome:${result.freshOrgId}`, to: result.member.email!,
          subject: content.subject, html: content.html,
        })
      })
    }
    return result.member
```

(Dynamic imports keep the auth hot path free of email modules; the `welcome:<orgId>` dedupe makes even a concurrent double-provision single-send.)

- [ ] **Step 4: Run the new test** — PASS.

- [ ] **Step 5: Run the auth regression suites**

Run: `TEST_DATABASE_URL=<url> TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/rbac-e2e.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/supabase/auth-utils.ts src/lib/supabase/__tests__/welcome-email-e2e.test.ts
git commit -m "feat(lifecycle): welcome email on fresh workspace creation"
```

---

### Task 9: Dunning — `invoice.payment_failed` webhook + docs

**Files:**
- Modify: `src/app/api/stripe/webhook/route.ts`, `docs/stripe-setup.md`
- Create: `src/lib/lifecycle/dunning.ts`
- Test: `src/lib/lifecycle/__tests__/dunning-e2e.test.ts`

**Interfaces:**
- Consumes: `sendLoggedEmail` (Task 3), `dunningEmail` (Task 6).
- Produces: `sendDunningEmails(invoice: { id: string | null; customer: string | { id: string } | null; amount_due?: number | null }): Promise<void>` — resolves the org by `stripeCustomerId`, emails every ADMIN, dedupe `dunning:<invoiceId>:<userId>`.

- [ ] **Step 1: Write the failing DB-backed test**

`src/lib/lifecycle/__tests__/dunning-e2e.test.ts` — DB-gated, fetch stubbed. Seed org with `stripeCustomerId: 'cus_<uuid>'`, `firstPaidAt` set, one ADMIN with email. Tests:
1. `sendDunningEmails({ id: 'in_1', customer: 'cus_…' })` → one SENT row `emailKey: 'dunning'`.
2. Second call with the same invoice id → no new row, no second fetch.
3. Unknown customer → resolves without throwing, zero rows.
4. `customer: null` or `id: null` → no-op.

- [ ] **Step 2: Run to verify failure** — module missing.

- [ ] **Step 3: Implement `src/lib/lifecycle/dunning.ts`**

```ts
/** Dunning notice on invoice.payment_failed. Transactional: ignores the
 *  marketing opt-out. Deduped per invoice+recipient, so Stripe webhook
 *  retries and multiple failure events for one invoice send once. */
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { sendLoggedEmail } from '@/lib/email/logged'
import { dunningEmail } from '@/lib/lifecycle/templates'

export async function sendDunningEmails(invoice: {
  id?: string | null
  customer?: string | { id: string } | null
}): Promise<void> {
  const invoiceId = invoice.id ?? null
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null
  if (!invoiceId || !customerId) return
  const organization = await prisma.organization.findUnique({
    where: { stripeCustomerId: customerId }, select: { id: true },
  })
  if (!organization) return
  const admins = await prisma.user.findMany({
    where: { organizationId: organization.id, role: 'ADMIN', isActive: true, email: { not: null } },
    select: { id: true, email: true },
    take: 20,
  })
  const content = dunningEmail({ appUrl: process.env.NEXT_PUBLIC_APP_URL || null })
  for (const admin of admins) {
    const result = await sendLoggedEmail({
      organizationId: organization.id, userId: admin.id, emailKey: 'dunning',
      dedupeKey: `dunning:${invoiceId}:${admin.id}`, to: admin.email!,
      subject: content.subject, html: content.html,
    })
    if (result === 'failed') apiLogger.warn('dunning: send failed', { organizationId: organization.id, invoiceId })
  }
}
```

- [ ] **Step 4: Run the test** — PASS.

- [ ] **Step 5: Handle the event in the webhook**

In `src/app/api/stripe/webhook/route.ts`, add a case after `invoice.payment_succeeded` (line 74-77):

```ts
    // A failed collection: notify admins with a fix-payment link. Access is
    // NOT revoked here — subscription-status rules (past_due + firstPaidAt)
    // decide access; this is purely the human-notification leg.
    case 'invoice.payment_failed': {
      const { sendDunningEmails } = await import('@/lib/lifecycle/dunning')
      await sendDunningEmails(event.data.object)
      break
    }
```

- [ ] **Step 6: Update `docs/stripe-setup.md`**

- Add `invoice.payment_failed` to the webhook endpoint's event list (the doc lists 4 events today — make it 5).
- Add a short "Dunning" subsection: enable **Smart Retries** (Stripe Dashboard → Settings → Billing → Revenue recovery) so Stripe retries the card automatically; the app emails admins on each failed invoice, once per invoice.

- [ ] **Step 7: Run the stripe route tests**

Run: `TEST_DATABASE_URL=<url> TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/stripe-routes-e2e.test.ts src/lib/billing/__tests__/sync-subscription-e2e.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/lifecycle/dunning.ts src/lib/lifecycle/__tests__/dunning-e2e.test.ts src/app/api/stripe/webhook/route.ts docs/stripe-setup.md
git commit -m "feat(billing): dunning email on invoice.payment_failed"
```

---

### Task 10: Digest hardening — claim-then-send via `EmailSend`, opt-out

**Files:**
- Modify: `src/lib/goals/digest.ts`
- Test: extend/adjust the digest's existing coverage — grep `src/lib/goals/__tests__/` for a digest test first; if none exists, create `src/lib/goals/__tests__/digest-claim-e2e.test.ts`

**Interfaces:**
- Consumes: `sendLoggedEmail` (Task 3), `unsubscribeUrl` (Task 4), `wrapEmailHtml` (Task 2).
- Produces: no signature changes — `sendWeeklyGoalDigests(now)` keeps its `{ users: number; sent: number }` return. The `users.metadata.lastGoalDigestAt` claim is replaced by an `EmailSend` claim keyed `goal-digest:${userId}:${YYYY-MM-DD}` (the Monday's date — the sweep only fires Mondays, so the date IS the week identifier).

- [ ] **Step 1: Write the failing test**

DB-gated, fetch stubbed. Seed org + user + one active org-visible goal (mirror whatever minimal goal shape `sendWeeklyGoalDigests` queries — copy seed shape from an existing goals e2e test such as `src/app/api/__tests__/goal-lens-e2e.test.ts`). Tests with `now = new Date('2026-08-03T14:05:00Z')` (a Monday):
1. First run → 1 email row `goal-digest:<userId>:2026-08-03`, SENT; in-app notification still created.
2. Second run same `now` → no duplicate.
3. Transport failure on first run → row FAILED; re-run (same window) → SENT with attempts 2. **This is the bug fix** — old code burned the metadata claim before sending.
4. User with `marketingEmailsOptOut: true` → in-app notification still sent, no email row.

- [ ] **Step 2: Run to verify failure** — currently the claim is metadata-based; test 3 fails (no retry) and test 4 fails (email sent despite opt-out).

- [ ] **Step 3: Implement in `src/lib/goals/digest.ts`**

- Delete `claimDigest` and the metadata write.
- In the recipient loop, replace the `claimDigest` check + `sendEmail` block: keep `notify(...)` unconditional (in-app is not email); then, when `user.email && !user.marketingEmailsOptOut` (add `marketingEmailsOptOut: true` to the recipient `select`):

```ts
          const content = formatGoalDigest(digestGoals, appUrl)
          // …notify(...) unchanged…
          if (user.email && !user.marketingEmailsOptOut) {
            const { sendLoggedEmail } = await import('@/lib/email/logged')
            const { unsubscribeUrl } = await import('@/lib/email/unsubscribe')
            const unsub = unsubscribeUrl(user.id)
            if (unsub) {
              const result = await sendLoggedEmail({
                organizationId, userId: user.id, emailKey: 'goal-digest',
                dedupeKey: `goal-digest:${user.id}:${now.toISOString().slice(0, 10)}`,
                to: user.email, subject: 'Your goals this week',
                html: content.html + `<p style="font-size:12px;color:#888"><a href="${unsub}" style="color:#888">Unsubscribe</a></p>`,
              })
              if (result === 'sent') users += 1
            }
          }
```

- Rework the `users`/`sent` tallies so the return keeps meaning "users emailed / notifications sent" (adjust to match the existing semantics you observe in the code; the dispatch route ignores the return, so exact naming is low-stakes — keep it truthful).
- Update the load-bearing comment at `src/app/api/cron/dispatch/route.ts:564-566` — the ordering hazard it describes is now fixed (claim is retry-safe).

- [ ] **Step 4: Run the digest test** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/goals/digest.ts src/lib/goals/__tests__/digest-claim-e2e.test.ts src/app/api/cron/dispatch/route.ts
git commit -m "fix(digest): retry-safe claim-then-send via EmailSend; respect marketing opt-out"
```

---

### Task 11: Feedback API — `POST /api/feedback`

**Files:**
- Create: `src/app/api/feedback/route.ts`
- Test: `src/app/api/__tests__/feedback-route-e2e.test.ts`

**Interfaces:**
- Consumes: `withAuthenticatedApi` + `ApiError` (`@/lib/server/api-handler` — same usage as `src/app/api/intelligence/user-suggestions/route.ts`), `rateLimit` (`@/lib/ratelimit`), `sendLoggedEmail` (Task 3), `contactInbox` (Task 2), `FeedbackSubmission` model (Task 1), `capabilitiesForPlan`/`entitlementPlanFor` enrichment (same imports as the contact route).
- Produces: `POST /api/feedback` accepting `{ category: 'COMPLAINT'|'IDEA'|'QUESTION'|'OTHER', message: string (1..5000), path?: string (≤300) }` → `{ success: true, id: string }`. Task 12's dialog calls this.

- [ ] **Step 1: Write the failing route test**

`src/app/api/__tests__/feedback-route-e2e.test.ts` — DB-gated, fetch stubbed; seed org + user and authenticate the way the repo's authenticated route e2e tests do (copy the session/auth seeding helper usage from `src/app/api/__tests__/rbac-e2e.test.ts` — read it first and reuse its helpers rather than inventing new ones). Tests:
1. Valid submission → 200, `FeedbackSubmission` row persisted with category/message/path and the caller's org+user ids, and an `EmailSend` row `emailKey: 'feedback'` addressed to the contact inbox with `replyTo` = submitter email.
2. Transport failure → still 200 and the row persists; the `EmailSend` row is FAILED (forwarding is best-effort, persistence is the record).
3. `message` empty or >5000 chars → 400, nothing persisted.
4. Unauthenticated → 401 (whatever status `withAuthenticatedApi` returns for no session — assert the code the harness shows).
5. 6th call inside a minute for one user → 429.

- [ ] **Step 2: Run to verify failure** — route missing.

- [ ] **Step 3: Implement `src/app/api/feedback/route.ts`**

```ts
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { rateLimit } from '@/lib/ratelimit'
import { contactInbox } from '@/lib/email/send'
import { sendLoggedEmail } from '@/lib/email/logged'
import { escapeHtml } from '@/lib/email/layout'
import { capabilitiesForPlan } from '@/lib/billing/capabilities'
import { entitlementPlanFor } from '@/lib/billing/entitlements'
import { afterResponse } from '@/lib/server/after-response'

export const runtime = 'nodejs'

const feedbackSchema = z.object({
  category: z.enum(['COMPLAINT', 'IDEA', 'QUESTION', 'OTHER']),
  message: z.string().trim().min(1).max(5000),
  path: z.string().trim().max(300).optional(),
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const limited = await rateLimit(`feedback:${auth.dbUser.id}`, { limit: 5, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError(429, 'Too many submissions — please wait a minute.')

  const parsed = feedbackSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw new ApiError(400, 'Please choose a category and write a message.')
  const { category, message, path } = parsed.data

  // Persist FIRST — the row is the record; the email forward is best-effort.
  const submission = await prisma.feedbackSubmission.create({
    data: {
      organizationId: auth.organizationId, userId: auth.dbUser.id,
      category, message, path: path || null,
    },
  })

  const plan = auth.dbUser.organization ? entitlementPlanFor(auth.dbUser.organization) : null
  const support = plan ? capabilitiesForPlan(plan).support : 'resources'
  const from = auth.dbUser.email || 'unknown'
  afterResponse(() => sendLoggedEmail({
    organizationId: auth.organizationId, userId: auth.dbUser.id,
    emailKey: 'feedback', dedupeKey: `feedback:${submission.id}`,
    to: contactInbox(), replyTo: auth.dbUser.email || undefined,
    subject: `[${category === 'COMPLAINT' ? 'Complaint' : 'Feedback'}] ${support} — ${from}`,
    html: [
      `<p><strong>Category:</strong> ${category}</p>`,
      `<p><strong>From:</strong> ${escapeHtml(from)} (user ${auth.dbUser.id}, workspace ${auth.organizationId}${plan ? `, plan ${plan}` : ''})</p>`,
      path ? `<p><strong>Page:</strong> ${escapeHtml(path)}</p>` : '',
      `<p style="white-space:pre-wrap">${escapeHtml(message)}</p>`,
    ].join(''),
  }))

  return { success: true, id: submission.id }
}, { requires: 'member' })
```

(Verify `auth.dbUser.organization` is present on the auth context — grep how the contact route/other routes obtain the org row; if the context lacks it, fetch the org by `auth.organizationId` for the plan enrichment.)

- [ ] **Step 4: Run the test** — PASS.

- [ ] **Step 5: Run route-permission coverage**

Run: `TEST_DATABASE_URL=<url> TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/app/api/__tests__/route-permissions.test.ts src/app/api/__tests__/mutation-coverage.test.ts`
Expected: PASS — if either enumerates routes and flags the new one, add `/api/feedback` to its expectations following the pattern used for other member-level POST routes.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/feedback/route.ts src/app/api/__tests__/feedback-route-e2e.test.ts
git commit -m "feat(feedback): authenticated feedback API — persist first, forward to inbox"
```

---

### Task 12: Feedback UI — dialog + sidebar entry

**Files:**
- Create: `src/components/feedback/feedback-dialog.tsx`
- Modify: `src/components/layout/sidebar.tsx` (both chrome spots that render `NotificationBell` — lines ~516 and ~606)
- Test: `src/components/feedback/__tests__/feedback-dialog.test.tsx`

**Interfaces:**
- Consumes: `POST /api/feedback` (Task 11); the repo's existing dialog/button/select primitives — open `src/components/integrations/connect-integration-dialog.tsx` and `src/components/billing/plan-picker.tsx` first and reuse the same `@/components/ui/*` imports and toast mechanism found there.
- Produces: `<FeedbackDialog open onOpenChange />` and a `MessageSquarePlus`-icon trigger button in the sidebar chrome.

- [ ] **Step 1: Write the failing component test**

`src/components/feedback/__tests__/feedback-dialog.test.tsx` — copy the rendering harness from `src/components/billing/__tests__/plan-picker.test.tsx` (same libraries, same jsdom/setup conventions — read it first; follow whatever it does for DOM setup). Tests:
1. Renders the four category options and a message textarea.
2. Submit with an empty message keeps the dialog open and does not call fetch.
3. Successful submit (`fetch` stubbed → `{ success: true, id: 'x' }`) POSTs to `/api/feedback` with `{ category, message, path }` (path from `usePathname` — mock `next/navigation` the way existing component tests do) and closes/thanks.
4. Server 429 shows the error message and keeps the input.

- [ ] **Step 2: Run to verify failure** — module missing.

- [ ] **Step 3: Implement `src/components/feedback/feedback-dialog.tsx`**

Client component. Shape (adapt primitives to what the reused components actually import):

```tsx
'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
// Reuse the exact dialog/button/textarea/select primitives used by
// connect-integration-dialog.tsx — same imports, same styling idioms.

const CATEGORIES = [
  { value: 'COMPLAINT', label: 'Something went wrong' },
  { value: 'IDEA', label: 'Idea or request' },
  { value: 'QUESTION', label: 'Question' },
  { value: 'OTHER', label: 'Other' },
] as const

export function FeedbackDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const pathname = usePathname()
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]['value']>('COMPLAINT')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  async function submit() {
    if (!message.trim() || busy) return
    setBusy(true); setError(null)
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, message: message.trim(), path: pathname || undefined }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.success) throw new Error(data?.error || 'Could not send feedback — please try again.')
      setSent(true); setMessage('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send feedback — please try again.')
    } finally {
      setBusy(false)
    }
  }
  // Render: dialog titled "Send feedback"; category segmented control/select;
  // textarea; submit button (disabled when empty/busy); `sent` state swaps the
  // form for "Thanks — we read every message." with a Close button; `error`
  // renders inline above the submit.
}
```

- [ ] **Step 4: Run the component test** — PASS.

- [ ] **Step 5: Add the sidebar trigger**

In `src/components/layout/sidebar.tsx`, next to each `<NotificationBell …/>` (lines ~516 and ~606): an icon button (`MessageSquarePlus` from `lucide-react`, matching the bell's `buttonClassName` styling) with `aria-label="Send feedback"` and tooltip "Send feedback", toggling local `feedbackOpen` state; render `<FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />` once at the component root. If the two bell sites live in different components within the file, hoist the state to their shared parent.

- [ ] **Step 6: Build check**

Run: `npx tsc --noEmit && npm run lint --silent 2>/dev/null || npx next lint --dir src/components/feedback`
Expected: clean. Then `npm run build` if the session's verification protocol calls for it (see the `verify` skill — no Supabase env locally; build + route smoke is the standard).

- [ ] **Step 7: Commit**

```bash
git add src/components/feedback/feedback-dialog.tsx src/components/feedback/__tests__/feedback-dialog.test.tsx src/components/layout/sidebar.tsx
git commit -m "feat(feedback): in-app feedback dialog in the sidebar chrome"
```

---

### Task 13: Full verification pass

**Files:** none new.

- [ ] **Step 1: Run the entire suite against the migrated test DB**

Run: `TEST_DATABASE_URL=<url> npm test`
Expected: PASS. (Remember the QA-DB gotcha: `prisma migrate deploy` against the test DB BEFORE trusting failures.)

- [ ] **Step 2: Production build**

Run: `npm run build`
Expected: succeeds with no email env vars set (call-time env reads).

- [ ] **Step 3: Update ops docs**

Add to the deploy notes (`docs/runbooks/deploy.md`) a short "Lifecycle email" checklist: `RESEND_API_KEY`, `EMAIL_FROM` (real verified domain — not `onboarding@resend.dev`), `CONTACT_INBOX`, optional `EMAIL_LINK_SECRET` (falls back to `CRON_SECRET`), Stripe: `invoice.payment_failed` event added + Smart Retries enabled.

- [ ] **Step 4: Commit docs and any fixups**

```bash
git add docs/runbooks/deploy.md
git commit -m "docs(deploy): lifecycle email + dunning environment checklist"
```
