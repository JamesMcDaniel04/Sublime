# The Goal Lens

Date: 2026-07-29
Status: Approved for implementation
Depends on: `2026-07-29-rbac-permission-core-design.md` (pieces A and B, shipped)

## Problem

Sublime has goals, and it has work — flows, agents, integrations, activity —
but the two only meet on a goal's detail page. There is no way to put the whole
product into the service of one goal, and no way to see across every goal at
once. Piece B added the plan gates for exactly that (`maxActiveGoals`,
`allGoalsView`) and nothing consumes them yet.

This spec adds the lens: a goal switcher that scopes every surface, an
all-goals position that is plan-gated, and an optional per-goal access boundary
for confidential goals.

## Decisions taken

- The lens scopes **every** surface including Integrations. The
  "is my connection missing?" risk is real and is mitigated explicitly (§5),
  not left to chance.
- Work attached to no goal is **hidden with a persistent count**, never
  silently dropped.
- The lens lives in the **URL path**, so a link carries its scope.
- A restricted goal hides **the goal and its numbers**; work already assigned
  to someone stays in their queue, anonymised (§7).
- All of piece C is one spec, per explicit request. The sections are sequenced
  so implementation can still land in stages: §1–§5 (the lens) are independently
  shippable before §6–§7 (restriction).

## 1. Routing

Every app surface moves under `/g/[scope]/`, where `scope` is a goal id or the
literal `all`:

```text
/g/all/dashboard        /g/goal_abc/dashboard
/g/all/goals            the goals list (overview)
/g/goal_abc/goals       that goal's detail + workroom
/g/all/flows            /g/goal_abc/flows
/g/all/agents           /g/goal_abc/agents
/g/all/integrations     /g/goal_abc/integrations
```

Next.js has no optional dynamic segment, so the segment is ALWAYS present and
`all` is the sentinel. This keeps one set of route files with one `params.scope`
— the alternative (parallel scoped and unscoped route trees) duplicates every
route forever and lets the two drift, which is the failure the `(app)` route
group was created to eliminate.

Two consequences:

- **`/goals/[id]` disappears.** A goal's detail page IS the goals surface seen
  through that goal's lens, so the existing route folds into
  `/g/[goalId]/goals` rather than sitting beside it.
- **`/settings` stays unscoped.** Workspace settings are not a per-goal concept.

`/goals/new` becomes `/g/all/goals/new`; creating a goal is not itself scoped.

Legacy paths (`/dashboard`, `/flows`, `/agents`, `/integrations`, `/goals`,
`/goals/[id]`) get permanent redirects to their `all`-scoped equivalents.

All scoped routes remain inside the `(app)` route group, so the billing gate in
`src/app/(app)/layout.tsx` continues to cover them by construction.

### 1.1 Link discipline

Every internal `<Link>` and `router.push` must carry the current scope. A
`useScopedHref()` helper (client) and `scopedHref(scope, path)` (server) are the
only sanctioned ways to build an in-app URL, so "forgot the scope" becomes a
lint-visible pattern rather than a silent reset to All goals.

## 2. Scope resolution — `src/lib/server/goal-scope.ts`

### 2.0 Where enforcement lives

Every app page in `(app)` is a `'use client'` component fetching through
`useCachedJson`, so pages cannot enforce anything. **Scoping is enforced in the
API routes, server-side.** Client pages read the scope from `useParams()` and
pass it on their fetches as `?goal=<scope>`.

This is the correct boundary rather than a workaround:

- A client that omits `?goal=` means "all", which is itself gated.
- A client that passes a goal id it cannot see gets a 404 (§6).
- Neither is a bypass, because the API never trusts the parameter beyond using
  it as a lookup key.

The routing move (§1) is therefore mechanical — params and links — while the
security-critical logic concentrates in this module and the goal-aware routes.

One resolver, called by every goal-aware API route:

