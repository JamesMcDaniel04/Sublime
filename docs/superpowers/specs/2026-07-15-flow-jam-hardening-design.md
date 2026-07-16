# Flow Jam Hardening — Design

**Date:** 2026-07-15
**Status:** Approved
**Goal:** Take Flow Jam from phased-MVP to production quality at parity with Figma's multiplayer feel, for 2–5 concurrent editors, on the existing Vercel + Supabase + Prisma stack.

## Decision

Harden the existing **server-sequenced patch engine** (Approach A). The API stays the durable
sequencer (revision numbers in Postgres), Supabase Realtime stays the fast delivery rail,
polling remains only as a fallback. No CRDT rewrite (Yjs), no managed vendor (Liveblocks) —
Figma itself uses server-ordered per-property last-write-wins, which is the shape we already have.

## Program shape — three sequenced specs

1. **Spec 1: Sync Engine Hardening** (foundation; detailed below)
2. **Spec 2: Presence & Multiplayer UX** (canvas-space cursors, selection presence, follow mode)
3. **Spec 3: Social Layer** (comments, reactions, spotlight)

Strict order: Spec 2 reads the connection state machine Spec 1 builds; Spec 3 rides the
channel Spec 1 hardens. One spec → plan → implement → verify cycle at a time.

## Spec 1 — Sync Engine Hardening

### Per-field merge (not per-node)

Patch node changes gain optional field-level granularity for `node.data` edits:
`{ id, fields: { <dataKey>: { before, after } } }`. Whole-node add/remove keeps the existing
`{ id, before, after }` form. Two peers editing different fields of the same node both win;
a conflict is now only "same field, same moment" (last write wins, conflict surfaced).
Schema change is an optional-field addition — old-format patches still parse (same pattern
as the 2026-07-15 `layout` fix).

### Peer-safe undo

Replace the whole-graph-snapshot undo stacks in the flow editor with **inverse patches of the
user's own operations**. Undo applies the inverse rebased onto the current graph; if the target
node/field no longer exists (peer deleted it), that entry is skipped. ⌘Z never reverts a
teammate's work. Same model for redo.

### Idempotent, loss-proof delivery

- Server remembers the last ~50 applied `mutationId`s per flow (JSONB column on `Flow`).
  A retried POST (timeout, flaky network) can't double-apply or double-report conflicts.
- On `pagehide`, pending unflushed patches are sent via `navigator.sendBeacon` so closing
  the tab mid-edit loses nothing.

### Gap detection over poll-waiting

Realtime broadcasts already carry the revision. On observing a gap (revision N+2 after N),
the client immediately fetches a snapshot rather than drifting until the next poll.
With realtime healthy the poll relaxes to a ~30s safety net; the 1s fast-poll remains only
for degraded mode.

### Explicit connection state machine

`connecting → live → catching-up → degraded → offline / denied / unconfigured` as a pure,
unit-tested reducer driving the Jam pill UI. Every state has a defined recovery path.

### Testing bar

- Merge / rebase / undo stay pure functions with exhaustive unit tests.
- A two-simulated-clients integration test (mock channel + mock sequencer) replays nasty
  interleavings: concurrent field edits, delete-vs-edit, drag-during-disconnect,
  undo-after-remote-delete, retry-after-timeout duplication.

## Spec 2 — Presence & Multiplayer UX (summary)

- **Canvas-space cursors:** broadcast in flow coordinates; each viewer projects through their
  own pan/zoom (React Flow viewport in DAG mode; pan/zoom translate in stack mode). Payload
  includes the sender's viewport. Off-screen peers get an edge-of-screen indicator.
- **Selection presence / soft locks:** peer's selected node gets an outline in their cursor
  color; opening a node a peer is configuring shows "X is editing this step" (warning, not a
  hard lock — per-field merge makes simultaneous edits mostly safe).
- **Follow mode:** click a peer's avatar → viewport tracks their broadcast viewport until you
  pan away.
- **Join/leave & connection UX:** throttled join/leave toasts; Jam pill labels driven by the
  Spec-1 state machine.

## Spec 3 — Social Layer (summary)

- **Comments:** `FlowComment` model (anchor = node id or canvas point, threads via `parentId`,
  resolve state). Authz through the API (`flowReadScope`); delivery via the jam channel;
  bell/push notifications for mentions and offline replies. Pins render on both canvas modes;
  sidebar lists open threads.
- **Emoji reactions:** ephemeral broadcast-only floating emoji.
- **Spotlight:** presenter broadcasts a request; peers get a consent toast, never a forced
  viewport takeover.

## Out of scope

Voice/video/audio chat, anonymous guest access, cross-org sharing, >5-editor scale work.

## Context: bugs already fixed (2026-07-15, pre-design)

- `layout` was invisible to the patch pipeline → drags produced empty patches and the
  reconcile poll reverted them ("snap back"); apply also erased stored layout.
- Realtime RLS only admitted owner/collaborators while the API admitted org-shares →
  org-shared teammates never connected to the channel.
- Missing `ENCRYPTION_KEY` produced a silent eternal "Reconnecting" state; now surfaced once.

## Risks

Highest-risk item: the undo rework (editor hot path). Mitigation: the two-client integration
test lands before the UI wires in. Patch-schema evolutions are additive/optional only.
