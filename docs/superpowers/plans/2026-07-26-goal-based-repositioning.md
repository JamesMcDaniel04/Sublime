# Goal-Based Repositioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reposition Sublime from "AI that knows your business" to "AI that proves its ROI" — a goal-based AI platform — across marketing surfaces (landing, about, metadata, README, signup) and product IA (goals-first dashboard, goal-first onboarding).

**Architecture:** Copy rewrite on marketing surfaces (no layout changes); dashboard reweighting in `home-assistant.tsx` driven by two new pure-logic helpers (`goalPresets`, `impactSentence`, `firstRunSteps`) in a new `src/lib/goals/dashboard-copy.ts`, unit-tested with the repo's `node:test` runner; a new `FirstRunGuide` component composed into the dashboard empty state. No new endpoints, no schema changes.

**Tech Stack:** Next.js App Router, React client components, Tailwind, lucide-react icons, `node:test` via `npm test` (tsx runner), existing client cache utilities (`getCachedJson`, `getSnapshot`).

**Spec:** `docs/superpowers/specs/2026-07-26-goal-based-repositioning-design.md`

## Global Constraints

- Branch: `feat/goals`. Commit after every task with a conventional-commit message ending in `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Test command: `npm test` (runs all `src/**/__tests__/*.test.ts(x)` via node:test). To run one file: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <file>`.
- Retired phrases — after Task 6 these must not appear anywhere in `src/` or `README.md`: "AI that knows your business", "AI-agent workspace", "delivers useful outcomes".
- Vocabulary: agents are "specialized agents" and are always framed as serving a goal; Sublime is "the goal-based AI platform"; keep the evidence language ("every run shows its work").
- Hero copy (verbatim, from the approved spec):
  - H1: `AI that proves its ROI`
  - Subhead: `Sublime connects to your tech stack, connects the dots, and deploys specialized agents against the goals that matter — quota, ARR, launch dates. Every run shows its work. Every goal shows its progress.`
  - CTA label: `Set your first goal`
- The sidebar nav order is ALREADY `Home, Goals, Agents, Integrations, Flows` (`src/components/layout/sidebar.tsx:82-88`) — no reorder task exists; only tooltip framing changes (Task 5).
- Copy-only edits must not change JSX structure, class names, or layout except where a task explicitly says so.

---

### Task 1: Landing page + root metadata rewrite

**Files:**
- Modify: `src/components/landing/landing-page.tsx` (copy strings only)
- Modify: `src/app/page.tsx:16-30` (metadata)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing consumed by later tasks (marketing copy only).

- [ ] **Step 1: Rewrite the hero (landing-page.tsx ~lines 245-257)**

Replace the H1 text, subhead paragraph, and CTA label:

```tsx
<h1 className="text-[clamp(2rem,4vw,3.2rem)] font-[500] leading-[1.08] tracking-[-0.04em] text-foreground max-w-[540px]">
  AI that proves its ROI
</h1>
<p className="mt-6 text-base leading-relaxed text-muted-foreground max-w-[420px]">
  Sublime connects to your tech stack, connects the dots, and deploys specialized
  agents against the goals that matter — quota, ARR, launch dates. Every run shows
  its work. Every goal shows its progress.
</p>
```

CTA button text: `Start building` → `Set your first goal` (keep the ArrowRight icon and classes).

- [ ] **Step 2: Rewrite the connections/marquee card copy (~lines 442-451)**

Keep the `Connections` eyebrow. Replace the H2 and subhead:

```tsx
<h2 className="text-[clamp(1.8rem,3vw,2.5rem)] font-[500] tracking-[-0.03em] leading-[1.15]">
  Connected to everything.<br />Accountable to <span className="text-primary">your goals.</span>
</h2>
<p className="mt-4 text-[15px] text-white/60">
  Sublime plugs into the stack you already run and connects the dots across it,
  so every agent starts with full context.
</p>
```

- [ ] **Step 3: Rewrite the features grid (~lines 490-513)**

Header: `Builds immediately.<br />Delivers from day one.` → `Three ways it<br />pays for itself.` (keep the `What you get` eyebrow). Replace the three tile objects (keep the `graphic` keys so the existing tile graphics render unchanged):

```tsx
{
  title: 'Automate the repetitive',
  desc: 'Specialized agents take over the recurring work — digests, triage, follow-ups — so your people stop doing robot work.',
  graphic: 'bars',
},
{
  title: 'Cut the cost',
  desc: 'Agents run in minutes for cents, and every run is logged — so you can see exactly what got done and what it replaced.',
  graphic: 'flow',
},
{
  title: 'Find the process wins',
  desc: 'Connected across your stack, Sublime spots bottlenecks and leaks, then proposes specialized agents to fix them.',
  graphic: 'chart',
},
```

- [ ] **Step 4: Showcase subhead (~lines 583-585)**

Headline stays (`Not another chatbot. A system that does the work.`). Replace the subhead:

```tsx
<p className="mt-5 text-[15px] text-muted-foreground max-w-[480px] mx-auto">
  Build specialized agents, connect your stack, and orchestrate flows — all
  reporting into the goals you set. Every run shows its evidence and finished artifact.
</p>
```

- [ ] **Step 5: Testimonial rewrite (~line 652)**

```tsx
&ldquo;We pointed Sublime&rsquo;s agents at our quarterly pipeline goal. They ship the
digests and follow-ups nobody had time for — and for the first time I have an ROI
number I can show in the QBR.&rdquo;
```

Attribution (Jamie Kim, Head of Revenue Ops, Falken Group) stays.

- [ ] **Step 6: Pricing subhead nudge (~lines 679-683)**

Header stays. In the small print under `<PricingGrid />`, replace the first sentence so the paragraph reads:

```tsx
<p className="mt-4 text-[12px] text-muted-foreground">
  Subscriptions start when you check out and can be canceled anytime. 1 credit = 1,000 AI
  tokens; credits are shared across your workspace — cost you can see per run. Checkout
  and invoicing are handled securely by Stripe.
</p>
```

- [ ] **Step 7: Final CTA (~lines 693-704)**

```tsx
<h2 className="text-[clamp(2rem,4vw,3.2rem)] font-[500] tracking-[-0.035em] text-foreground leading-[1.1] mx-auto max-w-[560px]">
  Set a goal. See the ROI.
</h2>
<p className="mt-5 text-[15px] text-muted-foreground max-w-[400px] mx-auto">
  Connect your stack and deploy specialized<br />agents against your goals today.
</p>
```

Button text: `Create an account` → `Set your first goal`.

- [ ] **Step 8: Root metadata (`src/app/page.tsx:16-30`)**

```tsx
export const metadata: Metadata = {
  metadataBase: new URL('https://trysublime.io'),
  title: 'Sublime — AI that proves its ROI',
  description:
    'Sublime is the goal-based AI platform. It connects to your tech stack, connects the dots, and deploys specialized agents that automate repetitive work, cut costs, and find process wins — measured against the goals your org runs on.',
  alternates: { canonical: '/' },
  openGraph: {
    title: 'Sublime — AI that proves its ROI',
    description:
      'The goal-based AI platform: connect your stack, and Sublime deploys specialized agents measured against the goals your org runs on.',
    url: 'https://trysublime.io',
    siteName: 'Sublime',
    type: 'website',
  },
}
```

- [ ] **Step 9: Verify no old strings remain in these two files**

Run: `grep -n "knows your business\|useful outcomes\|Start building\|All your tools in one place\|actually works" src/components/landing/landing-page.tsx src/app/page.tsx`
Expected: no output.

- [ ] **Step 10: Commit**

```bash
git add src/components/landing/landing-page.tsx src/app/page.tsx
git commit -m "feat(brand): reposition landing page around goal-based ROI story"
```

---

### Task 2: About page, README, signup microcopy

**Files:**
- Modify: `src/app/about/page.tsx`
- Modify: `README.md:1-14`
- Modify: `src/app/auth/signup/page.tsx:81-82`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: About metadata + hero (`src/app/about/page.tsx:10-47`)**

Metadata description:

```tsx
description:
  'Sublime is the goal-based AI platform: it connects to your tech stack and deploys specialized agents measured against the goals your org runs on.',
```

Hero H1: `AI that knows your business.` → `The goal-based AI platform.`

Hero paragraph:

```tsx
<p className="mt-6 max-w-[560px] text-base leading-relaxed text-muted-foreground">
  Sublime connects to the tools your team already uses: code, chat, docs, and
  project management. It connects the dots across them, then deploys specialized
  agents that automate repetitive work, cut costs, and surface process
  improvements — measured against the goals your org actually runs on.
</p>
```

- [ ] **Step 2: "Why we built it" rewrite (~lines 57-67)**

```tsx
<p className="text-[15px] leading-[1.7] text-muted-foreground">
  Most AI tools demo well and then stall, because nobody can say what they
  actually moved. Instead of a chatbot with no scoreboard, Sublime agents are
  deployed against goals — quota, ARR, a launch date — so their work is
  measured, not assumed.
</p>
<p className="text-[15px] leading-[1.7] text-muted-foreground">
  We believe the missing ingredient isn&apos;t a bigger model. It&apos;s
  accountability to outcomes. Sublime exists to close that gap: AI that plugs
  into real work, shows its evidence, and proves its ROI goal by goal.
</p>
```

- [ ] **Step 3: Principles tile (~lines 26-28)**

Replace the `Useful on day one` principle (grid stays three tiles):

```tsx
{
  title: 'ROI over demos',
  desc: 'The first agent you deploy does real, attributable work against a goal you set — not a toy demo.',
},
```

- [ ] **Step 4: README one-liner (`README.md:3`)**

```markdown
Sublime is the goal-based AI platform: connect your tech stack, and Sublime connects the dots and deploys specialized agents — measured against the goals your org runs on — with every run's tool calls, evidence, and errors inspectable.
```

Also add a `/goals` line to the Product Surface list (after the `/dashboard` line):

```markdown
- `/goals`: organization goals, progress and risk tracking, and AI impact/ROI reporting
```

- [ ] **Step 5: Signup microcopy (`src/app/auth/signup/page.tsx:82`)**

```tsx
subtitle="Create your workspace and set your first goal in minutes. Cancel anytime."
```

- [ ] **Step 6: Verify**

Run: `grep -n "knows your business\|AI-agent workspace\|useful outcomes\|Useful on day one" src/app/about/page.tsx README.md src/app/auth/signup/page.tsx`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/app/about/page.tsx README.md src/app/auth/signup/page.tsx
git commit -m "feat(brand): goal-based positioning on about page, README, and signup"
```

---

### Task 3: Dashboard copy helpers (TDD)

**Files:**
- Create: `src/lib/goals/dashboard-copy.ts`
- Test: `src/lib/goals/__tests__/dashboard-copy.test.ts`

**Interfaces:**
- Consumes: `GoalSummary` from `@/lib/types` (fields used: `name`, `personal`, `status`), `OrgImpact` from `@/components/goals/impact-strip` (fields used: `measured.runsCompleted`, `goalsTracked`).
- Produces (exact signatures, used by Tasks 4 and 5):
  - `type GoalPreset = { label: string; prompt: string; sendNow: boolean }`
  - `goalPresets(goals: ReadonlyArray<Pick<GoalSummary, 'name' | 'personal' | 'status'>>): GoalPreset[] | null` — null when no active org goals (caller falls back to generic presets).
  - `impactSentence(impact: { measured: { runsCompleted: number }; goalsTracked: number } | null): string | null`
  - `type FirstRunStep = { key: 'connect' | 'goal' | 'deploy'; label: string; detail: string; href: string; done: boolean }`
  - `firstRunSteps(counts: { connections: number; goals: number; agents: number }): { steps: FirstRunStep[]; showGuide: boolean }`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/goals/__tests__/dashboard-copy.test.ts` (style matches `chart-math.test.ts`):

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { firstRunSteps, goalPresets, impactSentence } from '../dashboard-copy'

const goal = (name: string, overrides: Partial<{ personal: boolean; status: 'active' | 'paused' }> = {}) => ({
  name,
  personal: false,
  status: 'active' as const,
  ...overrides,
})

test('goalPresets returns null when there are no active org goals', () => {
  assert.equal(goalPresets([]), null)
  assert.equal(goalPresets([goal('Q3 ARR', { personal: true })]), null)
  assert.equal(goalPresets([goal('Q3 ARR', { status: 'paused' })]), null)
})

test('goalPresets anchors prompts to up to two goal names', () => {
  const presets = goalPresets([goal('Q3 ARR'), goal('Launch v2'), goal('Cut churn')])
  assert.ok(presets)
  // Two named "what moved" chips, one generic time-loss chip, one propose chip.
  assert.equal(presets.length, 4)
  assert.equal(presets[0].label, 'What moved on Q3 ARR this week?')
  assert.ok(presets[0].prompt.includes('"Q3 ARR"'))
  assert.equal(presets[0].sendNow, true)
  assert.equal(presets[1].label, 'What moved on Launch v2 this week?')
  assert.equal(presets[2].label, 'Where am I losing time?')
  assert.equal(presets[3].label, 'Propose an agent for Q3 ARR')
  assert.equal(presets[3].sendNow, false)
})

test('goalPresets with a single goal yields three chips', () => {
  const presets = goalPresets([goal('Q3 ARR')])
  assert.ok(presets)
  assert.equal(presets.length, 3)
})

test('impactSentence summarizes runs and goals, and hides when empty', () => {
  assert.equal(impactSentence(null), null)
  assert.equal(impactSentence({ measured: { runsCompleted: 0 }, goalsTracked: 2 }), null)
  assert.equal(
    impactSentence({ measured: { runsCompleted: 12 }, goalsTracked: 3 }),
    'Specialized agents have completed 12 runs across 3 tracked goals.',
  )
  assert.equal(
    impactSentence({ measured: { runsCompleted: 1 }, goalsTracked: 1 }),
    'Specialized agents have completed 1 run across 1 tracked goal.',
  )
})

test('firstRunSteps marks progress and hides once everything exists', () => {
  const fresh = firstRunSteps({ connections: 0, goals: 0, agents: 0 })
  assert.equal(fresh.showGuide, true)
  assert.deepEqual(fresh.steps.map((step) => step.done), [false, false, false])
  assert.deepEqual(fresh.steps.map((step) => step.key), ['connect', 'goal', 'deploy'])
  assert.equal(fresh.steps[0].href, '/integrations')
  assert.equal(fresh.steps[1].href, '/goals/new')
  assert.equal(fresh.steps[2].href, '/agents')

  const partial = firstRunSteps({ connections: 3, goals: 0, agents: 1 })
  assert.equal(partial.showGuide, true)
  assert.deepEqual(partial.steps.map((step) => step.done), [true, false, true])
  assert.ok(partial.steps[0].detail.includes('3'))

  const done = firstRunSteps({ connections: 1, goals: 1, agents: 1 })
  assert.equal(done.showGuide, false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/dashboard-copy.test.ts`
Expected: FAIL — cannot find module `../dashboard-copy`.

- [ ] **Step 3: Implement `src/lib/goals/dashboard-copy.ts`**

```ts
import type { GoalSummary } from '@/lib/types'

/** Chip definitions for the dashboard composer, minus icons (the dashboard
 *  attaches lucide icons — this module stays server/test friendly). */
