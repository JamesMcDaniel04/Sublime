# Flow Jam production checklist

Flow Jam keeps the database as the source of truth. Supabase Realtime speeds up
presence, cursors, and graph delivery; the client polls the authenticated API as
a fallback when WebSockets are unavailable.

Before release:

- Apply `20260713070000_flow_collaboration_revision` and confirm the `flows`
  table has a non-null `collaborationRevision` integer column.
- Keep `ENCRYPTION_KEY` set consistently across all web instances. It signs the
  unguessable per-flow Realtime topic returned by the authenticated API.
- Confirm Supabase Realtime is enabled and production networks allow secure
  WebSocket connections to the project host.
- Open one shared flow as two different active organization members in separate
  browser profiles. Verify both header avatars and cursor labels appear.
- Edit different steps simultaneously and confirm both changes remain. Then
  edit the same step and confirm the conflict warning appears.
- Disconnect one browser from WebSockets, edit in the other, and confirm the
  disconnected browser catches up through polling within a few seconds.
- Attempt to Jam on a private flow and confirm the invite is rejected until the
  flow is shared.
- Confirm a stale manual Save returns `FLOW_SAVE_CONFLICT` and never overwrites
  the newer collaborative graph.
