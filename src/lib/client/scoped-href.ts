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

/**
 * The surfaces that actually exist under /g/[scope] — a CLOSED list, not an
 * exclusion list.
 *
 * Inverted deliberately. With an exclusion list, every new unscoped route
 * (/templates, /skills, /connections, tomorrow's /reports) silently becomes
 * /g/<scope>/that and 404s until someone remembers to exclude it. With this,
 * an unknown path is simply left alone, which is always safe.
 */
const SCOPED_PREFIXES = ['/dashboard', '/goals', '/agents', '/flows', '/integrations']

/** Sub-paths of /goals that are pages, not goal ids. */
const GOALS_SUBPAGES = new Set(['new'])

/**
 * Opening a goal SWITCHES the lens: /goals/<id> becomes /g/<id>/goals, not
 * /g/<scope>/goals/<id>.
 *
 * This is not a special case so much as the same rule the redirect in
 * next.config.js applies — encoded once, here, so a link and a redirect can
 * never disagree. Without it every goal-detail link resolves to a path that no
 * longer has a route, because /goals/[id] folded into the goals surface.
 */
function goalDetailHref(path: string): string | null {
  if (!path.startsWith('/goals/')) return null
  // Sliced rather than matched with a trailing (.*) group — the greedy form is
  // needlessly backtracky for what is just "first segment, then the remainder".
  const tail = path.slice('/goals/'.length)
  const end = tail.search(/[/?#]/)
  const id = end === -1 ? tail : tail.slice(0, end)
  if (!id || GOALS_SUBPAGES.has(id)) return null
  return `/g/${id}/goals${end === -1 ? '' : tail.slice(end)}`
}

export function scopedHref(scope: string, path: string): string {
  // Not ours to rewrite: absolute URLs, mailto:, anchors, relative paths.
  if (!path.startsWith('/')) return path
  // Already scoped — double-prefixing is the predictable bug when one helper
  // receives an href another already handled.
  if (path.startsWith('/g/')) return path

  const goalDetail = goalDetailHref(path)
  if (goalDetail) return goalDetail

  const scoped = SCOPED_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`),
  )
  return scoped ? `/g/${scope}${path}` : path
}

/** Explicit form of the rule above, for callers holding a goal id directly. */
export function goalHref(goalId: string): string {
  return `/g/${goalId}/goals`
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
