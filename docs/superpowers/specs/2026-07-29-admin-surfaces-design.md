# Admin Surfaces

Date: 2026-07-29
Status: Approved for implementation
Depends on: `2026-07-29-rbac-permission-core-design.md` (pieces A and B, shipped),
`2026-07-29-goal-lens-design.md` (piece C, shipped)

## Problem

Pieces A–C built admin capabilities with no way to use them. `resource:takeover`
is enforced and audited but nothing invokes it. `insights:workspace` gates two
endpoints nobody links to. Goal restriction has a complete, tested API and no
front end at all — shipped, but reachable only by curl.

Worse, piece A introduced a dead end: `goal:create:org` became admin-only while
the goal form still offers "Organization goal" to everyone, so a member fills in
the whole form and gets a 403 on submit.

This spec is the front end for what already exists, plus the one insight surface
that has no backend yet.

## Scope

Four items, deliberately unequal:

| | Item | Size |
|---|---|---|
| 1 | Workspace insights — adoption and goal contribution | large, new API |
| 2 | Per-member takeover / reassignment | medium |
| 3 | Goal restriction UI — contextual control and roll-up | medium, API exists |
| 4 | Gate the org-goal toggle for non-admins | small |

## Decisions taken

- Admin surfaces live as **tabs inside `/settings`**, not a separate `/admin`
  section.
- Insights answer **both** "is my team using this" and "who is moving the
  numbers", on one page.
- Takeover is reached **per member, from the Members tab** — the offboarding
  case — and lists names only.
- Restriction gets **both** a contextual control and a roll-up.

## 1. Placement, and the settings split

Two admin-only tabs join the existing six: **Insights**, and an extended
**Members**.

`src/app/(app)/settings/page.tsx` is already 670 lines holding every tab's
markup and all fourteen handlers inline. Adding insights and per-member takeover
to it would make it unworkable, so the file splits FIRST:

```text
src/app/(app)/settings/page.tsx          shell: tab list, role gate
src/app/(app)/settings/tabs/profile.tsx
              tabs/appearance.tsx
              tabs/security.tsx
              tabs/members.tsx           + member detail / takeover
              tabs/workspace.tsx
              tabs/billing.tsx
              tabs/insights.tsx          new
```

Each tab owns its own fetches and handlers. This is a prerequisite for the rest
of the spec, not an optional cleanup.

### 1.1 Gating

The tab list filters on `profile.role === 'ADMIN'`, but that is PRESENTATION
ONLY. Every endpoint behind an admin tab declares its own capability, so hiding
the tab and refusing the data are independent mechanisms — neither depends on
the other being correct.

## 2. Workspace insights

`GET /api/settings/insights`, declaring `requires: 'insights:workspace'` (the
capability already exists from piece A).

No new event capture: `UserEvent` and `GoalContribution` / `GoalWork` already
hold everything needed.

### 2.1 Adoption, per member

Last active, runs, flows created, agents created, credits used.

Derived from `UserEvent` grouped by `userId`, using the existing
`[organizationId, occurredAt]` index and the bounded `kind` vocabulary in
`src/lib/behavior/record-event.ts`. Kinds map to columns:

| Column | Kinds |
|---|---|
| runs | `agent_run_manual`, `flow_run_manual` |
| flows created | `flow_created` |
| agents created | `agent_created` |
| last active | max `occurredAt` across all kinds |

Credits do NOT come from `UserEvent`, and there is no per-seat credit figure to
read: `src/lib/billing/limits.ts` states the monthly allowance is an ORG-WIDE
pool. Per-member spend is instead derived by summing `AgentExecution.inputTokens
+ outputTokens` grouped by `userId`, which the existing
`[organizationId, userId, agentTaskId, startedAt]` index makes cheap.

It is reported as **tokens, labelled as a share of the org pool** — never as
"credits used" per person, which would imply a per-seat allowance that does not
exist.

The headline is the line an admin acts on: **"3 of 8 members have never run
anything."** Members with zero activity are listed explicitly rather than
omitted — an absent row reads as a rendering bug, and the whole point is to
surface the people who need help.

### 2.2 Contribution, per goal

Contributors, work items, throughput (used vs skipped), estimated time saved.
From `GoalContribution` and `GoalWork`, which already carry `assigneeUserId`
and `disposition`.

### 2.3 Aggregate only

