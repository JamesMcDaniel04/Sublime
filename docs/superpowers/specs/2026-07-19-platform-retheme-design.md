# Platform Retheme: Landing-Matched Black/White Theme with Light/Dark Toggle

**Date:** 2026-07-19
**Status:** Approved

## Goal

Make the signed-in platform UI match the landing page's visual language: grayscale
surfaces, slate accent, hairline borders, near-black CTAs — in a toggleable
light/dark theme. Remove the legacy green/orange (teal ink + ember) identity from
the product.

## Decisions (user-confirmed)

- **Sidebar:** theme-following — white with hairline border in light mode,
  near-black in dark mode (not an always-dark sidebar).
- **Default theme:** follow system preference; explicit toggle overrides and
  persists.

## Current state

- `src/app/globals.css` already defines a landing-matched grayscale shadcn token
  layer (`--background`, `--primary` slate, …) **including a complete `.dark`
  block**, and `tailwind.config.js` has `darkMode: 'class'` — but nothing ever
  sets the `dark` class on the app. No ThemeProvider or toggle exists.
- The green/orange look comes from three sources:
  1. `src/components/layout/sidebar.tsx` — `bg-gradient-sublime` (teal ink
     gradient) plus ~10 hardcoded hexes (`#062F33`, `#E95725`, `#FF6B35`,
     `#FFF0E8`, teal-tinted text like `#C0D5D5`).
  2. `src/app/sublime-design.css` — `--sublime-ink/orange/mint/canvas` tokens and
     `--gradient-sublime(-soft)` used across ~32 files.
  3. `tailwind.config.js` remaps `indigo` → ember (orange) and `sky` → horizon,
     so `indigo-*` utilities silently render orange in ~29 files.
- 574 class usages already read semantic tokens (theme automatically); 285 raw
  `bg-white` / `text-gray-*` / `bg-gray-*` / `border-gray-*` occurrences across
  36 files will look wrong in dark mode until converted.
- The landing/auth pages have their own scoped theme (`.lovable-landing` +
  `sublime-landing-theme` localStorage key) — left as is.

## Design

### 1. Theme infrastructure

- Add `next-themes`. Wrap the app in `ThemeProvider` inside
  `src/components/providers/client-providers.tsx` with `attribute="class"`,
  `defaultTheme="system"`, `enableSystem`, `storageKey="sublime-theme"`,
  `disableTransitionOnChange`.
- Add `suppressHydrationWarning` to `<html>` in `src/app/layout.tsx`.
- New `ThemeToggle` component (sun/moon icon button, visually matching the
  landing nav toggle) placed in the sidebar footer.

### 2. Neutralize brand tokens at the source

In `src/app/sublime-design.css`:
- `--sublime-ink`, `--sublime-ink-2` → near-black neutrals (graphite 900/950).
- `--sublime-orange`, `--sublime-orange-hover` → foreground neutrals;
  `--sublime-orange-soft` → neutral gray-100.
- `--sublime-mint`, `--sublime-mint-strong`, `--sublime-canvas` → neutral grays /
  white.
- `--gradient-sublime`, `--gradient-sublime-soft` → flat neutral fills.

In `tailwind.config.js`:
- Remap `indigo` and `ember` → graphite so former orange accents/CTAs render
  near-black (like the landing "Start building" button).
- Keep semantic red/green/amber Tailwind defaults — status colors are signal,
  not theme.

### 3. Sidebar and hardcoded-hex components

- Rewrite `sidebar.tsx` styling to tokens: `bg-background`, `border-border`
  hairline, `text-muted-foreground` inactive / `text-foreground` active,
  active item `bg-secondary`, credit bar `bg-foreground`.
- Remove remaining hardcoded hexes in `src/components/ui/tabs.tsx`,
  `page-header.tsx`, `empty-state.tsx`.

### 4. Dark-mode correctness sweep

- Convert the 285 raw-color occurrences (36 files) to semantic tokens
  (`bg-white` → `bg-background`/`bg-card`, `text-gray-900` → `text-foreground`,
  `text-gray-500` → `text-muted-foreground`, `border-gray-200` →
  `border-border`, etc.).
- Audit the existing 61 `dark:` variants for double-application once the class
  actually activates.

### 5. Verification

- `npm run build` + lint clean.
- Screenshot pass over key pages (home/dashboard, agents, flows, integrations,
  settings) in both light and dark modes, compared against the landing pages.

## Error handling & testing

No data-path or API changes; the risk surface is visual regression only,
mitigated by the screenshot pass. Existing unit tests are unaffected.

## Out of scope

- Landing and auth pages (already themed, separately scoped).
- Any change to status/semantic colors (success/warn/destructive).
- New brand assets or typography changes (Geist/Anonymous Pro stay).
