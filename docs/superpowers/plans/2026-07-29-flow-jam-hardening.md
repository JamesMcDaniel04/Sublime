# Flow Jam Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop an invite from silently stranding everyone already in a jam, make cursors visible across canvas modes, and let the jam bar distinguish "invited" from "here" so a future failure is self-diagnosing.

**Architecture:** The access-changed broadcast already exists end to end; the defect is that the inviter tears down the channel before the notice flushes. Awaiting the send fixes it. Cursor projection anchors to node ids — the only thing the dag and stack coordinate spaces share — and renders approximations visually distinct from precise pointers.

**Tech Stack:** React, Supabase Realtime, Zod, `node:test` + `tsx`, `@testing-library/react`.

**Spec:** `docs/superpowers/specs/2026-07-29-flow-jam-hardening-design.md`

## Global Constraints

- Test runner: `npm test`. Single file: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <path>`. Typecheck `npm run typecheck`, lint `npm run lint`.
- **Realtime cannot be exercised locally.** No Supabase credentials exist here. Every test proves logic, none proves the symptom is gone — see the manual step in Task 6.
- Cursor payloads stay in canvas coordinates. Never send window fractions.
- `maxDistance` is **per-space** — dag distances are React Flow coordinates, stack distances are content pixels. Each canvas passes its own constant; the pure function takes it as an argument.
- A projected (cross-space) cursor must never look like a precise one.
- No server→Realtime publish path. The inviting client broadcasts on the channel it is already on.
- Do not change the policy that only the flow owner manages jam access.
- `void channel.send(...)` is correct for *ephemeral* traffic (cursors, huddle signalling — see the comment at `use-flow-jam.ts:750`). Only the access notice needs awaiting, because only it is followed by a teardown of its own transport.

**Task order:** 1 → 2 → 3 → 4 → 5 are independent of each other except 3 depends on 2. Task 6 is the manual verification and runs last.

---

### Task 1: The access notice survives its own rotation

**Files:**
- Modify: `src/components/flows/use-flow-jam.ts:735-745`
- Test: `src/components/flows/__tests__/use-flow-jam.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `broadcastAccessChange` becomes `() => Promise<void>`; the `UseFlowJam` return type changes accordingly.

- [ ] **Step 1: Write the failing test**

Append to `src/components/flows/__tests__/use-flow-jam.test.ts`:

```ts
test('the access notice is flushed before the local refresh can rotate the channel', async () => {
  // The bug: send() needs a WebSocket round-trip while refreshAccess() is a
  // fetch that ends in a reconnect tearing down this very channel. Whichever
  // wins decides whether peers hear about the invite at all — which is why the
  // symptom is intermittent and worst on a fast connection.
  const order: string[] = []
  let resolveSend: (status: string) => void = () => {}
  const channel = {
    send: () =>
      new Promise<string>((resolve) => {
        order.push('send-started')
        resolveSend = (status) => {
          order.push('send-acked')
          resolve(status)
        }
      }),
  }
  const refreshAccess = () => order.push('refresh')

  const broadcast = makeBroadcastAccessChange({
    getChannel: () => channel,
    clientId: 'c1',
    markDurable: () => order.push('marked'),
    refreshAccess,
  })

  const pending = broadcast()
  // The refresh must NOT have run yet — the notice is still in flight.
  assert.deepEqual(order, ['send-started'])
  resolveSend('ok')
  await pending
  assert.deepEqual(order, ['send-started', 'send-acked', 'marked', 'refresh'])
})

test('with no channel it still refreshes the inviter', async () => {
  // Inviting from outside the jam: nobody to notify, but the inviter must
  // still pick up the rotated topic rather than sitting on a stale one.
  const order: string[] = []
  const broadcast = makeBroadcastAccessChange({
    getChannel: () => null,
    clientId: 'c1',
    markDurable: () => order.push('marked'),
    refreshAccess: () => order.push('refresh'),
  })
  await broadcast()
  assert.deepEqual(order, ['refresh'])
})

test('a failed send still refreshes rather than stranding the inviter', async () => {
  const order: string[] = []
  const broadcast = makeBroadcastAccessChange({
    getChannel: () => ({ send: async () => 'timed out' }),
    clientId: 'c1',
    markDurable: (status: string) => order.push(`marked:${status}`),
    refreshAccess: () => order.push('refresh'),
  })
  await broadcast()
  assert.deepEqual(order, ['marked:timed out', 'refresh'])
})
```

