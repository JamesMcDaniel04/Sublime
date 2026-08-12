# Backstory Studio parity review — Flows, Agents, Templates, Assistant, super-admin

Date: 2026-08-11
Reference: `jamesmcdaniel-cyber/Backstory_Studio_Playground` @ `a8bdb41`

Backstory Studio is a sibling of Sublime, not a different product: same Next.js +
Prisma + Supabase stack, same `src/{app,components,features,lib}` layout, same
worker runtime, same deploy targets. Patterns transplant with little translation.

**Scope constraint.** Sublime's visual design is settled. Everything below is UX
behavior, capability, or architecture. No restyling, no new design language, no
shell/navigation rework. **Goals and Activity are out of scope entirely.**

Sublime is the larger codebase (~1,320 TS files vs ~967) and is *ahead* in several
places. This is a targeted gap list, not a wholesale port.

---

## 1. Templates — the clearest win

### The finding

Sublime's template library (`src/components/templates/templates-explorer.tsx`,
reached via `/agents?view=templates`) has a search box that **does not search**.

- `onSearch` (line 402) only calls `setSearch(value)`. No grid filtering.
- `filteredSkills = skills` (line 306) — skills are never filtered by anything.
- Typing does nothing visible; you must press Enter or click "Ask AI" (line 536,
  544) to hit `/api/templates/ai-search`, which answers in a **separate
  suggestions panel** (line 557) while the grid underneath stays unfiltered.
- The only real filter is `dept`, and it applies *only* to Starter catalogue
  seeds (line 310) — never to your own templates, never to skills.
- Category exists solely as a card badge (line 340), not as a control.

A user who types "renewal" sees the full unfiltered grid and no feedback.

### Backstory already solved exactly this

Commit `a8bdb41` — *"one filter bar for templates, skills, and flow templates"* —
describes the identical before-state and replaces it with
`src/components/templates/library-filter-bar.tsx`: a plain search box that
filters as you type, a **Category** dropdown derived from what the grid actually
holds, and a **Role** dropdown. One line, whatever the catalogue grows to.

The load-bearing design decision is that **Role is derived, not stored**
(`src/lib/templates/roles.ts`). Nothing in either catalogue carries a role field —
templates have a category and tags, skills carry an audience in job titles.
Backfilling a column onto the built-ins would still leave stored and community
assets unfilterable, so role is read from classification text the item already
has, and deliberately **never from the description** (a template whose prose
mentions marketing is not a marketing template). Categories naming the output
rather than the reader are mapped outright.

Two non-obvious details worth keeping when porting:
- The search input sets `type="search"`, `name`, and `autoComplete="off"`.
  Without these, browser autofill treats a bare text input as an identity field
  and pre-fills the saved email, silently filtering the grid to nothing.
- The dropdown label is a real `<span id>` wired via `aria-labelledby`, because
  the Radix trigger is a button that otherwise announces with no name.

### Recommendation

Port `LibraryFilterBar` + `roles.ts`, render with Sublime's existing UI
primitives. Apply to templates, skills, and the flow-template gallery so all
three grids share one control. Keep `/api/templates/ai-search` in place but
demote it from the primary interaction — it becomes an optional assist, not the
only way to search. **Difficulty: small.** Highest user-visible payoff per unit
of work in this review.

---

## 2. Flows

### Correction to an earlier assumption

Sublime **does** have run cancellation. It is called *stop*, not *cancel*:
`src/app/api/flows/[id]/runs/[runId]/route.ts:96-102` flips the run to
`stopping`, and the interpreter polls cooperatively at
`src/features/flows/execute-flow.ts:1187-1201`. A name-based search for "cancel"
misses it. No work needed here.

### Where Sublime is ahead — do not regress

Sublime's execution backbone is materially more robust than Backstory's:

| Capability | Sublime | Backstory |
|---|---|---|
| Worker lease / heartbeat / claim | `queuedAt`, `claimedAt`, `heartbeatAt`, `leaseExpiresAt`, `workerId`, `queueAttempt` | none |
| Webhook idempotency | `idempotencyKey` + `idempotencyPayloadHash`, unique per org+flow | none |
| Dispatch outbox | `FlowDispatchOutbox` | none |
| Learning observations | `FlowLearningObservation` | none |
| Per-node pins | `FlowNodePin`, scoped **per user** | `graph.pinData` on the shared draft |
| Per-node test | `/api/flows/[id]/test-node` | none |
| Comments, pins, suggestions, run feedback, resubmit | present | none |

Sublime's per-user pin scoping is the better design — Backstory's shared
`pinData` mutates the draft other people are editing, which is why it needed a
separate per-run `stateOverrides` field to compensate.

