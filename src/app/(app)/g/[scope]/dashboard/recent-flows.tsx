'use client'

import { useMemo } from 'react'
import { ScopedLink } from '@/components/ui/scoped-link'
import { useScope, useScopedHref } from '@/lib/client/scoped-href'
import { useCachedJson } from '@/lib/client/use-cached-json'
import { pickRecentFlows, type RecentFlowInput } from '@/lib/flows/recent'
import { TemplateCatalogueCard } from '@/components/templates/template-catalogue-card'

type FlowsResponse = { success?: boolean; flows?: RecentFlowInput[] }

/** "active" → "Active" for the card's category badge. */
const statusLabel = (status: string) => status.charAt(0).toUpperCase() + status.slice(1)

/**
 * "Pick up where you left off" — the 3 most recently edited flows as quick
 * jumps back into their canvases, rendered with the same catalogue cards as
 * the flow templates page. Reads the same cached /api/flows payload the Flows
 * page uses (warmed at sign-in by the sidebar), so it costs no extra request
 * and inherits the goal lens from the URL scope. Renders nothing while
 * loading, on error, or when no qualifying flows exist — it is a shortcut,
 * not a source of truth; the Flows page owns load errors and empty states.
 */
export function RecentFlows() {
  const scope = useScope()
  // TemplateCatalogueCard links with a plain next/link, so the href must be
  // scoped here or the click would drop the goal lens.
  const scoped = useScopedHref()
  const { data } = useCachedJson<FlowsResponse>(`/api/flows?goal=${encodeURIComponent(scope)}`)
  const recent = useMemo(() => pickRecentFlows(data?.flows), [data])
  if (recent.length === 0) return null
  return (
    <div className="mt-8">
      <div className="flex items-center justify-between px-1">
        <p className="text-xs font-medium text-muted-foreground">Pick up where you left off</p>
        <ScopedLink
          href="/flows"
          className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          All flows →
        </ScopedLink>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {recent.map((flow) => (
          <TemplateCatalogueCard
            key={flow.id}
            href={scoped(`/flows/${flow.id}`)}
            name={flow.name}
            description={flow.description || 'No description yet.'}
            category={statusLabel(flow.status)}
            integrations={[]}
            kind="flow"
            actionLabel="Open flow"
          />
        ))}
      </div>
    </div>
  )
}