Add the import for `makeBroadcastAccessChange` from `@/lib/flows/jam-access-notice` at the top of that file.

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/__tests__/use-flow-jam.test.ts`
Expected: FAIL — cannot find module `@/lib/flows/jam-access-notice`.

- [ ] **Step 3: Extract the ordering into a pure factory**

Create `src/lib/flows/jam-access-notice.ts`:

```ts
/**
 * Announce a jam access change, then pick up the rotated channel.
 *
 * The order is the whole point. Changing access bumps
 * `collaborationAccessRevision`, which is baked into the Realtime topic's HMAC,
 * so refreshing rotates the topic and tears down the current channel. If the
 * notice is merely fired and not awaited, that teardown can win the race and
 * peers never learn — they then sit on a dead channel until the 30s poll.
 *
 * Extracted from the hook so the ordering is testable without a WebSocket.
 */
export type AccessNoticeDeps = {
  /** Null when the inviter is not in the jam — nobody to notify. */
  getChannel: () => { send: (payload: unknown) => Promise<string> } | null
  clientId: string
  markDurable: (status: string) => void
  refreshAccess: () => void
}

export function makeBroadcastAccessChange(deps: AccessNoticeDeps): () => Promise<void> {
  return async () => {
    const channel = deps.getChannel()
    if (!channel) {
      // Still refresh: the inviter's own topic rotated even with no peers.
      deps.refreshAccess()
      return
    }
    const status = await channel.send({
      type: 'broadcast',
      event: 'access-changed',
      payload: { clientId: deps.clientId },
    })
    deps.markDurable(status)
    deps.refreshAccess()
  }
}
```

- [ ] **Step 4: Use it in the hook**

In `src/components/flows/use-flow-jam.ts`, replace the body of
`broadcastAccessChange` (line 735) with the factory:

```ts
  const broadcastAccessChange = useMemo(
    () =>
      makeBroadcastAccessChange({
        getChannel: () => channelRef.current,
        clientId,
        markDurable,
        refreshAccess: () => refreshAccessRef.current(),
      }),
    [clientId, markDurable],
  )
```

Add `import { makeBroadcastAccessChange } from '@/lib/flows/jam-access-notice'`.

The returned value is now a `Promise<void>`. `jam-button` calls it as
`onAccessChanged?.()` and ignores the result, which stays correct — but change
that call to `await onAccessChanged?.()` inside the existing `try` so the
"Invited N teammates" toast cannot appear before the notice has flushed.

- [ ] **Step 5: Run tests and typecheck**

```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/__tests__/use-flow-jam.test.ts
npm run typecheck
```
Expected: PASS. Typecheck will flag `onAccessChanged`'s type — widen it to
`() => void | Promise<void>` in `jam-button.tsx`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/flows/jam-access-notice.ts src/components/flows/use-flow-jam.ts src/components/flows/jam-button.tsx src/components/flows/__tests__/use-flow-jam.test.ts
git commit -m "fix(flows): flush the jam access notice before rotating the channel"
```

---

### Task 2: Cursors carry a node anchor

