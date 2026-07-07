'use client'

import { ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { Sidebar } from './sidebar'
import { ErrorBoundary } from '@/components/ui/error-boundary'

/**
 * The single app chrome, mounted once in the root layout so the sidebar
 * PERSISTS across client navigations instead of remounting per page (each
 * authenticated page used to render its own <DashboardLayout>, so navigating
 * between them tore down and rebuilt the sidebar every time).
 *
 * On authenticated routes it renders the sidebar + content region; on public
 * routes (marketing, auth, connect) it passes children through untouched. The
 * <main id="main-content"> wrapper (skip-link target) is preserved in both.
 */

// Route prefixes that get the app chrome. Everything else (/, /auth/*, /connect,
// /privacy, /terms, /auth-code-error) renders bare.
const APP_PREFIXES = ['/dashboard', '/integrations', '/connections', '/templates', '/flows']

// Only the agent HQ + the flow builder want an edge-to-edge (fullscreen) content
// area; the rest (incl. the /flows list) use the centered container.
const FULLSCREEN_ROUTES = new Set(['/dashboard'])

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? ''
  const isAppRoute = APP_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))

  if (!isAppRoute) {
    return <main id="main-content">{children}</main>
  }

  // The flow builder (/flows/<id>) is fullscreen; the /flows list is centered.
  const fullscreen = FULLSCREEN_ROUTES.has(pathname) || (pathname.startsWith('/flows/') && pathname !== '/flows')
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <main id="main-content" className="flex-1 overflow-y-auto">
        {fullscreen ? (
          <ErrorBoundary>{children}</ErrorBoundary>
        ) : (
          <div className="container mx-auto max-w-7xl animate-fade-in px-3 py-4 sm:px-6 sm:py-8">
            <ErrorBoundary>{children}</ErrorBoundary>
          </div>
        )}
      </main>
    </div>
  )
}
