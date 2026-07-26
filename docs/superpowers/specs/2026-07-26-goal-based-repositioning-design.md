# Goal-Based Repositioning — Design

**Date:** 2026-07-26
**Branch:** `feat/goals` (Approach A — one sweep; marketing + product IA merge together)
**Status:** Approved by James

## Summary

Reposition Sublime from "AI that knows your business" (capability story) to
"AI that proves its ROI" — a goal-based AI platform (outcome story). Sublime
connects to your tech stack, connects the dots, and deploys specialized agents
that automate repetitive work, cut costs, and find process improvements —
measured against the goals the org runs on (KPIs, ARR, quota, launch dates).

Scope: marketing surfaces AND product IA (goals-first dashboard, goal-first
onboarding). ROI proof in v1 is goal progress + existing run evidence — no new
metrics engine, no estimated-savings heuristics.

## 1. Messaging framework

**Positioning statement:** Sublime is the goal-based AI platform. It connects
to your tech stack, connects the dots across it, and deploys specialized
agents that clear repetitive work, cut costs, and surface process
improvements — measured against the goals your org actually runs on.

**Hero (ROI-led, approved):**

> **AI that proves its ROI**
>
> Sublime connects to your tech stack, connects the dots, and deploys
> specialized agents against the goals that matter — quota, ARR, launch
> dates. Every run shows its work. Every goal shows its progress.
>
> CTA: **Set your first goal** → `/auth/signup`

**Narrative arc (used consistently on every surface):**

1. **Connect** — plug in the tools you already use.
2. **Connect the dots** — Sublime reconstructs how work gets done and where
   time and money leak.
3. **Deploy specialized agents** — against repetitive tasks, cost sinks, and
   process gaps.
4. **Prove it** — every run shows its evidence; every goal shows its
   progress. ROI you can point to, not vibes.

**Vocabulary shifts (applied everywhere):**

| Old | New |
| --- | --- |
| AI that knows your business | AI that proves its ROI |
| AI-agent workspace | goal-based AI platform |
| delivers useful outcomes | moves your numbers / progress you can measure |
| agents | specialized agents (always framed as serving a goal) |
| knowledge layer (as lead concept) | context as supporting evidence for why the ROI is real |

**Kept:** the evidence/trust language ("every run shows its work") — it is
the existing brand asset that makes "proves" credible. "Not another chatbot.
A system that does the work." stays.

## 2. Marketing surfaces

Layout and visual system unchanged; this is a copy-and-emphasis rewrite.

### Landing page (`src/components/landing/landing-page.tsx`)

- **Hero:** headline/subhead/CTA per framework above. Product mock stays.
- **Connections/marquee:** logo marquee stays. Copy: "All your tools in one
  place / one connected knowledge layer" → **"Connected to everything.
  Accountable to your goals."** Subhead: Sublime plugs into the stack you
  already run and connects the dots across it, so every agent starts with
  full context.
- **Features grid:** header "Builds immediately. / Delivers from day one." →
  **"Three ways it pays for itself."** Tiles become the three ROI levers:
  1. **Automate the repetitive** — specialized agents take over recurring
     work (digests, triage, follow-ups) so people stop doing robot work.
  2. **Cut the cost** — agents run in minutes for cents; every run is logged
     so you can see exactly what got done and what it replaced.
  3. **Find the process wins** — connected across your stack, Sublime spots
     bottlenecks and leaks and proposes agents to fix them.
  Existing tile graphics (bars/flow/chart) are reused, remapped to fit.
- **Showcase:** headline stays; subhead gains goal language — agents, flows,
  and connections all reporting into the goals you set.
- **Testimonial:** rewritten to an ROI/goal outcome, same attribution — e.g.
  pointing agents at quarterly goals and finally having an ROI number to show
  in the QBR.
- **Pricing:** header unchanged; subhead nudge tying credits to "cost you can
  see per run."
- **Final CTA:** "Start using AI that actually works." → **"Set a goal. See
  the ROI."** Button: "Set your first goal."

### Metadata (`src/app/page.tsx`)