**Files:**
- Modify: `src/lib/flows/jam-presence.ts`
- Test: `src/lib/flows/__tests__/jam-presence.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `jamCursorSchema` gains `anchor: z.string().nullable()`; exports
  `nearestNodeAnchor(point: {x:number;y:number}, nodes: AnchorNode[], maxDistance: number): string | null`
  and `projectAnchor(anchor: string | null, nodes: AnchorNode[]): {x:number;y:number} | null`,
  with `type AnchorNode = { id: string; x: number; y: number }`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/flows/__tests__/jam-presence.test.ts` (create it with the
standard `node:test` header if absent):

```ts
import { nearestNodeAnchor, projectAnchor } from '../jam-presence'

const nodes = [
  { id: 'a', x: 0, y: 0 },
  { id: 'b', x: 100, y: 0 },
  { id: 'c', x: 0, y: 100 },
]

test('anchors to the nearest node within range', () => {
  assert.equal(nearestNodeAnchor({ x: 10, y: 5 }, nodes, 200), 'a')
  assert.equal(nearestNodeAnchor({ x: 90, y: 5 }, nodes, 200), 'b')
})

test('returns null beyond maxDistance — an anchor nobody is near is a guess', () => {
  assert.equal(nearestNodeAnchor({ x: 5000, y: 5000 }, nodes, 200), null)
})

test('maxDistance is honoured per call, because the spaces do not share units', () => {
  // dag coordinates and stack pixels are not comparable; each canvas passes
  // its own constant rather than sharing one.
  assert.equal(nearestNodeAnchor({ x: 150, y: 0 }, nodes, 40), null)
  assert.equal(nearestNodeAnchor({ x: 150, y: 0 }, nodes, 80), 'b')
})

test('ties break deterministically by id, so the same input never flickers', () => {
  const tied = [
    { id: 'zeta', x: 0, y: 0 },
    { id: 'alpha', x: 20, y: 0 },
  ]
  assert.equal(nearestNodeAnchor({ x: 10, y: 0 }, tied, 100), 'alpha')
})

test('an empty graph anchors to nothing', () => {
  assert.equal(nearestNodeAnchor({ x: 0, y: 0 }, [], 200), null)
})

test('projectAnchor finds the node in the viewer own space', () => {
  assert.deepEqual(projectAnchor('b', nodes), { x: 100, y: 0 })
})

test('a deleted or unknown node projects to nothing rather than the origin', () => {
  // Rendering at 0,0 would put a teammate's cursor in the corner and read as a
  // bug; drawing nothing is the honest answer.
  assert.equal(projectAnchor('gone', nodes), null)
  assert.equal(projectAnchor(null, nodes), null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/jam-presence.test.ts`
Expected: FAIL — `nearestNodeAnchor` is not exported.

- [ ] **Step 3: Implement**

In `src/lib/flows/jam-presence.ts`, add to `jamCursorSchema`:

```ts
  /** The node the sender's cursor is nearest, or null over empty canvas.
   *  Just the id: an offset in the sender's units is meaningless in the other
   *  space, and same-space viewers use `point` anyway — carrying one would be
   *  an unused field that looks load-bearing. */
  anchor: z.string().nullable().default(null),
```

`.default(null)` so a peer on an older client still parses instead of having
its cursor dropped entirely.

Then append:

```ts
export type AnchorNode = { id: string; x: number; y: number }

/**
 * The node a cursor is pointing at, or null when it is over empty canvas.
 *
 * Nodes are the only thing the dag and stack spaces share, so they are the
 * only honest basis for showing a cross-space cursor. `maxDistance` is passed
 * in rather than shared because dag coordinates and stack pixels are not
 * comparable units.
 */
export function nearestNodeAnchor(
  point: { x: number; y: number },
  nodes: AnchorNode[],
  maxDistance: number,
): string | null {
  let bestId: string | null = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (const node of nodes) {
    const dx = node.x - point.x
    const dy = node.y - point.y
    const distance = Math.hypot(dx, dy)
    // Ties break by id so the same cursor position never flickers between two
    // equidistant nodes frame to frame.
    if (distance < bestDistance || (distance === bestDistance && bestId !== null && node.id < bestId)) {
      bestDistance = distance
      bestId = node.id
    }
  }

  return bestId !== null && bestDistance <= maxDistance ? bestId : null
}

/** Where that node sits in the VIEWER's space, or null if it is gone. */
export function projectAnchor(
  anchor: string | null,
  nodes: AnchorNode[],
): { x: number; y: number } | null {
  if (!anchor) return null
  const node = nodes.find((candidate) => candidate.id === anchor)
  return node ? { x: node.x, y: node.y } : null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/flows/__tests__/jam-presence.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/lib/flows/jam-presence.ts src/lib/flows/__tests__/jam-presence.test.ts
git commit -m "feat(flows): anchor jam cursors to nodes so they can cross canvas spaces"
```

