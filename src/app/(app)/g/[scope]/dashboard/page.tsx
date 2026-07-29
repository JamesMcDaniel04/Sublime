'use client'

import { Suspense, useEffect, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import { useScopedRouter } from '@/lib/client/use-scoped-router'
import { HomeAssistant } from './home-assistant'

/**
 * Home — the workspace assistant. This route used to be Agent HQ, so legacy
 * deep links (?agent=, ?run=, ?view=) from old notifications, bookmarks, and
 * emails are forwarded to /agents with their params intact.
 */
function HomePage() {
  const router = useScopedRouter()
  const searchParams = useSearchParams()
  const legacy = useMemo(
    () => ['agent', 'run', 'view'].some((key) => searchParams.get(key) !== null),
    [searchParams],
  )

  useEffect(() => {
    if (legacy) router.replace(`/agents?${searchParams.toString()}`)
  }, [legacy, router, searchParams])

  if (legacy) return null
  return <HomeAssistant />
}

export default function DashboardHomePage() {
  return (
    <Suspense fallback={null}>
      <HomePage />
    </Suspense>
  )
}
