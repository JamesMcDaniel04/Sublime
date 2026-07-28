# Goal work learning layer

**Date:** 2026-07-28
**Status:** approved, ready for planning

## Problem

The learning layer learns about the wrong thing.

`behavior/outcome-weights.ts` closes a real feedback loop, but it labels what
happened to a `UserSuggestion` — did the human accept our proposal to automate
something. Nothing anywhere learns from **what an agent produced**. The 3,700
lines across `behavior/` and `intelligence/` mine events, patterns and
correlations, and none of it can answer whether a specific piece of work helped.

`GoalWork` now records that: one row per subject, with a human disposition and
an outcome. This is a new signal class, not more of the same, and it is the
last unmet channel of the original directive — the goal should be accomplished
by agents, flows, templates **and the learning layer**, which should prove and
optimize its process while working toward the goal.

Sub-projects 1 (ledger), 2 (workroom) and the flow path are complete. This is
sub-project 4. Sub-project 3 (causal attribution with holdouts) stays separate.

## 1. Evidence capture

Two additions make a rule derivable. Neither alone is enough: skip reasons give
a complaint with no threshold, signals give a correlation with no stated cause.

### `log_work` gains `signals`

A flat object of why the agent picked this subject. It already knows — it read
the CRM to write the draft.

```ts
log_work({
  subject: 'Acme Corp — deal 412',
  signals: { daysCold: 21, stage: 'negotiation', contacts: 3 },
  …
})
```

Stored as `GoalWork.signals Json?`. Deliberately **flat and untyped**: every
department's subjects have different features, and a schema over them is a
taxonomy nobody maintains. The miner reads only numbers and short strings and
ignores anything else.

### Skip gains a one-tap reason

A closed vocabulary, so reasons are countable with no LLM:

```
too_early | wrong_contact | wrong_content | already_handled | not_relevant | other
```

`skipReason` already exists on the row and the PATCH route already accepts it —
the Skip button never sent one. Skip becomes two-step (Skip → reason chip);
`other` reveals an optional note.

### What the pair buys

- reasons alone → "people say too early ×5" — too early than *what*? no threshold
- signals alone → "skipped subjects had daysCold 4, 9, 11, 8" — no stated cause
- together → **"deals with `daysCold < 14` are skipped 6 of 7 times, reason
  `too_early` ×5"** — a rule you can write down, enforce, and later falsify

## 2. The rule model

```prisma
model GoalWorkRule {
  id             String    @id @default(cuid())
  organizationId String    @db.Uuid

  /// Level 1: goalId + resourceId both set — this agent, on this goal.
  /// Level 2: seedKey set, goalId and resourceId null — every deployment of
  /// this seed in this org. Promoted when the same lesson repeats on 2+ goals.
  goalId         String?
  resourceId     String?
  seedKey        String?

  /// The signal key it reasons about ('daysCold'). Used to dedupe and group
  /// for display — NOT to enforce.
  signal         String
  /// Rendered verbatim into the agent's prompt.
  statement      String

  skippedCount   Int
  totalCount     Int
  topSkipReason  String?

  status         String    @default("active") // active | retired
  /// Share of suppressed subjects the agent must draft anyway, as probes.
  exploreRate    Float     @default(0.2)

  learnedAt      DateTime  @default(now()) @db.Timestamptz(6)
  retiredAt      DateTime? @db.Timestamptz(6)
  retiredReason  String? // 'probes_contradicted' | 'unprobed'

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId, goalId, status])
  @@index([organizationId, seedKey, status])
  @@map("goal_work_rules")
}
```

`GoalWork` gains two columns in the same migration:

```prisma
  /// Flat, untyped features the agent used to pick this subject. See §1.
  signals        Json?
  /// Set when the agent drafts something an active rule would have
  /// suppressed. The entire falsification mechanism.
  probeForRuleId String?
```

`probeForRuleId` is what makes a rule testable: probes for a rule that come back
`used` are evidence against it, countable without parsing the statement. It is
deliberately not an FK — a retired rule's probes must stay readable as history.

**Both levels apply to a run.** `work-rules-port.ts` loads active Level-1 rules
matching `(goalId, resourceId)` *and* active Level-2 rules matching the agent's
`seedKey`, and the renderer lists them together. A Level-2 rule that a Level-1
rule contradicts is dropped in favor of the Level-1 one — the narrower
observation was made where the work actually happens.

### Why the statement is prose, not an enforced predicate

A structured `signal/comparator/threshold` triple would let code filter. But the
agent is the only thing that knows a subject's signals *before* it produces, and
it decides what to work on. Making code the enforcer would mean producing first
and discarding after — wasting exactly the work the rule exists to prevent.
`signal` remains a column purely so two rules about `daysCold` dedupe and
display together.

### Lifecycle

```
6 of 7 skipped, reason too_early ×5   →  rule learned, exploreRate 0.2
agent suppresses ~4 of 5, drafts 1 as a probe (probeForRuleId set)
     ↓
3 of 4 probes come back USED
     ↓
rule retired ('probes_contradicted'), the category is free again
```

Promotion to Level 2 needs the same `signal` learned on **2+ distinct goals** in
the org. Level-1 rules are never deleted by promotion.

## 3. The three tiers

### Tier 1 + 2 — one injected block

Rendered at run time beside `goalWorkSection` at `execute-agent.ts:866`:

