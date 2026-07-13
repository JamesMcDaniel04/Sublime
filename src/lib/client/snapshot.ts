'use client'

import type { Activity, Agent } from '@/lib/types'

/**
 * Client accessor for GET /api/snapshot — the ONE poll the app shell makes.
 *
 * The dashboard (10s), sidebar (30s), and notification bell (15s) all call
 * getSnapshot() on their own cadences; a freshness window (default 8s) +
 * in-flight dedupe collapse those into ~one network request per cycle for the
 * whole shell instead of six. The in-memory snapshot gives an instant paint
 * when returning Home during the signed-in browser session.
 */

export type Snapshot = {
  success: boolean
  agents: Agent[]
  activities: Activity[]
  usage: { since: string; executions: number; inputTokens: number; outputTokens: number }
  activeOrganizationId: string | null
  organizations: Array<{ id: string; name: string; slug: string; plan: string; logoUrl?: string | null }>
  notifications: Array<Record<string, unknown>>
  unread: number
}

export class SnapshotError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) {
    super(message)
    this.name = 'SnapshotError'
  }
}

const DEFAULT_FRESH_MS = 8_000

let cached: { data: Snapshot; ts: number } | null = null
let inflight: Promise<Snapshot> | null = null
let cacheScope: string | null = null

async function fetchSnapshot(): Promise<Snapshot> {
  const requestScope = cacheScope
  const res = await fetch('/api/snapshot', { cache: 'no-store' })
  const body = (await res.json().catch(() => ({}))) as Partial<Snapshot> & { error?: string; code?: string }
  if (!res.ok) throw new SnapshotError(body.error || `Snapshot failed (${res.status})`, body.code, res.status)
  const entry = { data: body as Snapshot, ts: Date.now() }
  if (cacheScope === requestScope) cached = entry
  return entry.data
}

/**
 * Return the snapshot, hitting the network only when the cached copy is older
 * than `maxAgeMs` (0 forces a fetch, e.g. after a mutation). Concurrent
 * callers share one request.
 */
export async function getSnapshot(maxAgeMs: number = DEFAULT_FRESH_MS): Promise<Snapshot> {
  if (cached && Date.now() - cached.ts < maxAgeMs) return cached.data
  inflight ??= fetchSnapshot().finally(() => { inflight = null })
  return inflight
}

/** Last-seen in-memory snapshot, for instant navigation back to Home. */
export function peekSnapshot(): Snapshot | null {
  return cached?.data ?? null
}

/** Clear tenant-specific shell data when the authenticated user changes. */
export function scopeSnapshot(userId: string | null): void {
  if (cacheScope === userId) return
  cacheScope = userId
  cached = null
  inflight = null
}
