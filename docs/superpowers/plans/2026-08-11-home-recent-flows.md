# Home Recent-Flows Strip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Pick up where you left off" strip to the Home hero — the 3 most recently updated flows as quick links back into their canvases.

**Architecture:** A pure selection function in `src/lib/flows/recent.ts` (unit-tested), a small client component `RecentFlows` next to `home-assistant.tsx` that reads the already-cached `/api/flows?goal=<scope>` payload, and two tiny extractions (`relativeTime`, `STATUS_STYLE`) so the strip reuses existing display idioms instead of duplicating them. No new API work — the flows endpoint already returns `updatedAt desc` and the sidebar warms the cache at sign-in.

**Tech Stack:** Next.js App Router (client components), `useCachedJson` SWR-style cache, `node:test` + `tsx` for unit tests, Tailwind + existing UI kit (`Badge`, `ScopedLink`).

**Spec:** `docs/superpowers/specs/2026-08-11-home-recent-flows-design.md`

## Global Constraints

- Cap the strip at **3** flows (`RECENT_FLOWS_LIMIT = 3`).
- Exclude AI-suggested drafts: `suggested && status === 'draft'`.
- Strip renders **only in the hero (pre-chat) state** of Home, below the preset chips.
- Render **nothing** while loading, on error, or when no qualifying flows exist — no header, no empty state.
- Preserve the API's recency order — do not re-sort client-side.
- Section header copy: `Pick up where you left off`; link copy: `All flows →`.
- Work on the current branch `feat/flow-import`. `git add` only the exact paths named in each commit step — unrelated commits can land mid-session in this repo.

---

### Task 1: `pickRecentFlows` selection logic (TDD)

**Files:**
- Create: `src/lib/flows/recent.ts`
- Test: `src/lib/flows/__tests__/recent.test.ts`

**Interfaces:**
- Consumes: nothing (pure module, no imports).
- Produces: `RECENT_FLOWS_LIMIT: number` (= 3), `type RecentFlowInput = { id: string; name: string; status: string; updatedAt: string; suggested?: boolean }`, and `pickRecentFlows<T extends RecentFlowInput>(flows: T[] | undefined | null): T[]`. Task 3's component imports `pickRecentFlows` and relies on the generic passing its own item type through.

- [ ] **Step 1: Write the failing test**

Create `src/lib/flows/__tests__/recent.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickRecentFlows, RECENT_FLOWS_LIMIT } from '../recent'

const flow = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: `Flow ${id}`,
  status: 'active',
  updatedAt: '2026-08-11T00:00:00.000Z',
  ...overrides,
})

test('caps at three and preserves the API order', () => {
  const flows = [flow('a'), flow('b'), flow('c'), flow('d')]
  const picked = pickRecentFlows(flows)
  assert.equal(RECENT_FLOWS_LIMIT, 3)
  assert.deepEqual(picked.map((f) => f.id), ['a', 'b', 'c'])
})

test('excludes suggested drafts but keeps suggested flows the user activated', () => {
  const flows = [
    flow('suggested-draft', { suggested: true, status: 'draft' }),
    flow('suggested-active', { suggested: true, status: 'active' }),
    flow('plain-draft', { status: 'draft' }),
  ]
  const picked = pickRecentFlows(flows)
  assert.deepEqual(picked.map((f) => f.id), ['suggested-active', 'plain-draft'])
})

test('includes disabled and draft (non-suggested) flows', () => {
  const flows = [flow('off', { status: 'disabled' }), flow('wip', { status: 'draft' })]
  assert.deepEqual(pickRecentFlows(flows).map((f) => f.id), ['off', 'wip'])
})

test('returns [] for empty, undefined, null, and non-array input', () => {
  assert.deepEqual(pickRecentFlows([]), [])
  assert.deepEqual(pickRecentFlows(undefined), [])
  assert.deepEqual(pickRecentFlows(null), [])
  assert.deepEqual(pickRecentFlows('nope' as never), [])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/jamesmcdaniel/Sublime && TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/recent.test.ts`
Expected: FAIL — cannot find module `../recent`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/flows/recent.ts`:

```ts
/**
 * Selection logic for the Home "Pick up where you left off" strip.
 * Pure (no React, no fetch) so it is directly unit-testable.
 */

/** The slice of the /api/flows list payload the Home strip reads. */
export type RecentFlowInput = {
  id: string
  name: string
  status: string
  updatedAt: string
  suggested?: boolean
}