```
## What your work has taught us

On this goal, your last 30 days: 18 produced · 14 used · 6 worked.
People skipped 4 — reasons: too early ×3, wrong contact ×1.

Rules you must follow:
- Do not draft deals cold under 14 days.
  (6 of 7 skipped, mostly "too early")
  Probe: draft roughly 1 in 5 of these anyway and pass
  probeRuleId "rul_8f2" to log_work, so we find out if this still holds.
```

Tier 1 is the stats sentence — deterministic, no LLM, present from the first run
with data. Tier 2 is the rules list, present only once a rule is earned.
`log_work` gains `probeRuleId`, which writes `GoalWork.probeForRuleId`.

### Tier 3 — propose, never act

Fires precisely when Tier 2 **fails**. If skips correlate with a signal you get
a rule and the agent keeps working. If they correlate with nothing, no rule is
derivable, and the honest conclusion is not "target better" but "this agent
produces more than the team can absorb." Those are opposite remedies, and which
one applies is decided by whether the evidence has structure.

That becomes a `UserSuggestion` on the existing surface with its existing
approval dialog:

> Signal-Based Sequence Personalizer produced 20 items last week and 15 were
> skipped, with no common reason. Halve its cadence to weekly?

Nothing in this spec mutates an agent's schedule or instructions. Cadence and
cost changes always need a human.

## 4. Files

| file | responsibility | I/O |
|---|---|---|
| `src/lib/goals/work-signals.ts` | correlate signals × disposition → rule candidates | pure |
| `src/lib/goals/work-rules.ts` | lifecycle decisions: earn, promote, retire | pure |
| `src/lib/goals/work-feedback.ts` | render the injected block from stats + rules | pure |
| `src/lib/goals/work-rules-port.ts` | load active rules for a run | DB |
| `src/lib/goals/run-work-learning.ts` | the weekly per-org tick that persists it | DB |

Four of five are pure, so every threshold and retire decision is unit-testable
without a database — the discipline `mine-peer-practices.ts` and
`aggregate-benchmarks.ts` already follow.

`cron/dispatch/route.ts:479` already fires
`void runBehaviorIntelligence(organizationId).catch(() => undefined)` per org.
`runGoalWorkLearning(organizationId)` goes beside it in the same best-effort
shape — a learning failure must never break the tick that also drives goal
refresh.

## 5. The algorithm

A **one-split decision stump**, because that is exactly the shape of the
statement we want. For each numeric signal, try every midpoint between observed
values and pick the split that best separates skipped from used. For categorical
signals, count per value. This yields "under 14 days" rather than a correlation
coefficient nobody can act on, and it is deterministic and testable.

| constant | value | why |
|---|---|---|
| `MIN_RULE_SAMPLE` | 5 subjects in the band | below this, one bad week invents a rule |
| `MIN_SKIP_RATE` | 0.7 of the band skipped | a rule should be nearly always right |
| `EVIDENCE_WINDOW` | 90 days | long enough to accumulate, short enough to stay current |
| `STATS_WINDOW` | 30 days | what Tier 1 reports |
| `PROMOTE_GOALS` | 2 distinct goals | one goal's quirk is not an org lesson |
| `EXPLORE_RATE` | 0.2 | ~1 in 5 suppressed subjects drafted as a probe |
| `RETIRE_PROBE_MIN` | 2 probes used | evidence against, not a single fluke |
| `RETIRE_PROBE_RATE` | 0.5 probe used-rate | half landing means the rule is wrong |
| `UNPROBED_TTL` | 60 days | see §6 |
| `CADENCE_SKIP_RATE` | 0.6 over ≥10 items | Tier 3 trigger, only when no rule is derivable |

## 6. Failure modes

- **The agent never sends `signals`.** No rules are derivable. Tier 1 still
  reports the funnel and skip reasons, so the block degrades to informative
  rather than breaking. This is the expected day-one state and must not read as
  an error.
- **The agent ignores the probe instruction.** A rule could then never be
  falsified — the calcification this design exists to prevent, reintroduced
  through non-compliance. So **a rule with zero probes after `UNPROBED_TTL`
  retires with reason `unprobed`**. Never keep a belief you have stopped
  testing, even when the reason you stopped was an agent not cooperating.
- **All skips are `other`.** No reason signal, but a signal *split* may still
  exist — the stump runs on signals, not reasons. The reason only enriches the
  statement.
- **Signal keys drift** (`daysCold` vs `days_cold`). Keys compare verbatim; a
  key seen fewer than `MIN_RULE_SAMPLE` times is never a candidate, so drift
  self-limits instead of producing junk rules.

## 7. Tests

- **Pure, the bulk of it** — split selection including exact ties and a signal
  that does not separate at all; the sample and skip-rate floors; categorical
  counting; promote on 2 goals but not 1; retire on probe evidence; retire on
  the `unprobed` TTL; the renderer's four states (no data → empty string, stats
  only, stats + rules, rules with a probe instruction carrying the real rule id).
- **Real Postgres** — the cron runner writes rules and retires them from probe
  evidence, and every query is org-scoped: a second org with identical signals
  must never earn the first org's rule.
- **Tool** — `signals` and `probeRuleId` land on the row; a `probeRuleId` naming
  a rule from another org is refused, not silently stored.
- **Component** — Skip becomes two-step and sends the chosen reason; `other`
  reveals the note field.

## Out of scope

- Cross-org k-anonymous learning (Level 3) — its own consumer (template
  curation) and its own privacy review.
- Autonomous mutation of agent config. Tier 3 proposes; a human accepts.
- An LLM anywhere in the miner. Every tier here is deterministic and countable.
- Causal attribution (#3). The funnel still says *used* and *worked*, never
  *caused*.