```ts
export type GoalScope =
  | { kind: 'all' }
  | { kind: 'goal'; goal: ResolvedGoal }

export async function resolveGoalScope(auth: AuthContext, scopeParam: string): Promise<GoalScope>
```

It refuses in three ways:

- `all` without `goal:read:all` → redirect per §8.
- A goal id the actor cannot see → 404 (§6).
- A malformed segment → 404.

It returns the loaded goal so callers do not re-query it.

This module also absorbs `visibleWhere()`, currently a private helper in
`src/app/api/goals/[id]/route.ts` and duplicated in spirit by the goals list
route's `OR: [{ ownerUserId: null }, { ownerUserId: me }]`. Restricted goals
need that rule in a dozen places; leaving it file-private guarantees drift.

Like `visibility.ts`, the where-fragment builders are pure functions returning
Prisma fragments. Only `resolveGoalScope` itself touches the database.

## 3. What each surface filters on

| Surface | Filter |
|---|---|
| Flows | `GoalContribution` rows with `resourceType = 'flow'` for this goal |
| Agents | `GoalContribution` rows with `resourceType = 'agent'` for this goal |
| Integrations | connections referenced by this goal's `GoalMetric` bindings |
| Dashboard | activity for the flows/agents above |
| Goals | the goal itself plus its `parentGoalId` children |

`GoalContribution` is unique on `(goalId, resourceType, resourceId)`, so one
flow may contribute to several goals. The lens is a filter over a join table; it
never reassigns ownership, and no flow ever "belongs to" a single goal.

## 4. The invariant: a lens narrows, never widens

Scoped queries `AND` the contribution filter onto the EXISTING
`flowReadScope` / `agentReadScope` from `src/lib/server/visibility.ts`. The lens
can only remove rows from what the actor could already see.

This is the security-critical rule of the whole spec. The tempting
implementation — "look up the goal's contributions, then fetch those resources
by id" — bypasses visibility entirely and would show a colleague's private flow
because it happens to serve your goal. Composing that way is forbidden, and §9.1
is a property test that fails if someone does it anyway.

Combine via Prisma `AND` when the target `where` already carries an `OR`; two
`OR` keys collide in one object. (Same constraint `visibility.ts` documents.)

## 5. Unattached work

Each scoped list runs a second count with the contribution filter negated,
intersected with the same read scope, and surfaces it persistently:

```text
12 flows not linked to this goal  ›
```

Opening it lists those items with an attach action. Because the count reuses the
read scope, it can never reveal the existence of work the actor could not
otherwise see.

For **Integrations** this affordance is load-bearing rather than decorative — it
is the mitigation for scoping a surface where absence reads as breakage. The
scoped integrations page always shows the ratio, not only when the list is
empty:

```text
Showing 3 of 11 connections · 8 not linked to this goal ›
```

## 6. Restricted goals

```prisma
model Goal {
  /// 'workspace' (default) — anyone in the org who can see goals may lens in.
  /// 'restricted' — only GoalMember rows and workspace admins.
  access String @default("workspace")
}

model GoalMember {
  goalId    String
  userId    String
  createdAt DateTime @default(now()) @db.Timestamptz(6)

  @@id([goalId, userId])
  @@index([userId])
  @@map("goal_members")
}
```

Marking a goal restricted requires a new capability, **`goal:restrict`**,
admin-only. Reusing `settings:workspace` would conflate "can change workspace
configuration" with "can hide a goal from colleagues"; those should be
separately revocable later, and a closed capability union makes adding one
cheap.

For a non-member a restricted goal is **absent, not forbidden**:

- missing from the goal switcher,
- `404` — never `403` — on `/g/<id>/*` and on every goal API,
- excluded from all-goals roll-ups, counts, and search.

`403` would confirm the goal exists, which for a confidential goal is most of
the secret.

