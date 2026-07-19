# UI Refinement Pass: Radix Consistency, Polish, Iconography

**Date:** 2026-07-19
**Status:** Approved

## Goal

Close the interaction-quality gaps left after the monochrome retheme: adopt the
already-installed Radix primitives everywhere hand-rolled equivalents remain,
tighten micro-interactions, and make iconography consistent — using Tailwind,
Radix UI, and lucide icons.

## Audit findings (current state)

- `src/components/ui/tooltip.tsx` exists but has **zero** consumers; 33
  interactive controls ship `title=` attribute hints instead (sidebar rail,
  canvas toolbars, step-card actions).
- Three hand-rolled backdrop menus (`fixed inset-0` click-away divs) live in
  `src/components/flows/dag-canvas.tsx`, `flow-canvas.tsx`, `step-card.tsx`,
  despite `@radix-ui/react-dropdown-menu` being installed and wrapped.
- Focus-visible rings are consistent in `ui/` primitives; a few custom
  interactive elements still use bare `focus:outline-none`.
- Skeleton/empty-state primitives exist; adoption uneven on list surfaces.
- Sidebar nav uses `Brain` for Agents; user wants `Bot`.

## Design

### 1. Tooltips (Radix)

- Mount a single `TooltipProvider` (`delayDuration={300}`) inside
  `ClientProviders`.
- Convert `title=` hints on interactive controls to `<Tooltip>` +
  `<TooltipTrigger asChild>` + `<TooltipContent>`: collapsed-rail nav items,
  sidebar collapse/search/new-agent buttons, canvas toolbar buttons, step-card
  action buttons. Keyboard shortcuts (⌘K, ⌘B) render inside tooltip content as
  `<kbd>`.
- Native `title` stays only on non-interactive truncated text.

### 2. Menus (Radix)

- Replace the three backdrop-div menus in `dag-canvas.tsx`, `flow-canvas.tsx`,
  and `step-card.tsx` with `DropdownMenu` from `@/components/ui/dropdown-menu`
  (focus trap, Esc, typeahead, collision-aware positioning for free).
- No new dependencies expected; add `@radix-ui/react-popover` only if one of
  the three turns out to need free-form content rather than menu items.

### 3. Micro-interaction polish

- Button primitive: add press feedback (`active:scale-[0.98]`) and confirm a
  uniform `focus-visible:ring-2 ring-ring ring-offset-2` treatment.
- Custom interactive rows/buttons with bare `focus:outline-none` get the same
  focus-visible ring.
- Card hover standardized to border + shadow step (no translate jitter inside
  dense lists).
- Skeleton loading states for the agents, integrations, and flows list
  surfaces where missing, using `ui/skeleton.tsx`.

### 4. Iconography

- Sidebar nav: `Bot` replaces `Brain` for Agents (user request).
- Lucide sizing convention: `h-4 w-4` inline/buttons, `h-5 w-5` page headers.
- Add icons to bare page headers and empty states where a fitting lucide icon
  exists; no decorative icon soup.

## Constraints

- The working tree is shared with concurrent sessions; re-audit exact line
  numbers at implementation time rather than trusting this spec's counts.
- Theme rules from the retheme hold: semantic tokens only, no static scale
  colors on themed surfaces; the `no-legacy-brand-colors` guard test must stay
  green.
- Landing/auth surfaces stay untouched.

## Testing

- Existing suite (1,240 tests) + guard test stay green.
- New render tests: tooltip-wrapped rail nav button exposes its label; each
  converted menu opens via Radix (`data-state` present).
- `next build` with placeholder Supabase env; both-theme visual spot check.

## Out of scope

- Page-level redesigns, new features, new Radix packages beyond popover (and
  only if required), landing/auth changes.
