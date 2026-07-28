# Action-motion goal templates

**Date:** 2026-07-28
**Status:** approved, ready for planning

## Problem

The goal template gallery reads as a dashboard catalogue. Every one of the 45
templates leads with a number and a data source — `Pipeline coverage ratio`,
`Improve win rate`, `Reads from: HubSpot, Salesforce, Google Sheets`. A seller
opening it finds things to *measure*, not work to *do*.

The agents that do the work already exist. `catalogue-expansion.ts` carries ten
per department, and the sales ten are pure action: Mutual Action Plan Generator,
Buying Committee Mapper, Deal Desk Packet Builder, Signal-Based Sequence
Personalizer, Territory White-Space Finder. Nothing in the gallery leads with
them; they appear as a footnote ("5 agents work on it").

Most templates — especially sales — should be about closing, engaging, and
creating assets for prospects: helping sellers identify, qualify, and close
faster. Some metric templates stay.

Two adjacent defects surfaced during design and are fixed here because they sit
directly on the same surfaces (§5, §6).

## 1. The motion discriminator

`TemplateSpec` becomes a discriminated union so the compiler enforces the
pairing, matching the existing discipline of `agents` (required, may be empty):

```ts
type BaseSpec = {
  category: GoalTemplateCategory
  tracks: string
  sources: MetricSource[]
  agents: string[]
  layout: DashboardLayout
  direction?: GoalTemplate['direction']
  unit?: GoalTemplate['unit']
  recurrence?: GoalTemplate['recurrence']
  /** Resolves for bookmarked /goals/new?template= links, hidden from the grid. */
  retired?: true
}

type OutcomeSpec = BaseSpec & { motion: 'outcome' }
type ActionSpec = BaseSpec & {
  motion: 'action'
  /** What lands in a person's hands each cycle. One noun phrase, card copy. */
  produces: string
}

type TemplateSpec = OutcomeSpec | ActionSpec
```

`GoalTemplate` gains `motion`, `produces?`, and `retired?`. An action template
that omits `produces` fails to compile.

### What an action template counts

Strictly the agents' own output — deals revived, plans delivered, briefs
shipped. Never a system-of-record reading.

This is not cosmetic. `AGENT_WRITABLE_SOURCES` in `agent-tool-policy.ts` is
`{manual, slack_assisted, gmail_assisted}`; a metric owned by Stripe or a CRM
has no reachable agent write path, by design, so a model can never overwrite a
synced number. Counting agent output puts action templates inside that
allowlist, which means the goal-native Goal Metric Collector can log their
progress and **an action goal is measurable the moment it is created, with zero
integrations connected.** Every outcome template is inert until someone connects
a source.

Action templates therefore take `sources: ['slack_assisted', 'manual']`.
`rankSources` already forces `manual` last, so the wizard offers assisted
capture first and manual entry as the floor.

### No new categories

The existing seven (`Revenue`, `Pipeline`, `Cost`, `Retention`, `Delivery`,
`Quality`, `Demand`) are reused. Category, scope, and recurrence badges are
unchanged. Motion is expressed only in the card body (§4). No new accents or
icons.

## 2. `retired` and the legacy-key arithmetic

`goal-templates.test.ts` locks two things that were conflating:

- 20 pre-v2 keys must resolve forever — bookmarked `/goals/new?template=<key>`
  links must not 404.
- Exactly 9 templates per department, 5 org + 4 personal.

Sales has 4 immovable legacy keys (2 org, 2 personal), leaving only 5 free
slots — capping action at 5/9 rather than the 6/9 wanted.

`retired: true` separates the two concerns. A retired template still resolves
through `goalTemplateByKey` but is filtered out of the gallery grid. The count
test changes from "9 templates" to "9 **visible** templates".

Deleting a legacy key breaks bookmarks. Repurposing one silently changes what a
user's bookmark creates. Retiring does neither.

`sales-org-arr-growth` is retired: ARR is a board metric that sits oddly in a
seller's gallery. Every other department has the same symmetric 5 free slots and
needs no retirement.

## 3. The catalogue

20 of 45 templates become action motion. Total entries become 46 (45 visible +
1 retired).

### Sales — 6 action, 3 outcome, 1 retired

Outcome, unchanged: `sales-org-quarterly-revenue`, `sales-personal-quota`,
`sales-personal-monthly-closed`.
Retired: `sales-org-arr-growth`.
Removed: `sales-org-pipeline-coverage`, `sales-org-win-rate`,
`sales-org-new-logos`, `sales-personal-pipeline-created`,
`sales-personal-meetings-booked`.

The four org templates trace identify → qualify → engage → close.

