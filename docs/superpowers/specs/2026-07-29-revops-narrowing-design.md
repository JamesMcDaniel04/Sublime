# Narrowing goals to RevOps

**Date:** 2026-07-29
**Status:** approved, ready for planning

## Segment

RevOps teams at companies under 500 people, with revenue teams under 50. That
is typically 1–3 people who own the revenue *process* as a system while
everyone around them owns a number.

Their chronic, unsolved pain is **rollout → adoption**. They announce a play on
Monday ("multithread anything over $50k", "inbound gets worked in 24 hours"),
put it in a Notion doc, and have no instrumentation on whether anyone runs it.
They find out at QBR, when the number misses.

`produced → used → worked` measures exactly that, and measures it without
asking a rep to self-report, because the disposition is the side effect of
copying or skipping. That is the wedge.

## What is wrong today

- **44% of the catalogue is aimed at someone who is not the buyer.** 4 of 9
  sales templates are `personal` scope — "Hit my quarterly quota", "Revive
  every stalled deal", "Follow up before the day ends". A RevOps person carries
  no quota and works no deals. Across all 45 templates it is 20.
- **There is no RevOps home.** `PRODUCT_DEPARTMENTS` is
  `sales | engineering | marketing | finance | csm`. RevOps spans sales,
  marketing and CS by definition, so the buyer lands on "Sales".
- **The funnel groups by agent, never by rep.** `work-stats.ts` buckets by
  `resourceId` — which agent produced it. `assigneeUserId` is on every
  `GoalWork` row already, so "which of my reps is running this play" is one
  `groupBy` away and currently unanswerable.

## Non-goals

No new templates, tables, or agent capabilities. This is a repositioning of
what exists. Explicitly not a forecasting tool, a CRM replacement, or a BI
product.

## 1. The RevOps lens

`PRODUCT_DEPARTMENTS` does not change — it is a data taxonomy, and RevOps is
not a department but a lens across three of them. The gallery gains one filter:

```ts
// Not a department — a view over the three revenue-owning ones, narrowed to
// the standards a process owner rolls out rather than a rep's own targets.
const REVOPS_LENS = (t: GoalTemplate) =>
  ['sales', 'marketing', 'csm'].includes(t.department) &&
  t.scope === 'org' &&
  t.motion === 'action'
```

It yields exactly 8 of the 27 templates in those departments. Tab row becomes
`All teams · RevOps · Sales · Marketing · Engineering · Finance · CS`. `all`
stays the default — a second inference for the default tab is over-thinking a
one-click change.

### Copy: task → standard

The names are imperatives today — a rep's to-do. A play is a standard the team
is held to. Keys never change, so bookmarked `/goals/new?template=` links are
untouched.

| key | today | as a standard |
|---|---|---|
| `sales-org-multithread-open-deals` | Multithread every open deal | Every open deal is multithreaded |
| `sales-org-qualify-inbound-same-day` | Qualify every inbound within a day | Inbound is qualified within a day |
| `sales-org-close-plan-on-commit` | A close plan on every commit deal | Every commit deal has a close plan |
| `sales-org-work-the-whitespace` | Work the whitespace list | Whitespace gets worked every week |
| `marketing-org-work-every-event-lead` | Work every event lead within a week | Event leads are worked within a week |
| `marketing-org-brief-every-launch` | A readiness brief before every launch | Every launch has a readiness brief |
| `csm-org-plan-every-new-account` | A plan for every new account | Every new account starts with a plan |
| `csm-org-close-every-adoption-gap` | Close every adoption gap | Adoption gaps get closed |

"Multithread every open deal" is something you do. "Every open deal is
multithreaded" is something you can be **failing at** — which is what RevOps
buys a tool to find out.

Descriptions are reframed the same way: what good looks like and who is held to
it, rather than what an individual should go do.

The 20 personal templates are unchanged and stay available to reps. They are
simply not in the buyer's tab.

## 2. The adoption view

### `byAssignee`

`computeWorkStats` gains `byAssignee` alongside `byAgent` — the same funnel
math, a different bucket. `WorkStatRow` gains `assigneeUserId` and
`assigneeName`; the work route resolves names from `User`, which it already
queries for assignee resolution.

```
Every open deal is multithreaded          this month

Team          24 produced → 17 used (71%) → 6 worked
──────────────────────────────────────────────────────
Dana Reed       8 →  8   (100%)
Sam Diaz        9 →  7    (78%)
Alex Chen       7 →  2    (29%)
Unassigned      3 →  0
```

`Unassigned` stays its own row rather than folding into a total: work nobody
owns does not get done, and at this size that is usually a routing gap RevOps
can fix in an afternoon. It is a process finding, not a rep finding.

### Two front doors, one boolean

The work route returns `viewerHasWork` — does the viewer have open assigned
items on this goal. The workroom renders queue-first when true, adoption-first
when false. Both always render.

