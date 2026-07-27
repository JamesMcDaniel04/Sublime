# Goal ↔ Agent Bundles — Design

**Date:** 2026-07-27
**Status:** Approved for planning

**Sub-project 2** of the "goals leverage AI" arc declared in
`2026-07-26-goal-recovery-plans-design.md`, and slice 2 of the current request:

| Slice | Scope | State |
| --- | --- | --- |
| 0 | Company logos on every metric-source surface | Shipped, `8021f7e` |
| 1 | `native:sublime-goals` tool plane | Shipped, `c3039cd..23dd710` |
| 2 | Goal-template ↔ agent bundles + goal-page deploy UI | **This spec** |

## Problem

A goal template today defines a number and a dashboard. Nothing in it *works on*
the goal. The user's framing: "the current goal templates are just integrations,
with values and a date, but nothing to really run daily to help do something to
achieve the goal."

The catalogue already holds ~85 agent/flow seeds, and `SeedTemplate.goalKinds`
was built to match them to goals — but only 6 seeds declare it, covering
`revenue | arr | mrr | quota | lead_gen`, while 28 of 45 goal templates are
`custom_kpi` and 5 are `savings`. For roughly 33 of 45 goal templates the matcher
returns nothing.

Slice 1 gave agents the ability to perceive and update a goal. This slice
connects the two catalogues and puts the result in front of the user.

## Decision summary (from brainstorming)

- **Deploy moment:** the goal detail page, after creation. The 3-step create
  wizard is untouched.
- **Bundle lookup:** persist `Goal.templateKey`, fall back to kind-matching for
  Copilot-drafted and manual goals.
- **Curation depth:** populate `agents` where an existing seed genuinely fits;
  an explicit `[]` where none does.
- **Goal-native seeds:** three — Pace Auditor, Metric Collector, Period Close
  Reporter.
- **Pre-creation visibility:** the template detail dialog gains a "Works on it"
  section; the gallery card gains an agent-count chip.

## What already exists (and must not be rebuilt)

Named explicitly because two obvious seed ideas are already-shipped features:

- **Diagnosing why a goal is off track** is `src/lib/goals/recovery.ts` — the
  sibling sub-project on this branch. No "blocker finder" seed.
- **Weekly goal pace by email** is `src/lib/goals/digest.ts`. No "weekly digest"
  seed.
- **Attribution** is derived from run records by `goalImpact()`. Nothing records
  contributions manually.
- **Deployment** is `POST /api/templates/provision`, which already materializes
  the agent, creates the `GoalContribution` with a calibrated
  `estimatedMinutesSavedPerRun`, and treats a duplicate link as idempotent.
- **Readiness** is `missingIntegrations(required, connected)` and
  `connectedSlugSet(tools)` in `src/lib/templates/relevance.ts`.

## Data model

One migration: a nullable column.

| Model | Field | Notes |
| --- | --- | --- |
| `Goal` | `templateKey String?` | The `GoalTemplate.key` this goal was created from. Null for Copilot-drafted and manually-created goals. Set by `POST /api/goals`; never edited afterward. |

No other schema change. In particular, "which bundle entries are already
deployed" needs no new storage: `GoalContribution.seedKey` already records the
seed behind each link (added for estimate calibration), and the goal detail page
already loads contributions.

### `GoalTemplate.agents`

`agents: string[]` becomes a **required** field on `TemplateSpec` in
`src/lib/goals/goal-templates.ts`. Required-but-possibly-empty is the point:
omitting it is a compile error, while writing `[]` is a deliberate statement that
no existing seed fits this goal. Without that distinction, "curated as empty" and
"nobody got to it" are indistinguishable and untestable.

Entries are `SeedTemplate.seedKey` values drawn from the goal template's own
department pool (each department has ~14 seeds for 9 goal templates), so a
curator chooses from a short, relevant list rather than all 85.

## Bundle resolution

New pure module `src/lib/goals/agent-bundle.ts`. Zero I/O, so the ranking and
applicability rules are exhaustively unit-testable.

