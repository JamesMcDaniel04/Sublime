# RBAC Permission Core & Plan Entitlements

Date: 2026-07-29
Status: Approved for implementation

## Problem

Authorization in Sublime is decided by three unrelated mechanisms that have
never been composed:

- `UserRole { ADMIN, USER }` exists on `User` and `OrganizationInvitation` but
  is checked in a handful of scattered call sites and never reaches the server
  auth context. No workspace has a functioning admin.
- Row-level sharing (`private | org_viewer | org_editor`) in
  `src/lib/server/visibility.ts` is well developed, but only covers flows and
  agents, and knows nothing about roles.
- Plan entitlements in `src/lib/billing/` gate numeric caps and a few product
  capabilities, but nothing goal-related.

The result: a route author has no single place to ask "is this allowed?", and
forgetting to ask is invisible. This spec fixes that, and adds the two plan
gates the goal lens will depend on.

## Scope

The wider ask decomposes into four pieces. **This spec covers A and B only.**

| | Piece | Status |
|---|---|---|
| **A** | Permission core — roles, capability module, mandatory route declaration, audited takeover | this spec |
| **B** | Plan entitlements — active-goal cap, cross-goal view capability | this spec |
| **C** | Goal lens — switcher, goal-scoped filtering, `Goal.access` + `GoalMember` | separate spec |
| **D** | Admin surfaces — org-goal authoring UI, workspace insights, takeover UI | separate spec |

C and D consume A and B; neither is designed here. This spec deliberately adds
no `GoalMember` table and no `Goal.access` column.

## Decisions taken

- The goal lens is a **focus filter by default, an access boundary only when a
  goal is explicitly marked restricted** (piece C).
- Higher tiers gate **both** the number of active goals **and** the cross-goal
  ("All goals") view.
- Admins get **full read plus takeover** across their workspace — which makes
  an audit trail mandatory, not optional.
- **Two roles**, `ADMIN` and `MEMBER`. No separate Owner role; admins manage
  billing.

## 1. Data model

### 1.1 Role rename

```prisma
enum UserRole { ADMIN, MEMBER }
```

Migration renames the enum value `USER` to `MEMBER` in place. `User.role` and
`OrganizationInvitation.role` both inherit it; their `@default(USER)` becomes
`@default(MEMBER)`.

### 1.2 Last-admin guard

A workspace must always have at least one active `ADMIN`. Enforced in
application code on every path that could remove the last one: role change,
deactivation (`User.isActive = false`), and member removal. Each returns a 409
with a clear message rather than silently succeeding.

Rationale: an org with zero admins can never manage billing, invite anyone, or
recover ownership — it is an unrecoverable state reachable by one careless
click.

### 1.3 Bootstrap

The first user in an `Organization` is `ADMIN`; every subsequent invitee
defaults to `MEMBER` unless the inviting admin selects otherwise.

This already holds: `src/lib/supabase/auth-utils.ts` provisions a new user with
`invitation?.role ?? 'ADMIN'`, so a workspace creator (who has no invitation)
is an admin and an invitee takes the invited role. No change required.

### 1.4 Effective role

`auth-utils.ts` normalizes legacy platform users to `role: 'ADMIN'` at the auth
boundary, so `dbUser.role` is already the **effective** role. `can()` consumes
that value and does not re-derive legacy status, or legacy super-admins would
silently lose access.

## 2. Permission core — `src/lib/server/permissions.ts`

A closed union, so referencing an undefined capability is a compile error:

```ts
export type Capability =
  | 'goal:create:org'        // author org-level goals (Goal.ownerUserId = null)
  | 'goal:read:all'          // the cross-goal lens (also plan-gated)
  | 'insights:workspace'     // activity across all members
  | 'member:manage'          // invite, remove, change role
  | 'billing:manage'
  | 'resource:takeover'      // read/edit/delete/reassign others' work
  | 'settings:workspace'

export type Actor = { userId: string; role: UserRole; plan: Plan }

export function can(actor: Actor, capability: Capability): boolean
```

`can()` is pure and synchronous — no I/O, no Prisma — so it is exhaustively
unit-testable. This mirrors `visibility.ts`, which deliberately keeps its scope
functions pure for the same reason.

