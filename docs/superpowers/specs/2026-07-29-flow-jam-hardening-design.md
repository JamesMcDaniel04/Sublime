# Flow Jam hardening

**Date:** 2026-07-29
**Status:** approved, ready for planning

## Reported symptoms

1. Users cannot reliably join a jam at the same time and see each other work on
   the same flow.
2. Other users' cursors are not visible after they join.
3. The invite / joining process needs hardening.

## Root cause (hypothesis, with a mechanism)

**The Realtime channel name is derived from an access revision that every
invite bumps.**

`collaboration/route.ts:23-33` mints the topic as an HMAC over
`(organizationId, flowId, collaborationAccessRevision)`. `jam/route.ts:83` does
`collaborationAccessRevision: { increment: 1 }` on every access change.

So inviting someone rotates the channel out from under everyone already in the
jam. The client *does* handle rotation — `use-flow-jam.ts:359-370` detects a
changed topic and reconnects — but only when it next fetches a snapshot, and
once realtime is live the poll slows to `CONNECTED_POLL_MS = 30000`.

That leaves a window of **up to 30 seconds after every invite** in which the
owner is subscribed to a dead channel and the invitee is alone on the new one.
Neither sees the other's cursor or edits, and nothing on screen explains why.

The inversion is what makes it feel unreproducible: the healthier the
connection, the longer the poll interval, and so the longer you are stranded.
It is worst in exactly the conditions where everything else looks fine.

**This is unproven.** It explains the symptoms precisely and is mechanically
sound, but reproducing it needs live Supabase Realtime and two authenticated
browsers, which the local environment does not have (see the `verify` skill).

### Second contributing cause

Cursors only render for peers in the *same canvas space*.
`dag-canvas.tsx:218` filters `space === 'dag'`; the flow page filters
`'stack'`. Stack is the default canvas, so the moment one person switches to
the DAG canvas, cursors silently stop crossing between them — working as
designed, indistinguishable from broken.

## 1. Closing the rotation window

### The inviter reconnects immediately

`POST /api/flows/[id]/jam` returns the new `accessRevision`. `jam-button`
hands it to the jam hook, which resnapshots at once rather than waiting for the
next poll.

### Peers are told on the channel they are still on — and the notice must survive

**Correction after reading the code.** This mechanism already exists end to
end: `jam-button` POSTs, calls `onAccessChanged`, which is
`broadcastAccessChange` (`use-flow-jam.ts:735`); that sends an `access-changed`
broadcast on the current channel, and every peer handles it at line 550 by
resnapshotting immediately. Peers do **not** wait for the 30s poll.

The defect is narrower and worse: the inviter destroys the channel out from
under its own notification.

```js
const broadcastAccessChange = () => {
  const channel = channelRef.current
  if (!channel) return
  void channel.send({ ... }).then(markDurable)  // in flight, NOT awaited
  refreshAccessRef.current()                    // → loadSnapshot → topic changed
}                                               //   → reconnect → old channel torn down
```

`channel.send` needs a WebSocket round-trip and an ack. `refreshAccessRef`
fires synchronously on the next line, `loadSnapshot` sees the rotated topic and
calls `reconnectRef.current()`, which tears down the very channel the broadcast
is travelling on. When the reconnect wins that race the notice is dropped and
peers fall back to the full 30s poll.

That explains the intermittency exactly: it depends on which of a fetch and a
WebSocket ack completes first, which varies by network, and it is likeliest to
fail on a fast connection where the snapshot returns quickly.

**The fix:** await the send before refreshing locally.

```js
const broadcastAccessChange = async () => {
  const channel = channelRef.current
  if (!channel) { refreshAccessRef.current(); return }
  markDurable(await channel.send({ type: 'broadcast', event: 'access-changed', payload: { clientId } }))
  refreshAccessRef.current()
}
```

No new mechanism, no server→Realtime publish path. If the inviter is not in the
jam there is no channel, peers fall back to the 30s poll, and the early return
still refreshes the inviter — degraded, not broken.

### The dead window stops being silent

`reduceJamConnection` gains a `rotating` state so the jam bar can show
"Access changed — reconnecting…" instead of an empty peer list that looks
identical to nobody being there.

## 2. Cursors across canvas spaces

Dag and stack coordinates are unrelated, so projection must anchor to something
both spaces share. Nodes are that thing.

At send time the sender attaches the nearest node to its cursor:

