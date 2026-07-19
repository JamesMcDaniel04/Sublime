# Platform Retheme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retheme the signed-in platform to the landing page's grayscale black/white look with a persisted, system-default light/dark toggle, removing all green/orange brand color.

**Architecture:** The shadcn token layer in `src/app/globals.css` already matches the landing palette in both light and dark; the work is (1) activating dark mode via `next-themes`, (2) neutralizing the legacy `--sublime-*` tokens and Tailwind `indigo→ember` remap at the source so ~30 files go monochrome without churn, and (3) converting remaining hardcoded hexes and raw `gray-*`/`white` utilities to semantic tokens so both modes render correctly. A file-scanning guard test ratchets forward with each task to lock in progress.

**Tech Stack:** Next.js (App Router), Tailwind (darkMode: 'class'), next-themes, node:test via `npm test`.

## Global Constraints

- Banned colors (must not appear in product code after this plan): `#062F33 #0B484C #FF6B35 #E95725 #BE3F18 #FFF0E8 #FFB08D #FFD6C4 #E9F3F1 #C8DFDB #DCE8E5 #C0D5D5 #B9D3D2 #9DC9C2 #7DACA8 #315B5E #18485C`
- Landing/auth scope is untouched: `src/components/landing/**`, `src/app/landing.css`, `src/components/auth/**` keep their own `.lovable-landing` theme and `sublime-landing-theme` storage key.
- App theme: `next-themes` with `attribute="class"`, `defaultTheme="system"`, `enableSystem`, `storageKey="sublime-theme"`, `disableTransitionOnChange`.
- Semantic status colors (Tailwind `red-*`, `green-*`, `amber-*`, and `--status-*` tokens) are signal, not theme — keep them.
- Genuinely-white elements may keep `bg-white`: org/integration logo tiles behind images, and modal scrims may use `bg-black/50`.
- Test runner: `npm test` (node:test via tsx). Verify suite passes before every commit.

## Canonical class mapping (used by Tasks 3–6)

| Old | New |
|---|---|
| `bg-white` (card/panel surface) | `bg-card` |
| `bg-white` (page or input background) | `bg-background` |
| `bg-gray-50` `bg-gray-100` `hover:bg-gray-50/100` | `bg-muted` / `hover:bg-muted` |
| `bg-gray-900` (dark chip/pill) | `bg-foreground text-background` |
| `text-gray-900` `text-gray-800` | `text-foreground` |
| `text-gray-700` `text-gray-600` `text-gray-500` `text-gray-400` | `text-muted-foreground` |
| `border-gray-100/200/300`, `divide-gray-*`, `ring-gray-*` | `border-border` / `divide-border` / `ring-border` |
| `text-white` on brand/dark fill | `text-primary-foreground` (on `bg-primary`) or `text-background` (on `bg-foreground`) |
| Teal text hexes `#C0D5D5 #B9D3D2 #9DC9C2 #7DACA8 #315B5E #18485C` | `text-muted-foreground` |
| Teal ink `#062F33` (text/border) | `text-foreground` / `border-border` |
| Orange `#FF6B35 #E95725 #BE3F18` (accent) | `text-foreground` (or `bg-foreground` for fills) |
| Orange on delete/danger actions `#FFB08D #FFD6C4` | `text-destructive/70` / `hover:text-destructive` |
| Peach/mint fills `#FFF0E8 #E9F3F1 #C8DFDB #DCE8E5` | `bg-muted` / `border-border` |
| Decorative (non-status) `orange-*` `teal-*` `emerald-*` | nearest `gray-*` token equivalent (`text-muted-foreground`, `bg-muted`) |

---

### Task 1: Theme infrastructure (next-themes + ThemeToggle)

**Files:**
- Modify: `package.json` (add dependency)
- Modify: `src/components/providers/client-providers.tsx`
- Modify: `src/app/layout.tsx:32` (html element)
- Create: `src/components/ui/theme-toggle.tsx`
- Test: `src/components/ui/__tests__/theme-toggle.test.tsx`

**Interfaces:**
- Produces: `ThemeToggle({ className?: string })` — named export, ghost icon button, `aria-label="Toggle theme"`. Task 3 places it in the sidebar footer.
- Produces: app-wide `class="dark"` on `<html>` driven by next-themes; every `dark:` variant and `.dark` token block activates from here on.

