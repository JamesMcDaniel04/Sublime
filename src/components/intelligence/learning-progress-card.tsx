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
  personal?: {
    hasActivity: boolean
    learningDaysLeft: number
    inLearningPeriod: boolean
    eligiblePatterns: number
    openSuggestion: boolean
  }
  ready: boolean
}

type Stage =
  | { kind: 'connect'; needed: number; total: number }
  | { kind: 'usage'; events: number }
  | { kind: 'learning'; daysLeft: number }
  | { kind: 'watching' }

/** The single most relevant "why nothing yet" stage — org gates first, then
 *  the personal learning gate. Returns null once suggestions can flow (an open
 *  suggestion exists, or eligible patterns are already feeding synthesis). */
function stageOf(r: Readiness): Stage | null {
  if (!r.connections.ready) return { kind: 'connect', needed: r.connections.needed, total: r.connections.total }
  if (!r.usage.ready) return { kind: 'usage', events: r.usage.events }
  const p = r.personal
  if (!p) return null
  if (p.openSuggestion || p.eligiblePatterns > 0) return null
  if (p.inLearningPeriod) return { kind: 'learning', daysLeft: p.learningDaysLeft }
  return { kind: 'watching' }
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

  const stage = readiness ? stageOf(readiness) : null
  if (!stage) return null

  return (
    <div className="mb-4 flex items-start gap-3 rounded-2xl border border-indigo-100 bg-indigo-50/60 p-3.5 text-sm shadow-1">
      {stage.kind === 'connect'
        ? <Plug className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" />
        : <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" />}
      <div className="min-w-0 flex-1">
        {stage.kind === 'connect' && (
          <>
            <p className="font-medium text-foreground">
              Connect {stage.needed} more {stage.needed === 1 ? 'tool' : 'tools'} and Sublime starts learning your patterns
            </p>
            <p className="mt-0.5 text-muted-foreground">
              {stage.total} of 3 connected. Once Sublime can see how you work across tools, it suggests agents and flows grounded in what you actually do — never generic ones.
            </p>
            <Link href="/integrations" className="mt-1.5 inline-block font-semibold text-indigo-600 underline-offset-2 hover:underline">
              Open integrations
            </Link>
          </>
        )}
        {stage.kind === 'usage' && (
          <>
            <p className="font-medium text-foreground">Sublime is learning how you work</p>
            <p className="mt-0.5 text-muted-foreground">
              {stage.events} usage {stage.events === 1 ? 'signal' : 'signals'} captured so far. Keep running agents, flows, and your connected tools — once enough real usage accrues, evidence-backed suggestions arrive in your notifications.
            </p>
          </>
        )}
        {stage.kind === 'learning' && (
          <>
            <p className="font-medium text-foreground">Sublime is in its learning period</p>
            <p className="mt-0.5 text-muted-foreground">
              Your tools are connected and usage is flowing. To make sure suggestions reflect a real routine (not a one-off), Sublime watches for about {stage.daysLeft} more {stage.daysLeft === 1 ? 'day' : 'days'} before it proposes anything.
            </p>
          </>
        )}
        {stage.kind === 'watching' && (
          <>
            <p className="font-medium text-foreground">Watching for repeatable routines</p>
            <p className="mt-0.5 text-muted-foreground">
              Everything's connected and Sublime is learning, but it hasn't seen the same task repeat enough to suggest automating it yet. Keep working the way you normally do — the moment a routine emerges, you'll get an evidence-backed suggestion.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