---

### Task 3: Send the anchor, render the projection

**Files:**
- Modify: `src/components/flows/use-flow-jam.ts` (attach anchor on send)
- Modify: `src/components/flows/dag-canvas.tsx:214-240`
- Modify: `src/app/(app)/flows/[id]/page.tsx:77-100`
- Test: `src/components/flows/__tests__/jam-cursor-projection.test.tsx`

**Interfaces:**
- Consumes: `nearestNodeAnchor`, `projectAnchor`, `AnchorNode` (Task 2).
- Produces: `updateCursor` accepts an `anchor` argument; both canvases render projected peers.

- [ ] **Step 1: Write the failing test**

Create `src/components/flows/__tests__/jam-cursor-projection.test.tsx`:

```tsx
import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup } from '@testing-library/react'
import { JamStackCursors } from '@/app/(app)/flows/[id]/page'

afterEach(cleanup)

const nodes = [{ id: 'n1', x: 40, y: 80 }]

const peer = (space: 'dag' | 'stack', anchor: string | null) => ({
  clientId: 'c1',
  userId: 'u1',
  name: 'Dana Reed',
  selectedNodeId: null,
  inHuddle: false,
  huddleMuted: false,
  cursor: {
    space,
    point: { x: 10, y: 10 },
    viewport: { x: 0, y: 0, zoom: 1 },
    anchor,
  },
})

test('a same-space cursor renders at its exact point, undimmed', () => {
  const { container } = render(
    <JamStackCursors peers={[peer('stack', 'n1')]} zoom={1} nodes={nodes} />,
  )
  const cursor = container.querySelector('[data-jam-cursor]') as HTMLElement
  assert.equal(cursor.dataset.projected, 'false')
  assert.equal(cursor.style.left, '10px')
})

test('a cross-space cursor renders at its anchored node, marked as projected', () => {
  // The visual distinction is the whole mitigation: an approximation must
  // never be mistaken for a pointer that is simply in the wrong place.
  const { container } = render(
    <JamStackCursors peers={[peer('dag', 'n1')]} zoom={1} nodes={nodes} />,
  )
  const cursor = container.querySelector('[data-jam-cursor]') as HTMLElement
  assert.equal(cursor.dataset.projected, 'true')
  assert.equal(cursor.style.left, '40px')
  assert.equal(cursor.style.top, '80px')
})

test('a cross-space cursor with no anchor is not drawn at all', () => {
  const { container } = render(
    <JamStackCursors peers={[peer('dag', null)]} zoom={1} nodes={nodes} />,
  )
  assert.equal(container.querySelector('[data-jam-cursor]'), null)
})

test('a cross-space cursor anchored to a deleted node is not drawn', () => {
  const { container } = render(
    <JamStackCursors peers={[peer('dag', 'gone')]} zoom={1} nodes={nodes} />,
  )
  assert.equal(container.querySelector('[data-jam-cursor]'), null)
})
```

