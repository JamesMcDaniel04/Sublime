'use client'

import { useEffect, useState } from 'react'

/**
 * The viewer's IANA timezone, resolved after mount.
 *
 * Returns `fallback` on the first render deliberately. The server has no idea
 * what zone the reader is in, so resolving during render would produce a
 * different string on the server than in the browser and trip a hydration
 * mismatch. Passing the schedule's own timezone as the fallback means the first
 * paint is merely less localized, never wrong.
 */
export function useViewerTimeZone(fallback: string): string {
  const [zone, setZone] = useState(fallback)

  useEffect(() => {
    try {
      const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (resolved) setZone(resolved)
    } catch {
      // Keep the fallback — an environment without a resolvable zone is not an
      // error worth surfacing over a schedule label.
    }
  }, [fallback])

  return zone
}
