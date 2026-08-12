# Landing rebrand: "Workflows you run with your customers"

**Date:** 2026-08-11
**Status:** Approved

## Goal

Reposition the marketing surface from "agents against RevOps goals/ROI" to
**collaborative workflows shared by internal employees and external
customers**. The ROI/cost-visibility story survives as one supporting feature
card, not the headline. Voice: the approved "shared-process" direction — calm,
product-led, descriptive; the workflow is the shared surface between a team and
the people it serves.

## Scope

Copy + light visual tweaks. Files touched:

1. `src/components/landing/landing-page.tsx` — all landing copy + app-mock tweaks
2. `src/app/layout.tsx` — site `metadata.description`
3. `src/app/opengraph-image.alt.txt` — OG alt text
4. `src/app/(public)/about/page.tsx` — light-touch alignment (2–3 line edits)

Out of scope: `opengraph-image.png` (may have the old tagline baked into the
bitmap — follow-up item), pricing grid component, nav/footer structure, auth
pages, product UI.

## Copy changes (exact strings)

### Hero

- H1: `Workflows you run <em>with</em> your customers`
- Sub: "Sublime is where your team and the people you serve work the same
  process — approvals, handoffs, requests — while agents handle the busywork
  in between."
- CTA button (hero **and** final CTA): "Create your first workflow"
  (replaces "Set your first goal", both instances; href `/auth/signup`
  unchanged)

### Integrations marquee

- Kicker "Connections": unchanged.
- H2: `Connected to everything.<br />Shared with <span className="text-primary">everyone who matters</span>.`
  (the primary-colored span moves from "your goals" to "everyone who matters")
- Sub: "Sublime plugs into the stack you already run, so every workflow — and
  every agent inside it — starts with full context."

### Features

- Kicker "What you get": unchanged.
- H2: `Built for both sides<br />of the work.`
- Cards, in this order:
  1. **NEW — "Customers are participants, not CCs"** (replaces "Goals show
     their progress"): "Invite the people you serve into the workflows that
     concern them. They file requests, approve steps, and watch status move —
     no status-chasing email threads." Graphic: new `people` variant (see
     Visual tweaks).
  2. **"Agents own the busywork"** (kept): "Specialized agents take over the
     recurring work between human steps — digests, triage, follow-ups — so
     your people stop doing robot work." Graphic: `flow` (unchanged).
  3. **"Every run proves its cost"** (kept — the ROI survivor): "Agents run in
     minutes for cents, and every run is logged against its workflow — so you
     see exactly what got done and what it replaced." Graphic: `bars`
     (unchanged).

### Testimonial

- Quote: "We moved client onboarding into a Sublime workflow. Our customers
  finally see where things stand, my team stopped chasing status over email,
  and the agents send the follow-ups nobody had time for."
- Attribution: name/avatar unchanged (Jamie Kim); title becomes
  "Head of Client Operations, Falken Group".

### Pricing

Unchanged (headline and fine print are not goals-specific).

### Final CTA

- H2: "Put your next process on a workflow."
- Sub: "Connect your stack, invite your team and your customers, and let
  agents keep the work moving."
- Button: "Create your first workflow".

### Site identity

- `src/app/layout.tsx` `metadata.description`: "Workflows you run with your
  customers. Sublime brings your team and the people you serve into the same
  process — with agents handling the busywork and proving the ROI of every
  run."
- `src/app/opengraph-image.alt.txt`: "Sublime — workflows you run with your
  customers. Collaborative agent workflows at trysublime.io."

### About page (light touch)

- Meta/description line "Sublime is the goal-based AI platform…" → "Sublime is
  the collaborative workflow platform: your team and your customers work the
  same process, with specialized agents handling the work in between."
- Hero line "The goal-based AI platform." → "Workflows both sides can see."
- Each remaining body line that leads with goals ("measured against the goals
  your org actually runs on", "deployed against goals — quota, ARR, a launch
  date", "proves its ROI goal by goal") is rewritten in place to its
  workflow-collaboration equivalent, keeping sentence count and paragraph
  structure; the "ROI over demos" value card **stays** (ROI is the supporting
  theme).
- Keep edits minimal — do not restructure the page.

## Visual tweaks (app mock + feature graphic)

All cues stay in the mock's existing abstract, text-light idiom (gray blobs,
token-based tints). No new images or dependencies.

1. **Row IDs**: `TRG-142` etc. → `FLW-142` etc. (same numbers).
2. **Dual-avatar stacks**: on rows 1, 4, and 7 of the 7 list rows (spread top
   to bottom), replace the single
   `h-5 w-5 rounded-full` avatar with two overlapping circles — one filled
   with a primary tint (internal member), one neutral with a visible border
   (external customer). Overlap via negative margin; sized to fit the 36px
   row height.
3. **Detail panel**: in the property list, add a "Shared with" row whose value
   is a pair of overlapping avatar dots (same internal/external treatment).
   Existing rows keep their layout.
4. **New `people` feature graphic**: a horizontal row of ~5 overlapping avatar
   circles inside the existing 128px graphic frame — mix of primary-tinted
   (internal) and border-outlined (external) circles, connected by the same
   muted line element the other graphics use.

## Architecture / risk notes

- All changes are presentational; no data flow, API, or state changes. The
  landing theme system (`.lovable-landing` scoped tokens, `sublime-theme`
  storage key) is untouched.
- Both themes must be checked: the mock's collaboration cues use token colors
  (`bg-primary/…`, `border-border`) so they adapt automatically, but the
  integrations section is a fixed dark-green panel — its new copy keeps the
  existing white/opacity classes.
- The `em` in the hero H1 inherits the heading font style; italicize via the
  default `em` rendering (no new classes unless it renders poorly).

## Verification

1. `next build` passes.
2. Browser harness (temp unauthed route + cached Playwright chromium, per the
   established protocol): screenshot the landing page in dark and light
   themes; confirm hero, marquee card, features, testimonial, final CTA copy,
   and the mock's avatar cues render correctly at desktop and mobile widths.
3. Grep the four touched files for leftover `goal`/`RevOps`/`ROI` strings and
   confirm each survivor is intentional (the ROI feature card, pricing fine
   print, about's "ROI over demos" card).
