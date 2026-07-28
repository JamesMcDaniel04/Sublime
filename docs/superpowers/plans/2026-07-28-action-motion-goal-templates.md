# Action-Motion Goal Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reframe 20 of 45 goal templates around the work agents do and the artifact they produce, and fix two defects on the same surfaces — raw cron strings in user-facing labels, and the Goal Metric Collector card rendering no tools.

**Architecture:** `GoalTemplate` gains a compiler-enforced `motion` discriminator (`'outcome' | 'action'`) plus `produces` and `retired`. Action templates count the agents' own output, which puts them inside `AGENT_WRITABLE_SOURCES` so they are measurable with zero integrations. The card branches on motion for its tool row only; readiness branches too, because the existing source-based rule inverts for action templates. Two independent defect fixes ride along: a pure `describeSchedule` module replacing cron strings with local-time phrases, and a `Works with` row surfacing `recommendedIntegrations`.

**Tech Stack:** Next.js (App Router), TypeScript, React, `node:test` + `tsx`, `@testing-library/react` with `@/test-support/jsdom-env`, Tailwind.

**Spec:** `docs/superpowers/specs/2026-07-28-action-motion-goal-templates-design.md`

## Global Constraints

- Test runner: `npm test` runs every `*.test.ts`/`*.test.tsx` under a `__tests__` directory. Single file: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <path>`.
- Typecheck with `npm run typecheck`. Lint with `npm run lint`.
- All 20 pre-v2 legacy template keys must keep resolving through `goalTemplateByKey` forever — bookmarked `/goals/new?template=<key>` links must not 404.
- Exactly 9 **visible** (non-retired) templates per department, 5 org + 4 personal.
- Action templates are `custom_kpi` / `count` / `increase` / `recurrence: 'monthly'`, with `COUNT_LAYOUT` (org) or `PERSONAL_LAYOUT` (personal), and `sources: ['slack_assisted', 'manual']`.
- `rankSources` already forces `manual` last; never hand-append it.
- Component tests import `'@/test-support/jsdom-env'` first, use `afterEach(cleanup)`, and assert with `node:assert/strict`.
- Never widen `requiredIntegrations` to express "either/or" — `missingIntegrations` is an AND check.
- Display-only for schedules: stored crons stay UTC, authoring surfaces are untouched.

**Three independent groups.** Tasks 1–2 (schedules), 3–4 (recommended integrations), and 5–9 (action motion) do not depend on each other. Each group ships on its own.

---

### Task 1: `describeSchedule` pure module

**Files:**
- Create: `src/lib/scheduling/describe-schedule.ts`
- Test: `src/lib/scheduling/__tests__/describe-schedule.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `describeSchedule(schedule: ScheduleLike, viewerTimeZone: string, now: Date): string` and `type ScheduleLike = { type: string; cron?: string; time?: string; timezone?: string; isActive?: boolean }`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/scheduling/__tests__/describe-schedule.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { describeSchedule } from '../describe-schedule'

/** Fixed reference instants so DST is pinned rather than ambient. */
const JULY = new Date('2026-07-15T00:00:00Z')
const JANUARY = new Date('2026-01-15T00:00:00Z')

const cron = (expression: string) => ({ type: 'cron', cron: expression, timezone: 'UTC' })

test('daily cron converts to the viewer 12-hour local time', () => {
  assert.equal(
    describeSchedule(cron('0 7 * * *'), 'America/Denver', JULY),
    'Every day at 1:00 AM MDT',
  )
})

test('the same cron reads differently across a DST boundary', () => {
  assert.equal(
    describeSchedule(cron('0 7 * * *'), 'America/Denver', JANUARY),
    'Every day at 12:00 AM MST',
  )
})

test('a weekly cron shifts the weekday backwards when the local time crosses midnight', () => {
  // Monday 01:00 UTC is Sunday 18:00 in Denver.
  assert.equal(
    describeSchedule(cron('0 1 * * 1'), 'America/Denver', JULY),
    'Every Sunday at 7:00 PM MDT',
  )
})

test('a weekday range keeps its weekday when no midnight is crossed', () => {
  assert.equal(
    describeSchedule(cron('0 16 * * 1-5'), 'America/Denver', JULY),
    'Weekdays at 10:00 AM MDT',
  )
})

test('an eastward viewer keeps the same weekday', () => {
  const label = describeSchedule(cron('0 13 * * 1'), 'Asia/Tokyo', JULY)
  assert.match(label, /^Every Monday at 10:00 PM/)
})

test('a two-day cron lists both days', () => {
  assert.equal(
    describeSchedule(cron('0 16 * * 2,4'), 'UTC', JULY),
    'Every Tuesday and Thursday at 4:00 PM UTC',
  )
})

test('an unparseable cron never prints the expression', () => {
  const label = describeSchedule(cron('*/15 * * * *'), 'America/Denver', JULY)
  assert.equal(label, 'On a custom schedule')
  assert.doesNotMatch(label, /\*/)
})

test('day-of-month crons fall back rather than misreporting', () => {
  assert.equal(describeSchedule(cron('0 9 1 * *'), 'UTC', JULY), 'On a custom schedule')
})

test('non-cron schedule types render without any cron vocabulary', () => {
  assert.equal(describeSchedule({ type: 'manual' }, 'UTC', JULY), 'Runs manually')
  assert.equal(describeSchedule({ type: 'hourly' }, 'UTC', JULY), 'Every hour')
  assert.equal(
    describeSchedule({ type: 'daily', time: '09:00', timezone: 'UTC' }, 'America/Denver', JULY),
    'Every day at 3:00 AM MDT',
  )
})