Both sections return counts, timestamps and names — NEVER the content of a run,
prompt, or work item. This keeps insights inside piece A's privacy line while
still answering both questions, and it is asserted by a key allow-list test
(§6.2) rather than left to reviewer diligence.

## 3. Per-member takeover

Clicking a member in the Members tab opens their detail: what they own, by type
and count, with last-activity dates. **Names only — clicking a resource does not
open it.**

- `GET /api/settings/members/[id]/resources` — `requires: 'resource:takeover'`.
  Returns flows, agents and goals owned by that member: `id`, `name`, `type`,
  `updatedAt`. No graphs, no objectives, no content.
- `POST /api/settings/members/[id]/reassign` — `requires: 'resource:takeover'`.
  Body `{ resourceIds: string[], toUserId: string }`. Every reassignment runs
  through `withElevatedAccess`, so it lands in the audit log by construction.
- **Reassign all** for the offboarding case.
- The target must be an ACTIVE member of the same workspace, or offboarding
  strands the work a second time.

### 3.1 A deliberate narrowing

Piece A decided admins get full read plus takeover. This surface implements
takeover only: it lists what someone owns and reassigns it, and does not open
contents.

Listing what someone owns solves offboarding, which is the real driving case.
Reading their drafts is a different feature with a different privacy cost, and
nothing yet needs it. The `resource:takeover` capability is unchanged, so a
later surface can offer content reads without revisiting the permission model.

## 4. Restriction UI

### 4.1 Contextual control

An admin-only **Access** section on the goal detail page
(`/g/[goalId]/goals`), beside the goal's other settings: a
`Workspace | Restricted` toggle and, when restricted, a member picker.

It drives the `/api/goals/[id]/members` endpoints built in piece C Stage 2, so
this is purely a front end over working, tested APIs.

Non-admins do not see the section.

### 4.2 The Restricted badge

A restricted goal shows a small **Restricted** badge to everyone who CAN see it.
Members of a confidential goal need to know it is confidential; without the
badge someone forwards a screenshot not realising.

### 4.3 Roll-up

The Insights tab carries a restricted-goals list: which goals are hidden, and
who can see each one.

This is the question the per-goal control structurally cannot answer, and it is
the one asked in practice ("who can see Project Atlas?").

Implementation reads `GET /api/goals/[id]/members` once per RESTRICTED goal —
not per goal, since unrestricted goals have no membership to show. Restriction
is rare by nature, so this is a handful of requests in practice.

The concrete trigger for collapsing it into a single list endpoint: **more than
ten restricted goals in a workspace**. Below that the N+1 is not worth a new
endpoint; above it, add `GET /api/goals/restricted` returning goals and members
in one read.

## 5. Gate the org-goal toggle

`src/app/(app)/g/[scope]/goals/new/page.tsx` offers "Organization goal" to
everyone, but piece A made `goal:create:org` admin-only. A member therefore
completes the entire form and receives a 403 on submit.

The option becomes disabled for non-admins with an inline explanation
("Organization goals are set by workspace admins"), and the form defaults to
Personal.

The server check is unchanged. This removes a dead end; it does not become the
enforcement.

## 6. Verification

1. **Capability gating** — a MEMBER receives 403 from
   `/api/settings/insights`, `/api/settings/members/[id]/resources`, and
   reassign. Driven against real handlers through `installTestAuth`, matching
   the pattern the RBAC suite already uses.
2. **Insights are aggregate-only** — asserted as an explicit key allow-list on
   the response, so a future field carrying content fails the test rather than
   leaking. Same discipline as the anonymised work serializer in piece C.
3. **Reassignment is audited** — a reassign writes an `AuditEvent`; the
   assertion is that the audit row exists, not merely that the update
   succeeded.
4. **Reassign refuses an inactive target** — 400, because otherwise offboarding
   strands the work again.
5. **Insights never cross orgs** — two seeded workspaces, and neither appears in
   the other's numbers.

Run with `npm test` against a throwaway Postgres per the `verify` skill, plus
`npm run check`.

## 7. Out of scope

- **Content reads of other members' work.** The capability permits it; no
  surface offers it (§3.1).
- **Deleting another member's resources** from the admin panel. Reassignment
  covers offboarding, and a bulk delete is a far worse mistake to make by
  accident. Nothing yet needs it.
- **Scheduled or exported insight reports.** The existing `/api/audit/export`
  covers the compliance case.
- **Goal-scoping the insights.** They are workspace-wide on purpose: "how is my
  team doing" is not a per-goal question, so the piece C lens does not apply.
