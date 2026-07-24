'use client'

import type { Activity, Agent } from '@/lib/types'
import { scopeCachedJson, seedCachedJson } from '@/lib/client/use-cached-json'

/**
 * Client accessor for GET /api/snapshot — the ONE poll the app shell makes.
 *
 * Agent HQ/sidebar (30s) and the notification bell (15s) all call
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
// Monotonic ordering of network reads: a response may resolve AFTER a newer
// request's response has already been applied (e.g. a slow poll racing the
// forced refetch that follows a delete). Applying it would repaint deleted
// state — the "zombie agent" bug — so seeding is gated on the sequence.
let fetchSeq = 0
let appliedSeq = 0
let cacheScope: string | null = null
let bootstrapped = false
const listeners = new Set<(snapshot: Snapshot) => void>()
const STORAGE_KEY = 'shell-snapshot:v1'
const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000

type BootstrapResponse = {
  success: boolean
  userId: string
  snapshot: Snapshot
  connectionStatus: { connections?: Record<string, unknown> }
  profile: { profile?: Record<string, unknown> }
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

function persistSnapshot(): void {
  if (!cacheScope || !cached) return
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify({ scope: cacheScope, ...cached }))
  } catch {
    // Storage is an optional paint optimization; the API remains authoritative.
  }
}

function hydrateSnapshot(): void {
  try {
    const raw = storage()?.getItem(STORAGE_KEY)
    if (!raw) return
    const entry = JSON.parse(raw) as { scope?: string; data?: Snapshot; ts?: number }
    if (entry.scope !== cacheScope || !entry.data || !entry.ts || Date.now() - entry.ts > PERSIST_MAX_AGE_MS) {
      storage()?.removeItem(STORAGE_KEY)
      return
    }
    cached = { data: entry.data, ts: entry.ts }
    for (const listener of listeners) listener(entry.data)
  } catch {
    try { storage()?.removeItem(STORAGE_KEY) } catch { /* unavailable */ }
  }
}

function seedSnapshot(data: Snapshot, seq?: number): Snapshot {
  // External seeds (login prime, hydration) count as the newest read; network
  // reads pass their own sequence and are dropped if something newer already
  // painted — never let a slow response overwrite fresher state.
  const effectiveSeq = seq ?? ++fetchSeq
  if (effectiveSeq < appliedSeq) return data
  appliedSeq = effectiveSeq
  cached = { data, ts: Date.now() }
  persistSnapshot()
  for (const listener of listeners) listener(data)
  return data
}

async function fetchBootstrap(): Promise<Snapshot> {
  const requestScope = cacheScope
  const seq = ++fetchSeq
  const res = await fetch('/api/bootstrap', { cache: 'no-store' })
  const body = (await res.json().catch(() => ({}))) as Partial<BootstrapResponse> & { error?: string; code?: string }
  if (!res.ok || !body.snapshot) throw new SnapshotError(body.error || `Bootstrap failed (${res.status})`, body.code, res.status)
  if (!requestScope || body.userId !== requestScope || cacheScope !== requestScope) {
    throw new SnapshotError('Bootstrap session changed while loading.', 'AUTH_SCOPE_CHANGED', 409)
  }

  bootstrapped = true
  seedCachedJson('/api/agents', { success: true, agents: body.snapshot.agents })
  if (body.connectionStatus) seedCachedJson('/api/nango/status', body.connectionStatus, { persist: true })
  if (body.profile) seedCachedJson('/api/settings/profile', body.profile)
  return seedSnapshot(body.snapshot, seq)
}

async function fetchSnapshot(): Promise<Snapshot> {
  if (!bootstrapped && cacheScope) return fetchBootstrap()
  const requestScope = cacheScope
  const seq = ++fetchSeq
  const res = await fetch('/api/snapshot', { cache: 'no-store' })
  const body = (await res.json().catch(() => ({}))) as Partial<Snapshot> & { error?: string; code?: string }
  if (!res.ok) throw new SnapshotError(body.error || `Snapshot failed (${res.status})`, body.code, res.status)
  if (cacheScope === requestScope) return seedSnapshot(body as Snapshot, seq)
  return body as Snapshot
}

/**
 * Return the snapshot, hitting the network only when the cached copy is older
 * than `maxAgeMs` (0 forces a fetch, e.g. after a mutation). Concurrent
 * callers share one request.
 */
export async function getSnapshot(maxAgeMs: number = DEFAULT_FRESH_MS): Promise<Snapshot> {
  if (cached && Date.now() - cached.ts < maxAgeMs) return cached.data
  if (maxAgeMs <= 0) {
    // Forced read (right after a mutation): an in-flight request may have hit
    // the server BEFORE the write committed, so reusing it returns
    // pre-mutation state — the sidebar's delete looked dead exactly this way.
    // Start a fresh request and make it the shared in-flight so concurrent
    // pollers converge on the newest data.
    const fresh = fetchSnapshot().finally(() => { if (inflight === fresh) inflight = null })
    inflight = fresh
    return fresh
  }
  if (!inflight) {
    const request: Promise<Snapshot> = fetchSnapshot().finally(() => { if (inflight === request) inflight = null })
    inflight = request
  }
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
  bootstrapped = false
  if (userId) hydrateSnapshot()
  else {
    try { storage()?.removeItem(STORAGE_KEY) } catch { /* unavailable */ }
  }
}

/** Repaint consumers when a scoped persisted snapshot hydrates after mount. */
export function subscribeSnapshot(listener: (snapshot: Snapshot) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Prime and persist the first authenticated model before a hard login redirect. */
export async function primeBootstrap(userId: string): Promise<Snapshot> {
  scopeCachedJson(userId)
  scopeSnapshot(userId)
  return fetchBootstrap()
}

/** Test seam: emulate a hard navigation while leaving sessionStorage intact. */
export function __testResetSnapshotForReload(): void {
  cached = null
  inflight = null
  cacheScope = null
  bootstrapped = false
  fetchSeq = 0
  appliedSeq = 0
  listeners.clear()
}