Export `JamStackCursors` from the flows page so the test can mount it.

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/__tests__/jam-cursor-projection.test.tsx`
Expected: FAIL — `JamStackCursors` is not exported / does not accept `nodes`.

- [ ] **Step 3: Attach the anchor when sending**

In `use-flow-jam.ts`, `updateCursor` currently takes a `JamCursor`. Callers
already know their nodes, so compute the anchor at the call site and pass it
through unchanged — the hook simply forwards whatever cursor it is given, so
no hook change is needed beyond the schema already accepting `anchor`.

In `dag-canvas.tsx`, where the pointer handler builds the cursor, add:

```tsx
  anchor: nearestNodeAnchor(flowPoint, nodes.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })), DAG_ANCHOR_MAX),
```

with `const DAG_ANCHOR_MAX = 240` — React Flow coordinate units, roughly one
node-width of slack.

In the flows page's stack pointer handler, add:

```tsx
  anchor: nearestNodeAnchor(contentPoint, stackAnchorNodes, STACK_ANCHOR_MAX),
```

with `const STACK_ANCHOR_MAX = 160` — content pixels, roughly half a card.
`stackAnchorNodes` is the step cards' measured offsets, which the stack already
tracks to position selection outlines.

- [ ] **Step 4: Render projections in both canvases**

Replace the `live` filter in `dag-canvas.tsx:217` with a resolver that keeps
both same-space and projectable cross-space peers:

```tsx
  const anchorNodes = nodes.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y }))
  const live = peers.flatMap((peer) => {
    if (!peer.cursor) return []
    if (peer.cursor.space === 'dag') return [{ peer, at: peer.cursor.point, projected: false }]
    // Cross-space: only a node anchor is meaningful, and only if it still exists.
    const at = projectAnchor(peer.cursor.anchor, anchorNodes)
    return at ? [{ peer, at, projected: true }] : []
  })
```

and on the rendered element add `data-jam-cursor data-projected={String(projected)}`
plus, when projected, `opacity-60` and a dashed ring
(`className="… outline outline-2 outline-dashed outline-current/50"`).

Apply the same resolver shape in `JamStackCursors`, swapping `'dag'` for
`'stack'`, and give it a `nodes: AnchorNode[]` prop.

- [ ] **Step 5: Run tests, typecheck, lint**

```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/__tests__/jam-cursor-projection.test.tsx
npm run typecheck && npm run lint
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/flows src/app/\(app\)/flows
git commit -m "feat(flows): project jam cursors across canvas spaces, visibly approximate"
```

---

### Task 4: The rotating connection state

**Files:**
- Modify: `src/lib/flows/jam-connection.ts`
- Modify: `src/components/flows/jam-button.tsx:44`
- Test: `src/components/flows/__tests__/use-flow-jam.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `JamConnectionState` gains `'rotating'`; `JamConnectionEvent` gains `'access-rotating'`.

- [ ] **Step 1: Write the failing test**

Append to `src/components/flows/__tests__/use-flow-jam.test.ts`:

```ts
test('rotating is a visible state, not a silent gap', () => {
  // Between the access change and the reconnect the canvas is identical to
  // "nobody is here". That ambiguity is the reported confusion.
  assert.equal(reduceJamConnection('connected', 'access-rotating'), 'rotating')
})

test('rotating resolves on the next successful snapshot rather than latching', () => {
  assert.equal(reduceJamConnection('rotating', 'snapshot-ok'), 'connected')
  assert.equal(reduceJamConnection('rotating', 'channel-subscribed'), 'connected')
})

test('a denial during rotation still wins', () => {
  // Being removed mid-rotation must show denied, never a hopeful "reconnecting".
  assert.equal(reduceJamConnection('rotating', 'access-denied'), 'denied')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/__tests__/use-flow-jam.test.ts`
Expected: FAIL — `reduceJamConnection` returns `'connected'` for an unknown event.

- [ ] **Step 3: Implement**

In `src/lib/flows/jam-connection.ts`, add `'rotating'` to `JamConnectionState`
and `'access-rotating'` to `JamConnectionEvent`, then handle it in
`reduceJamConnection` **after** the terminal `access-denied` / `not-configured`
checks so a denial still wins:

```ts
  if (event === 'access-rotating') return 'rotating'
  if (state === 'rotating') {
    // Only proof of a working channel or a fresh snapshot clears it.
    if (event === 'snapshot-ok' || event === 'channel-subscribed') return 'connected'
    return 'rotating'
  }
```

In `use-flow-jam.ts`, dispatch it at the top of the access-changed handler
(line 550) and inside `makeBroadcastAccessChange`'s caller before the refresh.

In `jam-button.tsx:44`, add the label:

```ts
  rotating: 'Access changed — reconnecting…',
```

- [ ] **Step 4: Run tests and typecheck**

```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/__tests__/use-flow-jam.test.ts
npm run typecheck
```
Expected: PASS. Typecheck flags any exhaustive switch over `JamConnectionState`
that now misses `rotating` — add the case rather than a default.

- [ ] **Step 5: Commit**

```bash
git add src/lib/flows/jam-connection.ts src/components/flows
git commit -m "feat(flows): show the jam rotation instead of an empty canvas"
```

---

### Task 5: Invited versus present

**Files:**
- Modify: `src/app/api/flows/[id]/jam/route.ts` (return `accessRevision`)
- Modify: `src/components/flows/jam-button.tsx`
- Test: `src/components/flows/__tests__/jam-button.test.tsx`

**Interfaces:**
- Consumes: the existing `GET /api/flows/[id]/jam` `userIds` list and `peers`.
- Produces: the POST response gains `accessRevision: number`.

- [ ] **Step 1: Write the failing test**

Append to `src/components/flows/__tests__/jam-button.test.tsx`:

```tsx
test('the roster separates who is here from who was only invited', () => {
  // An owner who invites three people and sees zero peers cannot tell "not
  // opened yet" from "broken". That ambiguity IS the reported bug.
  render(
    <JamButton
      {...baseProps}
      peers={[{ ...peerFixture, userId: 'u-sam', name: 'Sam Diaz' }]}
      invitedUserIds={['u-sam', 'u-dana', 'u-alex']}
      memberNames={{ 'u-sam': 'Sam Diaz', 'u-dana': 'Dana Reed', 'u-alex': 'Alex Chen' }}
    />,
  )
  assert.ok(screen.getByText(/3 invited/))
  assert.ok(screen.getByText(/1 here/))
  assert.ok(screen.getByText('Dana Reed'))
  assert.ok(screen.getByText(/invited, not joined/i))
})

test('someone present but never explicitly invited still counts as here', () => {
  // Org-shared flows grant read access without a FlowCollaborator row.
  render(
    <JamButton
      {...baseProps}
      peers={[{ ...peerFixture, userId: 'u-guest', name: 'Guest' }]}
      invitedUserIds={[]}
      memberNames={{}}
    />,
  )
  assert.ok(screen.getByText(/1 here/))
})
```

Reuse the file's existing `baseProps` / peer fixture; extend them with the two
new props.

- [ ] **Step 2: Run test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/__tests__/jam-button.test.tsx`
Expected: FAIL — `invitedUserIds` is not a prop.

- [ ] **Step 3: Return the revision from the route**

In `src/app/api/flows/[id]/jam/route.ts`, the transaction's third operation
already increments the revision. Replace `prisma.flow.updateMany` with a read
after the transaction and include it in the response:

```ts
  const updated = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId },
    select: { collaborationAccessRevision: true },
  })

  return {
    success: true,
    invited: addedIds.length,
    collaborators: requestedIds.length,
    userIds: requestedIds,
    // Lets the inviter resnapshot onto the rotated topic immediately instead
    // of waiting for its next poll.
    accessRevision: updated?.collaborationAccessRevision ?? null,
  }