export type GoalPreset = { label: string; prompt: string; sendNow: boolean }

/**
 * Goal-anchored composer chips. Returns null when the org has no active
 * shared goals so the dashboard falls back to its generic presets.
 */
export function goalPresets(
  goals: ReadonlyArray<Pick<GoalSummary, 'name' | 'personal' | 'status'>>,
): GoalPreset[] | null {
  const active = goals.filter((candidate) => !candidate.personal && candidate.status === 'active')
  if (active.length === 0) return null
  const named = active.slice(0, 2)
  return [
    ...named.map((candidate) => ({
      label: `What moved on ${candidate.name} this week?`,
      prompt: `Summarize recent progress on our goal "${candidate.name}" — what moved, what stalled, and which agent runs contributed.`,
      sendNow: true,
    })),
    {
      label: 'Where am I losing time?',
      prompt:
        'Look across my workspace activity and connections. Where are we losing time to repetitive work that a specialized agent could take over?',
      sendNow: true,
    },
    {
      label: `Propose an agent for ${named[0].name}`,
      prompt: `Propose a specialized agent that would help us hit the goal "${named[0].name}". Describe what it would do, then build it.`,
      sendNow: false,
    },
  ]
}

/** One-line aggregate proof under the goal strip. Null hides the line. */
export function impactSentence(
  impact: { measured: { runsCompleted: number }; goalsTracked: number } | null,
): string | null {
  if (!impact || impact.measured.runsCompleted === 0) return null
  const runs = impact.measured.runsCompleted
  const goals = impact.goalsTracked
  const runNoun = runs === 1 ? 'run' : 'runs'
  const goalNoun = goals === 1 ? 'tracked goal' : 'tracked goals'
  return `Specialized agents have completed ${runs} ${runNoun} across ${goals} ${goalNoun}.`
}

