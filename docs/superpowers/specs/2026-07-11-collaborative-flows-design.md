# Collaborative Flow Editing (FigJam-style) — Design Spec

**Date:** 2026-07-11 · **Status:** Implemented and hardened 2026-07-13
**Ask:** two or more members of the same org build a flow together in real time on a shared scaffold.

## Current-state facts (verified)

- The builder holds the whole graph in client state and saves via a **full-graph PUT** with a dirty-snapshot check (`page.tsx:242-247,528`) — **no server-side concurrency guard**: two editors today silently last-write-wins clobber each other.
- `@supabase/supabase-js` 2.50 is already a dependency → **Supabase Realtime** (channels: presence + broadcast) is available with zero new infra. Auth is already Supabase.
- Graph edits are already **structured operations** (`insertNodeAfter`, `updateNode`, `deleteNode`, `moveNodeAfter`, `changeNodeType`, `addContainerStep`, `applyCopilotOps`…) in `lib/flows/mutate.ts` — an op vocabulary suitable for broadcast, no CRDT needed for v1.
- The canvas is a vertical column (no XY cursors) → presence = **avatars + per-node "editing" indicators**, not free 2D cursors.
- Org membership + invitations just landed (`OrganizationInvitation` model) — the sharing prerequisite.

## Recommended architecture (v1: "op-broadcast + node claims")

1. **Channel per flow**: Supabase Realtime channel `flow:<flowId>`, joined by any org member with the builder open. RLS-style guard: join token derived from an authenticated API call that verifies org membership.
2. **Presence**: avatar stack in the builder header; each client publishes `{ userId, name, selectedNodeId }`. Selected node shows the collaborator's avatar ring + "Sam is editing" badge.
3. **Patch broadcast**: local mutations are diffed into id-addressed node/edge patches and sent through the authenticated collaboration API. The API applies them against the latest graph with a monotonic `collaborationRevision`; Realtime accelerates delivery, while polling provides reconnect catch-up. Same-node conflicts are visible and topology conflicts fail closed.
4. **Soft node claims**: selecting a node publishes a claim; other clients render that node read-only-ish (visible warning, still overridable — FigJam-style optimism, not hard locks).
5. **Server as sequencer (durability)**: `POST /api/flows/[id]/collaboration` applies patches with an atomic monotonic revision. The full-graph PUT remains for compatibility and uses compare-and-swap plus the same revision counter so it cannot silently clobber a concurrent Jam edit.
6. **Late joiners / reconnect**: fetch graph + current `rev`, then apply buffered ops.
7. **Undo/redo**: per-user undo of *their own* ops (inverse ops), FigJam-style; global undo is explicitly out of scope for v1.

**Why not CRDT (Yjs)?** The graph is a small structured document with an existing op vocabulary; a sequencer + commuting ops gets 90% of the experience for ~20% of the complexity. Yjs becomes worth it only if we later need offline merge or text-level co-editing inside fields.

## v1 scope cut

- ✅ presence avatars, per-node editing indicators, live op sync, rev-guarded saves, conflict toast ("Sam changed this step"), late-join catch-up
- ✅ viewport cursors plus exact per-node editing indicators
- ❌ (defer) character-level text cursors, comments/threads, global undo, offline authoring, view-only share links, cross-org guests

## Open questions for review

1. Should the run/test panel also be live-shared (see collaborators' test runs), or per-user?
2. Publish while others edit: require a "quiet" confirmation showing who else is active?
3. Rate/size limits on the ops table (append-only log grows — snapshot+truncate every N ops?).

## Rough sequencing (each its own plan)

1. **Rev-guarded saves** (fixes the existing silent-clobber bug — valuable standalone, small)
2. **Presence** (channel + avatars + selection badges — no data sync yet, medium)
3. **Op sync** (broadcast + sequencer + rebase + late-join, large)
4. Polish: claims, conflict toasts, per-user undo (medium)