```ts
// jam-presence.ts — added to jamCursorSchema
/** The node the sender's cursor is nearest, or null when it is over empty
 *  canvas. Just the id: an offset expressed in the sender's units would be
 *  meaningless in the other space, and same-space viewers use `point`
 *  anyway — so carrying one would be an unused field that looks load-bearing. */
anchor: z.string().nullable(),
```

At render time:

| viewer | behaviour |
|---|---|
| same space | exact `point`, unchanged from today |
| different space, anchor present | drawn at that node in the viewer's space with a small fixed offset, **dimmed with a dashed ring** |
| different space, no anchor | not drawn — there is nothing truthful to draw |

The visual distinction is the mitigation for the obvious risk: a pointer that
is subtly in the wrong place reads as a bug. A precise cursor and an
approximate one must never look alike. The no-anchor case stays silent rather
than guessing, because a cursor over empty canvas has no cross-space meaning.

`nearestNodeAnchor(point, nodes, maxDistance)` and `projectAnchor(anchor,
nodes)` are pure, so the whole projection is unit-testable without Supabase.

`maxDistance` is **per-space**, because the units are not comparable: dag
distances are React Flow coordinates while stack distances are content pixels.
Each canvas passes its own constant rather than sharing one, and the pure
function takes it as an argument precisely so neither space has to know about
the other's scale.

## 3. Invite and join hardening

The endpoint is in better shape than expected: transactional, rejects
non-members loudly with `INVALID_COLLABORATOR` rather than dropping them
silently, and deep-links its notification into the flow. Three targeted
additions.

### The response carries the new revision

Already computed; returning it is what enables the immediate resnapshot above.

### The jam bar separates invited from present

Today it shows connected peers only, so an owner who invites three people and
sees zero peers cannot tell "they have not opened it yet" from "this is
broken". That ambiguity is the reported confusion.

```
Jam · 3 invited · 1 here
  ● Sam Diaz          here
  ○ Dana Reed         invited, not joined
  ○ Alex Chen         invited, not joined
```

Had this existed the original bug would have been self-diagnosing: "2 here"
means the problem is cursors, "1 here" means the peer never connected.

### Revocation gets fast for free

A removed user is still on the old topic, receives the same `access-rotated`
broadcast, resnapshots, gets their 403 and is ejected at once — rather than
lingering up to 30 seconds with live presence on a flow they no longer have
access to. A security-adjacent win that falls out of §1 without its own
mechanism.

## Non-goals

- Changing the policy that only the flow owner manages access. A collaborator
  being unable to pull in a third person is a real question at a small team,
  but it is a permissions decision, not hardening.
- A server→Realtime publish path. Not needed, and it would mean shipping a
  service-role Supabase client into a request handler.
- Replacing the revision-in-topic scheme with a stable topic. That trades a
  cryptographic revocation property for reliability and deserves its own
  threat-model discussion.

## 4. Tests

Testable without Supabase, which is most of it:

- `channelTopic` — identical inputs produce an identical topic; a bumped
  revision produces a different one; a missing secret 503s in production and
  falls back to the local constant otherwise.
- `reduceJamConnection` — the new `rotating` state, and that it resolves to
  connected on resubscribe rather than latching.
- `nearestNodeAnchor` — nearest node within range; null beyond `maxDistance`;
  a deterministic tie-break; an empty graph; and that each space's own
  `maxDistance` is honoured rather than a shared constant.
- `projectAnchor` — projects onto a node present in the viewer's space; returns
  nothing when the anchored node was deleted.
- Component — a cross-space cursor renders with the dashed/dimmed treatment and
  a same-space cursor does not; the jam bar's invited-vs-present split.
- Route — invite returns `accessRevision`; a revoked user's next snapshot 403s.

## 5. What cannot be verified here

None of the above proves the bug is fixed. Realtime presence needs live
Supabase plus two authenticated browsers; this environment has neither. Every
test proves the logic is right; none proves the symptom is gone.

The completion step is manual: deploy, open the flow as two users in two
browsers, have the owner invite the second mid-jam, and confirm cursors appear
within a second or two rather than never.

If they still do not, the rotation window was not the cause. The next move is
temporary instrumentation on the jam path — topic, revision, SUBSCRIBED,
CLOSED, presence sync, peer count — deployed and read from a real two-person
session.

This is why the jam bar's invited-vs-present split ships alongside the fix
rather than after it. The rotation change is a hypothesis; the split is
diagnostic infrastructure. If the hypothesis holds, the fix works. If it does
not, the split distinguishes "presence never arrived" from "presence arrived
and did not render" — which nobody could tell apart before. Either way the next
session teaches something.
