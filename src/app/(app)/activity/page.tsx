'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'
import { History, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { ActivityFeed } from '@/components/activity/activity-feed'
import { ActivityBackfillPanel } from '@/components/activity/activity-backfill-panel'
import { ACTIVITY_SOURCES } from '@/components/activity/activity-source-labels'
import { useCachedJson } from '@/lib/client/use-cached-json'

/**
 * Workspace activity history.
 *
 * Deliberately workspace-level (not under /g/[scope]) like Settings and
 * Templates: the ledger is a per-organization stream with no goal dimension,
 * so scoping the route would promise a lens the data cannot honour.
 *
 * Plan-gated to Team and above via capabilities.activityHistory — the same
 * capability GET /api/activity enforces, read here from /api/billing/status so
 * the surface is locked rather than merely erroring.
 */
export default function ActivityPage() {
  const { data: billing, loading } = useCachedJson<{ capabilities?: { activityHistory?: boolean } }>('/api/billing/status')
  const allowed = billing?.capabilities?.activityHistory ?? false
  // Bumped after a backfill reports progress so the feed re-reads rather than
  // showing a ledger that predates the import the user just watched finish.
  const [feedKey, setFeedKey] = useState(0)
  const refreshFeed = useCallback(() => setFeedKey((current) => current + 1), [])

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Workspace"
        icon={History}
        title="Activity"
        description="Everything your connected tools did, normalized into one history — the signal behind workspace learning, patterns, and goal evidence."
      />

      {loading && !billing ? (
        <div className="space-y-4" aria-busy="true" aria-label="Loading activity">
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      ) : !allowed ? (
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
      ) : (
        <>
          <ActivityBackfillPanel onIngested={refreshFeed} />
          <ActivityFeed key={feedKey} sources={[...ACTIVITY_SOURCES]} />
        </>
      )}
    </div>
  )
}