/** Cards shown on the Home strip. */
export const RECENT_FLOWS_LIMIT = 3

/**
 * The most recently updated flows, excluding AI-suggested drafts — those are
 * Sublime's proposals, not flows the user worked on, and they already have a
 * dedicated rail on the Flows page. Relies on the API's `updatedAt desc`
 * ordering instead of re-sorting.
 */
export function pickRecentFlows<T extends RecentFlowInput>(flows: T[] | undefined | null): T[] {
  if (!Array.isArray(flows)) return []
  return flows
    .filter((flow) => !(flow.suggested && flow.status === 'draft'))
    .slice(0, RECENT_FLOWS_LIMIT)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/jamesmcdaniel/Sublime && TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/recent.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/recent.ts src/lib/flows/__tests__/recent.test.ts
git commit -m "feat(home): selection logic for the recent-flows strip

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Extract shared display helpers (`relativeTime`, `STATUS_STYLE`)

Pure refactor — no behavior change. Both helpers currently live as private copies inside files the new strip cannot import from without creating a cycle (`home-assistant.tsx` will import the strip component in Task 3) or importing from a page module (`flows/page.tsx`).

**Files:**
- Create: `src/lib/client/relative-time.ts`
- Create: `src/components/flows/flow-status.ts`
- Modify: `src/app/(app)/g/[scope]/dashboard/home-assistant.tsx` (delete local `relativeTime`, lines ~60–75, import instead)
- Modify: `src/app/(app)/g/[scope]/flows/page.tsx` (delete local `STATUS_STYLE`, lines ~94–98, import instead)

**Interfaces:**
- Consumes: the existing private implementations (moved verbatim).
- Produces: `relativeTime(iso: string): string` from `@/lib/client/relative-time`; `STATUS_STYLE: Record<string, string>` from `@/components/flows/flow-status`. Task 3 imports both.

- [ ] **Step 1: Create `src/lib/client/relative-time.ts`**

Move the function verbatim from `home-assistant.tsx` (its body must not change):

```ts
/** Compact relative time for list rows, e.g. "just now", "2h", "3d". */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w`
  return `${Math.floor(days / 30)}mo`
}
```

- [ ] **Step 2: Point `home-assistant.tsx` at it**

In `src/app/(app)/g/[scope]/dashboard/home-assistant.tsx`: delete the local `relativeTime` function **and** its doc comment (`/** Compact relative time … */`), and add to the imports:

```ts
import { relativeTime } from '@/lib/client/relative-time'
```

- [ ] **Step 3: Create `src/components/flows/flow-status.ts`**

Move the map verbatim from `flows/page.tsx`:

```ts
/** Flow status → badge classes, shared by the Flows grid and the Home recent-flows strip. */
export const STATUS_STYLE: Record<string, string> = {
  active: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
  draft: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
  disabled: 'border-border bg-muted text-muted-foreground',
}
```

- [ ] **Step 4: Point `flows/page.tsx` at it**

In `src/app/(app)/g/[scope]/flows/page.tsx`: delete the local `STATUS_STYLE` constant, and add to the imports:

```ts
import { STATUS_STYLE } from '@/components/flows/flow-status'
```

- [ ] **Step 5: Verify the refactor**

Run: `cd /Users/jamesmcdaniel/Sublime && npm run typecheck`
Expected: exits 0. (Runs `prisma generate` first — that is normal.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/client/relative-time.ts src/components/flows/flow-status.ts "src/app/(app)/g/[scope]/dashboard/home-assistant.tsx" "src/app/(app)/g/[scope]/flows/page.tsx"
git commit -m "refactor: share relativeTime and flow STATUS_STYLE for the home strip

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `RecentFlows` component, wired into the Home hero

**Files:**
- Create: `src/app/(app)/g/[scope]/dashboard/recent-flows.tsx`
- Modify: `src/app/(app)/g/[scope]/dashboard/home-assistant.tsx` (hero branch, after the preset-chips `<div>`, ~line 700)

**Interfaces:**
- Consumes: `pickRecentFlows` (Task 1), `relativeTime` + `STATUS_STYLE` (Task 2), existing `useScope`, `useCachedJson`, `ScopedLink`, `Badge`, `cn`.
- Produces: `RecentFlows(): JSX.Element | null` — a self-contained client component; `home-assistant.tsx` renders `<RecentFlows />` with no props.

- [ ] **Step 1: Create the component**

Create `src/app/(app)/g/[scope]/dashboard/recent-flows.tsx`:

```tsx
'use client'

