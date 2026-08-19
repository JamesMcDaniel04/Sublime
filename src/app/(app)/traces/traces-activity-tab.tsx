'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { ActivityFeed } from '@/components/activity/activity-feed'
import { ActivityBackfillPanel } from '@/components/activity/activity-backfill-panel'
import { ACTIVITY_SOURCES } from '@/components/activity/activity-source-labels'
import { useCachedJson } from '@/lib/client/use-cached-json'

/**
 * The tool-activity half of Traces: what the workspace's connected tools did,
 * normalized into one history.
 *
 * Lives beside the run stream rather than on its own page, but keeps its own
 * plan gate — activity history is Team and above (capabilities.activityHistory,
 * the same one GET /api/activity enforces) while runs are open to every member.
 * Gating the whole page would have taken traces away from Individual
 * workspaces, so the lock stays inside this tab.
 */
export function TracesActivityTab() {
  const { data: billing, loading } = useCachedJson<{ capabilities?: { activityHistory?: boolean } }>('/api/billing/status')
  const allowed = billing?.capabilities?.activityHistory ?? false
  // Bumped after a backfill reports progress so the feed re-reads rather than
  // showing a ledger that predates the import the user just watched finish.
  const [feedKey, setFeedKey] = useState(0)
  const refreshFeed = useCallback(() => setFeedKey((current) => current + 1), [])

  if (loading && !billing) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading activity">
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    )
  }

  if (!allowed) {
    return (
      <EmptyState
        icon={Lock}
        title="Activity history is on Team plans and above"
        description="Team, Business, and Enterprise workspaces keep a searchable cross-tool history and can import what happened before they connected."
        action={
          <Button asChild>
            <Link href="/settings?tab=billing">See plans</Link>
          </Button>
        }
      />
    )
  }

  return (
    <div className="space-y-6">
      <ActivityBackfillPanel onIngested={refreshFeed} />
      <ActivityFeed key={feedKey} sources={[...ACTIVITY_SOURCES]} />
    </div>
  )
}
