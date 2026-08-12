# Home: Recent Flows Strip

**Date:** 2026-08-11
**Status:** Approved

## Goal

Give people a fast way back into the flow canvases they were just working in.
The Home page stays the workspace assistant; the Flows page stays the full
inventory. Home gains a compact "recent flows" strip beneath the assistant's
hero as a navigation shortcut — nothing more.

(An earlier idea — moving the flows inventory onto Home and the assistant onto
the Flows page — was considered and dropped in favor of this.)

## What it does

- Shows the **3 most recently updated flows** for the current goal lens.
- Each card links straight into the canvas at `/flows/[id]` (scoped link).
- A small section header — "Pick up where you left off" — with an
  "All flows →" link to `/flows`.

## Data

- Reuses the client-cached `/api/flows?goal=<scope>` payload (same hook the
  Flows page and sidebar warm-up use: `useCachedJson`). No new endpoint, no
  extra request on Home.
- The API already orders by `updatedAt desc`; the component takes the first 3
  after filtering.
- **Excludes AI-suggested drafts** (`suggested && status === 'draft'`) — those
  are Sublime's proposals, not flows the user worked on, and they already have
  a dedicated surface on the Flows page. All other statuses (active, draft,
  disabled) qualify.

## Placement & visibility

- Renders **only in the hero (pre-chat) state** of Home, below the preset
  chips, inside the centered `max-w-4xl` block.
- Hidden during an active chat transcript — the transcript and pinned composer
  own the screen.
- Hidden entirely (no header, no empty state) when no qualifying flows exist,
  so first-run and no-flow workspaces see no extra chrome.
- While the flows payload is loading, render nothing (the cache is warmed at
  sign-in, so the common case paints immediately).

## Card contents

Compact card, 3-up grid on `sm+` (stacked on mobile):

- Workflow icon (matches the Flows page card treatment)
- Flow name (truncated)
- Status badge (reuses the Flows page `STATUS_STYLE` treatment)
- Relative updated time ("2h", "3d" — same `relativeTime` idiom Home already
  uses for chat history)

## Components

- `RecentFlows` client component at
  `src/app/(app)/g/[scope]/dashboard/recent-flows.tsx` (home-specific, lives
  next to `home-assistant.tsx`).
- Top-3 selection/filter logic extracted as a pure function
  (`pickRecentFlows`) and unit-tested: takes the flows array, returns ≤3
  non-suggested flows by recency.
- `home-assistant.tsx` renders `<RecentFlows />` in the hero branch after the
  preset chips.

## Error handling

- Fetch error or malformed payload → render nothing. The strip is a shortcut,
  not a source of truth; the Flows page already surfaces load errors.

## Testing

- Unit test for `pickRecentFlows`: caps at 3, excludes suggested drafts,
  preserves API recency order, handles empty/undefined input.
- Existing route-smoke coverage of `/dashboard` continues to guard the page
  render.