| key | name | scope · category | produces | counts |
|---|---|---|---|---|
| `sales-org-work-the-whitespace` | Work the whitespace list | Org · Pipeline | a ranked whitespace list with a next-best play per account | accounts you opened a first touch on this month |
| `sales-org-qualify-inbound-same-day` | Qualify every inbound within a day | Org · Pipeline | a scored qualification brief and a routed owner per lead | inbound leads qualified and routed inside 24 hours |
| `sales-org-multithread-open-deals` | Multithread every open deal | Org · Pipeline | a buying-committee map and a named intro plan per deal | open deals brought to three or more engaged contacts |
| `sales-org-close-plan-on-commit` | A close plan on every commit deal | Org · Revenue | a mutual action plan with owners and dates, ready to send | commit-stage deals with a customer-agreed action plan |
| `sales-personal-revive-stalled-deals` | Revive every stalled deal | Personal · Pipeline | a re-entry email drafted from the last real conversation | stalled deals in your book you re-engaged this month |
| `sales-personal-followup-same-day` | Follow up before the day ends | Personal · Pipeline | a follow-up recapping commitments and the next step | meetings you followed up on the same day |

```
work-the-whitespace     → sales-territory-white-space, sales-account-intent-brief
qualify-inbound         → sales-new-lead-to-sf-opportunity, sales-account-intent-brief
multithread-open-deals  → sales-multithreading-map, sales-account-intent-brief
close-plan-on-commit    → sales-mutual-action-plan, sales-deal-desk-packet
revive-stalled-deals    → sales-sequence-personalizer, sales-prospect-followup-digest
followup-same-day       → sales-discovery-followup-writer, sales-prospect-followup-digest
```

### Marketing — 4 action, 5 outcome

Removed: `marketing-org-cac`, `marketing-org-organic-traffic`,
`marketing-personal-content-output`, `marketing-personal-conversion-rate`.

| key | name | scope · category | produces |
|---|---|---|---|
| `marketing-org-work-every-event-lead` | Work every event lead within a week | Org · Demand | a segmented follow-up and a sales handoff per lead |
| `marketing-org-brief-every-launch` | A readiness brief before every launch | Org · Delivery | a launch readiness scorecard with named blockers and owners |
| `marketing-personal-repurpose-every-piece` | Repurpose every piece I publish | Personal · Demand | channel-specific variants with source-backed claims |
| `marketing-personal-messaging-from-customers` | Ground my messaging in customer words | Personal · Demand | cited messaging themes and objections from real conversations |

```
work-every-event-lead        → marketing-event-followup-orchestrator, mkt-inbound-mql-router
brief-every-launch           → marketing-launch-readiness, marketing-campaign-command-center
repurpose-every-piece        → marketing-content-repurpose-engine, mkt-content-repurposer
messaging-from-customers     → marketing-voice-of-customer, marketing-competitive-narrative
```

### Engineering — 3 action, 6 outcome

Removed: `engineering-org-deploy-frequency`, `engineering-org-lead-time`,
`engineering-personal-test-coverage`.

| key | name | scope · category | produces |
|---|---|---|---|
| `engineering-org-release-go-no-go` | A go/no-go brief before every release | Org · Delivery | a release readiness brief with named blockers and owners |
| `engineering-org-incident-context-packet` | A context packet on every incident | Org · Quality | a timestamped incident context packet |
| `engineering-personal-capture-every-decision` | Capture every architecture decision | Personal · Delivery | a drafted ADR with evidence and tradeoffs |

```
release-go-no-go         → eng-release-readiness-room, eng-pr-review-checklist-bot
incident-context-packet  → eng-incident-context-assembler, eng-oncall-handoff
capture-every-decision   → eng-architecture-decision-miner
```

### Finance — 3 action, 6 outcome

Removed: `finance-org-revenue-per-head`, `finance-org-burn-reduction`,
`finance-personal-forecast-accuracy`.

| key | name | scope · category | produces |
|---|---|---|---|
| `finance-org-work-every-overdue-invoice` | Work every overdue invoice | Org · Cost | a ranked collection queue with drafted outreach |
| `finance-org-review-every-spend-exception` | Review every spend exception | Org · Cost | an exception queue tied to approvals and plan |
| `finance-personal-explain-every-variance` | Explain every material variance | Personal · Quality | a cited variance narrative for leadership |

```
work-every-overdue-invoice     → finance-cash-collection-prioritizer, fin-weekly-cash-ar-digest
review-every-spend-exception   → finance-spend-exception-review, fin-spend-anomaly-reporter
explain-every-variance         → finance-revenue-variance-explainer, finance-forecast-assumption-register
```

### CSM — 4 action, 5 outcome

Removed: `csm-org-time-to-value`, `csm-org-csat`, `csm-personal-qbr-coverage`,
`csm-personal-response-time`.