### Gaps worth closing, ranked

1. **Live resource picker ("pick from a list").** Backstory's
   `/api/flows/tool-options` runs a **read-only** tool against a live connection
   and returns up to 200 items, so a user picks a Slack channel or a board from a
   list instead of typing an ID. Sublime has no equivalent — it imports n8n's
   `resourceLocator` but collapses it to a raw value
   (`src/lib/import/n8n.ts:334`). Sublime already has `searchable-select`, so
   this is mostly a server route plus wiring. **Difficulty: medium.**
   *Security note to preserve:* Backstory refuses write tools outright, and
   refuses the MCP and People.ai planes entirely, because those report
   `isWrite:false` for every tool regardless of what it does — so a "picker"
   call there could fire an arbitrary side effect. Port that refusal, not just
   the happy path.

2. **Workspace-wide run history.** Backstory has `/api/flows/runs` and an
   `@@index([organizationId, startedAt])` for a cross-flow execution log.
   Sublime's activity view is per-flow only
   (`src/app/(app)/g/[scope]/flows/[id]/activity`), so "what ran and what broke
   across my workspace" has no answer. **Difficulty: small**, plus an index
   migration.

3. **Execution manifest (config-drift guard).** Backstory pins a dependency
   fingerprint — graph hash, agent revisions, tool schemas, model defaults —
   before dispatch, and the worker compares it before executing, so a queued or
   resumed run cannot silently pick up incompatible live config. Sublime has
   `graphSnapshot` (the graph only), so an agent or tool edited mid-queue changes
   the run's behavior. **Difficulty: medium.**

4. **Run fork / patch.** Backstory's `stateOverrides` lets you re-run with
   "pretend this step produced X", without touching the shared draft. Strong
   debugging affordance. Sublime's per-user pins get partway there but do not
   apply per-run. **Difficulty: medium.**

5. **Public share link.** Backstory has `/share/flow/[token]` and
   `/api/flows/[id]/share`. Sublime has no read-only share. **Difficulty:
   medium** (needs a token model and an unauthenticated render path).

Explicitly *not* recommended: Backstory's `huddle` voice stack. Sublime has its
own `jam` collaboration and does not need a second one.

---

## 3. Agents

Near-parity. Sublime's agent API is a superset (it adds `export` and `skills`).
Both expose one agents page, chat sessions, memories, knowledge, runs, triggers.

Sublime's approval gate (`src/features/agents/approval.ts`) is the better-reasoned
of the two. It derives write-plane classification from the connector registry
rather than a local regex so a new plane cannot drift out of the gate; it forces
approval unconditionally for Postgres writes and non-GET HTTP (correctly
identifying an un-gated POST as an exfiltration primitive for prompt-injected
content); and it is deny-by-default.

### The one real gap: approvals have no inbox

Sublime resolves an approval **conversationally** — the run suspends as
`waiting_for_input` and a chat reply resolves it, matched against a natural
language regex (`APPROVE_RE`). That works for an interactive session and fails
for everything else. An agent running on a schedule or a trigger has no chat
window, so a pending approval has nowhere to surface and nobody to notice it.

Backstory models it as data instead: an `ApprovalRequest` row (org-scoped, with
`tool`, `summary`, `payload`, and a decision audit) plus an `/approvals` page —
a workspace-wide queue with explicit approve/reject actions.

It also ships a **reaper** (`src/lib/approvals/reap.ts`) for the failure mode
Sublime has no answer to: a process dying between "approving" and recording the
delivery outcome. Retrying automatically could duplicate a non-idempotent write,
so it fails closed after 30 minutes and terminalizes the linked run with an
explicit reconciliation error.

**Recommendation:** keep Sublime's gate logic exactly as-is; add the persistence
and the queue around it. Replace the regex match with explicit approve/reject
actions, and keep the conversational path as a convenience. Add the reaper.
**Difficulty: medium.** Prerequisite: one new model + migration.

---

## 4. Assistant

The two are aimed at different jobs, so this is the least directly portable area.
Sublime's Assistant (`src/app/api/assistant/chat`, 345 lines, plus `sessions`,
`extract`, `workspace-context`, `intelligence-context`) is a *workspace* assistant
that can create agents. Backstory's is a 57-line **documentation** assistant over
a librarian retrieval layer.

Two gaps stand out regardless of that difference:

1. **No streaming.** Sublime's assistant chat route has no streaming path at all —
   the reply lands in one block after the full generation. This is the single
   most noticeable interaction difference against any modern assistant.
   **Difficulty: medium**, and it touches the structured-output path, which is
   the reason it is not trivial.

