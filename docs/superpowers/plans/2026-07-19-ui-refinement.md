# UI Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt Radix primitives everywhere hand-rolled equivalents remain (tooltips, add-step menus), tighten focus/hover polish, and standardize iconography including the Bot nav icon.

**Architecture:** One `TooltipProvider` at the app root; `title=` hints on interactive controls become Radix Tooltips. The three duplicated `AddNestedStepMenu` components collapse into one shared Radix `DropdownMenu`-based component. Polish and icon changes are targeted edits to existing primitives and the sidebar.

**Tech Stack:** Tailwind, @radix-ui/react-tooltip + react-dropdown-menu (already installed), lucide-react, node:test via `npm test`.

## Global Constraints

- Semantic tokens only on themed surfaces; `no-legacy-brand-colors` guard test must stay green.
- Landing/auth surfaces untouched (`src/components/landing/**`, `src/app/landing.css`, `src/components/auth/**`).
- No new dependencies (add `@radix-ui/react-popover` ONLY if a menu needs free-form content — none currently does).
- The tree is shared with concurrent sessions: re-run each grep before editing; line numbers are advisory.
- Native `title=` stays on non-interactive truncated text (e.g. agent row description at sidebar.tsx:388).
- Run `npm test` before every commit.

---

### Task 1: Theme-correct Tooltip primitive, app-root TooltipProvider, sidebar tooltips

**Files:**
- Modify: `src/components/ui/tooltip.tsx:21` (static dark bg)
- Modify: `src/components/providers/client-providers.tsx` (mount provider)
- Modify: `src/components/layout/sidebar.tsx` (rail nav + icon buttons; lines ~433, ~580, ~713 and the collapse/search buttons carrying `title="... (⌘B)"` / `title="Search (⌘K)"`)
- Test: `src/components/ui/__tests__/tooltip.test.tsx`

**Interfaces:**
- Consumes: existing exports `Tooltip, TooltipTrigger, TooltipContent, TooltipProvider` from `@/components/ui/tooltip`.
- Produces: app-wide open `TooltipProvider delayDuration={300}`; a `RailTooltip` local helper in sidebar.tsx: `function RailTooltip({ label, shortcut, children }: { label: string; shortcut?: string; children: React.ReactNode })` wrapping children with side="right" tooltip. Later tasks may copy this pattern but do not import it.

- [ ] **Step 1: Write the failing test**

Create `src/components/ui/__tests__/tooltip.test.tsx`:

```tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderToString } from 'react-dom/server'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../tooltip'

// Radix portals emit nothing during SSR, so TooltipContent's classes can't be
// asserted from renderToString — check the source directly instead.
test('TooltipContent uses theme tokens, not static graphite', () => {
  const src = readFileSync('src/components/ui/tooltip.tsx', 'utf8')
  assert.doesNotMatch(src, /bg-graphite-900/)
  assert.match(src, /bg-foreground/)
  assert.match(src, /text-background/)
})

test('Tooltip tree renders SSR-safe without a provider crash', () => {
  const html = renderToString(
    <TooltipProvider>
      <Tooltip defaultOpen>
        <TooltipTrigger asChild><button>trigger</button></TooltipTrigger>
        <TooltipContent>hint</TooltipContent>
      </Tooltip>
    </TooltipProvider>,
  )
  assert.match(html, /trigger/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/ui/__tests__/tooltip.test.tsx`
Expected: FAIL — `bg-graphite-900` present, `text-background` absent.

- [ ] **Step 3: Retheme TooltipContent**

In `src/components/ui/tooltip.tsx` replace the className line:

```
old: "z-50 overflow-hidden rounded-md bg-graphite-900 px-3 py-1.5 text-xs text-white shadow-popover animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
new: "z-50 overflow-hidden rounded-md bg-foreground px-3 py-1.5 text-xs text-background shadow-popover animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/ui/__tests__/tooltip.test.tsx`
Expected: PASS.

- [ ] **Step 5: Mount TooltipProvider at app root**

In `src/components/providers/client-providers.tsx`, add the import and wrap the ThemeProvider children:

```tsx
import { TooltipProvider } from '@/components/ui/tooltip'
```

Inside `<ThemeProvider ...>`, wrap the existing `<SupabaseProvider>...</SupabaseProvider>` block:

```tsx
<TooltipProvider delayDuration={300}>
  <SupabaseProvider>
    ...unchanged children...
  </SupabaseProvider>
</TooltipProvider>
```

- [ ] **Step 6: Convert sidebar interactive hints**