| key | name | scope · category | produces |
|---|---|---|---|
| `csm-org-plan-every-new-account` | A plan for every new account | Org · Retention | an onboarding plan with owners, dates, and risk flags |
| `csm-org-close-every-adoption-gap` | Close every adoption gap | Org · Retention | a named adoption gap and the play to close it |
| `csm-personal-brief-every-qbr` | A real brief before every QBR | Personal · Retention | a QBR brief with outcomes, risks, and an expansion ask |
| `csm-personal-work-every-risk-flag` | Work every risk flag in my book | Personal · Retention | a churn-risk brief with the save play |

```
plan-every-new-account    → csm-onboarding-task-orchestrator, csm-onboarding-risk-radar
close-every-adoption-gap  → csm-adoption-gap-finder, csm-health-score-explainer
brief-every-qbr           → csm-qbr-prep-brief, csm-executive-briefing
work-every-risk-flag      → csm-churn-risk-early-warning, csm-escalation-command-center
```

All 36 cited seed keys verified to resolve through `getSeedByKey`.

Every action template is `custom_kpi` / `count` / `increase` / `monthly`, with
`COUNT_LAYOUT` (org) or `PERSONAL_LAYOUT` (personal).

## 4. Card and readiness

`GoalTemplateCard` branches on motion for the tool row only. Badges are
untouched.

