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
 */

type Entry = { data: unknown; ts: number }
const mem = new Map<string, Entry>()
const inflight = new Map<string, Promise<unknown>>()
let cacheScope: string | null = null

function write(url: string, data: unknown): void {
  const entry: Entry = { data, ts: Date.now() }
  mem.set(url, entry)
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

/** Isolate authenticated cache entries when the active browser user changes. */
export function scopeCachedJson(userId: string | null): void {
  if (cacheScope === userId) return
  cacheScope = userId
  mem.clear()
  inflight.clear()
}

export function useCachedJson<T = unknown>(url: string | null) {
  // Lazy init reads only the in-memory cache (empty on the server → SSR-safe).
  const [data, setData] = useState<T | undefined>(() => (url ? (mem.get(url)?.data as T | undefined) : undefined))
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(() => (url ? !mem.has(url) : false))

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
}
