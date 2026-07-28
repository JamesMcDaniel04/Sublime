# Goal work ledger and workroom

**Date:** 2026-07-28
**Status:** approved, ready for planning

## Problem

Goals tracks numbers. It does not track work.

The data model is `Goal → GoalMetric → MetricDatapoint` for the number, plus
`GoalContribution` — an attachment edge carrying `estimatedMinutesSavedPerRun`,
a constant a human typed. No row anywhere records that an agent produced a
specific thing for a goal, who it was for, or what became of it.

That absence has three consequences:

- `impact.ts` proves **hours saved**, not **goal advanced**. Its tiers are
  `measured` (runs, tokens, seconds), `estimated` (hours × a rate), and
  `correlated` (`paceDeltaPct`) — and that last is the only link between agent
  work and goal outcome. A correlation, not a record.
- The learning layer — `behavior/` and `intelligence/`, ~3,700 lines mining
  events, patterns, correlations and outcome weights — has **no goal-outcome
  signal to learn from**. It cannot optimize a process toward a goal because
  nothing records whether any individual piece of work helped.
- The goal page is a dashboard. There is nowhere the work actually happens.

The objective is not to surface metrics, raise warnings, or connect more
integrations. It is to make the goal something agents, flows, templates and the
learning layer **accomplish**, with a record good enough to prove and improve
the process while it runs.

## Scope

This is one of four sub-projects. This spec covers the first two together,
because neither is useful alone:

1. **Work ledger** — a record of each unit of work done toward a goal (this spec)
2. **Workroom** — the surface that produces and consumes those records (this spec)
3. **Process proof** — causal attribution and holdout experiments (later)
4. **Optimization loop** — the learning layer retuning agents from dispositions (later)

## 1. The record

```prisma
model GoalWork {
  id             String    @id @default(cuid())
  organizationId String    @db.Uuid
  goalId         String

  /// Provenance. runId groups one run's whole batch — no second table needed.
  /// It is an AgentExecution.id or a FlowRun.id depending on resourceType,
  /// deliberately not an FK: work outlives run pruning.
  resourceType   String    // 'agent' | 'flow'
  resourceId     String
  runId          String?

  subject        String    // "Acme Corp — deal 412"
  /// Stable external id. The dedupe key; null means never deduped.
  subjectRef     String?
  produced       String    // "re-entry email"
  body           String?   @db.Text
  /// Renders through the existing Markdown / HtmlPreview components, the same
  /// pair the template detail page already uses for agent output.
  bodyFormat     String    @default("markdown") // 'markdown' | 'html'

  assigneeUserId String?   @db.Uuid

  /// What a human did with it. Always knowable, captured at the moment of use.
  disposition    String    @default("pending") // pending | used | edited | skipped
  dispositionBy  String?   @db.Uuid
  dispositionAt  DateTime?
  skipReason     String?

  /// Whether it landed. Filled later by a human or an agent, or never.
  /// Deliberately separate from disposition: "a person liked the draft" and
  /// "it moved the goal" are different facts and must never be conflated.
  outcome        String    @default("unknown") // unknown | worked | no_response | failed
  outcomeSource  String?   // 'agent' | 'human'
  outcomeNote    String?
  outcomeAt      DateTime?

  createdAt      DateTime  @default(now()) @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  goal         Goal         @relation(fields: [goalId], references: [id], onDelete: Cascade)

  @@index([organizationId, goalId, disposition])
  @@index([goalId, assigneeUserId, disposition])
  @@index([goalId, resourceId])
  @@map("goal_work")
}
```

### `body` lives on the row

Not a reference into execution output. Execution messages get pruned, and the
workroom must still render a three-week-old artifact when you are reviewing
what worked.

### Dedupe is a partial unique index

Migration-managed, on `(goalId, subjectRef) WHERE disposition = 'pending' AND
subjectRef IS NOT NULL`. Same discipline `GoalRecoveryPlan` uses for "at most
one open plan per goal" and `GoalMetric` uses for one-primary.

