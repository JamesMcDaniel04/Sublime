# Collapsible Sidebar Design

**Date:** 2026-07-17
**Status:** Approved

## Summary

Make the desktop side navigation (`src/components/layout/sidebar.tsx`)
collapsible to a narrow icon rail. Mobile (overlay drawer) is unchanged.

## Decisions (user-confirmed)

- Collapse style: **icon rail** (~64px), not fully hidden.
- State lives in the `Sidebar` component, persisted to `localStorage`.

## Behavior

Desktop (`lg+`) only; the mobile overlay drawer always renders expanded.

**Expanded (default):** today's sidebar plus a collapse toggle button
(`PanelLeftClose` icon, `aria-label="Collapse sidebar"`) in the search row,
next to the notification bell.

**Collapsed (`w-16` rail), top to bottom:**

- Org logo (image only). Clicking it **expands** the sidebar — the org
  dropdown cannot fit in the rail.
- Expand toggle (`PanelLeft` icon, `aria-label="Expand sidebar"`).
- Search icon button — opens the ⌘K command palette.
- Notification bell (icon-only variant it already is).
- The 4 nav items as icon-only links with `title` tooltips and the same
  active highlight treatment (pill background) as expanded.
- Spacer, then the user avatar pinned at the bottom, linking to `/settings`
  with a `title` tooltip.

Hidden when collapsed: search label + ⌘K kbd hint, org name/chevron, the
Workspace/Private agent tree (drag-and-drop requires the expanded state),
section headers, the usage meter, and the user name/email/plan text.

**Persistence:** `localStorage` key `sidebar.collapsed` (`'1'` / absent),
read lazily in the `useState` initializer and written on toggle, both
`try/catch` guarded — the same idiom as `dashboard.assistantWidth`. Storage
unavailable → defaults to expanded; toggling still works for the session.

**Animation:** width transitions via the existing
`transition-[width] duration-200` idiom (replacing the current
`transition-transform` only where needed; the mobile translate behavior is
preserved).

**Keyboard:** `⌘B` / `Ctrl+B` toggles collapsed state, registered in the
same `keydown` effect that handles `⌘K`.

## Architecture

Approach: local component state — no context, no app-shell changes. The
sidebar is a normal flex child of `.sublime-app-shell`, so a width change
reflows the content region automatically.

Within `sidebar.tsx`, sections render conditionally on `collapsed`. The
component stays one file (it is large but cohesive; this change adds a
boolean and conditional classes, not new responsibilities).

## Error handling

- `localStorage` read/write wrapped in `try/catch` (private browsing).
- No other failure surface — purely presentational state.

## Testing

No component-test infrastructure exists in this repo. Verification is
`npm run typecheck` + `npm run lint`, plus a manual dev pass: toggle via
button and ⌘B, persistence across reload, tooltips on rail icons, active
nav highlight in both states, mobile drawer unaffected.

## Out of scope

- Hover-to-peek expansion.
- Collapsed-state access to the agent tree.
- Resizable sidebar width.