`goal:restrict` is added to the `Capability` union in
`src/lib/server/permissions.ts` and to `ADMIN_ONLY`. The union is closed, so
this is a one-line change plus a row in the exhaustive `can()` matrix test.

Workspace admins always resolve restricted goals, consistent with piece A's
decision that admins have full read across their workspace: restricted goals
appear in an admin's switcher (marked as restricted) and in their all-goals
roll-ups. Admin access to a restricted goal they are not a member of goes
through `withElevatedAccess`, so it is audited like any other cross-owner read.

Org goals default to `workspace`. **Personal goals ignore `access` entirely** —
`ownerUserId` already restricts them, and two mechanisms expressing one idea is
how contradictions get built.

## 7. The anonymised work queue

A `GoalWork` row assigned to someone who is not a goal member is a side channel
into a goal they cannot see, so this is the most delicate part of the design.

Such an assignee keeps the row in their **personal** queue — under `all`, never
under the goal's lens, which they cannot select. It renders through a dedicated
serializer that emits only:

`subject`, `body`, `bodyFormat`, `disposition`, `outcome`, and the disposition
actions.

It **omits** the goal's name, targets, progress, risk level, `signals`, and
`probeForRuleId`. `signals` is the dangerous field: free-form JSON the agent
used to pick the subject, which trivially leaks the goal's shape.

The serializer is the ONLY path by which a non-member reads a restricted goal's
work, and it is **allow-list based** — a newly added `GoalWork` column is
excluded until someone consciously includes it, so the default for new data is
"not leaked".

Goal members and admins continue to see the full row.

## 8. The all-goals plan gate

`scope === 'all'` requires the `goal:read:all` capability from piece A, which is
plan-gated to Team and above via `PlanCapabilities.allGoalsView`.

**Exception:** `all` is permitted when the workspace holds ≤1 active goal.
Without this an Individual workspace could not reach its own goals list to
create its first goal — the gate would lock people out of the product rather
than out of an aggregate view. There is nothing to aggregate at one goal, so
nothing is given away.

A member without the entitlement who requests `/g/all/*` is redirected to their
single accessible goal. The switcher's `All goals` slot renders an upgrade
affordance rather than disappearing, so the capability is discoverable.

## 9. Verification

1. **Property test — the lens only narrows.** For a seeded fixture, every scoped
   list must be a strict subset of its unscoped equivalent for the same actor,
   across flows, agents and integrations. This is what catches the §4 bypass.
2. **Restricted-goal absence** — a non-member receives 404 on the goal detail
   and every goal API, and the goal is absent from the switcher, all-goals
   roll-ups, counts and search. Asserted as absence, never as a 403.
3. **Anonymised work** — an assignee who is not a member reads their row and
   receives no goal name, targets, or `signals`. Asserted as an explicit key
   allow-list, so adding a `GoalWork` column fails the test rather than leaking.
4. **Plan gate** — `all` refused on Individual with 2+ active goals, permitted
   with ≤1; the ≤1 exception is asserted directly.
5. **Redirects** — every legacy path resolves to its `all`-scoped equivalent.

Run with `npm test` against a throwaway Postgres per the `verify` skill, plus
`npm run check`.

## 10. Migration

Additive, no backfill:

1. `Goal.access` with default `'workspace'`, so every existing goal keeps its
   current behaviour.
2. A new `goal_members` table.

The routing move is a code change plus redirects, not a data migration.

## Out of scope

- **Piece D** — admin surfaces (org-goal authoring UI, workspace activity
  insights, takeover/reassignment UI). The lens is a prerequisite for the
  insights being useful, which is why D follows C.
- **Cross-goal aggregation semantics** beyond listing. What the all-goals
  dashboard actually computes (weighted roll-ups, contribution attribution
  across goals) is a product question deserving its own spec; this one delivers
  the scope mechanism and the unaggregated all-goals views.
- **Auto-attaching** work to a goal on creation or run. Considered and
  rejected: implicit writes driven by a view setting surprise people.