test('an inactive schedule is marked paused', () => {
  assert.equal(
    describeSchedule({ ...cron('0 7 * * *'), isActive: false }, 'America/Denver', JULY),
    'Every day at 1:00 AM MDT (paused)',
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/scheduling/__tests__/describe-schedule.test.ts`
Expected: FAIL — cannot find module `../describe-schedule`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/scheduling/describe-schedule.ts`:

```ts
/**
 * Turns a stored schedule into a sentence in the viewer's own timezone.
 * Pure — no I/O, no date scanning — so it is safe to call on every render and
 * exhaustively unit-testable.
 *
 * Deliberately NOT built on nextOccurrence: its cron path scans minute-by-minute
 * and has measured ~13s worst case (see trigger-body.tsx), which is why that
 * editor printed a raw cron string instead of a label.
 *
 * `now` is injected rather than read from the clock because DST makes the
 * answer date-dependent: `0 7 * * *` UTC is 1:00 AM MDT in July and 12:00 AM
 * MST in January. That change is correct — the agent really does fire at a
 * different local time — so tests pin the reference instead of avoiding it.
 */

export type ScheduleLike = {
  type: string
  cron?: string
  time?: string
  timezone?: string
  isActive?: boolean
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DAY_ABBREVIATIONS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAYS = [1, 2, 3, 4, 5]
const FALLBACK = 'On a custom schedule'

/** Minutes past midnight plus the days it fires. `days: null` means every day. */
type CronParts = { hour: number; minute: number; days: number[] | null }

/** Cron day-of-week accepts both 0 and 7 for Sunday; normalize to 0-6. */
function parseDayOfWeek(field: string): number[] | null | undefined {
  if (field === '*') return null
  const days = new Set<number>()
  for (const part of field.split(',')) {
    const range = /^([0-7])-([0-7])$/.exec(part)
    if (range) {
      const start = Number(range[1])
      const end = Number(range[2])
      if (start > end) return undefined
      for (let day = start; day <= end; day += 1) days.add(day % 7)
      continue
    }
    if (!/^[0-7]$/.test(part)) return undefined
    days.add(Number(part) % 7)
  }
  return days.size > 0 ? [...days].sort((a, b) => a - b) : undefined
}

/** Only the shapes we can phrase honestly. Steps, hour ranges, and
 *  day-of-month all return null so the caller falls back rather than
 *  describing a schedule it does not actually understand. */
function parseCron(expression: string): CronParts | null {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const minute = Number(fields[0])
  const hour = Number(fields[1])
  if (!/^\d{1,2}$/.test(fields[0]) || minute < 0 || minute > 59) return null
  if (!/^\d{1,2}$/.test(fields[1]) || hour < 0 || hour > 23) return null
  if (fields[2] !== '*' || fields[3] !== '*') return null
  const days = parseDayOfWeek(fields[4])
  if (days === undefined) return null
  return { hour, minute, days }
}

/** How far the wall clock in `timeZone` runs ahead of UTC at `instant`. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant)
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0')
  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour') % 24,
    read('minute'),
    read('second'),
  )
  return asUtc - instant.getTime()
}

/** The instant at which `timeZone` reads the given wall clock. Two passes so a
 *  wall time on the far side of a DST transition still resolves correctly. */
function wallClockToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month, day, hour, minute)
  const firstPass = new Date(naive - zoneOffsetMs(new Date(naive), timeZone))
  return new Date(naive - zoneOffsetMs(firstPass, timeZone))
}

function datePartsIn(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant)
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0')
  return { year: read('year'), month: read('month') - 1, day: read('day') }
}

function weekdayIn(instant: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(instant)
  return DAY_ABBREVIATIONS.indexOf(name)
}

function formatTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(instant)
}

function joinDays(days: number[]): string {
  const names = days.map((day) => DAY_NAMES[day])
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** Resolve a wall clock in `fromZone` into a concrete instant on or after
 *  `now`, so DST is settled by a real date rather than assumed. */
function occurrenceOn(
  weekday: number | null,
  hour: number,
  minute: number,
  fromZone: string,
  now: Date,
): Date {
  const { year, month, day } = datePartsIn(now, fromZone)
  const base = wallClockToInstant(year, month, day, hour, minute, fromZone)
  if (weekday === null) return base
  // Walk forward at most a week to land on the requested source-zone weekday.
  for (let offset = 0; offset < 7; offset += 1) {
    const candidate = wallClockToInstant(year, month, day + offset, hour, minute, fromZone)
    if (weekdayIn(candidate, fromZone) === weekday) return candidate
  }
  return base
}

export function describeSchedule(
  schedule: ScheduleLike,
  viewerTimeZone: string,
  now: Date,
): string {
  const paused = schedule.isActive === false ? ' (paused)' : ''
  const sourceZone = schedule.timezone || 'UTC'

  if (schedule.type === 'manual') return 'Runs manually'
  if (schedule.type === 'once') return `Runs once${paused}`
  if (schedule.type === 'hourly') return `Every hour${paused}`

  if (schedule.type === 'daily' || schedule.type === 'weekly') {
    const [hourText, minuteText] = (schedule.time || '').split(':')
    const hour = Number(hourText)
    const minute = Number(minuteText)
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return `${FALLBACK}${paused}`
    const instant = occurrenceOn(null, hour, minute, sourceZone, now)
    const cadence = schedule.type === 'daily' ? 'Every day' : 'Every week'
    return `${cadence} at ${formatTime(instant, viewerTimeZone)}${paused}`
  }

  if (schedule.type !== 'cron') return `${FALLBACK}${paused}`

  const parsed = parseCron(schedule.cron || '')
  if (!parsed) return `${FALLBACK}${paused}`

  if (parsed.days === null) {
    const instant = occurrenceOn(null, parsed.hour, parsed.minute, sourceZone, now)
    return `Every day at ${formatTime(instant, viewerTimeZone)}${paused}`
  }

  // Map each source-zone weekday through to the viewer's, which is where the
  // day can shift: Monday 01:00 UTC is Sunday evening in Denver.
  const occurrences = parsed.days.map((day) =>
    occurrenceOn(day, parsed.hour, parsed.minute, sourceZone, now),
  )
  const viewerDays = [...new Set(occurrences.map((instant) => weekdayIn(instant, viewerTimeZone)))]
    .sort((a, b) => a - b)
  const time = formatTime(occurrences[0], viewerTimeZone)

  const isWeekdays =
    viewerDays.length === WEEKDAYS.length && WEEKDAYS.every((day) => viewerDays.includes(day))
  if (isWeekdays) return `Weekdays at ${time}${paused}`

  return `Every ${joinDays(viewerDays)} at ${time}${paused}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/scheduling/__tests__/describe-schedule.test.ts`
Expected: PASS, 10 tests.

If a `timeZoneName: 'short'` assertion mismatches (Node ICU can render `GMT+9` rather than `JST`), relax that one assertion to `assert.match` on the time portion only — never relax the weekday or hour assertions, which are the behavior under test.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/lib/scheduling/describe-schedule.ts src/lib/scheduling/__tests__/describe-schedule.test.ts
git commit -m "feat(scheduling): describe schedules in the viewer's local time"
```

---

### Task 2: Replace every user-facing cron string

**Files:**
- Create: `src/lib/scheduling/use-viewer-time-zone.ts`
- Modify: `src/app/templates/[id]/page.tsx:70-77`
- Modify: `src/app/agents/assistant-panel.tsx:74-79`
- Modify: `src/components/flows/nodes/trigger-body.tsx:271-274`

**Interfaces:**
- Consumes: `describeSchedule(schedule, viewerTimeZone, now)` from Task 1.
- Produces: `useViewerTimeZone(fallback: string): string`.

- [ ] **Step 1: Create the hydration-safe timezone hook**

Create `src/lib/scheduling/use-viewer-time-zone.ts`:

```ts
'use client'

import { useEffect, useState } from 'react'

/**
 * The viewer's IANA timezone, resolved after mount.
 *
 * Returns `fallback` on the first render deliberately. The server has no idea
 * what zone the reader is in, so resolving during render would produce a
 * different string on the server than in the browser and trip a hydration
 * mismatch. Passing the schedule's own timezone as the fallback means the first
 * paint is merely less localized, never wrong.
 */
export function useViewerTimeZone(fallback: string): string {
  const [zone, setZone] = useState(fallback)

  useEffect(() => {
    try {
      const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (resolved) setZone(resolved)
    } catch {
      // Keep the fallback — an environment without a resolvable zone is not an
      // error worth surfacing over a schedule label.
    }
  }, [fallback])

  return zone
}
```

- [ ] **Step 2: Fix the template detail page**

In `src/app/templates/[id]/page.tsx`, replace the whole `scheduleLabel` function (lines 70-77, the one containing the hardcoded `'0 14 * * 1'` case) with:

```tsx
function scheduleLabel(template: Template, viewerTimeZone: string): string {
  const schedule = templateSchedule(template)
  if (!schedule.isActive || schedule.type === 'manual') {
    return 'Run manually or add a schedule after connecting'
  }
  return describeSchedule(schedule, viewerTimeZone, new Date())
}
```

Add the imports at the top of the file:

```tsx
import { describeSchedule } from '@/lib/scheduling/describe-schedule'
import { useViewerTimeZone } from '@/lib/scheduling/use-viewer-time-zone'
```

Inside the `TemplateDetails` component, call the hook and thread it through. Find every `scheduleLabel(template)` call site and pass the zone:

```tsx
const viewerTimeZone = useViewerTimeZone(templateSchedule(template).timezone)
// ...at the call site:
{scheduleLabel(template, viewerTimeZone)}
```

Note the hardcoded `if (schedule.cron === '0 14 * * 1') return 'Every Monday at 14:00 ...'` line is deleted, not preserved — it is the same bug patched once by hand.

- [ ] **Step 3: Fix the assistant panel**

In `src/app/agents/assistant-panel.tsx`, replace the `scheduleLabel` function (line 74):

```tsx
function scheduleLabel(schedule: ProposalSchedule, viewerTimeZone: string): string {
  return describeSchedule(
    { type: schedule.type, cron: schedule.cron, time: schedule.time, timezone: schedule.timezone, isActive: schedule.isActive },
    viewerTimeZone,
    new Date(),
  )
}
```

Add the same two imports. Thread `useViewerTimeZone(schedule.timezone || 'UTC')` from the component that calls `scheduleLabel` (it is called from `proposalRows`; pass the zone in as a parameter rather than calling the hook inside a non-component function).

- [ ] **Step 4: Fix the flow trigger editor**

In `src/components/flows/nodes/trigger-body.tsx`, replace line 273:

```tsx
{schedule.type === 'cron'
  ? `Next run: ${describeSchedule(schedule, viewerTimeZone, new Date())}`
  : `Next run: ${nextRunLabel}`}
```

Add the imports, and inside the component add:

```tsx
const viewerTimeZone = useViewerTimeZone(schedule.timezone ?? 'UTC')
```

Leave the raw cron `<input>` at line 255 exactly as it is — that is an authoring control, not a label.

- [ ] **Step 5: Verify no cron strings remain in user-facing copy**

Run:

```bash
grep -rn "cron \${\|per cron\|Scheduled with cron" --include="*.tsx" src/
```

Expected: no matches.

- [ ] **Step 6: Typecheck, lint, full test run, commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/lib/scheduling/use-viewer-time-zone.ts "src/app/templates/[id]/page.tsx" src/app/agents/assistant-panel.tsx src/components/flows/nodes/trigger-body.tsx
git commit -m "fix(ui): show schedules as local times instead of cron expressions"
```

---

### Task 3: `Works with` row on the catalogue card

**Files:**
- Modify: `src/components/templates/template-catalogue-card.tsx:22-32` (props) and `:66-79` (tools slot)
- Modify: `src/components/templates/templates-explorer.tsx:387-397` (caller)
- Test: `src/components/templates/__tests__/template-catalogue-card.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `TemplateCatalogueCard` accepts `recommendedIntegrations?: readonly string[]`.

- [ ] **Step 1: Write the failing test**

Append to `src/components/templates/__tests__/template-catalogue-card.test.tsx`:

```tsx
test('falls back to a Works with row when nothing is required', () => {
  render(
    <TemplateCatalogueCard
      {...props}
      integrations={[]}
      recommendedIntegrations={['Slack', 'Gmail']}
    />,
  )
  assert.ok(screen.getByText('Works with'))
  assert.ok(screen.getByText('Slack'))
  assert.ok(screen.getByText('Gmail'))
  assert.equal(screen.queryByText('Requires'), null)
})

test('required integrations win — recommended ones stay hidden', () => {
  render(
    <TemplateCatalogueCard
      {...props}
      integrations={['HubSpot']}
      recommendedIntegrations={['Slack']}
    />,
  )
  assert.ok(screen.getByText('Requires'))
  assert.equal(screen.queryByText('Works with'), null)
  assert.equal(screen.queryByText('Slack'), null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/templates/__tests__/template-catalogue-card.test.tsx`
Expected: FAIL — "Works with" not found.

- [ ] **Step 3: Implement**

In `src/components/templates/template-catalogue-card.tsx`, add to `TemplateCatalogueCardProps`:

```tsx
  /** Shown only when nothing is required — these are capabilities, not
   *  prerequisites, so they never receive the missing/blocked treatment. */
  recommendedIntegrations?: readonly string[]
```

Destructure `recommendedIntegrations = []` alongside the other props, and replace the `tools={...}` slot with:

```tsx
        tools={
          integrations.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Requires</p>
              <div className="flex flex-wrap gap-1.5">
                {integrations.map((integration) => (
                  <span key={integration} className={cn(missingIntegrations.includes(integration) && 'saturate-150')}>
                    <IntegrationChip name={integration} />
                  </span>
                ))}
              </div>
            </div>
          ) : recommendedIntegrations.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Works with</p>
              <div className="flex flex-wrap gap-1.5">
                {recommendedIntegrations.map((integration) => (
                  <IntegrationChip key={integration} name={integration} />
                ))}
              </div>
            </div>
          ) : undefined
        }
```

In `src/components/templates/templates-explorer.tsx`, add to the `renderCatalogueCard` JSX (after `integrations={...}`):

```tsx
        recommendedIntegrations={t.recommendedIntegrations ?? []}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/templates/__tests__/template-catalogue-card.test.tsx`
Expected: PASS, including the pre-existing characterization tests.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/components/templates/template-catalogue-card.tsx src/components/templates/templates-explorer.tsx src/components/templates/__tests__/template-catalogue-card.test.tsx
git commit -m "fix(templates): surface recommended integrations when none are required"
```

---

### Task 4: Carry recommended integrations through the goal bundle

**Files:**
- Modify: `src/lib/goals/agent-bundle.ts:23-33` (`BundleEntry`) and `:73-85` (`push`)
- Modify: `src/components/goals/agent-bundle-card.tsx:135-143`
- Modify: `src/components/goals/goal-template-detail.tsx:234-242`
- Test: `src/lib/goals/__tests__/agent-bundle.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `BundleEntry` gains `recommendedIntegrations: string[]`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/goals/__tests__/agent-bundle.test.ts`:

```ts
test('the metric collector carries its recommended integrations', () => {
  const bundle = bundleForGoal({
    templateKey: null,
    kind: 'custom_kpi',
    source: 'manual',
  })
  const collector = bundle.find((entry) => entry.seedKey === 'goal-metric-collector')
  assert.ok(collector, 'the collector should be offered on an agent-writable source')
  assert.deepEqual(collector.requiredIntegrations, [], 'it requires neither Slack nor Gmail')
  assert.deepEqual(collector.recommendedIntegrations, ['slack', 'gmail'])
})
```

Ensure `bundleForGoal` and `assert` are already imported at the top of that file; they are.

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/agent-bundle.test.ts`
Expected: FAIL — `recommendedIntegrations` is `undefined`.

- [ ] **Step 3: Implement**

In `src/lib/goals/agent-bundle.ts`, add to `BundleEntry` after `requiredIntegrations`:

```ts
  /** Sources the agent can read from but does not need. Rendered as
   *  capabilities, never as a Connect prerequisite. */
  recommendedIntegrations: string[]
```

and inside `push`, after the `requiredIntegrations` line:

```ts
      recommendedIntegrations: seed.recommendedIntegrations ?? [],
```

In `src/components/goals/agent-bundle-card.tsx`, replace the `entry.requiredIntegrations.length > 0 && !blocked` block (line 135) with:

```tsx
                {!blocked && (entry.requiredIntegrations.length > 0 || entry.recommendedIntegrations.length > 0) && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(entry.requiredIntegrations.length > 0
                      ? entry.requiredIntegrations
                      : entry.recommendedIntegrations
                    ).map((integration) => (
                      <IntegrationChip key={integration} name={integration} />
                    ))}
                  </div>
                )}
```

In `src/components/goals/goal-template-detail.tsx`, replace the `agent.requiredIntegrations.length > 0` block (line 234) with the same shape, substituting `agent` for `entry`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/agent-bundle.test.ts
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/goals/__tests__/agent-bundle-card.test.tsx
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/lib/goals/agent-bundle.ts src/components/goals/agent-bundle-card.tsx src/components/goals/goal-template-detail.tsx src/lib/goals/__tests__/agent-bundle.test.ts
git commit -m "fix(goals): show what the metric collector works with"
```

---

### Task 5: The `motion` discriminator

**Files:**
- Modify: `src/lib/goals/goal-templates.ts:34-110` (types and factory), plus every existing spec literal
- Test: `src/lib/goals/__tests__/goal-templates.test.ts`

**Interfaces:**
- Consumes: `AGENT_WRITABLE_SOURCES` from `@/lib/goals/agent-tool-policy`.
- Produces: `GoalTemplate.motion: 'outcome' | 'action'`, `GoalTemplate.produces?: string`, `GoalTemplate.retired?: true`, and `export const VISIBLE_GOAL_TEMPLATES: GoalTemplate[]`.

This task adds the mechanism and marks all 45 existing templates `outcome`. The catalogue itself does not change yet — that is Tasks 6 and 7.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/goals/__tests__/goal-templates.test.ts`:

```ts
import { VISIBLE_GOAL_TEMPLATES } from '../goal-templates'
import { AGENT_WRITABLE_SOURCES } from '@/lib/goals/agent-tool-policy'

test('every template declares a motion', () => {
  for (const entry of GOAL_TEMPLATES) {
    assert.ok(
      entry.motion === 'outcome' || entry.motion === 'action',
      `${entry.key}: motion must be outcome or action, got ${entry.motion}`,
    )
  }
})

test('produces belongs to action templates and only to them', () => {
  for (const entry of GOAL_TEMPLATES) {
    if (entry.motion === 'action') {
      assert.ok(
        entry.produces && entry.produces.trim().length > 0,
        `${entry.key}: an action template must name what it produces`,
      )
    } else {
      assert.equal(entry.produces, undefined, `${entry.key}: outcome templates do not produce`)
    }
  }
})

test('action templates count agent output, outcome templates never do', () => {
  for (const entry of GOAL_TEMPLATES) {
    const selfReporting = entry.sources.every((source) => AGENT_WRITABLE_SOURCES.has(source))
    assert.equal(
      selfReporting,
      entry.motion === 'action',
      `${entry.key}: an action template's sources must all be agent-writable, ` +
        `and an outcome template's must not all be — otherwise the goal-native ` +
        `collector can or cannot log it, contradicting the motion`,
    )
  }
})

