'use client'

/**
 * useRouter that keeps the caller's goal lens on push/replace.
 *
 * Everything else on the router (back, forward, refresh, prefetch) is passed
 * through untouched, so this is a drop-in swap at the `const router = ...`
 * line rather than an edit at every call site.
 *
 * Paired with ScopedLink: between them, converting a file to be lens-aware is
 * two one-line import changes instead of touching every navigation in it.
 */

import { useRouter } from 'next/navigation'
import { useMemo } from 'react'
import { useScopedHref } from './scoped-href'

export function useScopedRouter() {
  const router = useRouter()
  const scoped = useScopedHref()
  return useMemo(
    () => ({
      ...router,
      push: (href: string, options?: Parameters<typeof router.push>[1]) => router.push(scoped(href), options),
      replace: (href: string, options?: Parameters<typeof router.replace>[1]) => router.replace(scoped(href), options),
      prefetch: (href: string, options?: Parameters<typeof router.prefetch>[1]) => router.prefetch(scoped(href), options),
    }),
    [router, scoped],
  )
}
