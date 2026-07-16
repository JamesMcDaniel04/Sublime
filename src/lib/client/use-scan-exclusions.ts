'use client'

import { useCallback, useMemo } from 'react'
import { useCachedJson } from './use-cached-json'
import { toggleScanExclusion } from '@/lib/intelligence/scan-exclusions'

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
      const next = toggleScanExclusion(exclusions, sourceRef, enabled)
      const response = await fetch('/api/organizations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { scanExclusions: next } }),
      })
      if (!response.ok) return false
      await refresh()
      return true
    },
    [exclusions, refresh],
  )

  return { loading, isLearningEnabled, setLearningEnabled }
}
