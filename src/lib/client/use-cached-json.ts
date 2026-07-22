'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * Stale-while-revalidate JSON fetch with a client cache that survives client
 * navigations within the current signed-in tab.
 *
 * The app fetches with raw `fetch` + `useState`, so every component starts empty
 * and refetches on mount — and because each page renders its own layout,
 * navigating remounts everything, showing a loading state until the refetch
 * lands. This hook caches responses by URL in memory for instant paint on
 * client-side navigation, revalidates in the background, and makes concurrent
 * callers for the same URL share one request.
 *
 * Authenticated workspace responses deliberately are not persisted to
 * localStorage, preventing one signed-in user from seeing another user's
 * last-seen data on a shared browser. Endpoints stay `no-store` on the wire.
 *
 * Exception — opt-in `persist: true` URLs: those entries also mirror into
 * sessionStorage tagged with the signed-in scope. This survives a full-page
 * navigation within the SAME tab (the OAuth redirect that otherwise repaints
 * the integrations page as all-disconnected) while keeping the shared-browser
 * posture: entries hydrate only when the settling sign-in scope matches the
 * tag, and the blob is purged on sign-out or when a different user signs in.
 */

type Entry = { data: unknown; ts: number }
const mem = new Map<string, Entry>()
const inflight = new Map<string, Promise<unknown>>()
let cacheScope: string | null = null

// ── Opt-in scoped sessionStorage persistence ────────────────────────────────

const STORAGE_KEY = 'cached-json:v1'
const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000
const persistentUrls = new Set<string>()
const hydrationListeners = new Set<() => void>()

type PersistedBlob = { scope: string; entries: Record<string, Entry> }

/** SSR-safe storage access; null when unavailable (server, sandboxed tab). */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

function readPersisted(): PersistedBlob | null {
  try {
    const raw = storage()?.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedBlob
    return parsed && typeof parsed.scope === 'string' && parsed.entries && typeof parsed.entries === 'object' ? parsed : null
  } catch {
    return null
  }
}

function purgePersisted(): void {
  try {
    storage()?.removeItem(STORAGE_KEY)
  } catch {
    /* storage unavailable — nothing persisted */
  }
}

function writePersisted(): void {
  if (!cacheScope) return
  const entries: Record<string, Entry> = {}
  for (const url of persistentUrls) {
    const entry = mem.get(url)
    if (entry) entries[url] = entry
  }
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify({ scope: cacheScope, entries }))
  } catch {
    /* quota/unavailable — persistence is best-effort */
  }
}

/** Load scope-matching persisted entries into memory; purge foreign ones. */
function hydratePersisted(): void {
  const blob = readPersisted()
  if (!blob) return
  if (blob.scope !== cacheScope) {
    purgePersisted()
    return
  }
  let hydrated = false
  for (const [url, entry] of Object.entries(blob.entries)) {
    if (Date.now() - entry.ts > PERSIST_MAX_AGE_MS) continue
    if (!mem.has(url)) {
      mem.set(url, entry)
      hydrated = true
    }
  }
  if (hydrated) for (const listener of hydrationListeners) listener()
}

function write(url: string, data: unknown): void {
  const entry: Entry = { data, ts: Date.now() }
  mem.set(url, entry)
  if (persistentUrls.has(url)) writePersisted()
}

export class CachedJsonError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'CachedJsonError'
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-store' })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new CachedJsonError((body as { error?: string })?.error || `Request failed (${res.status})`, res.status)
  return body
}

/** Reuse a recent response for imperative page loaders and coalesce callers. */
export async function getCachedJson<T = unknown>(url: string, maxAgeMs = 60_000): Promise<T> {
  const cached = mem.get(url)
  if (cached && Date.now() - cached.ts <= maxAgeMs) return cached.data as T
  // Same mid-flight scope-change handling as useCachedJson.refresh: a
  // response that raced a sign-in transition is dropped and refetched so
  // callers never receive (or cache) another scope's data.
  for (;;) {
    const requestScope = cacheScope
    let pending = inflight.get(url)
    if (!pending) {
      pending = fetchJson(url)
      inflight.set(url, pending)
    }
    let result: unknown
    try {
      result = await pending
    } finally {
      if (inflight.get(url) === pending) inflight.delete(url)
    }
    if (cacheScope === requestScope) {
      write(url, result)
      return result as T
    }
  }
}