```text
bundleForGoal({ templateKey, kind, source, recurrence, deployedSeedKeys })
  → BundleEntry[]
```

`BundleEntry` = `{ seedKey, name, description, requiredIntegrations, origin,
conditional, deployed }` where `origin` is `'curated' | 'goal_native' |
'kind_match'`.

Composition, in display order:

1. **Curated** — `goalTemplateByKey(templateKey)?.agents`, in listed order.
2. **Goal-native** — the three new seeds, filtered by applicability below.
3. **Fallback** — `goalTemplatesFor(kind)`, included **only when the curated
   list is empty or absent**. This is what serves Copilot-drafted and manual
   goals, and template goals whose `agents` is a deliberate `[]`.

Deduped by `seedKey`, first occurrence wins. Entries whose `seedKey` appears in
`deployedSeedKeys` are marked `deployed: true` and rendered as already-deployed
rather than dropped, so the card shows the full bundle and its state.

### Applicability

Applicability rules mirror slice 1's write policy exactly, so the UI never offers
an agent whose first tool call would refuse:

| Seed | Offered when |
| --- | --- |
| Pace Auditor | always |
| Metric Collector | goal's metric `source` ∈ `manual`, `slack_assisted`, `gmail_assisted` — the same set `canWriteDatapoint()` permits |
| Period Close Reporter | goal has a non-null `recurrence` |

`source` is `string | null`. **Null means "not yet known"** — the pre-creation
case, where the user has not picked a metric source yet. With a null source,
Metric Collector is included with `conditional: true`, and the detail dialog
renders it with the qualifier "if you track this goal manually or with AI-read".
`recurrence` is always known pre-creation (it comes from the template), so Period
Close Reporter is never conditional.

## The three goal-native seeds

Added to the seed catalogue as ordinary `SeedTemplate`s, so they flow through the
existing provision, adoption-ranking and readiness machinery unchanged. Each
declares `'goals'` in its **`integrations`** list, which is what activates the
`native:sublime-goals` plane via the descriptor's `matches: has('goal')`.

**`'goals'` must never appear in `requiredIntegrations`.** Readiness is computed
by `missingIntegrations(required, connected)` against the workspace's *connected*
slugs, and the goals plane has no connection to make — its descriptor is
`available: () => true`, scoped by `GoalContribution` rather than by credentials.
Listing it as required would leave every goal-native seed permanently blocked on
an integration that cannot be connected. `combinedAgentSpec()` in the provision
route unions `integrations`, `requiredIntegrations` and `recommendedIntegrations`
onto the materialized agent, so the plane still activates from `integrations`
alone.

### Goal Pace Auditor

- `departments`: all five; `kind`: `agent`; schedule: daily
- `integrations`: `['goals']`; `requiredIntegrations`: `['slack']`
- Reads `get_pace`. When the goal is behind, posts a Slack message naming the
  current value, the expected pace, the gap, and the run-rate now required to
  finish on time. Says nothing when on track — a daily "still fine" post trains
  people to ignore it.
- `estimatedMinutesSaved`: 10

### Goal Metric Collector

- `departments`: all five; `kind`: `agent`; schedule: daily
- `integrations`: `['goals']`; `requiredIntegrations`: `[]`;
  `recommendedIntegrations`: `['slack', 'gmail']`
- `deliversToGoal: true` — **the one delivery-exempt seed in the catalogue.**

`normalizeDelivery()` forces a Slack (or Gmail) delivery integration into every
seed's `requiredIntegrations`, which is why all 80 existing seeds require one.
That is right for agents whose output is a message, and wrong for this one: its
output is a datapoint written back to the goal, so it has nowhere to deliver and
nothing to connect. A new optional `SeedTemplate.deliversToGoal` flag makes
`normalizeDelivery` pass the seed through untouched, and the catalogue-wide
delivery invariant in `catalogue.test.ts` exempts flagged seeds.

