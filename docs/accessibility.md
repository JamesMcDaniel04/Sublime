# Accessibility

**Target standard: WCAG 2.1 Level AA.**

The ADA does not itself specify a technical standard for web content, and this
document is not legal advice. In practice US web accessibility claims are argued
against WCAG 2.1 AA, the DOJ's 2024 Title II rule adopts it by name, and it is
what procurement and VPAT processes ask for — so it is what this project builds
and tests against.

Audited 2026-08-14. Reproduce anything below with `npm run test:e2e`.

## Automated conformance

`e2e/accessibility.spec.ts` runs axe-core against every page reachable without
an account, in both desktop and mobile viewports, and fails on any serious or
critical WCAG 2.1 A/AA violation. It runs in CI as part of the `browser` job.

**Current result: 16/16 passing** — `/`, `/about`, `/contact`, `/privacy`,
`/terms`, `/auth/login`, `/auth/signup`, plus a keyboard-reachability check.

axe detects roughly a third of WCAG issues. **A green run is a floor, not a
certificate.** The manual pass below is the part that finds the rest.

## What was fixed in the 2026-08-14 pass

| Issue | Criterion | Fix |
|---|---|---|
| No skip link — keyboard users tabbed the whole sidebar on every navigation | 2.4.1 Bypass Blocks (A) | Skip link in the root layout; both layouts' `<main id="main-content">` made focusable |
| 108 form controls with no programmatic label | 3.3.2, 4.1.2 (A) | 61 associated by codemod; 47 remain (see backlog) |
| Panel resize handle was mouse-only | 2.1.1 Keyboard (A) | Arrow keys nudge, Shift jumps, Home resets; focusable splitter |
| Section numerals at 60% opacity ≈ 2.9:1 | 1.4.3 Contrast (AA) | Raised to the full `muted-foreground` token |
| `muted-foreground` on `muted`/`secondary` = 4.36:1 | 1.4.3 (AA) | Token darkened to 43% — 4.65:1 |
| `warning` on white = 4.11:1 | 1.4.3 (AA) | Lightness 38% → 35% — 4.8:1 |
| Form field borders 1.25:1 (light) / 1.66:1 (dark) | 1.4.11 Non-text Contrast (AA) | `--input` raised to 3.04:1 and 3.01:1 |
| JS smooth-scrolling ignored the OS motion preference | 2.3.3 (AAA), vestibular safety | `scrollBehavior()` helper honours `prefers-reduced-motion` |
| One unnamed icon-only button | 4.1.2 (A) | `aria-label` added |

Contrast note: `--border` was deliberately **not** darkened. 1.4.11 covers
boundaries required to identify a component; a card hairline is decoration, and
darkening every one would be a redesign rather than a fix. `--input` — the
boundary that identifies a form field on a same-coloured background — was.

## Known backlog

`npm run lint` runs the full `jsx-a11y/recommended` ruleset. Four rules carry a
remaining backlog and are set to `warn`, with `--max-warnings 91` pinned at
today's exact count: **a new violation fails CI while the existing ones are
worked down.** Lower the number as they go; it only ratchets down.

| Count | Rule | Nature |
|---|---|---|
| 47 | `label-has-associated-control` | Multi-line labels, and controls that already own an `id`. Each needs a per-site decision the codemod correctly refused to guess. |
| 17 | `click-events-have-key-events` | Mostly modal backdrops and `stopPropagation` wrappers — several are legitimately non-interactive and want an eslint-disable with a reason, not a handler. |
| 17 | `no-static-element-interactions` | Same set. |
| 8 | `no-autofocus` | Defensible inside a dialog, arguable elsewhere (3.2.1 On Focus). |
| 2 | `no-noninteractive-element-interactions` | Drag affordances. |

## Not covered by automation — needs a manual pass

These cannot be meaningfully assessed by a rule set, and none has been done yet:

- **The flow builder** (`@xyflow/react`). A drag-and-drop canvas is the hardest
  surface in the product. Node selection, connection creation and repositioning
  need keyboard equivalents, and the canvas needs an accessible alternative
  representation. Assume it does not conform today.
- **The 3D landing scene** (`three.js` / `@react-three/fiber`). Needs a
  meaningful text alternative and must respect reduced motion.
- **Screen-reader passes** with VoiceOver and NVDA over the core journeys:
  sign-in, create an agent, run a flow, read a run.
- **Keyboard-only walkthrough** of the authenticated app — the axe suite cannot
  reach it without a seeded session.
- **Voice huddle** (WebRTC). Audio-only communication needs a text alternative
  for deaf and hard-of-hearing users.
- **Live regions.** Toasts come from `sonner`, which announces; run status and
  streaming agent output are dynamic content that likely does not.
- **Duplicate `id`s.** The label codemod generates ids from label text,
  uniquified per file. A component rendered more than once on a page could emit
  duplicate ids — axe checks this on public pages, but not on authenticated ones.

## Accommodations the product already provides

Worth recording, since these are the questions a VPAT or procurement review asks:

- Light and dark themes, both meeting AA text contrast.
- Visible focus indicators on every interactive primitive — `outline-none` is
  never used without a replacement ring.
- Radix UI primitives for dialogs, menus, selects, switches and tooltips, which
  bring focus trapping, escape handling and ARIA wiring.
- Global reduced-motion support in `globals.css`, plus per-component handling in
  the landing scene and stat tiles.
- Full keyboard operation of standard forms and navigation.
- Semantic landmarks (`<main>`, `<nav>`) and a working skip link.
- Two-factor codes accept paste and use `autocomplete="one-time-code"`.

## Reporting a barrier

There is no accessibility statement page or dedicated contact route yet. Both
are worth adding: a statement is a common procurement requirement, and a named
contact is treated as evidence of good faith. `/contact` currently offers a
"Privacy & security" reason and no accessibility one.
