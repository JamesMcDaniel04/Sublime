'use client'

import { useCallback, useMemo } from 'react'
import { useCachedJson } from './use-cached-json'

type OrgSettings = { scanExclusions?: string[] }
type OrganizationsResponse = { organizations?: { settings?: OrgSettings }[] }

/**
 * Per-connection learning opt-out (Task 4.5): reads and writes
 * organizations.settings.scanExclusions — the org-wide list of
 * `<plane>:<connectionRef>` keys the connection scan skips. Shared by the
 * MCP-server rows so both surfaces reflect
 * the same underlying setting. Imports only from scan-exclusions.ts (no
 * server-only code) so it's safe to use from a client component.
 */
export function useScanExclusions() {
  const { data, loading, refresh } = useCachedJson<OrganizationsResponse>('/api/organizations')
  const rawExclusions = data?.organizations?.[0]?.settings?.scanExclusions
  const exclusions = useMemo(() => rawExclusions ?? [], [rawExclusions])

  const isLearningEnabled = useCallback((sourceRef: string) => !exclusions.includes(sourceRef), [exclusions])

  const setLearningEnabled = useCallback(
    async (sourceRef: string, enabled: boolean): Promise<boolean> => {
      // Verb form, not a full-array replacement: the server applies add/remove
      // against the array as it exists NOW. The old read-modify-write shipped
      // this client's (SWR-cached, possibly stale) copy of the whole array, so
      // admin A's toggle silently deleted admin B's concurrent opt-out — a
      // privacy setting reverting itself.
      const response = await fetch('/api/organizations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanExclusionUpdate: enabled ? { remove: sourceRef } : { add: sourceRef } }),
      }).catch(() => null)
      if (!response?.ok) return false
      await refresh()
      return true
    },
    [refresh],
  )

  return { loading, isLearningEnabled, setLearningEnabled }
}
