/**
 * Flow Jam presence math + wire types (Spec 2) — all pure.
 *
 * Cursors travel in CANVAS coordinates, not window fractions: a peer pointing
 * at a node must render at that node for every viewer, regardless of each
 * viewer's pan/zoom/window. Payloads are tagged with the canvas `space` they
 * were captured in — dag (React Flow) and stack coordinates are unrelated, so
 * a cursor only renders for viewers in the same space (selection outlines are
 * node-anchored and work across spaces).
 */
import { z } from 'zod'

export type JamCanvasSpace = 'dag' | 'stack'

/** React Flow convention: screen = flow * zoom + offset (container-relative). */
export const jamViewportSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  zoom: z.number().finite().positive(),
  /** Stack canvas only: the scroll container's scrollTop (follow mode restores it). */
  scrollTop: z.number().finite().optional(),
})
export type JamViewport = z.infer<typeof jamViewportSchema>

export const jamCursorSchema = z.object({
  space: z.enum(['dag', 'stack']),
  /** Canvas-space point: flow coordinates (dag) or content coordinates (stack). */
  point: z.object({ x: z.number().finite(), y: z.number().finite() }),
  /** The sender's viewport — what follow mode adopts. */
  viewport: jamViewportSchema,
})
export type JamCursor = z.infer<typeof jamCursorSchema>

/** Container-relative client point → flow point, inverting the RF transform. */
export function clientToFlowPoint(
  client: { x: number; y: number },
  origin: { x: number; y: number },
  viewport: JamViewport,
): { x: number; y: number } {
  return {
    x: (client.x - origin.x - viewport.x) / viewport.zoom,
    y: (client.y - origin.y - viewport.y) / viewport.zoom,
  }
}

/** Flow point → container-relative screen point under MY viewport. */
export function flowToScreenPoint(
  point: { x: number; y: number },
  viewport: JamViewport,
): { x: number; y: number } {
  return { x: point.x * viewport.zoom + viewport.x, y: point.y * viewport.zoom + viewport.y }
}

/**
 * Stack-canvas capture: the transformed wrapper's measured rect already
 * reflects pan/zoom/scroll, so content coordinates are just the offset from
 * its origin with the zoom divided back out.
 */
export function contentPointFromClient(
  client: { x: number; y: number },
  rect: { left: number; top: number },
  zoom: number,
): { x: number; y: number } {
  return { x: (client.x - rect.left) / zoom, y: (client.y - rect.top) / zoom }
}

/**
 * Off-screen peer affordance: where on the container's edge to pin the
 * indicator, and the direction (degrees, 0 = right, 90 = down) toward the
 * peer's actual position. Null while the point is on screen.
 */
export function edgeIndicator(
  point: { x: number; y: number },
  bounds: { width: number; height: number },
  margin: number,
): { x: number; y: number; angle: number } | null {
  const x = Math.min(Math.max(point.x, margin), bounds.width - margin)
  const y = Math.min(Math.max(point.y, margin), bounds.height - margin)
  if (x === point.x && y === point.y) return null
  const angle = (Math.atan2(point.y - y, point.x - x) * 180) / Math.PI
  return { x, y, angle }
}

/** Stable per-teammate cursor/outline color, hashed from the user id. */
export function jamCursorColor(userId: string): string {
  let hash = 0
  for (let index = 0; index < userId.length; index++) hash = (hash * 31 + userId.charCodeAt(index)) | 0
  return `hsl(${Math.abs(hash) % 360} 72% 46%)`
}

/**
 * A cursor broadcast, carrying enough identity to UPSERT its sender into the
 * roster. Root cause R3 of the jam-stability incident: presence `track()` was
 * fired once with no retry, and the cursor handler could only UPDATE peers the
 * presence sync had already delivered — one lost track() made a teammate
 * permanently invisible. Cursor events now self-heal the roster.
 */
export type JamPeerLike = {
  clientId: string
  userId: string
  name: string
  selectedNodeId: string | null
  cursor: JamCursor | null
  inHuddle: boolean
  huddleMuted: boolean
}

export function applyCursorEvent<T extends JamPeerLike>(
  peers: T[],
  payload: {
    clientId?: unknown
    userId?: unknown
    name?: unknown
    cursor?: unknown
    selectedNodeId?: unknown
  },
  selfClientId: string,
): T[] {
  const clientId = typeof payload.clientId === 'string' ? payload.clientId : null
  if (!clientId || clientId === selfClientId) return peers
  const parsedCursor = jamCursorSchema.safeParse(payload.cursor)
  const cursor = parsedCursor.success ? parsedCursor.data : null
  const selectedNodeId = typeof payload.selectedNodeId === 'string' ? payload.selectedNodeId : null

  const known = peers.find((peer) => peer.clientId === clientId)
  if (known) {
    return peers.map((peer) =>
      peer.clientId === clientId ? { ...peer, cursor, selectedNodeId: selectedNodeId ?? peer.selectedNodeId } : peer,
    )
  }
  // Upsert requires identity — without it we'd mint ghost "Teammate" entries.
  if (typeof payload.userId !== 'string' || !payload.userId || typeof payload.name !== 'string' || !payload.name) {
    return peers
  }
  const upserted: JamPeerLike = {
    clientId,
    userId: payload.userId,
    name: payload.name,
    selectedNodeId,
    cursor,
    inHuddle: false,
    huddleMuted: false,
  }
  return [...peers, upserted as T]
}

/** Presence roster changes between two syncs, keyed by clientId. */
export function diffPeers<T extends { clientId: string }>(
  previous: T[],
  next: T[],
): { joined: T[]; left: T[] } {
  const before = new Set(previous.map((peer) => peer.clientId))
  const after = new Set(next.map((peer) => peer.clientId))
  return {
    joined: next.filter((peer) => !before.has(peer.clientId)),
    left: previous.filter((peer) => !after.has(peer.clientId)),
  }
}