The flag is declared on the seed rather than kept as an exemption list in
`catalogue.ts`, which would require a circular value import from
`goal-native-seeds.ts`. It also reads as a statement about the agent rather than
as a special case.

Consequence, accepted: Pace Auditor and Period Close Reporter both genuinely post
messages and normalize to Slack as usual. Metric Collector is therefore the agent
that keeps "every goal has something deployable with zero integrations" true.
- Reads the source named in its instructions (a Slack channel, a mailbox, or a
  URL), extracts the current value, and calls `log_datapoint`. The only consumer
  of slice 1's write path, and the only way a number living outside an
  integration reaches the goal automatically.
- Refuses by construction on system-of-record goals — the tool plane rejects the
  write — which is why applicability restricts it to writable sources.
- `estimatedMinutesSaved`: 15

### Period Close Reporter

- `departments`: all five; `kind`: `agent`; schedule: monthly
- `integrations`: `['goals']`; `requiredIntegrations`: `['slack']`
- Runs on a monthly cadence regardless of the goal's own recurrence, and its
  first act is to check whether a period actually closed since it last ran —
  a quarterly goal simply produces nothing on two runs out of three. Scheduling
  per-goal-recurrence would mean three seed variants for one behavior.
- Summarizes the period just closed: final value vs the frozen target, whether
  it settled achieved or missed, and the delta against the prior period.
  Distinct from the digest, which is a weekly cross-goal email of current pace,
  not a per-goal period retrospective.
- `estimatedMinutesSaved`: 20

## Surfaces

### Template gallery card

`GoalTemplateCard` gains one chip in the existing `tools` slot: "N agents",
where N is the bundle size computed with `source: null`. No layout change beyond
the chip.

### Template detail dialog

`GoalTemplateDetail` gains a "Works on it" section directly after "Reads from",
using the same row treatment: the agent's name, its one-line description, and its
required integrations as `IntegrationChip`s. Conditional entries carry their
qualifier. This section is **display only** — no deploy control before the goal
exists.

### Goal detail page

New `AgentBundleCard`, mounted after the soft-source nudge and before
`GoalDashboard`. For each entry:

- **Deployable** (all required integrations connected) → a Deploy button.
- **Blocked** → dimmed, with the missing tools named from
  `missingIntegrations()` and a link to `/integrations`. Deploy disabled. This
  matches how the metric-source picker and template cards already present
  unavailable options.
- **Deployed** → a check and a link to the agent.

Deploy posts `{ seedKey, goalId }` to `/api/templates/provision` and reloads,
the same two-step the recovery strip already uses. The card renders nothing when
the resolved bundle is empty.

## Testing

Pure-unit on `bundleForGoal`, plus component tests matching the existing goals
component-test style.

| Test | Asserts |
| --- | --- |
| Referential integrity | Every `seedKey` in every `GoalTemplate.agents` across all 45 templates resolves through `getSeedByKey` |
| Goals is never required | No seed anywhere in the catalogue lists `'goals'` in `requiredIntegrations` — it has no connection to make, so requiring it would block the seed forever |
| Delivery exemption is minimal | Exactly one seed sets `deliversToGoal`; every other seed still normalizes to a Slack or Gmail delivery integration |
| Curated ordering | Curated entries precede goal-native, which precede fallback |
| Fallback gating | `kind_match` entries appear only when curated is empty/absent |
| Collector applicability | Offered for the three writable sources, withheld for all six system-of-record sources |
| Collector conditionality | `source: null` yields `conditional: true`, not exclusion |
| Reporter applicability | Withheld when `recurrence` is null |
| Dedupe | A seed both curated and kind-matched appears once, as `curated` |
| Deployed marking | A seedKey in `deployedSeedKeys` is marked, not dropped |
| Empty bundle | Card renders nothing rather than an empty shell |

## Out of scope

- Deploying from the create wizard — the deploy moment is the goal page
- Bulk "deploy all" — one deliberate deploy at a time
- Per-workspace bundle editing
- Broadening `goalKinds` beyond what the fallback path needs
- Any change to recovery plans, the digest, or attribution