```

- [ ] **Step 4: Render the split**

In `jam-button.tsx`, add props
`invitedUserIds?: string[]` and `memberNames?: Record<string, string>`, then
render above the peer list:

```tsx
  const presentUserIds = new Set(peers.map((peer) => peer.userId))
  const notJoined = (invitedUserIds ?? []).filter((id) => !presentUserIds.has(id))
```

```tsx
  <p className="text-xs text-muted-foreground">
    Jam · {invitedUserIds?.length ?? 0} invited · {presentUserIds.size} here
  </p>
  {notJoined.map((id) => (
    <div key={id} className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{memberNames?.[id] ?? 'Teammate'}</span>
      <span>invited, not joined</span>
    </div>
  ))}
```

The flows page already fetches org members for the invite picker; pass that map
and the `userIds` from `GET /jam` down as the two new props.

- [ ] **Step 5: Run tests, typecheck, full suite**

```bash
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/components/flows/__tests__/jam-button.test.tsx
npm run typecheck && npm run lint && npm test
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/flows src/components/flows
git commit -m "feat(flows): show who was invited but has not joined the jam"
```

---

### Task 6: Manual verification (the only proof that matters)

**Files:** none.

Nothing in Tasks 1–5 proves the reported symptom is fixed. Realtime presence
needs live Supabase and two authenticated browsers, and this environment has
neither.

- [ ] **Step 1: Deploy the branch to an environment with Supabase configured**

Confirm `ENCRYPTION_KEY` or `SUPABASE_SERVICE_ROLE_KEY` is set — without one,
`channelTopic` 503s in production and the jam is dead for an unrelated reason.

- [ ] **Step 2: Two browsers, two users, one flow**

1. User A (the flow owner) opens the flow. The jam bar should read `1 here`.
2. User A invites User B. The bar should briefly show
   "Access changed — reconnecting…", then `2 invited · 1 here`.
3. User B opens the flow. Both should now read `2 here`.
4. Both move the mouse. **Each should see the other's cursor within a second.**

- [ ] **Step 3: Cross-canvas check**

Have User B switch to the DAG canvas while A stays on the stack. Each should
still see the other's cursor, drawn at a node, dimmed with a dashed ring.

- [ ] **Step 4: Revocation check**

User A removes User B. User B should be ejected within a second or two rather
than lingering with live presence.

- [ ] **Step 5: If cursors still do not appear**

The rotation race was not the cause. Add temporary instrumentation to
`use-flow-jam.ts` logging `topic`, `accessRevision`, `SUBSCRIBED`, `CLOSED`,
presence sync and peer count, deploy, and repeat step 2 reading both consoles.
The `invited vs here` split already narrows it: `2 here` with no cursors is a
render problem, `1 here` is a presence problem, and they need different fixes.

---

## Self-Review

**Spec coverage.** §1 rotation → Task 1 (the corrected await-then-refresh fix)
and Task 4 (the `rotating` state); the immediate-resnapshot half → Task 5 Step 3
returning `accessRevision`. §2 cross-space cursors → Tasks 2 (pure anchor math)
and 3 (send + render, with the projected treatment). §3 invite hardening → Task
5; revocation-gets-fast falls out of Task 1 and is checked in Task 6 Step 4.
§4 tests → distributed. §5 what cannot be verified → Task 6, which is the whole
point of that section.

**Type consistency.** `AnchorNode`, `nearestNodeAnchor`, `projectAnchor` are
defined in Task 2 and consumed in Task 3. `makeBroadcastAccessChange` and
`AccessNoticeDeps` are defined in Task 1 and used only there. `JamConnectionState`
gains `'rotating'` in Task 4, consumed by `jam-button`'s label map in the same
task. `invitedUserIds` / `memberNames` are introduced in Task 5 only.

**Two hazards worth flagging.** Task 3 assumes the stack canvas already tracks
step-card offsets for selection outlines; if it does not, that measurement has
to be added there and the task grows. And Task 1 changes `broadcastAccessChange`
to async — `jam-button` must `await` it, or the toast races the notice again in
a new place.