Without it, an agent on a daily cron redrafts the same eight stalled deals
every morning and the queue is unusable by Thursday. With it, a subject can
have only one item awaiting a human at a time — but once handled, a fresh item
may be created later, which is correct for a deal that stalls twice.

Prisma cannot express a partial unique index, so it ships as raw SQL in the
migration, and its behavior is proven against a real Postgres (§5). `Goal` and
`Organization` each need a back-relation field added for the schema to compile.

### Authorization needs nothing new

`resolveLinkedGoalIds` in `goals-port.ts` already resolves an agent's reachable
goals from `GoalContribution`, and its comment states it is "the ENTIRE
authorization input." Work writes inherit that scope unchanged.

## 2. How agents write it

Two tools join the four in `goals.ts`; `GoalsDataPort` gains two methods.
`GoalsToolClient` stays database-free and unit-testable exactly as it is.

```
log_work   Record one thing you produced toward this goal. Call it once per
           subject — one row per deal, lead or account, never one per run.
           { goalId?, subject, subjectRef?, produced, body, bodyFormat?,
             assigneeHint? }

list_work  What is already queued for this goal, newest first, with each
           item's disposition and outcome. Read it before producing so you
           do not redraft something a human has not dealt with, and so you
           can see what was skipped and stop producing that kind of thing.
           { goalId?, disposition? }
```

`list_work` is not politeness. It is how an agent avoids fighting the dedupe
index, and it is the cheapest possible optimization loop: an agent that reads
`disposition: skipped` on its last five items for deals under 14 days cold can
stop drafting them with no learning-layer machinery at all.

### `log_work` carries no write policy

`agent-tool-policy.ts` restricts `log_datapoint` to `manual`/`slack_assisted`/
`gmail_assisted` because a system of record owns the number and a model's guess
must never overwrite a synced Stripe reading. **Work has no system of record —
the agent is the author.** That allowlist is exactly the wrong shape here.
`log_work` is permitted on any linked goal, including Stripe-backed ones.

### `assigneeHint` resolution

The agent passes a name or email it already read from CRM while writing the
draft. The server resolves it against org members. An unresolvable hint yields
`assigneeUserId: null` and the item lands in the Unassigned pool — an agent
guessing a stranger's name must never fail a run.

## 3. The workroom

### The goal page inverts

Today: composition strip → recovery strip → agent bundle → dashboard. All four
are about the number. The workroom goes above the dashboard:

```
Goal header + status
Workroom              ← new, primary
Put agents to work    ← the supply side, unchanged
Dashboard             ← the number, demoted
Recovery plan         ← when off track, unchanged
```

New components under `src/components/goals/workroom/` — `work-queue.tsx`
(filters + list), `work-item.tsx`, `work-outcome-prompt.tsx`,
`work-funnel-strip.tsx`. Their own directory because `components/goals/` is
already 25 files.

```
GOAL · Revive every stalled deal              this month 3 / 12
┌─ Work ────────────────────────────────────────────────────┐
│ [Mine 6]  [Unassigned 3]  [All 24]  [Done 11]             │
│                                                            │
│ ● Acme Corp — deal 412              re-entry email        │
│   "Following up on the pricing question from our 3/14…"    │
│                              [Copy] [Edit] [Skip] [⇄ Dana] │
│                                                            │
│ ● Initech — deal 88                 re-entry email        │
│   unassigned                        [Claim] [Copy] [Skip]  │
└────────────────────────────────────────────────────────────┘
┌─ Did these land? ── 4 sent over a week ago ───────────────┐
│ Globex deal 21 · sent 3/19    [Worked] [No response]      │
└────────────────────────────────────────────────────────────┘
```

### The action is the disposition

No separate marking step to forget:

| action | writes |
|---|---|
| **Copy** (artifact to clipboard) | `disposition: used` |
| **Edit** → save | `disposition: edited`, new `body` |
| **Skip** | `disposition: skipped` + optional `skipReason` |
| **Claim / assign** | `assigneeUserId` |
| **Worked / No response** | `outcome`, `outcomeSource: 'human'` |