export type FirstRunStep = {
  key: 'connect' | 'goal' | 'deploy'
  label: string
  detail: string
  href: string
  done: boolean
}

/**
 * First-run guide state, derived purely from counts — no persisted
 * "onboarding completed" flag. Steps complete in any order; the guide
 * disappears once all three exist.
 */
export function firstRunSteps(counts: {
  connections: number
  goals: number
  agents: number
}): { steps: FirstRunStep[]; showGuide: boolean } {
  const steps: FirstRunStep[] = [
    {
      key: 'connect',
      label: 'Connect your stack',
      detail:
        counts.connections > 0
          ? `${counts.connections} connected — add more anytime`
          : 'Plug in the tools your team already uses',
      href: '/integrations',
      done: counts.connections > 0,
    },
    {
      key: 'goal',
      label: 'Set a goal',
      detail:
        counts.goals > 0
          ? `${counts.goals} goal${counts.goals === 1 ? '' : 's'} tracked`
          : 'What are you trying to achieve? Quota, ARR, a launch date?',
      href: '/goals/new',
      done: counts.goals > 0,
    },
    {
      key: 'deploy',
      label: 'Deploy specialized agents against it',
      detail:
        counts.agents > 0
          ? `${counts.agents} agent${counts.agents === 1 ? '' : 's'} working`
          : 'Sublime proposes agents once a goal exists',
      href: '/agents',
      done: counts.agents > 0,
    },
  ]
  return { steps, showGuide: steps.some((step) => !step.done) }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/dashboard-copy.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/goals/dashboard-copy.ts src/lib/goals/__tests__/dashboard-copy.test.ts
git commit -m "feat(goals): pure helpers for goal-aware dashboard chips, impact line, first-run guide"
```

---

### Task 4: Goals-first dashboard reweighting

**Files:**
- Modify: `src/components/goals/goal-status-strip.tsx` (accept goals via prop)
- Modify: `src/app/dashboard/home-assistant.tsx` (empty-state hero reorder, goal-aware chips, impact line, no-goals CTA)

**Interfaces:**
- Consumes: `goalPresets`, `impactSentence` from `@/lib/goals/dashboard-copy` (Task 3); `GoalSummary` from `@/lib/types`; `OrgImpact` from `@/components/goals/impact-strip`; `getCachedJson` from `@/lib/client/use-cached-json`.
- Produces: `GoalStatusStrip({ goals }: { readonly goals: GoalSummary[] | null })` — new required prop; the strip no longer self-fetches. `GoalStatusStrip` is used ONLY by `home-assistant.tsx` (verify with grep before editing).

- [ ] **Step 1: Verify the strip's only consumer**

Run: `grep -rn "GoalStatusStrip" src --include="*.tsx"`
Expected: exactly two hits — the component file and `home-assistant.tsx`. If more appear, keep the prop optional with the existing self-fetch as fallback instead of removing it.

- [ ] **Step 2: Lift the fetch out of `GoalStatusStrip`**

Replace the component body so goals come in as a prop (delete the `useEffect`/`useState`/`getCachedJson` import; keep rendering identical):

```tsx
'use client'

import Link from 'next/link'
import { Target } from 'lucide-react'
import type { GoalSummary } from '@/lib/types'
import { GoalProgressBar, RiskBadge } from './goal-viz'

export function GoalStatusStrip({ goals }: { readonly goals: GoalSummary[] | null }) {
  const visible = (goals ?? [])
    .filter((goal) => !goal.personal && goal.status === 'active')
    .slice(0, 3)
  if (!visible.length) return null

  return (
    <div className="mb-4 rounded-2xl border bg-card p-3 shadow-1">
      {/* header + grid exactly as today, mapping over `visible` */}
```

(The JSX below the guard is unchanged from the current file except `goals.map` → `visible.map`.)

- [ ] **Step 3: Fetch goals + impact in `HomeAssistant`**

In `home-assistant.tsx`, add imports:

```tsx
import { Target } from 'lucide-react' // add to the existing lucide-react import list
import { getCachedJson } from '@/lib/client/use-cached-json'
import type { GoalSummary } from '@/lib/types'
import type { OrgImpact } from '@/components/goals/impact-strip'
import { goalPresets, impactSentence } from '@/lib/goals/dashboard-copy'
```

Add state + effect inside `HomeAssistant` (next to the salutation state, ~line 217):

```tsx
// Goals drive the empty-state hero: strip, chips, and the no-goals CTA.
const [goals, setGoals] = useState<GoalSummary[] | null>(null)
const [impact, setImpact] = useState<OrgImpact | null>(null)
useEffect(() => {
  let cancelled = false
  getCachedJson<{ goals?: GoalSummary[] }>('/api/goals', 60_000)
    .then((data) => {
      if (!cancelled) setGoals(data.goals ?? [])
    })
    .catch(() => {
      if (!cancelled) setGoals([])
    })
  getCachedJson<{ impact?: OrgImpact }>('/api/goals/impact', 60_000)
    .then((data) => {
      if (!cancelled) setImpact(data.impact ?? null)
    })
    .catch(() => undefined)
  return () => {
    cancelled = true
  }
}, [])
```

- [ ] **Step 4: Goal-aware chips**

Above the `return`, derive the chip list (`PRESETS` entries have an `icon`; goal chips all use `Target`):

```tsx
const goalChips = goals ? goalPresets(goals) : null
const chips = goalChips
  ? goalChips.map((preset) => ({ ...preset, icon: Target }))
  : PRESETS
```

In the empty-state chip row (~line 600), map over `chips` instead of `PRESETS` (the `applyPreset` callback already only uses `prompt`/`sendNow` — change its parameter type to `{ prompt: string; sendNow: boolean }`).

- [ ] **Step 5: Reorder the empty-state hero + impact line + no-goals CTA**

Replace the empty-state hero block (currently eyebrow → TypedHeadline → LearningProgressCard → GoalStatusStrip → composer → chips) with goals leading. `hasGoals` means at least one active org goal:

```tsx
const hasGoals = Boolean(goals?.some((goal) => !goal.personal && goal.status === 'active'))
const proofLine = impactSentence(impact)
```

```tsx
<div className="w-full max-w-4xl">
  <GoalStatusStrip goals={goals} />
  {hasGoals && proofLine && (
    <p className="mb-4 text-center text-sm text-muted-foreground">{proofLine}</p>
  )}
  <p className="eyebrow text-center">
    <span className="text-indigo-400">{'///'}</span> {salutation}
    {user?.firstName ? `, ${user.firstName}` : ''}
  </p>
  {goals !== null && !hasGoals ? (
    <div className="mt-2 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">
        What are you trying to achieve this quarter?
      </h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        Set a goal — quota, ARR, a launch date — and Sublime deploys specialized
        agents against it.
      </p>
      <Button className="mt-4" onClick={() => router.push('/goals/new')}>
        <Target className="mr-1.5 h-4 w-4" /> Set your first goal
      </Button>
    </div>
  ) : (
    <div className="mt-2">
      <TypedHeadline phrases={HEADLINE_CTAS} />
    </div>
  )}
  <div className="mt-6">
    <LearningProgressCard />
    {composer}
  </div>
  {/* chips row unchanged apart from mapping `chips` */}
```

Notes: while `goals === null` (loading), render the TypedHeadline branch — no layout flash for returning users with goals; the strip renders null until data lands. The composer stays visible in the no-goals state (users can still chat their way in).

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS. (No component tests cover this file; the suite guards against import/type breakage via route-smoke and lib tests.)

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/components/goals/goal-status-strip.tsx src/app/dashboard/home-assistant.tsx
git commit -m "feat(dashboard): goals-first empty state — strip on top, goal-aware chips, impact line, no-goals CTA"
```

---

### Task 5: First-run guide card + sidebar framing

**Files:**
- Create: `src/components/goals/first-run-guide.tsx`
- Modify: `src/app/dashboard/home-assistant.tsx` (compose the card into the empty-state hero)
- Modify: `src/components/layout/sidebar.tsx:82-88` (nav descriptions)

**Interfaces:**
- Consumes: `firstRunSteps` from `@/lib/goals/dashboard-copy` (Task 3); `getCachedJson` from `@/lib/client/use-cached-json`; `getSnapshot` from `@/lib/client/snapshot` (returns `{ agents: Agent[] }`); `/api/nango/status` responds `{ connections?: Record<string, { connected: boolean }> }`.
- Produces: `FirstRunGuide({ goalsCount }: { readonly goalsCount: number | null })` — renders null until all counts are known and whenever `showGuide` is false.

- [ ] **Step 1: Create `src/components/goals/first-run-guide.tsx`**

```tsx
'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, CheckCircle2, Circle } from 'lucide-react'
import { getCachedJson } from '@/lib/client/use-cached-json'
import { getSnapshot } from '@/lib/client/snapshot'
import { firstRunSteps } from '@/lib/goals/dashboard-copy'

/**
 * Goal-first onboarding: the brand narrative as three soft-ordered steps.
 * State derives from live counts — no persisted onboarding flag; the card
 * disappears once connections, a goal, and an agent all exist.
 */
export function FirstRunGuide({ goalsCount }: { readonly goalsCount: number | null }) {
  const [connections, setConnections] = useState<number | null>(null)
  const [agents, setAgents] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    getCachedJson<{ connections?: Record<string, { connected: boolean }> }>(
      '/api/nango/status',
      60_000,
    )
      .then((data) => {
        if (!cancelled)
          setConnections(
            Object.values(data.connections ?? {}).filter((status) => status.connected).length,
          )
      })
      .catch(() => {
        if (!cancelled) setConnections(0)
      })
    getSnapshot()
      .then((snapshot) => {
        if (!cancelled) setAgents(snapshot.agents.length)
      })
      .catch(() => {
        if (!cancelled) setAgents(0)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (connections === null || agents === null || goalsCount === null) return null
  const { steps, showGuide } = firstRunSteps({ connections, goals: goalsCount, agents })
  if (!showGuide) return null

  return (
    <div className="mb-4 rounded-2xl border bg-card p-4 shadow-1">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Connect. Connect the dots. Deploy. Prove it.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {steps.map((step) => (
          <Link
            key={step.key}
            href={step.href}
            className="group flex items-start gap-2.5 rounded-xl border bg-background p-3 transition-colors hover:bg-muted"
          >
            {step.done ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" aria-hidden />
            ) : (
              <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className="min-w-0">
              <span className="flex items-center gap-1 text-sm font-medium">
                {step.label}
                <ArrowRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{step.detail}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Compose into the dashboard empty state**

In `home-assistant.tsx`, import `FirstRunGuide` and render it as the FIRST child of the empty-state hero container (above `GoalStatusStrip`):

```tsx
<FirstRunGuide goalsCount={goals === null ? null : goals.filter((goal) => !goal.personal && goal.status === 'active').length} />
<GoalStatusStrip goals={goals} />
```

- [ ] **Step 3: Sidebar nav framing (`sidebar.tsx:82-88`)**

Add a `description` per entry and surface it as a `title` tooltip on the nav link:

```tsx
const navigation = [
  { name: 'Home', href: '/dashboard', icon: Sparkles, description: 'Your assistant across the workspace' },
  { name: 'Goals', href: '/goals', icon: Target, description: 'The numbers your workspace is accountable to' },
  { name: 'Agents', href: '/agents', icon: Bot, description: 'Specialized agents serving your goals' },
  { name: 'Integrations', href: '/integrations', icon: Plug, description: 'Connect the tools you already use' },
  { name: 'Flows', href: '/flows', icon: Workflow, description: 'Orchestrate multi-step work' },
]
```

In the nav render (~line 614), add `title={item.description}` to the `<Link>`.

- [ ] **Step 4: Run tests + type-check**

Run: `npm test && npx tsc --noEmit`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/goals/first-run-guide.tsx src/app/dashboard/home-assistant.tsx src/components/layout/sidebar.tsx
git commit -m "feat(onboarding): goal-first first-run guide on dashboard + goal-framed nav tooltips"
```

---

### Task 6: Repo-wide copy sweep + route smoke

**Files:**
- Modify: any stragglers the sweep finds (expected: none beyond Tasks 1-2)
- No new files.

**Interfaces:** none.

- [ ] **Step 1: Retired-phrase sweep**

Run: `grep -rn "knows your business\|AI-agent workspace\|delivers useful outcomes\|deliver useful outcomes" src README.md docs/supabase`
Expected: no output. Fix any hit with the Task 1/2 vocabulary (email templates in `docs/supabase/email-templates/` count as product surfaces).

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: PASS. If a test pinned old copy, update the assertion to the new string — never re-add old copy to satisfy a test.

- [ ] **Step 3: Route smoke for the three changed pages**

Invoke the project `verify` skill (throwaway Postgres + route-smoke protocol) and confirm `/`, `/about`, and `/dashboard` render: `/` and `/about` return 200 with the new hero strings present; `/dashboard` renders for a seeded authenticated user.

- [ ] **Step 4: Build check**

Run: `npx next build`
Expected: build succeeds (this catches server-component/client-component import mistakes the type-checker can miss).

- [ ] **Step 5: Commit (only if the sweep changed files)**

```bash
git add -A
git commit -m "chore(brand): finish goal-based copy sweep"
```