Title `Sublime — AI that proves its ROI`; description (and OG tags) rewritten
to the positioning statement.

### About page (`src/app/about/page.tsx`)

- Hero: **"The goal-based AI platform."**
- "Why we built it": the missing ingredient isn't a bigger model, it's
  accountability to outcomes — AI stalls when nobody can say what it moved.
- Principles: reword "Useful on day one" → **"ROI over demos"** (first agent
  you deploy does real, attributable work). "Evidence over vibes" and "Your
  data stays yours" stay. Grid remains three tiles.
- Metadata description updated to match.

### README

One-liner updated to the positioning statement.

## 3. Goals-first dashboard (`src/app/dashboard/home-assistant.tsx`)

Reweighting of the existing assistant surface — goals lead, the assistant is
how you act on them.

- **Goal strip to the top** of the empty state, above salutation/composer —
  promoted from status strip to lead element (existing `GoalStatusStrip`
  data; more prominent placement/sizing).
- **Impact line under the strip:** one sentence of aggregate proof from
  existing run data — "Agents completed N runs this week across M goals" —
  reusing `impact-strip.tsx`. No new metrics engine.
- **Goal-aware preset chips:** when goals exist, goal-anchored prompts
  replace the generic chips — "What moved on [goal] this week?", "Where am I
  losing time?", "Propose an agent for [goal]". With no goals, current
  generic chips remain.
- **No-goals state:** hero becomes a goal CTA — "What are you trying to
  achieve this quarter?" with **Set your first goal** → `/goals/new` and the
  goal template gallery. Replaces the neutral "Welcome back" empty state as
  the primary path.
- **Salutation stays**, demoted beneath the goal strip.

**Sidebar (`src/components/layout/sidebar.tsx`):** Goals moves to the top of
the nav group (Home, **Goals**, Agents, Flows, …); labels/tooltips pick up
the framing (Agents = "specialized agents serving your goals").

No new data models or endpoints — composition of shipped goals v1/v2
components plus copy. Orthogonal to the v2.4 copilot-dynamic-dashboards plan.

## 4. Goal-first onboarding

No separate `/onboarding` route or state machine. The dashboard's first-run
state IS the onboarding, extending the no-goals state above.

- **First-run guide card** on the dashboard for new workspaces — the brand
  narrative as three steps with live state:
  1. **Connect your stack** — links to `/connections`; shows count when >0.
  2. **Set a goal** — "What are you trying to achieve? Quota, ARR, a launch
     date?" → `/goals/new` + goal template gallery.
  3. **Deploy agents against it** — lights up once a goal exists; leads into
     the existing goal copilot / template recommendations for that goal.
- **Soft ordering, no gates** — steps complete in any order. State derives
  from existing counts (connections, goals, agents). No new persistence, no
  "onboarding completed" flag; the card disappears once all three exist.
- **Card header carries the pitch:** "Connect. Connect the dots. Deploy.
  Prove it."
- Signup page microcopy updated ("Set your first goal in minutes").

## 5. Error handling

Nothing new — all surfaces read existing data through existing paths. The
first-run card and goal strip render nothing (rather than erroring) if their
counts/queries fail, matching the current dashboard's tolerant loading
behavior.

## 6. Verification

- **Copy sweep:** grep confirms no surface still says "AI that knows your
  business" or "AI-agent workspace"; update any tests that pin old strings.
- **Dashboard states:** component tests for first-run, no-goals-with-
  connections, and goals-present states, following existing patterns in
  `src/components/goals/__tests__/`.
- **Route smoke:** the project `verify` protocol (throwaway Postgres, real
  route handlers) for `/`, `/about`, `/dashboard`.

## Decisions log

- Scope: marketing + product IA (not marketing-only, not full every-touchpoint sweep).
- Product IA: goals-first dashboard + goal-first onboarding (nav reorder included via sidebar change).
- ROI proof v1: goal progress + run evidence only — no impact-metrics layer, no estimated-savings heuristics.
- Hero: ROI-led ("AI that proves its ROI").
- Structure: Approach A — one sweep on `feat/goals`, merged as one release so marketing never advertises an unshipped entry point.