Copy is the honest primary action: sending via a connected channel is out of
scope, and a seller genuinely works by pasting a draft into their mail client.
A **Send** action is a natural later addition that nothing here blocks.

### Outcome is prompted, never chored

Used or edited items older than **7 days** with `outcome: 'unknown'` collect
into the "Did these land?" strip — two taps, no navigation. That is the entire
mechanism for populating outcome without polling a CRM.

### Empty state points at supply

A goal with no work says so and links to the agent bundle directly below. The
two sections explain each other, and it is the honest answer to "why is my
workroom empty."

### Routes

Following the existing `withAuthenticatedApi` shape used by
`src/app/api/goals/[id]/route.ts`:

- `GET /api/goals/[id]/work` — filtered list (`mine` | `unassigned` | `all` | `done`)
- `PATCH /api/goals/[id]/work/[workId]` — disposition, outcome, assignee, body

## 4. Reading it back

One pure module, `src/lib/goals/work-stats.ts` — a funnel over rows, no I/O:

```
produced → used → worked
```

Rendered as a strip at the top of the workroom, **not** as a dashboard widget.
A widget type would mean touching `dashboard.ts`, six layout presets,
`parseDraftLayout` and their tests — real cost for no gain, since this belongs
beside the work rather than inside the number's dashboard.

```
┌─ This month ──────────────────────────────────────────┐
│ 24 produced   →   17 used (71%)   →   6 worked (35%)  │
│                                                        │
│ Signal-Based Sequence Personalizer  18 → 14 → 6       │
│ Account Intent Brief                 6 →  3 → 0       │
└────────────────────────────────────────────────────────┘
```

The per-agent breakdown is the payoff: it answers "which of my agents is
actually worth running" from recorded fact, which nothing in the product can do
today.

It is **descriptive, not causal**. No attribution, no holdouts. Those are
sub-project #3 and would be dishonest to imply from these counts. The copy says
"used" and "worked", never "caused".

## 5. State machine and invariants

```
pending ──Copy──→ used   ─┐
pending ──Edit──→ edited ─┴──Worked / No response──→ outcome set
pending ──Skip──→ skipped   (terminal — outcome stays unknown forever)
```

**`outcome` may only be set on `used` or `edited`.** A skipped item was never
sent, so nothing could have landed; permitting an outcome on it would corrupt
the funnel's denominator and make a process look better or worse than it was.
The PATCH route refuses that transition.

Other refusals: un-skipping a skipped item, dispositioning by a non-member,
any cross-org access.

Skipped items are excluded from the outcome denominator but counted in
`produced`, so a high skip rate correctly reads as a targeting problem rather
than disappearing.

## 6. Tests

- **Pure** — `work-stats.ts`: zero denominators, per-agent grouping, skipped
  items excluded from the outcome denominator but present in `produced`.
- **Tool client** — `log_work`/`list_work` refuse goals outside
  `resolveLinkedGoalIds`, mirroring the existing `GoalsToolClient` scoping
  tests. Client stays DB-free via a fake port.
- **Route** — every illegal transition refused: outcome on a skipped item,
  un-skipping, disposition by a non-member, cross-org access.
- **Real Postgres** — the partial unique index is the one claim unit tests
  cannot prove. Two pending items with the same `subjectRef` must be rejected;
  after the first is dispositioned, a new one must be allowed. Uses the
  throwaway-Postgres protocol from the `verify` skill.
- **Component** — filter tabs, action→disposition mapping, the outcome prompt
  appearing only for used/edited items older than 7 days, empty state linking
  to the bundle.

## Out of scope

- Causal attribution and holdout experiments (#3).
- The learning layer reading dispositions to retune agents (#4).
- Sending from the workroom via a connected channel.
- Changing `impact.ts`. It keeps reporting hours-saved as it does now. Once the
  measured funnel and the estimate render on one page, the estimate will have
  to justify itself — that pressure is intended, but rewiring it is not this
  spec.
- Polling integrations to detect outcomes.