- **outcome** — `Reads from` + metric-source chips (today's rendering, unchanged)
- **action** — `Agents do` + curated agent names, then a `Produces` line

Readiness splits, because the current rule inverts for action templates.
`isReady` requires a connected non-`manual` metric source; action templates
default to `manual`, so all 20 would score not-ready and sort to the bottom of
the grid — exactly backwards, since they are the ones that work on day one.

| motion | ready when |
|---|---|
| `outcome` | a non-`manual` metric source is connected (unchanged) |
| `action` | at least one curated agent has **all** its `requiredIntegrations` connected |

Agent readiness needs *integration* connectivity, which the gallery does not
load today. It adds a second best-effort fetch of `/api/integrations/available`
feeding `connectedSlugSet`, mirroring `templates-explorer.tsx:190`. Both fetches
degrade to "nothing connected" on failure and never gate a card.

`GoalTemplateGallery` filters `retired` templates out of `GOAL_TEMPLATES` before
paginating.

## 5. Schedules render as local time, never cron

The template detail page prints `Scheduled with cron 0 7 * * * (UTC)`.
`agent-config-form.tsx:196` already states the rule — "the UI offers only
friendly visual cadences and never exposes raw cron" — and already has
`cronToTime` and `daysFromCron`. Three surfaces leaked.

| site | today | after |
|---|---|---|
| `app/templates/[id]/page.tsx:74` | `Scheduled with cron 0 7 * * * (UTC)` | `Every day at 1:00 AM MDT` |
| `app/agents/assistant-panel.tsx:77` | `cron 0 13 * * 1 (UTC)` | `Every Monday at 7:00 AM MDT` |
| `components/flows/nodes/trigger-body.tsx:273` | `Next run: per cron "0 16 * * 1-5"` | `Next run: weekdays at 10:00 AM MDT` |

`page.tsx:73` also carries a hardcoded `if (cron === '0 14 * * 1')` special case
— the same bug patched once by hand. It is deleted.

New pure module `src/lib/scheduling/describe-schedule.ts`:

```ts
export function describeSchedule(
  schedule: { type: string; cron?: string; time?: string; timezone?: string; isActive?: boolean },
  viewerTimeZone: string,
  /** Reference instant for DST resolution. Injected so tests are deterministic. */
  now: Date,
): string
```

Parses the five cron fields, converts the wall clock from `schedule.timezone`
into `viewerTimeZone`, composes a phrase. Time is formatted with
`Intl.DateTimeFormat(viewerTimeZone, { hour: 'numeric', minute: '2-digit',
timeZoneName: 'short' })` — 12-hour with the zone abbreviation, since the value
previously read as UTC and the ambiguity must not survive.

Three constraints shape the implementation:

- **The weekday shifts.** `0 1 * * 1` is Monday 01:00 UTC but **Sunday 7:00 PM**
  in Denver. The converter carries a −1/0/+1 day delta through to the weekday
  set. Converting the hour while keeping the weekday would misreport the day for
  every weekly agent west of UTC.
- **`nextOccurrence` cannot be reused.** Its cron path scans minute-by-minute
  and has measured ~13 seconds worst case (documented at
  `trigger-body.tsx:136`, which is precisely why that file prints a raw cron
  string instead of a label). `describeSchedule` is pure string math with no
  date scanning, so it is safe on every render and retires that workaround.
- **DST moves the label, correctly.** `0 7 * * *` UTC is 1:00 AM MDT in summer
  and 12:00 AM MST in winter — the agent genuinely fires at a different local
  time either side of the transition, so the label should change. That makes the
  output date-dependent, hence the injected `now`: callers pass `new Date()`,
  tests pass a fixed instant.
- **Hydration.** There is no user timezone column in the schema (verified), so
  the viewer's zone comes from `Intl.DateTimeFormat().resolvedOptions().timeZone`
  — which differs between server and client render. All three sites are
  `'use client'` but Next still SSRs them. A `useViewerTimeZone()` hook returns
  the schedule's own timezone on first paint and the resolved zone after mount.

Cron shapes the parser cannot phrase (`*/15`, hour ranges, day-of-month lists)
fall back to a plain cadence sentence rather than printing the expression.

Scope is display-only. Stored schedules stay UTC, authoring is untouched, and
the admin cron *input* at `templates-explorer.tsx:897` remains a raw cron field
— an authoring control, not a user-facing label.

## 6. Recommended integrations on the catalogue card

The Goal Metric Collector card renders no tool row at all, despite a description
promising it reads from Slack, an inbox, or a web page.

Measured: 1 of 83 seeds renders no tool row, and 54 seeds carry
`recommendedIntegrations` that no card surfaces anywhere.

`TemplateCatalogueCard` renders its row only when `integrations.length > 0`, and
the caller passes `requiredIntegrations` — `[]` for this seed.

**The empty array is correct and stays.** `missingIntegrations` is an AND check:
listing `['slack','gmail']` as required would put the collector behind a Connect
button demanding *both*, when it needs *either one*, or just a URL. That is why
it was authored as recommended.

Fix: `TemplateCatalogueCard` takes a `recommendedIntegrations` prop and renders
a **Works with** row when `requiredIntegrations` is empty. Those chips never
receive the missing/blocked treatment — they are not prerequisites, and dimming
them would reintroduce the same lie.

The goals surfaces have the same gap: `agent-bundle-card.tsx:137` and
`goal-template-detail.tsx:234` render `requiredIntegrations` only, and
`BundleEntry` does not carry the recommended list. `bundleForGoal` gains
`recommendedIntegrations` and both surfaces get the row.

This matters more after §3: the collector is the goal-native agent for every
action template, so the empty card appears on the detail dialog of all 20.

## 7. Tests

New invariants in `goal-templates.test.ts`:

- every template declares a `motion`
- every action template has non-empty `produces`; no outcome template has it
- every action template's `sources` ⊆ `AGENT_WRITABLE_SOURCES`
- no outcome template claims an agent-writable-only source set
- exactly 9 **visible** (non-retired) per department, 5 org + 4 personal
- all 20 legacy keys still resolve, retired ones included
- action counts per department: sales 6, marketing 4, engineering 3, finance 3, csm 4

New `describe-schedule.test.ts`, pure:

All cases pass a fixed `now`, so DST is pinned rather than ambient.

- `0 7 * * *` UTC from `America/Denver`, July reference → `Every day at 1:00 AM MDT`
- the same input with a January reference → `Every day at 12:00 AM MST`
  (DST shifts both the hour and the abbreviation)
- `0 1 * * 1` UTC from `America/Denver` → `Every Sunday at 7:00 PM MST`
  (the weekday shift)
- `0 16 * * 1-5` → weekday phrasing
- `0 13 * * 1` from `Asia/Tokyo` → Monday retained, no shift
- unparseable shapes (`*/15 * * * *`) fall back without printing the expression
- `type: 'manual'` and `isActive: false` produce their existing labels

Updated fixtures: four test files use `sales-org-pipeline-coverage`
(`agent-bundle.test.ts:14`, `:101`, `agent-bundle-card.test.tsx:12`,
`goal-template-agents-ui.test.tsx:11`, `:33`). They repoint to
`sales-org-multithread-open-deals`, which additionally makes them exercise a
curated action bundle.

`goal-template-card.test.tsx:29` uses `sales-org-arr-growth` as its
no-recurrence example; it still resolves after retirement, so no change.

Card tests: an action template renders `Agents do` + `Produces` and no
`Reads from`; an outcome template is unchanged; a retired template is absent
from the gallery grid but resolves by key.

## Out of scope

- Authoring schedules in local time — display only.
- Linking an action goal to the outcome metric it drives. The goal schema binds
  exactly one metric, and the layout presets assert single-metric widgets.
- New agent seeds. Every action template uses agents that already ship.
- New template categories, accents, or icons.
- Showing `recommendedIntegrations` on all 54 seeds that have them; the rule
  here is scoped to seeds with no required integrations.
