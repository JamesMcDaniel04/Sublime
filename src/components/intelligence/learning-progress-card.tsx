'use client'

/**
 * Onboarding pull toward the intelligence gates. Shows the next concrete step
 * until the platform can start recommending: connect >= 3 tools, then let
 * real usage accrue. Renders nothing once both gates are met (suggestions
 * arrive through the notification bell from then on) — this card never
 * competes with the assistant for attention after onboarding.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Plug, Sparkles } from 'lucide-react'
import { getCachedJson } from '@/lib/client/use-cached-json'

type Readiness = {
  connections: { total: number; needed: number; ready: boolean }
  usage: { events: number; needed: number; ready: boolean }
  ready: boolean
}

export function LearningProgressCard() {
  const [readiness, setReadiness] = useState<Readiness | null>(null)

  useEffect(() => {
    let cancelled = false
    getCachedJson<{ readiness?: Readiness }>('/api/intelligence/readiness', 60_000)
      .then((data) => {
        if (!cancelled && data?.readiness) setReadiness(data.readiness)
      })
      .catch(() => {
        /* the card simply doesn't render */
      })
    return () => { cancelled = true }
  }, [])

  if (!readiness || readiness.ready) return null

  const connecting = !readiness.connections.ready
  return (
    <div className="mb-4 flex items-start gap-3 rounded-2xl border border-indigo-100 bg-indigo-50/60 p-3.5 text-sm shadow-1">
      {connecting ? <Plug className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" /> : <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" />}
      <div className="min-w-0 flex-1">
        {connecting ? (
          <>
            <p className="font-medium text-foreground">
              Connect {readiness.connections.needed} more {readiness.connections.needed === 1 ? 'tool' : 'tools'} and Sublime starts learning your patterns
            </p>
            <p className="mt-0.5 text-muted-foreground">
              {readiness.connections.total} of 3 connected. Once Sublime can see how you work across tools, it suggests agents and flows grounded in what you actually do — never generic ones.
            </p>
            <Link href="/integrations" className="mt-1.5 inline-block font-semibold text-indigo-600 underline-offset-2 hover:underline">
              Open integrations
            </Link>
          </>
        ) : (
          <>
            <p className="font-medium text-foreground">Sublime is learning how you work</p>
            <p className="mt-0.5 text-muted-foreground">
              {readiness.usage.events} usage {readiness.usage.events === 1 ? 'signal' : 'signals'} captured so far. Keep running agents, flows, and your connected tools — once enough real usage accrues, evidence-backed suggestions arrive in your notifications.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