test('retired templates resolve by key but leave the visible catalogue', () => {
  const retired = GOAL_TEMPLATES.filter((entry) => entry.retired)
  for (const entry of retired) {
    assert.ok(goalTemplateByKey(entry.key), `${entry.key}: must still resolve for bookmarks`)
    assert.ok(
      !VISIBLE_GOAL_TEMPLATES.includes(entry),
      `${entry.key}: retired templates must not reach the gallery`,
    )
  }
  assert.equal(VISIBLE_GOAL_TEMPLATES.length, GOAL_TEMPLATES.length - retired.length)
})
```

Then change the existing catalogue-shape test to count visible templates:

```ts
test('catalogue shape: 9 visible per served department, 5 org + 4 personal', () => {
  assert.equal(VISIBLE_GOAL_TEMPLATES.length, PRODUCT_DEPARTMENTS.length * 9)
  for (const department of PRODUCT_DEPARTMENTS) {
    const entries = VISIBLE_GOAL_TEMPLATES.filter((entry) => entry.department === department)
    assert.equal(entries.length, 9, `${department} should have 9 visible templates`)
    assert.equal(entries.filter((entry) => entry.scope === 'org').length, 5, `${department} org split`)
    assert.equal(entries.filter((entry) => entry.scope === 'personal').length, 4, `${department} personal split`)
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/goal-templates.test.ts`
Expected: FAIL — `VISIBLE_GOAL_TEMPLATES` is not exported.

- [ ] **Step 3: Change the types**

In `src/lib/goals/goal-templates.ts`, add to the `GoalTemplate` type after `category`:

```ts
  /** `action` = the number counts the agents' own output, so the goal-native
   *  collector can log it and the goal works with zero integrations.
   *  `outcome` = a system of record owns the number. */
  motion: 'outcome' | 'action'
  /** Action only: the artifact that lands in someone's hands each cycle. */
  produces?: string
  /** Resolves through goalTemplateByKey for bookmarked links, hidden from the
   *  gallery. Deleting a key 404s a bookmark; repurposing one silently changes
   *  what that bookmark creates. Retiring does neither. */
  retired?: true
```

Replace the `TemplateSpec` type with a discriminated union so an action template that forgets `produces` fails to compile:

```ts
type BaseSpec = {
  category: GoalTemplateCategory
  tracks: string
  sources: MetricSource[]
  /** Required, may be `[]`. See GoalTemplate.agents. */
  agents: string[]
  layout: DashboardLayout
  direction?: GoalTemplate['direction']
  unit?: GoalTemplate['unit']
  recurrence?: GoalTemplate['recurrence']
  retired?: true
}

type TemplateSpec =
  | (BaseSpec & { motion: 'outcome' })
  | (BaseSpec & { motion: 'action'; produces: string })
```

In the `template` factory's returned object, after `category: spec.category,`:

```ts
  motion: spec.motion,
  produces: spec.motion === 'action' ? spec.produces : undefined,
  retired: spec.retired,
```

At the bottom of the file, next to `goalTemplateByKey`:

```ts
/** The catalogue the gallery renders. Retired templates still resolve by key —
 *  see GoalTemplate.retired. */
export const VISIBLE_GOAL_TEMPLATES: GoalTemplate[] = GOAL_TEMPLATES.filter(
  (entry) => !entry.retired,
)
```

- [ ] **Step 4: Mark all 45 existing templates as outcome**

Every spec literal opens with a quoted `category:`, and no type declaration does — so this regex hits exactly the 45 literals:

```bash
perl -0pi -e "s/\n(\s+)category: '/\n\$1motion: 'outcome', category: '/g" src/lib/goals/goal-templates.ts
grep -c "motion: 'outcome'" src/lib/goals/goal-templates.ts
```

Expected: `45`. If the count differs, revert with `git checkout src/lib/goals/goal-templates.ts` and redo the type edits by hand — a wrong count means a literal was missed or a type declaration was hit.

- [ ] **Step 5: Run tests to verify they pass**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/goal-templates.test.ts`
Expected: PASS. The agent-writable test passes because zero existing templates are agent-writable-only (verified during design).

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/lib/goals/goal-templates.ts src/lib/goals/__tests__/goal-templates.test.ts
git commit -m "feat(goals): add motion discriminator to goal templates"
```

---

### Task 6: The sales catalogue

**Files:**
- Modify: `src/lib/goals/goal-templates.ts` (the Sales block)
- Modify: `src/lib/goals/__tests__/agent-bundle.test.ts:14`, `:101`
- Modify: `src/components/goals/__tests__/agent-bundle-card.test.tsx:12`
- Modify: `src/components/goals/__tests__/goal-template-agents-ui.test.tsx:11`, `:33`
- Test: `src/lib/goals/__tests__/goal-templates.test.ts`

**Interfaces:**
- Consumes: `motion`, `produces`, `retired` from Task 5.
- Produces: six new sales template keys, listed below.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/goals/__tests__/goal-templates.test.ts`:

```ts
test('sales leads with the work: 6 action, 3 outcome, 1 retired', () => {
  const sales = VISIBLE_GOAL_TEMPLATES.filter((entry) => entry.department === 'sales')
  assert.equal(sales.filter((entry) => entry.motion === 'action').length, 6)
  assert.equal(sales.filter((entry) => entry.motion === 'outcome').length, 3)
  assert.equal(goalTemplateByKey('sales-org-arr-growth')?.retired, true)
})

test('every curated agent on an action template exists in the seed catalogue', () => {
  for (const entry of GOAL_TEMPLATES.filter((candidate) => candidate.motion === 'action')) {
    assert.ok(entry.agents.length > 0, `${entry.key}: an action template needs curated agents`)
    for (const seedKey of entry.agents) {
      assert.ok(getSeedByKey(seedKey), `${entry.key}: unknown seed ${seedKey}`)
    }
  }
})
```

Add `import { getSeedByKey } from '@/lib/templates/catalogue'` to that test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/goal-templates.test.ts`
Expected: FAIL — sales has 0 action templates.

- [ ] **Step 3: Rewrite the sales block**

In `src/lib/goals/goal-templates.ts`, delete these five templates entirely: `sales-org-pipeline-coverage`, `sales-org-win-rate`, `sales-org-new-logos`, `sales-personal-pipeline-created`, `sales-personal-meetings-booked`.

Add `retired: true,` to the `sales-org-arr-growth` spec. Leave `sales-org-quarterly-revenue`, `sales-personal-quota`, and `sales-personal-monthly-closed` untouched.

Then add these six:

```ts
  template('sales-org-work-the-whitespace', 'sales', 'org', 'Work the whitespace list', 'Unworked accounts get ranked and turned into a next-best play every week.', 'custom_kpi', {
    motion: 'action', category: 'Pipeline', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    produces: 'a ranked whitespace list with a next-best play per account',
    tracks: 'Whitespace accounts the team opened a first touch on this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['sales-territory-white-space', 'sales-account-intent-brief'],
  }),
  template('sales-org-qualify-inbound-same-day', 'sales', 'org', 'Qualify every inbound within a day', 'Every inbound lead gets scored, enriched, and routed before it goes cold.', 'custom_kpi', {
    motion: 'action', category: 'Pipeline', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    produces: 'a scored qualification brief and a routed owner per lead',
    tracks: 'Inbound leads qualified and routed within 24 hours this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['sales-new-lead-to-sf-opportunity', 'sales-account-intent-brief'],
  }),
  template('sales-org-multithread-open-deals', 'sales', 'org', 'Multithread every open deal', 'Every open deal gets its buying committee mapped and the missing roles worked.', 'custom_kpi', {
    motion: 'action', category: 'Pipeline', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    produces: 'a buying-committee map and a named intro plan per deal',
    tracks: 'Open deals brought to three or more engaged contacts this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['sales-multithreading-map', 'sales-account-intent-brief'],
  }),
  template('sales-org-close-plan-on-commit', 'sales', 'org', 'A close plan on every commit deal', 'Nothing sits in commit without an agreed path to signature.', 'custom_kpi', {
    motion: 'action', category: 'Revenue', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    produces: 'a mutual action plan with owners and dates, ready to send',
    tracks: 'Commit-stage deals with a customer-agreed action plan this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['sales-mutual-action-plan', 'sales-deal-desk-packet'],
  }),
  template('sales-personal-revive-stalled-deals', 'sales', 'personal', 'Revive every stalled deal', 'Deals with no touch in two weeks get a grounded re-entry, not a nudge.', 'custom_kpi', {
    motion: 'action', category: 'Pipeline', unit: 'count', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    produces: 'a re-entry email drafted from the last real conversation',
    tracks: 'Stalled deals in your book you re-engaged this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['sales-sequence-personalizer', 'sales-prospect-followup-digest'],
  }),
  template('sales-personal-followup-same-day', 'sales', 'personal', 'Follow up before the day ends', 'Every meeting turns into a follow-up that repeats what was actually committed.', 'custom_kpi', {
    motion: 'action', category: 'Pipeline', unit: 'count', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    produces: 'a follow-up recapping commitments and the next step',
    tracks: 'Meetings you followed up on the same day this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['sales-discovery-followup-writer', 'sales-prospect-followup-digest'],
  }),
```

- [ ] **Step 4: Repoint the four test fixtures**

`sales-org-pipeline-coverage` no longer exists. In each of these, replace it with `'sales-org-multithread-open-deals'`:

- `src/lib/goals/__tests__/agent-bundle.test.ts:14` and `:101`
- `src/components/goals/__tests__/agent-bundle-card.test.tsx:12`
- `src/components/goals/__tests__/goal-template-agents-ui.test.tsx:11` and `:33`

If any of those tests assert on specific curated seed names, update the expectation to `sales-multithreading-map` and `sales-account-intent-brief`. Do not weaken an assertion to make it pass — if a test expected two curated entries, it should still expect two.

`src/components/goals/__tests__/goal-template-card.test.tsx:29` uses `sales-org-arr-growth` as its no-recurrence fixture; it still resolves after retirement, so leave it alone.

- [ ] **Step 5: Run the full suite**

```bash
npm test
```
Expected: PASS. The catalogue-shape test confirms 9 visible sales templates, 5 org + 4 personal.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add -A src/lib/goals src/components/goals
git commit -m "feat(goals): reframe the sales catalogue around the work"
```

---

### Task 7: The remaining four departments

**Files:**
- Modify: `src/lib/goals/goal-templates.ts` (Marketing, Engineering, Finance, CSM blocks)
- Test: `src/lib/goals/__tests__/goal-templates.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5 and 6.
- Produces: 14 new template keys.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/goals/__tests__/goal-templates.test.ts`:

```ts
test('every department carries action templates in the agreed mix', () => {
  const expected: Record<string, number> = {
    sales: 6, marketing: 4, engineering: 3, finance: 3, csm: 4,
  }
  for (const [department, count] of Object.entries(expected)) {
    const actual = VISIBLE_GOAL_TEMPLATES.filter(
      (entry) => entry.department === department && entry.motion === 'action',
    ).length
    assert.equal(actual, count, `${department}: expected ${count} action templates, got ${actual}`)
  }
  assert.equal(VISIBLE_GOAL_TEMPLATES.filter((entry) => entry.motion === 'action').length, 20)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/goal-templates.test.ts`
Expected: FAIL — marketing has 0 action templates.

- [ ] **Step 3: Marketing — delete four, add four**

Delete `marketing-org-cac`, `marketing-org-organic-traffic`, `marketing-personal-content-output`, `marketing-personal-conversion-rate`. Add:

```ts
  template('marketing-org-work-every-event-lead', 'marketing', 'org', 'Work every event lead within a week', 'Event leads get segmented, enriched, and handed to sales before they cool.', 'custom_kpi', {
    motion: 'action', category: 'Demand', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    produces: 'a segmented follow-up and a sales handoff per lead',
    tracks: 'Event leads followed up within a week this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['marketing-event-followup-orchestrator', 'mkt-inbound-mql-router'],
  }),
  template('marketing-org-brief-every-launch', 'marketing', 'org', 'A readiness brief before every launch', 'No launch ships without tasks, creative, and enablement reconciled.', 'custom_kpi', {
    motion: 'action', category: 'Delivery', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    produces: 'a launch readiness scorecard with named blockers and owners',
    tracks: 'Launches with a completed readiness brief this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['marketing-launch-readiness', 'marketing-campaign-command-center'],
  }),
  template('marketing-personal-repurpose-every-piece', 'marketing', 'personal', 'Repurpose every piece I publish', 'One piece becomes every channel it should have been on.', 'custom_kpi', {
    motion: 'action', category: 'Demand', unit: 'count', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    produces: 'channel-specific variants with source-backed claims',
    tracks: 'Pieces you repurposed into at least one other channel this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['marketing-content-repurpose-engine', 'mkt-content-repurposer'],
  }),
  template('marketing-personal-messaging-from-customers', 'marketing', 'personal', 'Ground my messaging in customer words', 'Claims trace back to something a customer actually said.', 'custom_kpi', {
    motion: 'action', category: 'Demand', unit: 'count', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    produces: 'cited messaging themes and objections from real conversations',
    tracks: 'Messaging updates grounded in cited customer conversations this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['marketing-voice-of-customer', 'marketing-competitive-narrative'],
  }),
```

- [ ] **Step 4: Engineering — delete three, add three**

Delete `engineering-org-deploy-frequency`, `engineering-org-lead-time`, `engineering-personal-test-coverage`. Add:

```ts
  template('engineering-org-release-go-no-go', 'engineering', 'org', 'A go/no-go brief before every release', 'Every release gets a named decision instead of a hopeful deploy.', 'custom_kpi', {
    motion: 'action', category: 'Delivery', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    produces: 'a release readiness brief with named blockers and owners',
    tracks: 'Releases that shipped with a completed go/no-go brief this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['eng-release-readiness-room', 'eng-pr-review-checklist-bot'],
  }),
  template('engineering-org-incident-context-packet', 'engineering', 'org', 'A context packet on every incident', 'Responders open a timeline, not a blank channel.', 'custom_kpi', {
    motion: 'action', category: 'Quality', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    produces: 'a timestamped incident context packet',
    tracks: 'Incidents that got a context packet this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['eng-incident-context-assembler', 'eng-oncall-handoff'],
  }),
  template('engineering-personal-capture-every-decision', 'engineering', 'personal', 'Capture every architecture decision', 'Decisions made in review threads become findable records.', 'custom_kpi', {
    motion: 'action', category: 'Delivery', unit: 'count', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    produces: 'a drafted ADR with evidence and tradeoffs',
    tracks: 'Architecture decisions you captured as an ADR this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['eng-architecture-decision-miner'],
  }),
```

- [ ] **Step 5: Finance — delete three, add three**

Delete `finance-org-revenue-per-head`, `finance-org-burn-reduction`, `finance-personal-forecast-accuracy`. Add:

```ts
  template('finance-org-work-every-overdue-invoice', 'finance', 'org', 'Work every overdue invoice', 'Collections get worked by value and relationship, not by spreadsheet order.', 'custom_kpi', {
    motion: 'action', category: 'Cost', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    produces: 'a ranked collection queue with drafted outreach',
    tracks: 'Overdue invoices with outreach sent this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['finance-cash-collection-prioritizer', 'fin-weekly-cash-ar-digest'],
  }),
  template('finance-org-review-every-spend-exception', 'finance', 'org', 'Review every spend exception', 'Unusual spend gets a named reviewer before it becomes a surprise.', 'custom_kpi', {
    motion: 'action', category: 'Cost', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    produces: 'an exception queue tied to approvals and plan',
    tracks: 'Spend exceptions reviewed and closed this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['finance-spend-exception-review', 'fin-spend-anomaly-reporter'],
  }),
  template('finance-personal-explain-every-variance', 'finance', 'personal', 'Explain every material variance', 'Variances arrive with a reason attached, not a question mark.', 'custom_kpi', {
    motion: 'action', category: 'Quality', unit: 'count', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    produces: 'a cited variance narrative for leadership',
    tracks: 'Material variances you explained with cited evidence this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['finance-revenue-variance-explainer', 'finance-forecast-assumption-register'],
  }),
```

- [ ] **Step 6: CSM — delete four, add four**

Delete `csm-org-time-to-value`, `csm-org-csat`, `csm-personal-qbr-coverage`, `csm-personal-response-time`. Add:

```ts
  template('csm-org-plan-every-new-account', 'csm', 'org', 'A plan for every new account', 'Onboarding starts from a plan with owners and dates, not an intro call.', 'custom_kpi', {
    motion: 'action', category: 'Retention', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    produces: 'an onboarding plan with owners, dates, and risk flags',
    tracks: 'New accounts that started with a completed onboarding plan this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['csm-onboarding-task-orchestrator', 'csm-onboarding-risk-radar'],
  }),
  template('csm-org-close-every-adoption-gap', 'csm', 'org', 'Close every adoption gap', 'Unused capability becomes a named play, not a health-score number.', 'custom_kpi', {
    motion: 'action', category: 'Retention', unit: 'count', recurrence: 'monthly', layout: COUNT_LAYOUT,
    produces: 'a named adoption gap and the play to close it',
    tracks: 'Adoption gaps worked to a close this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['csm-adoption-gap-finder', 'csm-health-score-explainer'],
  }),
  template('csm-personal-brief-every-qbr', 'csm', 'personal', 'A real brief before every QBR', 'You walk in with outcomes and an ask, not a slide of usage charts.', 'custom_kpi', {
    motion: 'action', category: 'Retention', unit: 'count', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    produces: 'a QBR brief with outcomes, risks, and an expansion ask',
    tracks: 'QBRs you ran from a prepared brief this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['csm-qbr-prep-brief', 'csm-executive-briefing'],
  }),
  template('csm-personal-work-every-risk-flag', 'csm', 'personal', 'Work every risk flag in my book', 'A risk signal becomes a save play the same week it appears.', 'custom_kpi', {
    motion: 'action', category: 'Retention', unit: 'count', recurrence: 'monthly', layout: PERSONAL_LAYOUT,
    produces: 'a churn-risk brief with the save play',
    tracks: 'Risk flags in your book you worked this month.',
    sources: ['slack_assisted', 'manual'],
    agents: ['csm-churn-risk-early-warning', 'csm-escalation-command-center'],
  }),
```

- [ ] **Step 7: Run the full suite**

```bash
npm test
```
Expected: PASS — 20 action templates, 9 visible per department with the 5/4 split intact.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
git add src/lib/goals/goal-templates.ts src/lib/goals/__tests__/goal-templates.test.ts
git commit -m "feat(goals): add action templates across marketing, engineering, finance, and CSM"
```

---

### Task 8: Motion-aware readiness

**Files:**
- Create: `src/lib/goals/template-readiness.ts`
- Test: `src/lib/goals/__tests__/template-readiness.test.ts`

**Interfaces:**
- Consumes: `GoalTemplate` from Task 5, `bundleForGoal` from `@/lib/goals/agent-bundle`.
- Produces: `templateIsReady(template: GoalTemplate, connectedSources: Set<string>, connectedIntegrations: Set<string>): boolean`.

Extracted to its own pure module because both the card and the gallery need it, and two copies of a rule this subtle will drift.

- [ ] **Step 1: Write the failing test**

Create `src/lib/goals/__tests__/template-readiness.test.ts`:

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { templateIsReady } from '../template-readiness'
import { goalTemplateByKey } from '../goal-templates'

const outcome = goalTemplateByKey('sales-org-quarterly-revenue')!
const action = goalTemplateByKey('sales-org-multithread-open-deals')!

test('an outcome template is ready once a real metric source is connected', () => {
  assert.equal(templateIsReady(outcome, new Set(['stripe']), new Set()), true)
  assert.equal(templateIsReady(outcome, new Set(), new Set()), false)
})

test('manual never makes an outcome template ready', () => {
  // Otherwise every template scores ready and the signal says nothing.
  assert.equal(templateIsReady(outcome, new Set(['manual']), new Set()), false)
})

test('an action template is ready when a curated agent can actually run', () => {
  // sales-multithreading-map requires salesforce + granola.
  assert.equal(
    templateIsReady(action, new Set(), new Set(['salesforce', 'granola'])),
    true,
  )
})

test('a partially connected action template is not ready', () => {
  assert.equal(templateIsReady(action, new Set(), new Set(['salesforce'])), false)
})

test('action readiness ignores metric sources entirely', () => {
  assert.equal(templateIsReady(action, new Set(['stripe', 'hubspot']), new Set()), false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/template-readiness.test.ts`
Expected: FAIL — cannot find module `../template-readiness`.

- [ ] **Step 3: Implement**

Create `src/lib/goals/template-readiness.ts`:

```ts
/**
 * Whether a workspace can start a template today. Pure so the card and the
 * gallery cannot disagree.
 *
 * The rule has to branch on motion. An outcome template is inert until a
 * system of record is connected. An action template counts the agents' own
 * output, so its metric needs nothing at all — its real prerequisite is that
 * at least one of the agents doing the work can run. Scoring action templates
 * on their metric source would mark all 20 not-ready and sort the day-one
 * templates to the bottom of the grid.
 */
import type { GoalTemplate } from '@/lib/goals/goal-templates'
import { bundleForGoal } from '@/lib/goals/agent-bundle'

export function templateIsReady(
  template: GoalTemplate,
  connectedSources: Set<string>,
  connectedIntegrations: Set<string>,
): boolean {
  if (template.motion === 'action') {
    // source: null — the metric source is chosen later in the wizard.
    const bundle = bundleForGoal({
      templateKey: template.key,
      kind: template.kind,
      source: null,
      recurrence: template.recurrence,
    })
    return bundle.some(
      (entry) =>
        entry.origin === 'curated' &&
        entry.requiredIntegrations.length > 0 &&
        entry.requiredIntegrations.every((integration) =>
          connectedIntegrations.has(integration),
        ),
    )
  }

  // `manual` is excluded: every template can fall back to manual entry, so
  // counting it would mark all of them ready and say nothing.
  return template.sources.some(
    (source) => source !== 'manual' && connectedSources.has(source),
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/goals/__tests__/template-readiness.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/lib/goals/template-readiness.ts src/lib/goals/__tests__/template-readiness.test.ts
git commit -m "feat(goals): motion-aware template readiness"
```

---

### Task 9: The card and the gallery

**Files:**
- Modify: `src/components/goals/goal-template-card.tsx`
- Modify: `src/components/goals/goal-template-gallery.tsx`
- Test: `src/components/goals/__tests__/goal-template-card.test.tsx`
- Test: `src/components/goals/__tests__/goal-template-gallery.test.tsx`

**Interfaces:**
- Consumes: `templateIsReady` from Task 8, `VISIBLE_GOAL_TEMPLATES` from Task 5.
- Produces: `GoalTemplateCard` accepts an added required prop `connectedIntegrations: Set<string>`.

- [ ] **Step 1: Write the failing test**

Append to `src/components/goals/__tests__/goal-template-card.test.tsx`:

```tsx
const actionTemplate = goalTemplateByKey('sales-personal-revive-stalled-deals')!

test('an action card leads with the agents and the artifact, not a data source', () => {
  render(
    <GoalTemplateCard
      template={actionTemplate}
      connectedSources={new Set()}
      connectedIntegrations={new Set()}
      onOpen={() => {}}
    />,
  )
  assert.ok(screen.getByText('Agents do'))
  assert.equal(screen.queryByText('Reads from'), null)
  assert.ok(screen.getByText('Signal-Based Sequence Personalizer'))
  assert.ok(
    screen.queryAllByText((_, element) =>
      (element?.textContent ?? '').includes(actionTemplate.produces!),
    ).length > 0,
    'the card must name what it produces',
  )
})

test('an outcome card still reads from its sources', () => {
  render(
    <GoalTemplateCard
      template={template}
      connectedSources={new Set()}
      connectedIntegrations={new Set()}
      onOpen={() => {}}
    />,
  )
  assert.ok(screen.getByText('Reads from'))
  assert.equal(screen.queryByText('Agents do'), null)
})
```

Every existing `render(<GoalTemplateCard ... />)` in this file needs `connectedIntegrations={new Set()}` added.

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/goals/__tests__/goal-template-card.test.tsx`
Expected: FAIL — "Agents do" not found.

- [ ] **Step 3: Implement the card**

In `src/components/goals/goal-template-card.tsx`, add `connectedIntegrations: Set<string>` to the props type and destructuring, import `templateIsReady` from `@/lib/goals/template-readiness`, and add a constant beside `VISIBLE_SOURCES`:

```tsx
const VISIBLE_AGENTS = 2
```

Replace the `ready` computation:

```tsx
  const ready = templateIsReady(template, connectedSources, connectedIntegrations)
```

Keep the memoized `bundleForGoal` call but also derive the curated entries from it:

```tsx
  const bundle = useMemo(
    () =>
      bundleForGoal({
        templateKey: template.key,
        kind: template.kind,
        source: null,
        recurrence: template.recurrence,
      }),
    [template.key, template.kind, template.recurrence],
  )
  const agentCount = bundle.length
  const curated = bundle.filter((entry) => entry.origin === 'curated')
  const shownAgents = curated.slice(0, VISIBLE_AGENTS)
  const agentOverflow = curated.length - shownAgents.length
```

Replace the `tools={...}` slot with a motion branch:

```tsx
        tools={
          template.motion === 'action' ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Agents do</p>
              <div className="flex flex-wrap items-center gap-1.5">
                {shownAgents.map((entry) => (
                  <IntegrationChip key={entry.seedKey} name={entry.name} />
                ))}
                {agentOverflow > 0 && (
                  <span className="text-xs font-medium text-muted-foreground">+{agentOverflow}</span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">Produces {template.produces}</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Reads from</p>
              <div className="flex flex-wrap items-center gap-1.5">
                {shown.map((source) => (
                  <span
                    key={source}
                    data-connected={connectedSources.has(source)}
                    className={cn(!connectedSources.has(source) && 'opacity-55')}
                  >
                    <IntegrationChip
                      name={SOURCE_LABELS[source] ?? source}
                      logo={<SourceLogo source={source} className="h-4 w-4" />}
                    />
                  </span>
                ))}
                {overflow > 0 && (
                  <span className="text-xs font-medium text-muted-foreground">+{overflow}</span>
                )}
              </div>
              {agentCount > 0 && (
                <p className="text-xs font-medium text-muted-foreground">
                  {agentCount} {agentCount === 1 ? 'agent' : 'agents'} work on it
                </p>
              )}
            </div>
          )
        }
```

- [ ] **Step 4: Implement the gallery**

In `src/components/goals/goal-template-gallery.tsx`:

Replace the `GOAL_TEMPLATES` import with `VISIBLE_GOAL_TEMPLATES`, import `templateIsReady` from `@/lib/goals/template-readiness` and `connectedSlugSet` from `@/lib/templates/relevance`, and delete the local `isReady` helper.

Add a second best-effort fetch beside `loadSources`:

```tsx
  const [integrations, setIntegrations] = useState<
    Parameters<typeof connectedSlugSet>[0]
  >([])

  // Best-effort, exactly like loadSources: action templates are ranked by
  // whether their agents can run, so this drives readiness for those cards.
  // A failure degrades to "nothing connected" and never gates a card.
  const loadIntegrations = useCallback(async () => {
    try {
      const response = await fetch('/api/integrations/available', { cache: 'no-store' })
      const body = await response.json()
      if (!response.ok || !body.success) throw new Error('integrations unavailable')
      setIntegrations(body.tools ?? [])
    } catch {
      setIntegrations([])
    }
  }, [])

  useEffect(() => { void loadIntegrations() }, [loadIntegrations])

  const connectedIntegrations = useMemo(
    () => connectedSlugSet(integrations),
    [integrations],
  )
```

Rewrite `byReadiness` and `visible` to use the shared rule:

```tsx
const byReadiness = (
  templates: readonly GoalTemplate[],
  connectedSources: Set<string>,
  connectedIntegrations: Set<string>,
) =>
  [...templates].sort(
    (a, b) =>
      Number(templateIsReady(b, connectedSources, connectedIntegrations)) -
      Number(templateIsReady(a, connectedSources, connectedIntegrations)),
  )
```

```tsx
  const visible = useMemo(() => {
    const inDepartment =
      department === 'all'
        ? VISIBLE_GOAL_TEMPLATES
        : VISIBLE_GOAL_TEMPLATES.filter((entry) => entry.department === department)
    return byReadiness(inDepartment, connected, connectedIntegrations)
  }, [department, connected, connectedIntegrations])
```

Pass the new prop to the card:

```tsx
              connectedIntegrations={connectedIntegrations}
```

- [ ] **Step 5: Add the gallery test**

Append to `src/components/goals/__tests__/goal-template-gallery.test.tsx`:

```tsx
test('a retired template resolves by key but never reaches the grid', () => {
  assert.ok(goalTemplateByKey('sales-org-arr-growth'), 'bookmarked links must still resolve')
  assert.ok(
    !VISIBLE_GOAL_TEMPLATES.some((entry) => entry.key === 'sales-org-arr-growth'),
    'a retired template must not render in the gallery',
  )
})
```

Add the imports it needs: `goalTemplateByKey` and `VISIBLE_GOAL_TEMPLATES` from `@/lib/goals/goal-templates`. Match the existing mocking style in that file — if it stubs `fetch` for `/api/goals/metrics/sources`, extend the stub to answer `/api/integrations/available` with `{ success: true, tools: [] }` so the new fetch does not warn.

- [ ] **Step 6: Run the full suite**

```bash
npm run typecheck && npm run lint && npm test
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/goals
git commit -m "feat(goals): action cards lead with the work and rank by agent readiness"
```

---

## Self-Review

**Spec coverage.** §1 motion discriminator → Task 5. §2 `retired` and legacy arithmetic → Tasks 5 (mechanism, visible-count test) and 6 (retiring `sales-org-arr-growth`). §3 catalogue → Tasks 6 and 7. §4 card and readiness → Tasks 8 and 9. §5 schedule display → Tasks 1 and 2. §6 recommended integrations → Tasks 3 and 4. §7 tests → distributed; every listed invariant appears in Tasks 5, 6, 7, 8, or 9. Out-of-scope items are absent from every task, as intended.

**Type consistency.** `templateIsReady(template, connectedSources, connectedIntegrations)` is defined in Task 8 and called with that argument order in Task 9's card and gallery. `describeSchedule(schedule, viewerTimeZone, now)` is defined in Task 1 and called with three arguments at all three sites in Task 2. `VISIBLE_GOAL_TEMPLATES` is exported in Task 5 and consumed in Tasks 6, 7, 8, and 9. `BundleEntry.recommendedIntegrations` is added in Task 4 and read in Task 4's two components only — Task 9 reads `entry.name` and `entry.origin`, which already exist.

**Known ordering hazard.** Task 8's test imports `sales-org-multithread-open-deals`, which Task 6 creates. Running Task 8 before Task 6 will fail on a null fixture. Tasks 5 → 6 → 7 → 8 → 9 must run in order. Tasks 1–2 and 3–4 are free to run at any point.
