# Trial-Lapse Enforcement Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make trial-lapse lockout survive missed Stripe webhooks, extend it to background execution, and stop offering a trial to orgs that already used theirs.

**Architecture:** `billingStateFor()` stays the single access rule and gains a defensive time-based branch; a daily cron reconciles `plan` against Stripe; a new `assertOrganizationBillingActive()` gate is called at the two execution choke points (`runAgentExecution`, `dispatchFlowExecution`) plus the trigger routes and cron pre-filter; `BillingAccess` threads `trialUsed` into the paywall copy.

**Tech Stack:** Next.js App Router, Prisma, Stripe SDK, node:test + tsx.

**Spec:** `docs/superpowers/specs/2026-07-31-trial-lapse-enforcement-design.md`

## Global Constraints

- Grace window: `TRIAL_LAPSE_GRACE_MS = 24 * 60 * 60 * 1000` (24h), exported from `src/lib/billing/trial.ts`.
- 402 message text (match `src/lib/server/auth.ts:76` exactly): `'Choose a paid plan to start using Sublime. You can cancel anytime.'`, code `'PAYMENT_REQUIRED'`.
- Grandfathered orgs are never restricted — every new denial path must check `isGrandfatheredOrganization` first (via `billingStateFor`).
- Tests: `npm test` (node:test via tsx). DB-backed tests live in `TEST_DATABASE_URL`-gated suites (see `src/app/api/__tests__/rbac-e2e.test.ts`).
- `systemPrisma` usage requires a `// systemPrisma:` justification comment (repo convention).
- Commit after each task; commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Defensive lapse rule in `billingStateFor`

**Files:**
- Modify: `src/lib/billing/trial.ts`
- Test: `src/lib/billing/__tests__/trial.test.ts`

**Interfaces:**
- Produces: `billingStateFor(org: BillingFields, now?: Date)` where `BillingFields` now REQUIRES `firstPaidAt: Date | null`; exported `TRIAL_LAPSE_GRACE_MS: number`. All later tasks and existing callers (`src/lib/server/auth.ts:75`, `src/lib/billing/access.ts:40`, `src/app/api/billing/status/route.ts:23`) pass full Prisma org rows, which already carry `firstPaidAt` — only test fixtures need updating.

- [ ] **Step 1: Write the failing tests** — append to `src/lib/billing/__tests__/trial.test.ts`, and add `firstPaidAt: null` to the four existing `billingStateFor` fixtures (line 7-51):

```ts
const AFTER_LAUNCH = new Date('2026-07-20T00:00:00.000Z')
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000)

test('a lapsed trial with no payment is denied even if the webhook never downgraded the plan', () => {
  const billing = billingStateFor(
    { plan: Plan.PROFESSIONAL, trialEndsAt: hoursAgo(72), firstPaidAt: null, createdAt: AFTER_LAUNCH },
    NOW,
  )
  assert.equal(billing.state, 'payment_required')
})

test('a lapsed trial that converted (payment collected) keeps access', () => {
  const billing = billingStateFor(
    { plan: Plan.PROFESSIONAL, trialEndsAt: hoursAgo(72), firstPaidAt: hoursAgo(70), createdAt: AFTER_LAUNCH },
    NOW,
  )
  assert.equal(billing.state, 'paid')
})

test('a trial that ended within the 24h grace window keeps access while webhooks settle', () => {
  const billing = billingStateFor(
    { plan: Plan.PROFESSIONAL, trialEndsAt: hoursAgo(1), firstPaidAt: null, createdAt: AFTER_LAUNCH },
    NOW,
  )
  assert.equal(billing.state, 'paid')
})

test('an in-flight trial keeps access', () => {
  const billing = billingStateFor(
    { plan: Plan.PROFESSIONAL, trialEndsAt: hoursAgo(-24 * 7), firstPaidAt: null, createdAt: AFTER_LAUNCH },
    NOW,
  )
  assert.equal(billing.state, 'paid')
})

test('grandfathered workspaces are never lapse-denied', () => {
  const billing = billingStateFor(
    { plan: Plan.TRIAL, trialEndsAt: hoursAgo(72), firstPaidAt: null, createdAt: AFTER_LAUNCH, grandfatheredAt: new Date() },
    NOW,
  )
  assert.equal(billing.state, 'paid')
})
```