- [ ] **Step 1: Install next-themes**

Run: `npm install next-themes`
Expected: added to `dependencies` in package.json, no peer warnings that break install.

- [ ] **Step 2: Write the failing test**

Create `src/components/ui/__tests__/theme-toggle.test.tsx`:

```tsx
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToString } from 'react-dom/server'
import { ThemeToggle } from '../theme-toggle'

test('ThemeToggle renders a labeled button without a provider (SSR-safe)', () => {
  const html = renderToString(<ThemeToggle />)
  assert.match(html, /aria-label="Toggle theme"/)
  assert.match(html, /<button/)
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../theme-toggle`.

- [ ] **Step 4: Implement ThemeToggle**

Create `src/components/ui/theme-toggle.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/button'

// Renders a placeholder until mounted: next-themes only knows the resolved
// theme on the client, and rendering the "wrong" icon during SSR would flash.
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const isDark = mounted && resolvedTheme === 'dark'
  return (
    <Button
      variant="ghost"
      size="icon"
      className={className}
      aria-label="Toggle theme"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  )
}
```

- [ ] **Step 5: Wire the provider**

In `src/components/providers/client-providers.tsx`, add the import and wrap everything currently inside `<MotionConfig>`:

```tsx
import { ThemeProvider } from 'next-themes'
```

```tsx
return (
  <MotionConfig reducedMotion="user">
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      storageKey="sublime-theme"
      disableTransitionOnChange
    >
      <SupabaseProvider>
        {children}
        <Toaster ... (unchanged) />
      </SupabaseProvider>
    </ThemeProvider>
  </MotionConfig>
)
```

In `src/app/layout.tsx`, next-themes mutates `<html>` before hydration, so suppress the mismatch warning:

```tsx
<html lang="en" suppressHydrationWarning className={`${geist.variable} ${anonymousPro.variable}`}>
```

- [ ] **Step 6: Run tests to verify pass**

Run: `npm test`
Expected: PASS (all suites, including the new one).

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add package.json package-lock.json src/components/providers/client-providers.tsx src/app/layout.tsx src/components/ui/theme-toggle.tsx src/components/ui/__tests__/theme-toggle.test.tsx
git commit -m "feat: add next-themes provider and ThemeToggle"
```

---

### Task 2: Neutralize brand tokens (CSS + Tailwind) with ratchet guard test

**Files:**
- Create: `src/lib/__tests__/no-legacy-brand-colors.test.ts`
- Modify: `src/app/sublime-design.css:14-21` (landing identity block), `:62-63` (fg tokens), `:65` (bg-page), `:85-86` (gradients)
- Modify: `tailwind.config.js:12-15` (ember scale), `:42` (indigo remap)

**Interfaces:**
- Produces: guard test with a `CLEAN_PATHS` array — later tasks append paths as they clean them (the ratchet). Exports nothing; test-only.
- Produces: neutral values behind `--sublime-*`, `--gradient-sublime(-soft)`, and `indigo-*`/`ember-*` utilities — ~30 consumer files go monochrome with no edits.

- [ ] **Step 1: Write the failing guard test**

Create `src/lib/__tests__/no-legacy-brand-colors.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Legacy teal/orange brand colors. The landing-matched theme is grayscale +
// slate; none of these may appear in product code. Ratchet: each retheme task
// appends the paths it cleaned to CLEAN_PATHS.
const BANNED =
  /#(062F33|0B484C|FF6B35|E95725|BE3F18|FFF0E8|FFB08D|FFD6C4|E9F3F1|C8DFDB|DCE8E5|C0D5D5|B9D3D2|9DC9C2|7DACA8|315B5E|18485C)\b/gi

// Landing + auth keep their own scoped theme; never scanned.
const EXCLUDED = ['src/components/landing', 'src/app/landing.css', 'src/components/auth']

const CLEAN_PATHS = [
  'src/app/sublime-design.css',
  'src/app/globals.css',
  'tailwind.config.js',
]

function filesUnder(path: string): string[] {
  if (EXCLUDED.some((ex) => path.startsWith(ex))) return []
  if (statSync(path).isFile()) return [path]
  return readdirSync(path).flatMap((entry) => filesUnder(join(path, entry)))
}