In `src/components/layout/sidebar.tsx`, add imports:

```tsx
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
```

Add a local helper above `export function Sidebar()`:

```tsx
function RailTooltip({ label, shortcut, children }: { label: string; shortcut?: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" className="flex items-center gap-2">
        {label}
        {shortcut && <kbd className="rounded border border-background/30 px-1 font-mono text-[10px]">{shortcut}</kbd>}
      </TooltipContent>
    </Tooltip>
  )
}
```

Apply it (drop the corresponding `title=` props):
1. Rail nav links (the `navigation.map` when `rail` is true): wrap the `<Link>` in `<RailTooltip label={item.name}>`; remove `title={rail ? item.name : undefined}`.
2. Expand/collapse buttons (`title="Expand sidebar (⌘B)"` / `title="Collapse sidebar (⌘B)"`): wrap in `<RailTooltip label="Expand sidebar" shortcut="⌘B">` (resp. "Collapse sidebar"); remove `title`.
3. Rail search button (`title="Search (⌘K)"`): `<RailTooltip label="Search" shortcut="⌘K">`.
4. Rail org-logo expand button (`title={\`${activeOrg?.name || 'Workspace'} — expand sidebar\`}`): `<RailTooltip label={activeOrg?.name || 'Workspace'}>`.
5. Settings link (`title={rail ? 'Settings' : undefined}`): wrap in `<RailTooltip label="Settings">` only when rail — simplest: always wrap; tooltip on the expanded row is harmless but noisy, so wrap conditionally: `rail ? <RailTooltip label="Settings">{link}</RailTooltip> : link` by extracting the link JSX to a `const settingsLink`.
6. Leave `title={agent.description || agent.title}` (line ~388) — truncated-text case, allowed by Global Constraints.

- [ ] **Step 7: Full test + typecheck**

Run: `npm test` and `npm run typecheck`
Expected: all pass / clean.

- [ ] **Step 8: Commit**

```bash
git add src/components/ui/tooltip.tsx src/components/ui/__tests__/tooltip.test.tsx src/components/providers/client-providers.tsx src/components/layout/sidebar.tsx
git commit -m "feat: adopt Radix tooltips for interactive hints"
```

---

### Task 2: Shared Radix AddStepMenu (removes triplicated hand-rolled menu)

**Files:**
- Create: `src/components/flows/add-step-menu.tsx`
- Modify: `src/components/flows/dag-canvas.tsx:95-124` (delete local `AddNestedStepMenu`, import shared)
- Modify: `src/components/flows/flow-canvas.tsx:126-160` (same)
- Modify: `src/components/flows/step-card.tsx:836-869` (same; this copy takes a `label` prop)
- Test: `src/components/flows/__tests__/add-step-menu.test.tsx`

**Interfaces:**
- Consumes: `NODE_TYPES`, `type EditableType` from `src/components/flows/node-types.ts`; `DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem` from `@/components/ui/dropdown-menu`.
- Produces: `export function AddStepMenu({ label = 'Add a step', onPick }: { label?: string; onPick: (type: EditableType) => void })` — the only add-step menu; call sites: `<AddStepMenu onPick={...} />` or `<AddStepMenu label="Add to branch" onPick={...} />`.

- [ ] **Step 1: Write the failing test**

Create `src/components/flows/__tests__/add-step-menu.test.tsx`:

```tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToString } from 'react-dom/server'
import { AddStepMenu } from '../add-step-menu'

test('AddStepMenu renders a Radix dropdown trigger with the label', () => {
  const html = renderToString(<AddStepMenu onPick={() => undefined} />)
  assert.match(html, /Add a step/)
  assert.match(html, /aria-haspopup="menu"/)
})

test('AddStepMenu accepts a custom label', () => {
  const html = renderToString(<AddStepMenu label="Add to branch" onPick={() => undefined} />)
  assert.match(html, /Add to branch/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/__tests__/add-step-menu.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement AddStepMenu**

Create `src/components/flows/add-step-menu.tsx`:

```tsx
'use client'

import { Plus } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { NODE_TYPES, type EditableType } from './node-types'

/** Shared "+ Add step" picker for the DAG canvas, stack canvas, and nested
 *  step bodies. Radix gives focus trap, Esc, typeahead, and collision-aware
 *  positioning that the previous hand-rolled backdrop menus lacked. */