### 2.1 Auth context

`AuthContext` in `src/lib/server/auth.ts` gains:

```ts
role: UserRole
isAdmin: boolean
plan: Plan          // from entitlementPlanFor(organization), NOT organization.plan
```

`requireAuthContext()` is the sole authentication gate for 113 of 126 API
routes, so this reaches almost the entire surface in one change.

Using `entitlementPlanFor()` rather than `organization.plan` is load-bearing:
it resolves grandfathering, and a gate written against the raw column would
revoke access that `src/lib/billing/entitlements.ts` promises to legacy
workspaces.

### 2.2 Evaluation order

Fixed, and enforced inside `can()` by construction:

```
plan entitlement  →  role  →  goal assignment (piece C)  →  row visibility (existing)
```

Plan is evaluated **before** role so that being an admin can never substitute
for having bought the tier. `goal:read:all` is the case where both apply: an
admin on the Individual plan does not get the cross-goal view.

## 3. Plan entitlements

Two gates, each landing in the file that already exists for its shape.

### 3.1 Active-goal cap — `src/lib/billing/limits.ts`

`PlanLimits` gains `maxActiveGoals`:

| Plan | Label | maxActiveGoals |
|---|---|---|
| `TRIAL` | Payment required | 1 |
| `STARTER` | Individual | 1 |
| `PROFESSIONAL` | Team | 5 |
| `BUSINESS` | Business | 25 |
| `ENTERPRISE` | Enterprise | `UNLIMITED` |

Enforced on goal **create** and on any transition back to `active` (unpause,
un-archive) — without the second, pause/resume cycles walk past the cap, the
same hole `assertSeatCapacity` already closes for deactivate/reactivate. The
count considers `status = 'active'` goals only, so pausing or archiving frees a
slot.

Exceeding it throws `ApiError(403, 'PLAN_LIMIT')` via the existing
`overLimitError()` helper in `src/lib/billing/enforce.ts` — matching every
other capacity gate rather than introducing a second error shape.

### 3.2 Cross-goal view — `src/lib/billing/capabilities.ts`

`PlanCapabilities` gains `allGoalsView: boolean`, true for Team and above. It
reuses the existing `const team = plan === PROFESSIONAL || plan === BUSINESS`
line rather than introducing a parallel tier test.

### 3.3 Downgrade behavior

**Non-destructive.** A workspace dropping from Team to Individual while holding
four goals keeps all four. The cross-goal view locks, and creating a new goal
is blocked until the workspace is back under cap. Existing goals are never
archived or deleted by a plan change.

Rationale: destroying customer data on downgrade generates support load and
churn, and blocking new creation achieves the commercial objective without it.

## 4. Route enforcement

`withAuthenticatedApi` takes a **required** second argument:

```ts
export const GET  = withAuthenticatedApi(handler, { requires: 'member' })
export const POST = withAuthenticatedApi(handler, { requires: 'goal:create:org' })
```

`requires: 'member'` means "any authenticated member of the workspace" — the
common case, but it must be typed explicitly, so a new route cannot inherit
permissiveness by omission. Because the argument is mandatory in TypeScript,
the migration is compiler-driven: `npm run typecheck` stays red until every
route has made a decision.

On failure the wrapper returns 403 via the existing `AuthContextError` path, so
error shape and logging are unchanged.

### 4.1 Differently-authenticated routes

13 routes do not use the wrapper. None is drift; each authenticates by another
mechanism and stays as-is, recorded in an explicit exception list with its
mechanism:

| Route | Mechanism |
|---|---|
| `stripe/webhook` | Stripe signature |
| `stripe/portal`, `stripe/topup`, `stripe/checkout` | session, billing-exempt by design |
| `cron/retention`, `cron/dispatch` | shared secret |
| `flows/[id]/trigger`, `agents/[id]/trigger` | trigger token |
| `mcp-connections/oauth/callback`, `google/oauth/callback` | OAuth state |
| `slack/events/[bindingId]` | Slack signature |
| `system/behavior` | internal |
| `health` | public |

### 4.2 Completeness test