/** Warm common navigation data after sign-in without blocking the current UI. */
export function prefetchCachedJson(urls: string[]): void {
  for (const url of urls) void getCachedJson(url).catch(() => undefined)
}

/** Seed a URL from the authenticated bootstrap response without another HTTP
 * request. Persistence remains opt-in and is always tagged with cacheScope. */
export function seedCachedJson<T>(url: string, data: T, options?: { persist?: boolean }): void {
  if (options?.persist) persistentUrls.add(url)
  write(url, data)
}

/** Isolate authenticated cache entries when the active browser user changes. */
export function scopeCachedJson(userId: string | null): void {
  if (cacheScope === userId) return
  cacheScope = userId
  mem.clear()
  inflight.clear()
  // Sign-out purges the persisted snapshot; a settling sign-in hydrates it
  // when (and only when) the stored scope matches the user signing in.
  if (userId === null) purgePersisted()
  else hydratePersisted()
}

/**
 * Test seam: simulate a hard page load — module memory resets while
 * sessionStorage survives. Never used in production code paths.
 */
export function __testResetForReload(): void {
  cacheScope = null
  mem.clear()
  inflight.clear()
  persistentUrls.clear()
  hydrationListeners.clear()
}

export function useCachedJson<T = unknown>(url: string | null, options?: { persist?: boolean }) {
  const persist = options?.persist === true
  if (url && persist) persistentUrls.add(url)
  // Lazy init reads only the in-memory cache (empty on the server → SSR-safe).
  const [data, setData] = useState<T | undefined>(() => (url ? (mem.get(url)?.data as T | undefined) : undefined))
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(() => (url ? !mem.has(url) : false))

  // Hard page load ordering: this hook mounts before the sidebar settles the
  // sign-in scope. When hydration then loads persisted entries, repaint from
  // the snapshot instead of waiting for the in-flight revalidation.
  useEffect(() => {
    if (!url || !persist) return
    const onHydrated = () => {
      const entry = mem.get(url)
      if (entry) {
        setData(entry.data as T)
        setLoading(false)
      }
    }
    hydrationListeners.add(onHydrated)
    return () => {
      hydrationListeners.delete(onHydrated)
    }
  }, [url, persist])

  const refresh = useCallback(async (): Promise<T | undefined> => {
    if (!url) return undefined
    // The scope guard prevents painting a response fetched under a previous
    // signed-in user. But sign-in *settling* during a hard page load changes
    // the scope while the very first fetch is in flight — in that case the
    // right move is to refetch under the new scope, not to strand the hook
    // with `loading: false` and no data (which paints empty states).
    try {
      for (;;) {
        const requestScope = cacheScope
        let pending = inflight.get(url)
        if (!pending) {
          pending = fetchJson(url)
          inflight.set(url, pending)
        }
        let result: unknown
        try {
          result = await pending
        } finally {
          if (inflight.get(url) === pending) inflight.delete(url)
        }
        if (cacheScope === requestScope) {
          write(url, result)
          setData(result as T)
          setError(null)
          return result as T
        }
      }
    } catch (caught) {
      setError(caught)
      return undefined
    } finally {
      setLoading(false)
    }
  }, [url])

  useEffect(() => {
    if (!url) return
    void refresh()
  }, [url, refresh])

  // Optimistically overwrite the cached value (e.g. after a local mutation).
  const mutate = useCallback(
    (next: T) => {
      if (url) write(url, next)
      setData(next)
    },
    [url],
  )

  return { data, loading, error, refresh, mutate }
}

/** Drop a URL's cached entry so the next mount/refresh refetches from the server. */
export function invalidateCachedJson(url: string): void {
  mem.delete(url)
  if (persistentUrls.has(url)) writePersisted()
}