test('no legacy brand colors in cleaned paths', () => {
  const offenders: string[] = []
  for (const file of CLEAN_PATHS.flatMap(filesUnder)) {
    if (!/\.(tsx?|css|js)$/.test(file)) continue
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (line.match(BANNED)) offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 120)}`)
    })
  }
  assert.deepEqual(offenders, [], `Legacy brand colors found:\n${offenders.join('\n')}`)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — offenders listed in `src/app/sublime-design.css` (the `--sublime-*` block and gradients).

- [ ] **Step 3: Neutralize sublime-design.css**

Replace the landing-identity color block (`src/app/sublime-design.css:14-21`) with graphite neutrals:

```css
  --sublime-ink: #0F0F17;          /* graphite-950 */
  --sublime-ink-2: #171721;        /* graphite-900 */
  --sublime-orange: #171721;       /* legacy accent slot → near-black CTA */
  --sublime-orange-hover: #3C3C46; /* graphite-800 */
  --sublime-orange-soft: #F1F2F5;  /* graphite-100 */
  --sublime-mint: #F1F2F5;
  --sublime-mint-strong: #E3E3E4;  /* graphite-200 */
  --sublime-canvas: #FFFFFF;
```

Replace the two sublime gradients (`:85-86`) with flat neutrals:

```css
  --gradient-sublime: linear-gradient(145deg, var(--graphite-900), var(--graphite-950));
  --gradient-sublime-soft: linear-gradient(145deg, var(--graphite-50), #FFFFFF 55%, var(--graphite-100));
```

Update the link/accent semantic tokens (`:62-63`) to the landing slate accent:

```css
  --fg-link: #64748B;       /* slate accent, matches --primary 215 16% 47% */
  --fg-accent: var(--graphite-900);
```

`--bg-page` (`:65`) now resolves to white via `--sublime-canvas`; no edit needed.

- [ ] **Step 4: Remap orange Tailwind scales to graphite**

In `tailwind.config.js`, leave the `ember` scale constant defined (documentation of the legacy palette) but stop exposing orange through utilities — change lines 42 (`indigo: ember`) and 30 (`ember,`):

```js
        // Legacy accent utilities render near-black, like the landing CTA.
        // (`ember`/`indigo` used to point at the orange scale.)
        ember: graphite,
        indigo: graphite,
```

Then delete the now-unused `const ember = {...}` block at the top of the file.

- [ ] **Step 5: Run tests to verify pass**

Run: `npm test`
Expected: PASS — guard finds no banned colors in the three cleaned paths.

- [ ] **Step 6: Commit**

```bash
git add src/lib/__tests__/no-legacy-brand-colors.test.ts src/app/sublime-design.css tailwind.config.js
git commit -m "feat: neutralize legacy teal/orange brand tokens to graphite"
```

---

### Task 3: Sidebar rewrite (theme-following)

**Files:**
- Modify: `src/components/layout/sidebar.tsx` (all color classes; ThemeToggle placement in footer)
- Modify: `src/lib/__tests__/no-legacy-brand-colors.test.ts` (ratchet)

**Interfaces:**
- Consumes: `ThemeToggle` from `@/components/ui/theme-toggle` (Task 1).
- Produces: sidebar styled entirely with semantic tokens; renders correctly with and without `.dark` on `<html>`.

- [ ] **Step 1: Ratchet the guard test**

Append to `CLEAN_PATHS` in `src/lib/__tests__/no-legacy-brand-colors.test.ts`:

```ts
  'src/components/layout',
```

Run: `npm test`
Expected: FAIL — offenders listed in `src/components/layout/sidebar.tsx`.

- [ ] **Step 2: Apply the class conversions**

Exact old → new replacements in `src/components/layout/sidebar.tsx` (line numbers from current file):

| Line | Old | New |
|---|---|---|
| 371 | `text-[#C0D5D5] ... hover:bg-white/10 hover:text-white` | `text-muted-foreground ... hover:bg-muted hover:text-foreground` |
| 373 | `bg-white/10 ... text-[#FFD6C4]` | `bg-muted ... text-muted-foreground` |
| 384 | `text-white hover:bg-white/10 hover:text-white` | `text-foreground hover:bg-muted` |
| 387 | `text-[#FFB08D] hover:bg-white/10 hover:text-[#FFD6C4]` | `text-destructive/70 hover:bg-muted hover:text-destructive` |
| 397 | `bg-[#062F33]/60` | `bg-black/50` |
| 401 | `border-[#062F33]/10 bg-white text-[#062F33] shadow-brand` | `border-border bg-background text-foreground shadow-2` |
| 410 | `border-r border-white/10 bg-gradient-sublime text-white shadow-[12px_0_40px_rgba(6,47,51,0.08)]` | `border-r border-border bg-background text-foreground` |
| 416 | `border-b border-white/10` | `border-b border-border` |
| 424 | `hover:bg-white/10` | `hover:bg-muted` |
| 430 | `bg-white ... ring-1 ring-white/20` | `bg-white ... ring-1 ring-border` (logo tile keeps white) |
| 438, 448, 553 | `text-[#B9D3D2] hover:bg-white/10 hover:text-white` | `text-muted-foreground hover:bg-muted hover:text-foreground` |
| 453, 547 | `border-white/15 bg-white/10 text-white hover:border-white/30 hover:bg-white/15 hover:text-white` | `border-border bg-muted text-foreground hover:bg-secondary` |
| 458 | `hover:bg-white/10` | `hover:bg-muted` |
| 466 | `ring-white/20` | `ring-border` |
| 469 | `text-[#9DC9C2]` | `text-muted-foreground` |
| 474 | `bg-white p-1 text-[#062F33]` | `bg-popover p-1 text-popover-foreground` |
| 540 | `border-white/15 bg-white/10 ... text-[#B9D3D2] hover:border-white/30 hover:bg-white/15 hover:text-white` | `border-border bg-muted ... text-muted-foreground hover:bg-secondary hover:text-foreground` |
| 545 | `border-white/10 bg-white/10 ... text-[#9DC9C2]` | `border-border bg-background ... text-muted-foreground` |
| 577 | `isActive ? 'bg-[#FFF0E8] text-[#062F33] shadow-2' : 'text-[#C0D5D5] hover:bg-white/10 hover:text-white'` | `isActive ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'` |
| 580 | `isActive ? 'text-[#E95725]' : 'text-[#7DACA8]'` | `isActive ? 'text-foreground' : 'text-muted-foreground'` |
| 596, 627, 646, 664 | `bg-white/10` (drag-over) | `bg-muted` |
| 600, 649 | `text-[#7DACA8]` | `text-muted-foreground` |
| 604 | `text-[#B9D3D2] hover:bg-white/10 hover:text-white` | `text-muted-foreground hover:bg-muted hover:text-foreground` |
| 616, 678 | `text-[#7DACA8]` | `text-muted-foreground` |
| 626, 663 | `text-[#C0D5D5] hover:bg-white/10 hover:text-white` | `text-muted-foreground hover:bg-muted hover:text-foreground` |
| 633, 670 | `text-[#7DACA8]` | `text-muted-foreground` |
| 635, 672 | `text-[#7DACA8]` | `text-muted-foreground` |
| 637, 655, 674 | `border-white/10` | `border-border` |
| 685 | `border-t border-white/10` | `border-t border-border` |
| 688 | `text-[#9DC9C2]` | `text-muted-foreground` |
| 693 | `bg-white/10` (track) | `bg-muted` |
| 694 | `bg-[#FF6B35]` (credit bar) | `bg-foreground` |
| 705, 707 | `hover:bg-white/10` / `bg-white/10` | `hover:bg-muted` / `bg-muted` |
| 710 | `bg-[#FFF0E8] ... text-[#BE3F18]` | `bg-muted ... text-foreground` |
| 716 | `text-[#7DACA8]` | `text-muted-foreground` |
| 720 | `bg-white/10 ... text-[#B9D3D2]` | `bg-muted ... text-muted-foreground` |

- [ ] **Step 3: Add the ThemeToggle to the footer**

In the footer block (starts line 685, `border-t`), next to the settings/user row, add:

```tsx
import { ThemeToggle } from '@/components/ui/theme-toggle'
```

```tsx
<ThemeToggle className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground" />
```

Place it inside the footer's flex row (beside the plan label / settings link); in rail (collapsed) mode it shows as the icon alone, which already fits the 8×8 icon-button pattern used at line 553.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS (guard now clean for `src/components/layout`).

- [ ] **Step 5: Visual smoke check**

Run: `npm run dev`, load `/dashboard`, toggle the theme.
Expected: white sidebar + hairline border in light; near-black in dark; no teal/orange anywhere; active nav item reads as gray pill with near-black icon.

- [ ] **Step 6: Commit**

```bash
git add src/components/layout/sidebar.tsx src/lib/__tests__/no-legacy-brand-colors.test.ts
git commit -m "feat: theme-following monochrome sidebar with theme toggle"
```

---

### Task 4: UI primitives (tabs, page-header, empty-state, dialog, select, html-preview)

**Files:**
- Modify: `src/components/ui/tabs.tsx:45,63`, `src/components/ui/page-header.tsx:19-20`, `src/components/ui/empty-state.tsx:24,30`, plus raw grays in `src/components/ui/dialog.tsx`, `src/components/ui/select.tsx`, `src/components/ui/html-preview.tsx`
- Modify: `src/lib/__tests__/no-legacy-brand-colors.test.ts` (ratchet)

**Interfaces:**
- Produces: fully token-based UI primitives; every page using them inherits both modes for free.

- [ ] **Step 1: Ratchet the guard test**

Append `'src/components/ui',` to `CLEAN_PATHS`. Run `npm test`. Expected: FAIL with offenders in tabs/page-header/empty-state.

- [ ] **Step 2: Apply exact replacements**

`src/components/ui/tabs.tsx:45` (TabsList):

```
old: border border-[#DCE8E5] bg-[#E9F3F1]/80 p-1 text-[#315B5E]
new: border border-border bg-muted p-1 text-muted-foreground
```

`src/components/ui/tabs.tsx:63` (TabsTrigger):

```
old: text-[#315B5E] ... hover:text-[#062F33] ... data-[state=active]:text-[#062F33]
new: text-muted-foreground ... hover:text-foreground ... data-[state=active]:text-foreground
```

`src/components/ui/page-header.tsx:19` (eyebrow):

```
old: text-[#18485C] before:h-px before:w-5 before:bg-[#FF6B35]
new: text-muted-foreground before:h-px before:w-5 before:bg-foreground
```

`src/components/ui/page-header.tsx:20` (title):

```
old: text-[#062F33]
new: text-foreground
```

`src/components/ui/empty-state.tsx:24`:

```
old: border-dashed border-[#C8DFDB] bg-gradient-sublime-soft
new: border-dashed border-border bg-muted/40
```

`src/components/ui/empty-state.tsx:30` (icon chip):

```
old: bg-[#FFF0E8] text-[#E95725]
new: bg-muted text-foreground
```

In `dialog.tsx`, `select.tsx`, `html-preview.tsx`: convert raw `bg-white`/`text-gray-*`/`border-gray-*` per the canonical mapping table (dialog/select surfaces → `bg-popover text-popover-foreground`; html-preview content frame may keep `bg-white` — it renders untrusted arbitrary HTML that assumes a light canvas).

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/ui src/lib/__tests__/no-legacy-brand-colors.test.ts
git commit -m "feat: convert UI primitives to semantic theme tokens"
```

---

### Task 5: App pages sweep (agents, dashboard, settings, templates, integrations)

**Files:**
- Modify (per canonical mapping table): `src/app/agents/agent-activity-pane.tsx`, `agent-config-form.tsx`, `assistant-panel.tsx`, `knowledge-panel.tsx`, `page.tsx`; `src/app/dashboard/home-assistant.tsx`; `src/app/settings/page.tsx`, `learnings-panel.tsx`; `src/app/templates/[id]/page.tsx`; `src/app/integrations/page.tsx`, `oauth-integrations-grid.tsx`; `src/app/flows/[id]/page.tsx`, `src/app/flows/[id]/activity/page.tsx`; `src/app/skills/[id]/page.tsx`
- Modify: `src/lib/__tests__/no-legacy-brand-colors.test.ts` (ratchet)

**Interfaces:**
- Consumes: canonical mapping table (top of plan) — apply mechanically; keep status colors and logo-tile whites per Global Constraints.

- [ ] **Step 1: Ratchet the guard test**

Append `'src/app',` to `CLEAN_PATHS` (EXCLUDED already skips `src/app/landing.css`). Run `npm test`. Expected: FAIL listing every remaining offender under `src/app` — this is the authoritative work list for this task.

- [ ] **Step 2: Convert hexes and raw grays**

For each offender line plus each `bg-white|text-gray-|bg-gray-|border-gray-` match in the listed files, apply the canonical mapping table. Judgment calls allowed by Global Constraints: logo tiles keep `bg-white`; status badges keep semantic colors; decorative `orange-*`/`teal-*` become gray equivalents.

Find residuals with:

```bash
grep -rn "bg-white\|text-gray-\|bg-gray-\|border-gray-" src/app --include="*.tsx"
```

- [ ] **Step 3: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 4: Visual smoke check**

Run dev server; check `/dashboard`, `/agents`, `/settings`, `/integrations`, one flow page — both modes.
Expected: no white-on-white or dark-on-dark text; surfaces separate by hairline borders.

- [ ] **Step 5: Commit**

```bash
git add src/app src/lib/__tests__/no-legacy-brand-colors.test.ts
git commit -m "feat: convert app pages to semantic theme tokens"
```

---

### Task 6: Component sweep (flows, integrations, notifications, search, share) + dark: audit

**Files:**
- Modify (per canonical mapping table): `src/components/flows/*` (advanced-params, canvas-rail, dag-canvas, flow-canvas, flow-comments, flow-picker, jam-button, run-panel, step-card, test-input-panel, test-panel, copilot-panel, checker-panel, data-tree, resizable-panel, token-text-editor, tool-args-editor, trigger-filter-editor), `src/components/connections/mcp-connection-dialog.tsx`, `mcp-servers-panel.tsx`, `src/components/integrations/integration-ai-search.tsx`, `integration-logo.tsx`, `src/components/intelligence/suggested-improvement-banner.tsx`, `src/components/notifications/notification-bell.tsx`, `src/components/search/command-palette.tsx`, `src/components/share-control.tsx`, `src/components/templates/templates-explorer.tsx`
- Modify: `src/lib/__tests__/no-legacy-brand-colors.test.ts` (final ratchet)

**Interfaces:**
- Produces: guard test scanning ALL of `src` (minus exclusions) — the permanent regression net.

- [ ] **Step 1: Final ratchet**

Replace the whole `CLEAN_PATHS` array with:

```ts
const CLEAN_PATHS = ['src', 'tailwind.config.js']
```

Run: `npm test`. Expected: FAIL listing every remaining offender in the repo — the authoritative work list.

- [ ] **Step 2: Convert all offenders**

Apply the canonical mapping table to each offender, plus raw grays found by:

```bash
grep -rn "bg-white\|text-gray-\|bg-gray-\|border-gray-" src/components --include="*.tsx" | grep -v "landing\|auth"
```

React Flow canvas (`dag-canvas.tsx`, `flow-canvas.tsx`): canvas backgrounds → `bg-background`, node cards → `bg-card border-border`, edge/handle grays → keep (React Flow default grays are neutral) unless they collide in dark mode.

- [ ] **Step 3: Audit existing dark: variants**

```bash
grep -rn "dark:" src/components src/app --include="*.tsx" | grep -v "landing\|auth"
```

For each: if the base class is now a semantic token (`bg-card`, `text-foreground`…), the `dark:` variant is redundant or conflicting — delete it. Keep `dark:` only where a genuinely different treatment is wanted in dark mode (e.g. `dark:prose-invert` in markdown rendering).

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add src/components src/lib/__tests__/no-legacy-brand-colors.test.ts
git commit -m "feat: complete monochrome token sweep across components"
```

---

### Task 7: Full verification

**Files:**
- None created; verification only (fix-forward any findings within this task).

- [ ] **Step 1: Full check**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all pass. (Skip `npm run build` only if it requires DB env; otherwise run it too.)

- [ ] **Step 2: Screenshot pass**

Dev server up; capture `/dashboard`, `/agents`, `/flows/[any]`, `/integrations`, `/settings` in light AND dark. Compare against the landing pages: grayscale surfaces, hairline `#E5E5E5`-class borders in light, `240 4% 26%` borders in dark, slate accent, near-black CTAs.
Expected: platform and landing read as one product; toggle persists across reload (localStorage `sublime-theme`); system preference respected on first visit (verify in a private window with OS dark mode).

- [ ] **Step 3: Fix-forward and commit any residuals**

```bash
git add -A src
git commit -m "fix: dark-mode polish from screenshot pass"
```

(Skip the commit if nothing changed.)