2. **No grounded citations.** Backstory retrieves from documented sources and
   renders numbered citations, with a system prompt that makes excerpts
   authoritative over the model's recollection and instructs it to stop rather
   than pad when sources run out (`src/lib/librarian/prompt.ts`). Sublime has no
   `help-center` equivalent and no citation UI. **Difficulty: medium–large**
   (needs a doc corpus before any of the retrieval matters).

---

## 5. Super-admin

Sublime has **no** `/admin` UI, no `/api/admin`, and zero hits for any
platform-role concept. What it does have is the right foundation: a closed
`Capability` union with a pure `can()` (`src/lib/server/permissions.ts`), routes
that must declare `requires`, `systemPrisma` for cross-tenant reads, and an
`AuditEvent` model.

### Blocker to clear first

`src/lib/supabase/auth-utils.ts:230-232` splices `role: 'ADMIN'` into any user
whose `createdAt` is at or before `2026-07-19T20:31:00Z`, on every request,
via a bare timestamp comparison (`src/lib/billing/entitlements.ts:21-23`). The
elevation is invisible in the database — `users.role` still reads `MEMBER` — and
`src/app/api/settings/members/route.ts:21` re-derives it independently.

Grandfathering the *entitlement* is intentional and should stay. Deriving an
*authorization role* from a row's creation date is a separate thing riding on the
same signal. Today the blast radius is one workspace, since `ADMIN` is org-scoped.
It stops being contained the moment a platform tier reads this normalized role —
which is exactly what the work below does. Anything that can influence a
`createdAt` (seed, import, restore, backfill) mints an admin.

**Fix:** use an explicit column as the marker rather than the date fallback.
**Difficulty: small.** Do this *before* any admin surface exists.

### Sequenced recommendations

1. **Platform tier as a second axis** — `User.platformRole` unioned with
   `Organization.kind`. Do *not* add `SUPER_ADMIN` to `UserRole`. The union means
   a reviewer who moves to a customer workspace loses rights with no flag to
   remember to clear. Sublime's `can()` is already the right shape; widen `Actor`
   to carry both and thread it from `src/lib/server/auth.ts`. **Small.**
2. **Hardcoded platform-owner identity + DB trigger.** A closed email list in
   committed code, no env union — an unset env var fails open — backed by a
   trigger so the invariant survives out-of-band writes. **Small.** Do it with #1.
3. **`LlmCall` cost ledger.** Sublime tracks only `inputTokens`/`outputTokens` on
   `AgentExecution`, has no cost column anywhere, and nothing at all on
   `FlowRun`. There is currently no way to answer "what does this customer cost
   us" or "which model is burning money". Needs a per-call ledger with provider,
   model, surface, cost, and a `priceVersion` stamp, plus a 90-day sweep.
   **Medium** — the schema is easy; instrumenting every call site is the work.
4. **`/admin/costs`.** Falls out of #3 almost free. **Small.**
5. **`/admin/users`.** The highest-value operator screen. **Medium.**

### Security constraints to carry over

- **Split moderation from operation from day one.** One permission meaning both
  "can review shared content" and "can read every user's PII and reset their
  password" gets granted for the first reason and exploited for the second.
- **`internalOnly` must 404 *before* auth**, not 403 after — a 403 confirms the
  route exists.
- **Audit privileged reads, not just writes.** Reading a whole platform's
  personal details is the consequential act; Sublime's `recordAudit` currently
  only fires on mutations.
- **Never let an admin route hand out a credential.** Password reset goes through
  the anon client's `resetPasswordForEmail`, never the service-role
  `generateLink`, so no credential reaches the operator, a response body, or a log.
- **`systemPrisma` is where tenant isolation ends.** Sublime's own
  `tenant-guard.ts` calls itself "a guardrail, not a security boundary". Backstory
  backs this with real Postgres RLS; Sublime does not. An admin surface on
  `systemPrisma` without RLS means the wrapper's permission check is the only
  thing between a bug and a full-platform read. Budget for RLS on the platform
  tables or accept that risk explicitly.
- **Order external and local state changes so failure is safe** — ban in Supabase
  *then* set `isActive: false`; the reverse leaves a live session on an account
  marked deactivated.

---

## Suggested order

1. Fix the date-derived ADMIN grant (small, unblocks everything, security).
2. `LibraryFilterBar` + derived roles (small, biggest visible payoff).
3. Approvals inbox + reaper (medium, closes a real correctness hole).
4. Platform tier + owner identity (small, prerequisite for admin).
5. Cost ledger → `/admin/costs` → `/admin/users` (medium).
6. Flow resource picker; workspace-wide run history (medium).
7. Assistant streaming (medium).