export function AddStepMenu({ label = 'Add a step', onPick }: { label?: string; onPick: (type: EditableType) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2 text-sm font-medium text-muted-foreground transition-colors duration-fast hover:border-foreground/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <Plus className="h-4 w-4" /> {label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-[var(--radix-dropdown-menu-trigger-width)] overflow-auto">
        {NODE_TYPES.map((type) => (
          <DropdownMenuItem key={type.value} className="text-xs" onSelect={() => onPick(type.value)}>
            {type.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
```

Note the hover treatment also drops the old `hover:border-blue-400 hover:text-blue-700` (non-status blue on a neutral control) in favor of monochrome tokens.

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/__tests__/add-step-menu.test.tsx`
Expected: PASS.

- [ ] **Step 5: Replace the three local copies**

In each of `dag-canvas.tsx`, `flow-canvas.tsx`, `step-card.tsx`:
1. Delete the whole local `function AddNestedStepMenu(...) {...}` definition.
2. Add `import { AddStepMenu } from './add-step-menu'`.
3. Replace call sites: `<AddNestedStepMenu onPick={...} />` → `<AddStepMenu onPick={...} />`; step-card's `<AddNestedStepMenu label={...} onPick={...} />` → `<AddStepMenu label={...} onPick={...} />`.
4. Remove now-unused imports (`NODE_TYPES` stays only if still used elsewhere in the file — dag-canvas.tsx also uses `NODE_TYPE_LABEL`/`nodeIconOf`, keep those).

Verify no backdrop pattern remains:

Run: `grep -rn "fixed inset-0 z-10" src/components/flows`
Expected: no output.

- [ ] **Step 6: Full test + typecheck**

Run: `npm test && npm run typecheck`
Expected: pass / clean (existing dag-canvas/flow tests still green).

- [ ] **Step 7: Commit**

```bash
git add src/components/flows/add-step-menu.tsx src/components/flows/__tests__/add-step-menu.test.tsx src/components/flows/dag-canvas.tsx src/components/flows/flow-canvas.tsx src/components/flows/step-card.tsx
git commit -m "feat: shared Radix AddStepMenu replaces triplicated hand-rolled menus"
```

---

### Task 3: Focus & hover polish, integrations skeletons

**Files:**
- Modify: `src/components/ui/badge.tsx:7` (`focus:` → `focus-visible:`)
- Modify: `src/components/ui/card.tsx:12` (drop hover translate)
- Modify: `src/components/marketing/contact-form.tsx:17` (focus-visible ring)
- Modify: `src/app/integrations/page.tsx` (loading skeletons)

**Interfaces:**
- Consumes: `Skeleton` from `@/components/ui/skeleton` (`<Skeleton className="h-40 rounded-xl" />` pattern, as used in `src/app/flows/page.tsx:224`).
- Produces: nothing new — behavioral polish only.

- [ ] **Step 1: Badge focus ring**

`src/components/ui/badge.tsx` line 7:

```
old: focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2
new: focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2
```

- [ ] **Step 2: Card hover — border/shadow step only**

`src/components/ui/card.tsx` line 12:

```
old: "shadow-2 transition-all duration-base ease-out-quart hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
new: "shadow-2 transition-all duration-base ease-out-quart hover:border-foreground/20 hover:shadow-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
```

(Translate on hover makes dense card grids jitter; shadow-brand is oversized for list cards.)

- [ ] **Step 3: Contact form focus ring**

`src/components/marketing/contact-form.tsx` line 17:

```
old: focus:outline-none focus:border-ring transition-colors
new: focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-ring transition-colors
```

- [ ] **Step 4: Integrations loading skeletons**

In `src/app/integrations/page.tsx`: find the loading branch (where the page renders nothing or a spinner while integrations fetch). Add:

```tsx
import { Skeleton } from '@/components/ui/skeleton'
```

and render, in the grid the cards normally occupy:

```tsx
<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
  {Array.from({ length: 6 }, (_, i) => (
    <Skeleton key={`integration-skeleton-${i}`} className="h-32 rounded-xl" />
  ))}
</div>
```

Match the page's actual grid classes (copy the wrapper classes of the loaded grid). If the page already renders a skeleton/loading grid (concurrent sessions!), skip this step.

- [ ] **Step 5: Full test + typecheck + commit**

Run: `npm test && npm run typecheck`
Expected: pass / clean.

```bash
git add src/components/ui/badge.tsx src/components/ui/card.tsx src/components/marketing/contact-form.tsx src/app/integrations/page.tsx
git commit -m "feat: focus-visible rings, calmer card hover, integrations skeletons"
```

---

### Task 4: Iconography — Bot nav icon, PageHeader icon slot, empty-state icons

**Files:**
- Modify: `src/components/layout/sidebar.tsx:7-28,82` (Brain → Bot)
- Modify: `src/components/ui/page-header.tsx` (optional icon prop)
- Test: extend `src/components/ui/__tests__/tooltip.test.tsx`? No — create `src/components/ui/__tests__/page-header.test.tsx`

**Interfaces:**
- Produces: `PageHeader` gains optional `icon?: React.ComponentType<{ className?: string }>` rendered left of the title at `h-5 w-5` inside a bordered tile. Existing call sites unaffected (prop optional).

- [ ] **Step 1: Bot nav icon**

In `src/components/layout/sidebar.tsx`:
1. Import list: replace `Brain,` with `Bot,` (keep alphabetical order).
2. Navigation array: `{ name: 'Agents', href: '/agents', icon: Brain }` → `{ name: 'Agents', href: '/agents', icon: Bot }`.
3. Run `grep -n "Brain" src/components/layout/sidebar.tsx` — expected: no output.

- [ ] **Step 2: Write failing PageHeader icon test**

Create `src/components/ui/__tests__/page-header.test.tsx`:

```tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToString } from 'react-dom/server'
import { Bot } from 'lucide-react'
import { PageHeader } from '../page-header'

test('PageHeader renders optional icon beside the title', () => {
  const html = renderToString(<PageHeader title="Agents" icon={Bot} />)
  assert.match(html, /<svg/)
  assert.match(html, /Agents/)
})

test('PageHeader without icon renders no icon tile', () => {
  const html = renderToString(<PageHeader title="Agents" />)
  assert.doesNotMatch(html, /<svg/)
})
```

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/ui/__tests__/page-header.test.tsx`
Expected: FAIL — `icon` prop does not exist / no svg rendered.

- [ ] **Step 3: Implement the icon slot**

In `src/components/ui/page-header.tsx`:

```tsx
interface PageHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  eyebrow?: string
  title: string
  description?: string
  actions?: React.ReactNode
  icon?: React.ComponentType<{ className?: string }>
}

function PageHeader({ eyebrow, title, description, actions, icon: Icon, className, ...props }: PageHeaderProps) {
  return (
    <div
      className={cn("flex flex-wrap items-end justify-between gap-4 animate-fade-in-up", className)}
      {...props}
    >
      <div className="space-y-1.5">
        {eyebrow && <p className="eyebrow flex items-center gap-2 text-muted-foreground before:h-px before:w-5 before:bg-foreground">{eyebrow}</p>}
        <div className="flex items-center gap-3">
          {Icon && (
            <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-muted text-foreground">
              <Icon className="h-5 w-5" aria-hidden="true" />
            </span>
          )}
          <h1 className="text-3xl font-semibold leading-tight tracking-[-0.025em] text-foreground">{title}</h1>
        </div>
        {description && <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/ui/__tests__/page-header.test.tsx`
Expected: PASS.

- [ ] **Step 5: Adopt icons on the main PageHeader call sites**

Run `grep -rn "<PageHeader" src/app --include="*.tsx"` and add matching lucide icons where the header is bare, aligned with the nav: Agents pages → `Bot`, Integrations → `Plug`, Flows → `Workflow`, Settings → `Settings`, Dashboard → `Sparkles`. Import each icon from `lucide-react` in that file. Skip call sites that already pass compact custom layouts.

- [ ] **Step 6: Full test + typecheck + commit**

Run: `npm test && npm run typecheck`
Expected: pass / clean.

```bash
git add src/components/layout/sidebar.tsx src/components/ui/page-header.tsx src/components/ui/__tests__/page-header.test.tsx src/app
git commit -m "feat: Bot nav icon, PageHeader icon slot, header icons"
```

---

### Task 5: Verification

**Files:** none (fix-forward only).

- [ ] **Step 1: Full suite + lint + build**

Run: `npm test && npm run lint && NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder-anon-key SKIP_MIGRATE=1 npx next build`
Expected: tests green (guard included), lint clean, build succeeds.

- [ ] **Step 2: Residual audit**

Run: `grep -rn "fixed inset-0 z-10" src/components --include="*.tsx"` → no output.
Run: `grep -rn "title={" src/components/layout/sidebar.tsx` → only the agent-row truncation title remains.

- [ ] **Step 3: Commit any fix-forward residuals**

```bash
git add -A src && git commit -m "fix: UI refinement residuals"
```

(Skip if nothing changed.)
