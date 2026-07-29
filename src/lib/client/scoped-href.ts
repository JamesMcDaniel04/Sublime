'use client'

/**
 * The only sanctioned way to build an in-app URL.
 *
 * Every app surface lives under /g/[scope], so a raw <Link href="/flows"> would
 * silently drop the user's lens back to All goals. Routing every href through
 * here makes "forgot the scope" a greppable pattern rather than a bug someone
 * notices three screens later.
 */

import { useParams } from 'next/navigation'
import { useCallback } from 'react'

/**
 * Deliberately duplicated from src/lib/server/goal-scope.ts rather than
 * re-exported. That module imports Prisma, and pulling it into a client
 * component drags the whole client into the browser bundle (and fails the
 * build). The two constants are pinned equal by a test in
 * __tests__/scoped-href.test.ts — do not "DRY" this away.
 */
export const ALL_SCOPE = 'all'

/** Workspace-level paths that are deliberately never scoped. */
const UNSCOPED_PREFIXES = ['/settings', '/auth', '/api']

export function scopedHref(scope: string, path: string): string {
  // Not ours to rewrite: absolute URLs, mailto:, anchors, relative paths.
  if (!path.startsWith('/')) return path
  // Already scoped — double-prefixing is the predictable bug when one helper
  // receives an href another already handled.
  if (path.startsWith('/g/')) return path
  if (UNSCOPED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return path
  return `/g/${scope}${path}`
}

/** The lens the current route is rendering under. */
export function useScope(): string {
  const params = useParams<{ scope?: string }>()
  return params?.scope || ALL_SCOPE
}

export function useScopedHref(): (path: string) => string {
  const scope = useScope()
  return useCallback((path: string) => scopedHref(scope, path), [scope])
}
