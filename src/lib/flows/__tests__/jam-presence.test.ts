import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clientToFlowPoint,
  flowToScreenPoint,
  contentPointFromClient,
  edgeIndicator,
  diffPeers,
  jamCursorSchema,
} from '../jam-presence'

test('client → flow round-trips through the React Flow viewport transform', () => {
  const viewport = { x: -120, y: 60, zoom: 1.5 }
  const origin = { x: 300, y: 100 }
  const flow = clientToFlowPoint({ x: 480, y: 400 }, origin, viewport)
  // screen = flow * zoom + viewport offset (relative to container origin)
  assert.deepEqual(flow, { x: (480 - 300 - -120) / 1.5, y: (400 - 100 - 60) / 1.5 })

  const screen = flowToScreenPoint(flow, viewport)
  assert.deepEqual(screen, { x: 480 - 300, y: 400 - 100 })
})

test('stack content point divides out the zoom from the measured rect', () => {
  const point = contentPointFromClient({ x: 500, y: 260 }, { left: 100, top: 60 }, 2)
  assert.deepEqual(point, { x: 200, y: 100 })
})

test('edgeIndicator is null when the point is inside the bounds', () => {
  assert.equal(edgeIndicator({ x: 400, y: 300 }, { width: 800, height: 600 }, 24), null)
})

test('edgeIndicator clamps to the margin and points toward the peer', () => {
  const bounds = { width: 800, height: 600 }
  const right = edgeIndicator({ x: 1000, y: 300 }, bounds, 24)
  assert.deepEqual(right, { x: 800 - 24, y: 300, angle: 0 })

  const below = edgeIndicator({ x: 400, y: 900 }, bounds, 24)
  assert.deepEqual(below, { x: 400, y: 600 - 24, angle: 90 })

  const topLeft = edgeIndicator({ x: -100, y: -100 }, bounds, 24)
  assert.equal(topLeft?.x, 24)
  assert.equal(topLeft?.y, 24)
  assert.equal(topLeft?.angle, -135)
})

test('diffPeers reports joins and leaves by clientId', () => {
  const alice = { clientId: 'a', userId: 'u1', name: 'Alice', selectedNodeId: null, cursor: null }
  const bob = { clientId: 'b', userId: 'u2', name: 'Bob', selectedNodeId: null, cursor: null }
  const { joined, left } = diffPeers([alice], [alice, bob])
  assert.deepEqual(joined.map((p) => p.name), ['Bob'])
  assert.deepEqual(left, [])

  const gone = diffPeers([alice, bob], [bob])
  assert.deepEqual(gone.left.map((p) => p.name), ['Alice'])
  assert.deepEqual(gone.joined, [])
})

test('cursor schema accepts v2 payloads and rejects the old window-fraction shape', () => {
  const valid = jamCursorSchema.safeParse({
    space: 'dag',
    point: { x: 120.5, y: -40 },
    viewport: { x: -120, y: 60, zoom: 1.5 },
  })
  assert.equal(valid.success, true)

  const stack = jamCursorSchema.safeParse({
    space: 'stack',
    point: { x: 10, y: 20 },
    viewport: { x: 0, y: 0, zoom: 1, scrollTop: 340 },
  })
  assert.equal(stack.success, true)

  // Old clients broadcast {x, y} fractions — must not parse as a v2 cursor.
  assert.equal(jamCursorSchema.safeParse({ x: 0.4, y: 0.7 }).success, false)
  // Absurd zoom values are rejected rather than dividing by zero downstream.
  assert.equal(
    jamCursorSchema.safeParse({ space: 'dag', point: { x: 0, y: 0 }, viewport: { x: 0, y: 0, zoom: 0 } }).success,
    false,
  )
})