import { useMemo } from 'react'
import { Workflow } from 'lucide-react'
import { ScopedLink as Link } from '@/components/ui/scoped-link'
import { Badge } from '@/components/ui/badge'
import { useScope } from '@/lib/client/scoped-href'
import { useCachedJson } from '@/lib/client/use-cached-json'
import { relativeTime } from '@/lib/client/relative-time'
import { STATUS_STYLE } from '@/components/flows/flow-status'
import { pickRecentFlows, type RecentFlowInput } from '@/lib/flows/recent'
import { cn } from '@/lib/utils'

type FlowsResponse = { success?: boolean; flows?: RecentFlowInput[] }

/**
 * "Pick up where you left off" — the 3 most recently edited flows as quick
 * jumps back into their canvases. Reads the same cached /api/flows payload the
 * Flows page uses (warmed at sign-in by the sidebar), so it costs no extra
 * request and inherits the goal lens from the URL scope. Renders nothing while
 * loading, on error, or when no qualifying flows exist — it is a shortcut,
 * not a source of truth; the Flows page owns load errors and empty states.
 */
export function RecentFlows() {
  const scope = useScope()
  const { data } = useCachedJson<FlowsResponse>(`/api/flows?goal=${encodeURIComponent(scope)}`)
  const recent = useMemo(() => pickRecentFlows(data?.flows), [data])
  if (recent.length === 0) return null
  return (
    <div className="mt-8">
      <div className="flex items-center justify-between px-1">
        <p className="text-xs font-medium text-muted-foreground">Pick up where you left off</p>
        <Link
          href="/flows"
          className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          All flows →
        </Link>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {recent.map((flow) => (
          <Link
            key={flow.id}
            href={`/flows/${flow.id}`}
            className="rounded-xl border bg-card p-3 shadow-1 transition-colors hover:border-foreground/30"
          >
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-muted text-foreground">
                <Workflow className="h-4 w-4" />
              </span>
              <p className="min-w-0 flex-1 truncate text-sm font-medium" title={flow.name}>
                {flow.name}
              </p>
            </div>
            <div className="mt-2.5 flex items-center justify-between">
              <Badge
                variant="outline"
                className={cn('text-[10px] font-medium capitalize', STATUS_STYLE[flow.status] || STATUS_STYLE.draft)}
              >
                {flow.status}
              </Badge>
              <span className="text-xs text-muted-foreground">{relativeTime(flow.updatedAt)}</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Render it in the hero branch**

In `src/app/(app)/g/[scope]/dashboard/home-assistant.tsx`, add the import:

```ts
import { RecentFlows } from './recent-flows'
```

Then, in the hero branch (`empty ? …`), insert `<RecentFlows />` immediately after the preset-chips block — the current code ends the hero like this:

```tsx
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {chips.map((preset, index) => (
                …
              ))}
            </div>
          </div>
        </div>
```

and must become:

```tsx
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {chips.map((preset, index) => (
                …
              ))}
            </div>
            <RecentFlows />
          </div>
        </div>
```

(The chips' `map` body stays exactly as it is — only the `<RecentFlows />` line is added.)

- [ ] **Step 3: Make the centered hero scroll-safe**

The hero wrapper uses `items-center` for vertical centering. With the strip (and the first-run guide) adding height, a short viewport would CLIP the top of centered content — `items-center` + overflow clips above the container with no way to scroll to it. The standard fix is auto margins on the child instead of `items-center` on the parent, plus `overflow-y-auto`.

In `home-assistant.tsx`, change the hero wrapper (currently):

```tsx
        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
          <div className="w-full max-w-4xl">
```

to:

```tsx
        <div className="flex min-h-0 flex-1 justify-center overflow-y-auto p-4">
          <div className="my-auto w-full max-w-4xl">
```

`my-auto` centers vertically exactly like `items-center` when content fits, and degrades to a scrollable top-aligned layout when it does not.

- [ ] **Step 4: Verify**

Run, from `/Users/jamesmcdaniel/Sublime`:

1. `npm run typecheck` — expected: exits 0.
2. `npm test` — expected: all tests pass, including the 4 from Task 1.
3. `npm run lint` — expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/g/[scope]/dashboard/recent-flows.tsx" "src/app/(app)/g/[scope]/dashboard/home-assistant.tsx"
git commit -m "feat(home): recent-flows strip below the assistant hero

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