The filesystem walk at `src/app/api/__tests__/route-smoke.test.ts:148` already
enumerates every `route.ts` and fails when one is neither covered nor
explicitly skipped. It is extended to assert that every exported handler either
declares `requires` or appears in the §4.1 exception list. A 14th
differently-authenticated route arriving unclassified fails CI.

## 5. Admin takeover — elevated, never ambient

Admins have full read and takeover, but **not passively**. Default list queries
stay owner/visibility-scoped: an admin's flow list shows their own flows, not
every flow in the workspace.

Cross-owner access is an explicit request — an admin surface, or an opt-in
`?scope=workspace` parameter — routed through a single wrapper:

```ts
await withElevatedAccess(auth, { action, resourceType, resourceId }, fn)
```

It asserts `can(actor, 'resource:takeover')`, runs `fn`, and records an audit
event via `recordAudit()` as an unavoidable side effect. **The only code path
that grants cross-owner access is the one that writes the audit row**, so
reaching another member's private work without a log entry is not expressible.

Audited actions: `admin.resource.read`, `admin.resource.update`,
`admin.resource.delete`, `admin.resource.reassign`, `member.role.change`,
`member.deactivate`.

Two reasons for elevated-not-ambient:

1. An admin's own workspace stays usable rather than flooded with every
   member's drafts.
2. The audit log stays meaningful — each entry is a deliberate act rather than
   incidental list traffic.

`recordAudit()` is failure-swallowing by design ("writing must never break the
action it records"). That property is retained: a failed audit write is
reported to Sentry, and does not fail the admin's action.

## 6. Page-level gating

Server components in the `(app)` route group read role from the same
`requireAuthContext()`, so a page and its data API cannot disagree. This
follows the principle `src/lib/billing/access.ts` already documents for
billing: it defers to the same function the API's 402 uses, specifically so the
two can never diverge.

Admin-only pages redirect rather than render-and-hide. Client-side `isAdmin` is
presentation only; the server is authoritative.

## 7. Verification

1. **Exhaustive `can()` table** — every `role × plan × capability` combination
   asserted. The function is pure, so coverage is complete rather than sampled.
2. **Declaration completeness** — the extended walk in §4.2.
3. **Negative route smoke** — seed a `MEMBER` context via `installTestAuth`
   and assert **403** against each admin-capability route, driving the real
   handlers. Positive-only authorization tests are how these defects ship.
4. **Entitlement tests** — goal cap at the boundary (creating the Nth+1 returns
   402), `allGoalsView` false on Individual, a grandfathered org resolving to
   Enterprise.
5. **Last-admin guard** — demoting, deactivating, or removing the sole admin
   fails with 409.

Run with `npm test` against a throwaway Postgres per the `verify` skill's
route-smoke protocol, plus `npm run check`.

## 8. Migration & rollout

One Prisma migration:

1. Rename enum value `USER` to `MEMBER`.
2. Backfill one `ADMIN` per existing workspace.

### 8.1 Backfill rule

Most workspaces already have an admin: provisioning assigns `ADMIN` to a user
who arrives without an invitation (§1.3). The backfill is therefore
**conditional repair, not a blanket promotion** — for each organization with
zero active `ADMIN` users, promote the earliest-created active user, which
under the current bootstrap flow is the person who created the workspace.
Organizations that already have an admin are left untouched.

The migration asserts, after backfill, that every organization holding at least
one active user also holds at least one `ADMIN`. If any organization fails that
check the migration aborts, rather than shipping a workspace nobody can
administer.

### 8.2 Ordering

The role rename and backfill deploy before the route-declaration change, so
that no window exists in which routes demand a role the database has not yet
assigned.

## Out of scope

- **Postgres RLS.** `tenant-guard.ts` names RLS as the eventual structural fix
  for tenant isolation, and it remains the right long-term answer for that
  axis. It is a poor fit for role and entitlement logic, and folding it in here
  would block every other piece. Tracked separately as the successor to
  `tenant-guard`.
- **Middleware URL-pattern gating.** It can only see the URL, not the resource,
  and "can this admin take over *this* flow?" is a row-level question. It would
  also reintroduce the drifting-prefix-array problem that the `(app)` route
  group was created to eliminate.
- Pieces C and D, per §Scope.