Note: `NOW` already exists at line 54 of the test file; move it (and `daysFromNow`) above the new tests.

- [ ] **Step 2: Run to verify failure** — `npm test -- src/lib/billing/__tests__/trial.test.ts` (or the repo's glob equivalent: `npx tsx --test src/lib/billing/__tests__/trial.test.ts`). Expected: TS error (missing `firstPaidAt` in `BillingFields`) / new tests FAIL.

- [ ] **Step 3: Implement** — in `src/lib/billing/trial.ts`: add `firstPaidAt: Date | null` to `BillingFields`; add the constant and branch:

```ts
/**
 * Webhook lag allowance. A trialEndsAt this far in the past with no collected
 * payment means the trial-cancellation webhook was missed — deny defensively
 * rather than trusting a stale paid `plan`. Wide enough that a legitimate
 * trial→paid conversion (invoice + subscription.updated within minutes) never
 * trips it; the daily reconcile cron closes whatever this window leaves.
 */
export const TRIAL_LAPSE_GRACE_MS = 24 * 60 * 60 * 1000

export function billingStateFor(org: BillingFields, now: Date = new Date()): BillingState {
  if (isGrandfatheredOrganization(org)) return { state: 'paid', plan: entitlementPlanFor(org) }
  const trialLapsedUnpaid =
    org.trialEndsAt != null &&
    now.getTime() - org.trialEndsAt.getTime() > TRIAL_LAPSE_GRACE_MS &&
    org.firstPaidAt == null
  if (trialLapsedUnpaid) return { state: 'payment_required', plan: org.plan }
  if (org.plan !== Plan.TRIAL) return { state: 'paid', plan: org.plan }
  return { state: 'payment_required', plan: org.plan }
}
```

Update the function's doc comment to mention the defensive branch.

- [ ] **Step 4: Verify** — run the test file (PASS) and `npx tsc --noEmit` (all callers still typecheck; fix any caller that selects a partial org without `firstPaidAt` by adding the field to its select).
- [ ] **Step 5: Commit** — `git add src/lib/billing/trial.ts src/lib/billing/__tests__/trial.test.ts <any caller fixed>` ; `git commit -m "feat(billing): deny access when a lapsed unpaid trial was never downgraded"`

---

### Task 2: Extract `applySubscription` into a shared sync module

**Files:**
- Create: `src/lib/billing/sync-subscription.ts`
- Modify: `src/app/api/stripe/webhook/route.ts` (delete lines 15-74, import instead)
- Test: `src/lib/billing/__tests__/sync-subscription-e2e.test.ts` (TEST_DATABASE_URL-gated)

**Interfaces:**
- Produces: `applySubscription(subscription: Stripe.Subscription): Promise<void>` (moved verbatim); `reconcileOrganizationSubscription(stripe: Stripe, org: { id: string; stripeSubscriptionId: string }): Promise<{ outcome: 'synced' | 'cleared' }>` — used by Task 3.

- [ ] **Step 1: Move code** — create `src/lib/billing/sync-subscription.ts` containing `ORG_BILLING_FIELDS` and `applySubscription` moved VERBATIM from `webhook/route.ts:15-74` (imports: `type Stripe` from 'stripe', `Plan`, `prisma`, `planForPriceId`, `apiLogger`, `captureError`, `isGrandfatheredOrganization`, `subscriptionGrantsAccess`). Add:

```ts
/** True for Stripe's "no such subscription" error shape (deleted/detached). */
function isMissingSubscriptionError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: string }).code === 'resource_missing'
}

/**
 * Re-sync one organization's plan from Stripe. A vanished subscription is
 * applied as a cancellation (plan reverts to TRIAL; grandfathered orgs keep
 * ENTERPRISE) so a missed `customer.subscription.deleted` webhook self-heals.
 */
export async function reconcileOrganizationSubscription(
  stripe: Stripe,
  org: { id: string; stripeSubscriptionId: string },
): Promise<{ outcome: 'synced' | 'cleared' }> {
  try {
    const subscription = await stripe.subscriptions.retrieve(org.stripeSubscriptionId)
    await applySubscription(subscription)
    return { outcome: 'synced' }
  } catch (error) {
    if (!isMissingSubscriptionError(error)) throw error
    const organization = await prisma.organization.findUnique({
      where: { id: org.id },
      select: ORG_BILLING_FIELDS,
    })
    if (!organization) return { outcome: 'cleared' }
    await prisma.organization.update({
      where: { id: organization.id },
      data: {
        ...(isGrandfatheredOrganization(organization)
          ? { plan: Plan.ENTERPRISE, stripeSubscriptionId: null }
          : { plan: Plan.TRIAL, stripeSubscriptionId: null }),
        trialEndsAt: null,
      },
    })
    return { outcome: 'cleared' }
  }
}
```

`reconcileOrganizationSubscription` needs the Stripe VALUE type only as a parameter type — keep `import type Stripe from 'stripe'`.
Update `webhook/route.ts` to `import { applySubscription } from '@/lib/billing/sync-subscription'` and delete the moved block.

- [ ] **Step 2: Write DB-backed tests** — `src/lib/billing/__tests__/sync-subscription-e2e.test.ts`, gated exactly like `rbac-e2e.test.ts` (`const TEST_DB = process.env.TEST_DATABASE_URL; if (TEST_DB) { ... }`). `applySubscription` takes plain data — craft minimal objects cast via `as unknown as Stripe.Subscription`. Cases:

```ts
const fakeSubscription = (over: Record<string, unknown>) => ({
  id: 'sub_test', customer: 'cus_test', status: 'active',
  items: { data: [{ price: { id: process.env.STRIPE_PRICE_PROFESSIONAL ?? 'price_pro_test' } }] },
  trial_end: null, metadata: {},
  ...over,
}) as unknown as Stripe.Subscription
```

1. seeded org (createdAt after cutoff, `stripeCustomerId: 'cus_test'`) + `status: 'canceled'` → plan becomes `TRIAL`, `stripeSubscriptionId` null.
2. `status: 'trialing'`, `trial_end` future, recognized price → plan set to the price's plan, `trialEndsAt` mirrors, `trialStartedAt` stamped once.
3. `status: 'active'` with unrecognized price on an org already on a paid plan → plan unchanged (alarm branch).

Point the price map at a known id: set `process.env.STRIPE_PRICE_PROFESSIONAL = 'price_pro_test'` in the test `before()` BEFORE importing the module (check `src/lib/stripe/plans.ts` for the exact env var names and read timing; if the map is built at import time, env must be set first).

- [ ] **Step 3: Run** — `TEST_DATABASE_URL=... npx tsx --test src/lib/billing/__tests__/sync-subscription-e2e.test.ts` per the `verify` skill (throwaway Postgres + migrate deploy). Expected: PASS. Also `npx tsc --noEmit`.
- [ ] **Step 4: Run webhook route's existing structural tests** — `npx tsx --test src/app/api/__tests__/route-permissions.test.ts`. Expected: PASS (webhook still listed, source moved not changed).
- [ ] **Step 5: Commit** — `git commit -m "refactor(billing): extract subscription sync from webhook for reuse + first webhook-logic tests"`

---

### Task 3: Daily reconcile cron route

**Files:**
- Create: `src/app/api/cron/billing-reconcile/route.ts`
- Modify: `vercel.json` (add cron entry), `src/app/api/__tests__/route-permissions.test.ts` (exempt list)

**Interfaces:**
- Consumes: `reconcileOrganizationSubscription` from Task 2.

- [ ] **Step 1: Add exempt-list entry first (failing structural test not practical here — the test fails on the NEW route file, so add both together):** in `route-permissions.test.ts` `DIFFERENTLY_AUTHENTICATED`, after `cron/dispatch`: `{ route: 'cron/billing-reconcile', mechanism: 'cron shared secret' },`

- [ ] **Step 2: Implement the route** — `src/app/api/cron/billing-reconcile/route.ts`:

```ts
/**
 * /api/cron/billing-reconcile — daily Stripe↔plan reconciliation.
 *
 * Webhooks are the primary path for plan changes; this closes the failure
 * mode where a missed subscription webhook leaves a lapsed workspace on a
 * paid plan forever. For every org holding a subscription id, re-fetch the
 * subscription and re-apply it; a vanished subscription applies as canceled.
 * Also alarms on orgs that claim a paid plan with no subscription at all.
 *
 * Auth: identical fail-closed CRON_SECRET bearer check as /api/cron/dispatch.
 */
import { timingSafeEqual } from 'crypto'
import { Plan } from '@prisma/client'
import { systemPrisma } from '@/lib/prisma'
import { getStripe } from '@/lib/stripe'
import { reconcileOrganizationSubscription } from '@/lib/billing/sync-subscription'
import { GRANDFATHERED_WORKSPACE_CUTOFF } from '@/lib/billing/entitlements'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

function checkAuthorized(request: Request): Response | null {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return Response.json({ success: false, error: 'CRON_SECRET not configured' }, { status: 503 })
  }
  const authHeader = request.headers.get('authorization') || ''
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  if (!(a.length === b.length && timingSafeEqual(a, b))) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

export async function GET(request: Request) {
  const unauthorized = checkAuthorized(request)
  if (unauthorized) return unauthorized
  try {
    const stripe = getStripe()
    // systemPrisma: global billing sweep across all orgs by design (CRON_SECRET-gated).
    const orgs = await systemPrisma.organization.findMany({
      where: { stripeSubscriptionId: { not: null } },
      select: { id: true, stripeSubscriptionId: true },
      take: 500,
    })
    let synced = 0
    let cleared = 0
    let failed = 0
    for (const org of orgs) {
      try {
        const result = await reconcileOrganizationSubscription(stripe, {
          id: org.id,
          stripeSubscriptionId: org.stripeSubscriptionId!,
        })
        if (result.outcome === 'synced') synced += 1
        else cleared += 1
      } catch (error) {
        failed += 1
        apiLogger.error('billing-reconcile: org reconcile failed', {
          organizationId: org.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // A paid plan with no subscription and no grandfather marker cannot be
    // reached by any legitimate write path — alarm, don't auto-downgrade.
    // systemPrisma: global billing sweep across all orgs by design (CRON_SECRET-gated).
    const orphans = await systemPrisma.organization.findMany({
      where: {
        plan: { not: Plan.TRIAL },
        stripeSubscriptionId: null,
        grandfatheredAt: null,
        createdAt: { gt: GRANDFATHERED_WORKSPACE_CUTOFF },
      },
      select: { id: true, plan: true },
      take: 100,
    })
    if (orphans.length > 0) {
      apiLogger.error('billing-reconcile: paid orgs with no subscription', {
        organizationIds: orphans.map((org) => org.id),
      })
      captureError(new Error('Paid organization(s) with no Stripe subscription'), {
        scope: 'billing.reconcile',
        count: orphans.length,
      })
    }

    return Response.json({ success: true, checked: orgs.length, synced, cleared, failed, orphaned: orphans.length })
  } catch (error) {
    apiLogger.error('billing-reconcile: unhandled error', {
      error: error instanceof Error ? error.message : String(error),
    })
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
```

Check `captureError`'s second-arg type in `src/lib/observability/sentry.ts` and match it.

- [ ] **Step 3: vercel.json** — add to `crons`: `{ "path": "/api/cron/billing-reconcile", "schedule": "30 3 * * *" }` (before the 4:00 retention job).
- [ ] **Step 4: Verify** — `npx tsx --test src/app/api/__tests__/route-permissions.test.ts` PASS; `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(billing): daily Stripe reconcile cron self-heals missed webhooks"`

---

### Task 4: Background execution hard-stop

**Files:**
- Modify: `src/lib/billing/enforce.ts` (two new exports)
- Modify: `src/features/agents/execute-agent.ts` (~line 370, inside `runAgentExecution`)
- Modify: `src/features/flows/execute-flow.ts` (~line 1041, top of `dispatchFlowExecution`)
- Modify: `src/app/api/agents/[id]/trigger/route.ts` (~line 55), `src/app/api/flows/[id]/trigger/route.ts` (after flow lookup)
- Modify: `src/app/api/cron/dispatch/route.ts` (pre-filters)
- Test: `src/app/api/__tests__/rbac-e2e.test.ts` (new describe block)

**Interfaces:**
- Consumes: `billingStateFor` (Task 1 signature).
- Produces: `assertOrganizationBillingActive(organizationId: string): Promise<void>` (throws `ApiError` 402 `PAYMENT_REQUIRED`); `paymentRequiredOrgIds(organizationIds: string[]): Promise<Set<string>>`.

- [ ] **Step 1: Write the failing e2e test** — new `describe('billing hard-stop', ...)` inside the `TEST_DB` gate of `rbac-e2e.test.ts`:

```ts
describe('billing hard-stop', () => {
  test('an unpaid workspace cannot fire an agent through its trigger webhook', async () => {
    await withSeeded({ role: 'ADMIN', plan: 'TRIAL' }, async (seeded: any) => {
      const secret = 'trigger-secret-test'
      const { hashToken } = await import('@/lib/crypto/secrets')
      const agent = await prisma.agentTask.create({
        data: {
          organizationId: seeded.organizationId,
          userId: seeded.auth.dbUser.id,
          agentType: 'GENERAL',
          description: 'billing gate probe',
          objective: 'noop',
          status: 'ACTIVE',
          metadata: { triggerSecretHash: hashToken(secret) },
        },
      })
      const { POST } = await import('../agents/[id]/trigger/route')
      const response = await POST(req(`/api/agents/${agent.id}/trigger`, {
        method: 'POST',
        headers: { 'x-trigger-secret': secret, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }))
      assert.equal(response.status, 402)
    })
  })
})
```

Adjust `agentTask.create` required fields to the schema (check `prisma/schema.prisma` `AgentTask` model; drop/add fields until the create is valid — the load-bearing parts are `status: 'ACTIVE'`, org id, and `triggerSecretHash`). Seeded TRIAL orgs are created with a recent `createdAt`; confirm `seedTestOrg` doesn't backdate before the grandfather cutoff (if it does, override `createdAt` after seeding).

- [ ] **Step 2: Run to verify failure** — trigger route currently returns 200/500, not 402. Expected: FAIL.
- [ ] **Step 3: Implement the gate helpers** — append to `src/lib/billing/enforce.ts`:

```ts
import { systemPrisma } from '@/lib/prisma'   // merge into existing import line
import { billingStateFor } from './trial'

const ORG_ACCESS_FIELDS = {
  plan: true, trialEndsAt: true, firstPaidAt: true, createdAt: true, grandfatheredAt: true,
} as const

/**
 * Billing gate for execution paths that don't flow through requireAuthContext
 * (cron dispatch, queue workers, Slack, trigger webhooks, timed resumes).
 * Unknown org fails closed. Same 402 the interactive API raises.
 */
export async function assertOrganizationBillingActive(organizationId: string): Promise<void> {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: ORG_ACCESS_FIELDS,
  })
  if (!organization || billingStateFor(organization).state === 'payment_required') {
    throw new ApiError('Choose a paid plan to start using Sublime. You can cancel anytime.', 402, 'PAYMENT_REQUIRED')
  }
}

/** Batch form for the cron tick: which of these orgs are locked out? */
export async function paymentRequiredOrgIds(organizationIds: string[]): Promise<Set<string>> {
  if (organizationIds.length === 0) return new Set()
  // systemPrisma: cross-org billing lookup for the CRON_SECRET-gated dispatch tick.
  const orgs = await systemPrisma.organization.findMany({
    where: { id: { in: organizationIds } },
    select: { id: true, ...ORG_ACCESS_FIELDS },
  })
  return new Set(
    orgs.filter((org) => billingStateFor(org).state === 'payment_required').map((org) => org.id),
  )
}
```

- [ ] **Step 4: Wire the choke points.**
  - `execute-agent.ts` `runAgentExecution`, immediately after `const { agentId, organizationId, userId } = data`: `await assertOrganizationBillingActive(organizationId)`.
  - `execute-flow.ts` `dispatchFlowExecution`, first statement: `await assertOrganizationBillingActive(job.organizationId)`.
  - `agents/[id]/trigger/route.ts`, after the secret check passes (line ~54): wrap in try/catch returning `NextResponse.json({ success: false, error: 'This workspace needs an active plan before agents can run.' }, { status: 402 })`.
  - `flows/[id]/trigger/route.ts`: same pattern after the flow+token validation.
- [ ] **Step 5: Cron pre-filter** — in `cron/dispatch/route.ts`:
  - Before the `dueWaits` loop: `const waitOrgIds = [...new Set(dueWaits.map(w => w.organizationId))]` → `const unpaidWaitOrgs = await paymentRequiredOrgIds(waitOrgIds)`; inside the loop, `if (unpaidWaitOrgs.has(waiting.organizationId)) continue`.
  - After `dueAgents` is computed: batch-check its org ids the same way and filter them out (debug log the skipped count).
  - In the flows loop, collect `flows` org ids once before the loop and `continue` on unpaid.
- [ ] **Step 6: Verify** — e2e test now PASSES (402); run the whole gated suite (`rbac-e2e`) plus `npx tsc --noEmit`. Also confirm interactive manual-run routes still work for paid orgs: run `npm test` for regressions.
- [ ] **Step 7: Commit** — `git commit -m "feat(billing): hard-stop background execution for unpaid workspaces"`

---

### Task 5: Lapsed-trial paywall copy

**Files:**
- Modify: `src/lib/billing/access.ts` (thread `trialUsed`), `src/app/(app)/layout.tsx` (pass prop), `src/components/billing/plan-picker.tsx`, `src/components/billing/pricing-grid.tsx`
- Test: `src/components/billing/__tests__/plan-picker.test.tsx`

**Interfaces:**
- Consumes: `organization.trialStartedAt` (already selected — full org row).
- Produces: `BillingAccess` `payment_required` variant gains `trialUsed: boolean`; `PlanPicker({ canManageBilling, trialUsed })`; `PricingGrid({ trialUsed?: boolean })`.

- [ ] **Step 1: Write the failing SSR test** — append to `plan-picker.test.tsx` (match its existing renderToString style):

```tsx
test('a workspace that used its trial is offered a subscription, not another trial', () => {
  const html = renderToString(<PlanPicker canManageBilling trialUsed />)
  assert.ok(html.includes('Subscribe'))
  assert.ok(!html.includes('14-day'))
  assert.ok(!html.includes('charged'))
})

test('a fresh workspace still sees the trial offer', () => {
  const html = renderToString(<PlanPicker canManageBilling trialUsed={false} />)
  assert.ok(html.includes('14-day trial'))
})
```

- [ ] **Step 2: Run to verify failure** — `npx tsx --test src/components/billing/__tests__/plan-picker.test.tsx`. Expected: FAIL (prop doesn't exist / copy unchanged).
- [ ] **Step 3: Implement.**
  - `access.ts`: variant `| { status: 'payment_required'; canManageBilling: boolean; trialUsed: boolean }`; the no-organization return uses `trialUsed: false`; the main return uses `trialUsed: organization.trialStartedAt != null` (add `trialStartedAt` to any explicit select if one exists — `getAuthWithUser` uses `include: { organization: true }`, so the field is present).
  - `(app)/layout.tsx`: `<PlanPicker canManageBilling={access.canManageBilling} trialUsed={access.trialUsed} />`.
  - `plan-picker.tsx`: prop `Readonly<{ canManageBilling: boolean; trialUsed: boolean }>`. When `trialUsed && canManageBilling`: h1 `'Pick your plan.'`; paragraph `'Your free trial has ended. Choose a plan to keep using Sublime — billing starts right away, and you can cancel anytime.'`; render `<PricingGrid trialUsed />`.
  - `pricing-grid.tsx`: `export function PricingGrid({ trialUsed = false }: Readonly<{ trialUsed?: boolean }>)`; CTA render becomes `{trialUsed && tier.cta.startsWith('Start') ? 'Subscribe' : tier.cta}`.
  - Check other `PricingGrid`/`PlanPicker` usages (`grep -rn "PricingGrid\|PlanPicker" src`) — marketing pages keep the default.
- [ ] **Step 4: Verify** — SSR tests PASS; `npx tsc --noEmit` clean (it will flag every `PlanPicker`/`BillingAccess` consumer needing the new field).
- [ ] **Step 5: Commit** — `git commit -m "fix(billing): stop offering a trial to workspaces that already used theirs"`

---

### Task 6: Full verification

- [ ] **Step 1:** `npx tsc --noEmit` clean.
- [ ] **Step 2:** `npm test` — full unit suite green.
- [ ] **Step 3:** Gated DB suites per the `verify` skill (throwaway Postgres, `prisma migrate deploy`, then the e2e files touched here).
- [ ] **Step 4:** `npm run lint` and `npm run build`.
- [ ] **Step 5:** Commit any stragglers; report results honestly (superpowers:verification-before-completion).
