'use client'

import { ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { Sidebar } from './sidebar'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { TrialBanner } from '@/components/billing/trial-banner'

/**
 * The app chrome, mounted once by the (app) route group layout so the sidebar
 * PERSISTS across client navigations instead of remounting per page.
 *
 * It no longer decides WHETHER to render chrome — route-group membership does
 * that, replacing a hand-maintained APP_PREFIXES list that had already drifted
 * (/skills/[id] was missing from it). All this decides now is whether the
 * content area is edge-to-edge.
 */

// Only Home (the assistant), agent HQ, and the flow builder want an
// edge-to-edge (fullscreen) content area; the rest (incl. the /flows list)
// use the centered container.
const FULLSCREEN_ROUTES = new Set(['/dashboard', '/agents'])

export function AppShell({
  children,
  trialDaysRemaining,
}: {
  children: ReactNode
  trialDaysRemaining: number | null
}) {
  const pathname = usePathname() ?? ''
  // Every app surface lives under /g/<scope>; strip the lens prefix to recover
  // the bare surface before matching (same normalization the goal switcher
  // uses). Matching the raw pathname silently un-fullscreened Home, agent HQ
  // and the flow builder the day the routes moved.
  const surface = pathname.replace(/^\/g\/[^/]+/, '') || '/'

  // The flow builder (/flows/<id>) is fullscreen; the /flows list AND any
  // deeper /flows/<id>/* subpage (e.g. /flows/<id>/activity) use the centered
  // container, so only exactly one path segment past "/flows/" goes edge-to-edge.
  const flowSegments = surface.startsWith('/flows/') ? surface.slice('/flows/'.length).split('/').filter(Boolean) : []
  const fullscreen = FULLSCREEN_ROUTES.has(surface) || flowSegments.length === 1

  return (
    <div className="sublime-app-shell flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TrialBanner daysRemaining={trialDaysRemaining} />
        <main id="main-content" tabIndex={-1} className="sublime-app-main flex-1 overflow-y-auto">
          {fullscreen ? (
            <ErrorBoundary>{children}</ErrorBoundary>
          ) : (
            <div className="container mx-auto max-w-7xl animate-fade-in px-3 py-5 sm:px-8 sm:py-10">
              <ErrorBoundary>{children}</ErrorBoundary>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