No new field, no config step, and it is behaviourally true: the person with no
assigned work is the person watching the process. It also handles the common
small-company case of a RevOps lead who carries a small book — they see their
queue first and the team below it.

`UserRole` is deliberately NOT used. It is `ADMIN | USER`, a permissions
concept; keying on it would conflate "can change settings" with "owns the
process", which breaks both ways — the RevOps hire is often a `USER` and the
`ADMIN` is often an engineer.

### The stance that keeps it usable

A per-rep table is one design decision from a surveillance product, and at a
40-person revenue team where RevOps sits next to the reps, a dashboard that
reads as a narc tool gets quietly disabled — taking the disposition signal, and
the wedge, with it.

So the copy points at the process, not the person:

- lead with the team number, not the leaderboard
- order reps by volume, never rank them
- never use the word "compliance"
- put a rep's skip reasons directly beside their number

That last one matters most. "Alex 7→2, all skipped 'too early'" is a targeting
bug, not a performance issue — and nine times in ten the pairing shows the play
is wrong rather than the rep.

## 3. Rules as playbook findings

A rule has two audiences and today speaks only to one.

`statement` is unchanged — it is injected verbatim into the agent's prompt and
must stay directive. The strip renders the same fields as a finding for the
human:

```
What your team is telling you

Deals under 14 days cold — skipped 6 of 7, mostly "too early"
  Signal-Based Sequence Personalizer · learned 20 Jul        [Turn off]

Prospecting-stage deals — skipped 9 of 10, mostly "not relevant"
  Org-wide · learned 10 Jul                                  [Turn off]

In their words
  "The account merged last week, so this is moot."
  "We already have an exec sponsor here — this is redundant."
```

Three shifts. The heading stops being about robots. The imperative becomes an
observation about entry criteria — a qualification finding, which is a RevOps
artifact rather than an agent config detail. And the `skipNote` verbatims
become the highest-signal thing on the page: unprompted rep feedback on the
playbook, which RevOps otherwise gathers by hand from win/loss decks twice a
year.

### The one thing this does store

The finding phrasing cannot be derived from the fields a rule already carries.
`signal` is `daysCold`; the threshold `14` exists only inside the prose of
`statement`. Reconstructing "deals under 14 days cold" at render time would
mean parsing an English sentence the miner wrote — fragile, and it breaks the
moment the statement's wording changes.

So `GoalWorkRule` gains one nullable `finding` column, written by the miner at
the same moment it writes `statement`, from the same `signal` and split it
already has in hand:

```ts
statement: `Do not work subjects whose ${signal} is under ${split}.`   // the agent
finding:   `${signal} under ${split}`                                  // the human
```

One column, one line in `work-signals.ts`, no parsing. Rules learned before
this ships have `finding: null` and fall back to rendering `statement`, so
nothing breaks and no backfill is needed.

Goal-wide skip reasons and recent notes come from the same work GET that
already returns rules.

## 4. Positioning

**Value prop:** Roll out a play. See who ran it. Learn what to change.

**Positioning line:** For RevOps teams under 500 people, Sublime instruments the
plays you roll out — so you know who ran them, who didn't, and what your team is
telling you about your ICP.

**Why it is defensible:** every adoption metric RevOps has today is
self-reported — logged activity, ticked tasks, a box a rep checks because a
manager asked. Reps optimize those and everyone knows it. `disposition` is not a
report; it is the side effect of the action. That claim is hard to copy without
building the workroom.

## 5. Tests

- **Pure** — `REVOPS_LENS` selects exactly the 8 org-scope action templates in
  sales, marketing and CS, and no personal-scope or outcome template ever
  passes it; `computeWorkStats` buckets by assignee including a null-assignee
  bucket, and its funnel math matches `byAgent` on the same rows.
- **Route** — `viewerHasWork` is true only when the viewer has *open* assigned
  items (a used or skipped item must not count); `byAssignee` names resolve,
  and a deleted user degrades to a label rather than throwing.
- **Component** — the workroom renders adoption first when `viewerHasWork` is
  false and queue first when true, and both always render; the rules strip
  shows the finding phrasing rather than the imperative, falls back to
  `statement` when `finding` is null (rules learned before this ships), and
  renders `skipNote` verbatims when present.
- **Miner** — `findRuleCandidates` returns a `finding` alongside every
  `statement`, for both the numeric and categorical branches.
- **Catalogue** — the 8 renamed templates keep their keys, so the legacy-key
  test and every bookmarked link stay green.

## Out of scope

- New templates, tables, or agent capabilities.
- Changing `PRODUCT_DEPARTMENTS` or the 5-org/4-personal per-department split.
- Rewriting personal-scope templates — reps remain the daily active users.
- Any change to how rules are earned, promoted, or retired.
